/**
 * WebSocket服務
 * 處理與後端的即時通訊
 */

import { AppDispatch } from '../store';
import { setConnectionStatus, addNotification, updateEngineStatus } from '../store/slices/systemSlice';
import { updateOpportunity, addExecution, removeMonitoringPair, updatePairTriggerStats } from '../store/slices/arbitrageSlice';
import { addExecution as addTwapExecution } from '../store/slices/twapSlice';
import { updatePrice } from '../store/slices/pricesSlice';
import logger from '../utils/logger';
import { getWsUrl } from '../utils/env';

let wsRef: WebSocket | null = null;
// let pollingTimers: Map<string, any> = new Map();
let reconnectTimer: NodeJS.Timeout | null = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY = 1500; // 1.5秒，加快重連

/**
 * 連接WebSocket
 */
export function connectWebSocket(dispatch: AppDispatch) {
  const wsUrl = getWsUrl();
  
  if (wsRef && wsRef.readyState === WebSocket.OPEN) {
    return;
  }

  try {
    wsRef = new WebSocket(wsUrl);
    
    wsRef.onopen = () => {
      console.log('🔗 WebSocket 連接成功');
      dispatch(setConnectionStatus('connected'));
      reconnectAttempts = 0;
      
      // 連接成功後立即獲取最新數據
      dispatch(updateEngineStatus({ isRunning: true }));
    };

    wsRef.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        handleWebSocketMessage(message, dispatch);
      } catch (error) {
        console.error('WebSocket 消息解析失敗:', error);
      }
    };

    wsRef.onclose = () => {
      console.log('🔌 WebSocket 連接關閉');
      dispatch(setConnectionStatus('disconnected'));
      dispatch(updateEngineStatus({ isRunning: false }));
      
      // 自動重連
      if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        reconnectAttempts++;
        console.log(`🔄 嘗試重連 WebSocket (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
        reconnectTimer = setTimeout(() => {
          connectWebSocket(dispatch);
        }, RECONNECT_DELAY);
      } else {
        console.error('❌ WebSocket 重連失敗，已達到最大重試次數');
        dispatch(updateEngineStatus({ isRunning: false }));
      }
    };

    wsRef.onerror = (error) => {
      console.error('WebSocket 錯誤:', error);
      dispatch(updateEngineStatus({ isRunning: false }));
    };

  } catch (error) {
    console.error('WebSocket 連接失敗:', error);
    dispatch(updateEngineStatus({ isRunning: false }));
  }
}

/**
 * 斷開WebSocket連接
 */
export function disconnectWebSocket() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  
  if (wsRef) {
    wsRef.close();
    wsRef = null;
  }
  
  reconnectAttempts = 0;
}

/**
 * 處理WebSocket消息
 */
function handleWebSocketMessage(message: any, dispatch: AppDispatch) {
  const { type, data, timestamp } = message;
  
  switch (type) {
    case 'arbitragePriceUpdate':
      // 套利價格更新
      if (data && data.id) {
        const { id, leg1Price, leg2Price, spread, spreadPercent, threshold, pairConfig } = data;
        
        // 計算價差方向
        const leg1Side = pairConfig?.leg1?.side || 'buy';
        const leg2Side = pairConfig?.leg2?.side || 'sell';
        const direction = (leg1Side === 'sell' && leg2Side === 'buy') ? 'leg1_sell_leg2_buy' : 'leg1_buy_leg2_sell';
        
        const opportunity = {
          id,
          pairConfig: pairConfig || {
            id,
            leg1: { exchange: leg1Price?.exchange || '', symbol: leg1Price?.symbol || '', type: 'spot', side: 'buy' },
            leg2: { exchange: leg2Price?.exchange || '', symbol: leg2Price?.symbol || '', type: 'spot', side: 'sell' },
            threshold: threshold || 0,
            amount: 0,
            enabled: true,
            createdAt: Date.now(),
            lastTriggered: null,
            totalTriggers: 0
          },
          leg1Price,
          leg2Price,
          spread: spread || 0,
          spreadPercent: spreadPercent || 0,
          threshold: threshold || 0,
          shouldTrigger: (spreadPercent || 0) >= (threshold || 0),
          timestamp: timestamp || Date.now(),
          direction: direction as 'leg1_buy_leg2_sell' | 'leg1_sell_leg2_buy'
        };
        
        dispatch(updateOpportunity(opportunity));
        
        // 觸發自定義事件，讓頁面可以監聽
        window.dispatchEvent(new CustomEvent('priceUpdate', {
          detail: {
            type: 'priceUpdate',
            data: {
              id,
              leg1Price,
              leg2Price,
              spread,
              spreadPercent,
              threshold,
              pairConfig
            }
          }
        }));
      }
      break;

    case 'arbitrageExecuted':
      // 套利執行完成
      console.log('🔔 收到套利執行完成消息:', data);
      if (data) {
        const now = timestamp || Date.now();
        const leg1 = data.leg1 || {};
        const leg2 = data.leg2 || {};
        const pairId = data.pairId;
        
        // 添加執行記錄到 Redux store（只調用一次，使用完整的數據結構）
        dispatch(addExecution({
          opportunity: {
            id: pairId,
            pairConfig: {
              id: pairId,
              leg1: {
                exchange: leg1.exchange || '',
                symbol: leg1.symbol || '',
                type: leg1.type || 'spot',
                side: leg1.side || 'buy'
              },
              leg2: {
                exchange: leg2.exchange || '',
                symbol: leg2.symbol || '',
                type: leg2.type || 'spot',
                side: leg2.side || 'sell'
              },
              threshold: data.threshold || 0,
              qty: data.qty || 0,
              maxExecs: data.maxExecs || 1,
              totalTriggers: data.totalTriggers || 0,
              enabled: true,
              createdAt: now,
              lastTriggered: now
            },
            leg1Price: { 
              symbol: leg1.symbol || '', 
              exchange: leg1.exchange || '', 
              bid1: null, 
              ask1: null 
            },
            leg2Price: { 
              symbol: leg2.symbol || '', 
              exchange: leg2.exchange || '', 
              bid1: null, 
              ask1: null 
            },
            spread: data.spread || 0,
            spreadPercent: data.spreadPercent || 0,
            threshold: data.threshold || 0,
            shouldTrigger: false,
            timestamp: now,
            direction: 'leg1_buy_leg2_sell'
          },
          amount: data.qty || 0,
          result: {
            leg1OrderId: data.leg1OrderId,
            leg2OrderId: data.leg2OrderId
          },
          success: true,
          timestamp: now,
          maxExecs: data.maxExecs || 1,
          totalTriggers: data.totalTriggers || 0,
          completed: true
        }));

        // 更新觸發統計
        dispatch(updatePairTriggerStats({
          pairId: pairId,
          totalTriggers: data.totalTriggers || 0,
          lastTriggered: now
        }));

        dispatch(addNotification({
          type: 'success',
          message: '套利執行成功'
        }));

        // 觸發自定義事件，讓頁面可以監聽
        window.dispatchEvent(new CustomEvent('arbitrageExecuted', {
          detail: {
            type: 'arbitrageExecuted',
            data: data
          }
        }));
      }
      break;

    case 'pairRemoved':
      // 監控對被移除
      if (data?.id) {
        dispatch(addNotification({ type: 'info', message: `已完成並移除: ${data.id}` }));
        dispatch(removeMonitoringPair(data.id));

        // 觸發自定義事件，讓頁面可以監聽
        window.dispatchEvent(new CustomEvent('pairRemoved', {
          detail: {
            type: 'pairRemoved',
            data: data
          }
        }));
      }
      break;

    case 'arbitrageFailed':
      // 套利執行失敗
      if (data) {
        dispatch(addNotification({
          type: 'error',
          message: `套利執行失敗: ${data.reason || '未知錯誤'}`
        }));

        // 觸發自定義事件，讓頁面可以監聽
        window.dispatchEvent(new CustomEvent('arbitrageFailed', {
          detail: {
            type: 'arbitrageFailed',
            data: data
          }
        }));
      }
      break;

    case 'twapExecuted':
      // TWAP 執行完成
      if (data) {
        dispatch(addTwapExecution({
          strategyId: data.planId,
          timestamp: data.timestamp || Date.now(),
          amount: data.qty || 0,
          leg1Price: data.price || undefined,
          leg2Price: data.price || undefined,
          success: data.success || false,
          error: data.error || undefined
        }));

        dispatch(addNotification({
          type: data.success ? 'success' : 'error',
          message: data.success ? 'TWAP 執行成功' : 'TWAP 執行失敗'
        }));
      }
      break;

    case 'twapPlanCompleted':
      // TWAP 策略完成
      if (data) {
        dispatch(addNotification({
          type: 'success',
          message: `TWAP 策略完成: ${data.planId}`
        }));
      }
      break;

    case 'twapPlanFailed':
      // TWAP 策略失敗
      if (data) {
        dispatch(addNotification({
          type: 'error',
          message: `TWAP 策略失敗: ${data.planId} - ${data.reason || '未知錯誤'}`
        }));
      }
      break;

    case 'priceUpdate':
      // 價格更新（通用）
      if (data && data.symbol) {
        dispatch(updatePrice({
          symbol: data.symbol,
          exchange: data.exchange || 'bybit',
          bid1: data.bid1 || { price: 0, amount: 0 },
          ask1: data.ask1 || { price: 0, amount: 0 },
          spread: data.spread || 0,
          spreadPercent: data.spreadPercent || 0,
          timestamp: data.timestamp || Date.now()
        }));
      }
      break;

    case 'arbitrageEngineStatus':
      // 🔧 套利引擎狀態變更
      if (data) {
        console.log('🔔 收到套利引擎狀態變更:', data);
        dispatch(updateEngineStatus({
          isRunning: data.running || false
        }));
        
        // 顯示通知
        dispatch(addNotification({
          type: 'info',
          message: data.running ? '套利引擎已啟動' : '套利引擎已停止'
        }));
        
        logger.info(`套利引擎狀態: ${data.running ? '運行中' : '已停止'}`, data, 'WebSocket');
      }
      break;

    case 'log':
      // 日誌消息
      if (data && data.message) {
        logger.info(data.message, data.data || {}, data.source || 'WebSocket');
      }
      break;

    default:
      console.log('未處理的 WebSocket 消息類型:', type, data);
      break;
  }
}

/**
 * 發送 WebSocket 消息
 */
export function sendWebSocketMessage(message: any) {
  if (wsRef && wsRef.readyState === WebSocket.OPEN) {
    wsRef.send(JSON.stringify(message));
    return true;
  }
  return false;
}

/**
 * 獲取 WebSocket 連接狀態
 */
export function getWebSocketStatus(): boolean {
  return wsRef !== null && wsRef.readyState === WebSocket.OPEN;
}