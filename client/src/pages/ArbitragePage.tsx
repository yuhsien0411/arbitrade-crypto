

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { 
  Row, Col, Card, Form, Select, InputNumber, Button, Table, Space, 
  Typography, Tag, Switch, Modal, Divider, Alert, Tooltip, Input, App as AntdApp
} from 'antd';
import { 
  PlusOutlined, DeleteOutlined, PlayCircleOutlined, PauseCircleOutlined,
  SettingOutlined, ExclamationCircleOutlined
} from '@ant-design/icons';
import { useSelector, useDispatch } from 'react-redux';
import { RootState, AppDispatch } from '../store';
import { apiService, MonitoringPairConfig } from '../services/api';
import { getApiBaseUrl } from '../utils/env';
import type { 
  PairConfig, 
  CreatePairRequest
} from '../types/arbitrage';
import { addMonitoringPair, removeMonitoringPair, updateMonitoringPair, updateOpportunity, setMonitoringPairs, setOpportunities, updatePairTriggerStats, setRecentExecutions } from '../store/slices/arbitrageSlice';
import { updateExchanges } from '../store/slices/systemSlice';
import { formatAmountWithCurrency, getBaseCurrencyFromSymbol } from '../utils/formatters';
import logger from '../utils/logger';
import storage from '../utils/storage';

// 使用統一的 PairConfig 型別，添加向後兼容欄位
interface ArbitragePairExtended extends PairConfig {
  amount: number;  // 向後兼容，等同於 qty
  totalAmount?: number;
  consumedAmount?: number;
  [key: string]: any;
}

const { Title, Text } = Typography;
const { Option } = Select;
const { confirm } = Modal;

const ArbitragePage: React.FC = (): React.ReactElement => {
  const dispatch = useDispatch<AppDispatch>();
  const { message } = AntdApp.useApp();
  const { exchanges, isConnected } = useSelector((state: RootState) => state.system);
  const { monitoringPairs: rawMonitoringPairs, currentOpportunities, recentExecutions } = useSelector((state: RootState) => state.arbitrage);
  // 將 monitoringPairs 轉換為擴展類型以支援新參數，並確保數據完整性
  const monitoringPairs = (rawMonitoringPairs || []).filter((pair: any) => 
    pair && 
    typeof pair === 'object' && 
    pair.leg1 && 
    typeof pair.leg1 === 'object' && 
    pair.leg2 && 
    typeof pair.leg2 === 'object'
  ) as ArbitragePairExtended[];
  // 避免 effect 依賴變更導致反覆重建 interval：用 ref 保存最新列表
  const monitoringPairsRef = useRef<ArbitragePairExtended[]>(monitoringPairs);
  useEffect(() => { monitoringPairsRef.current = monitoringPairs; }, [monitoringPairs]);

  // 更新節流：對齊 bybit 的穩定感，每個 pair 最快 1s 更新一次
  const lastUpdateAtRef = useRef<Record<string, number>>({});
  
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [editingPair, setEditingPair] = useState<any>(null);
  const [isInitialized, setIsInitialized] = useState(false);
  const [averagePrices, setAveragePrices] = useState<Record<string, any>>({});
  const [leg1Exchange, setLeg1Exchange] = useState<string>('bybit');
  const [leg2Exchange, setLeg2Exchange] = useState<string>('bybit');

  // 立即檢查初始化狀態
  useEffect(() => {
    // 如果 Redux 狀態已經有數據，立即標記為已初始化
    if (monitoringPairs.length > 0 || rawMonitoringPairs.length === 0) {
      setIsInitialized(true);
    }
  }, [rawMonitoringPairs, monitoringPairs]);

  // 可用的交易所和交易對
  const defaultExchanges = [
    {
      key: 'bybit',
      name: 'Bybit',
      supportCustomSymbol: true,
      description: '支援用戶自行輸入任何可用的交易對',
      status: 'active',
      implemented: true,
      connected: true
    },
    {
      key: 'binance',
      name: 'Binance',
      supportCustomSymbol: true,
      description: '支援統一交易帳戶 (Portfolio Margin)',
      status: 'active',
      implemented: true,
      connected: true
    },
    {
      key: 'bitget',
      name: 'Bitget',
      supportCustomSymbol: true,
      description: '僅支援合約交易 (USDT-M 永續合約)',
      status: 'active',
      implemented: true,
      connected: true
    }
  ];

  // 優先使用系統中的交易所，如果沒有則使用預設
  const availableExchanges = Object.keys(exchanges).length > 0
    ? Object.entries(exchanges)
        .map(([key, exchange]) => ({ 
          key, 
          name: exchange.name, 
          supportCustomSymbol: true,
          description: exchange.message || (key === 'bitget' ? '僅支援合約交易 (USDT-M 永續合約)' : '支援自定義交易對'),
          connected: exchange.connected,
          status: exchange.status ?? (['bybit', 'binance', 'bitget'].includes(key) ? 'active' : 'planned'),
          implemented: exchange.implemented ?? (['bybit', 'binance', 'bitget'].includes(key)),
          features: exchange.features,
          priority: exchange.priority
        }))
    : defaultExchanges;

  const loadMonitoringPairs = useCallback(async () => {
    try {
      const response = await apiService.getMonitoringPairs();
      if (response.data && Array.isArray(response.data)) {
        const normalized: ArbitragePairExtended[] = [] as any;
        response.data.forEach((pair: any) => {
          if (!pair || typeof pair !== 'object') return;
          // 確保數據結構正確，添加必要的預設值
          const normalizedPair = {
            ...(pair || {}),
            leg1: {
              ...(pair?.leg1 || {}),
              side: pair.leg1?.side || 'buy',
              type: pair.leg1?.type || 'spot'
            },
            leg2: {
              ...(pair?.leg2 || {}),
              side: pair.leg2?.side || 'sell',
              // 避免預設為 linear 導致兩腿都變合約；安全預設為 spot
              type: pair.leg2?.type || 'spot'
            },
            threshold: pair.threshold ?? 0.1,
            qty: pair.qty || 0.001,
            amount: pair.qty || 0.001,
            enabled: pair.enabled !== false,
            maxExecs: pair.maxExecs || 1,
            executionsCount: pair.executionsCount || 0,
            createdAt: pair.createdAt || Date.now(),
            lastTriggered: pair.lastTriggered || null,
            totalTriggers: pair.totalTriggers || 0
          };
          if (normalizedPair.leg1?.exchange && normalizedPair.leg1?.symbol && normalizedPair.leg2?.exchange && normalizedPair.leg2?.symbol) {
            normalized.push(normalizedPair);
          }
        });
        // 以一次性覆蓋，避免殘留舊資料
        dispatch(setMonitoringPairs(normalized as any));
        
        // 更新觸發統計
        normalized.forEach((pair: any) => {
          if (pair.totalTriggers !== undefined || pair.lastTriggered !== undefined) {
            dispatch(updatePairTriggerStats({
              pairId: pair.id,
              totalTriggers: pair.totalTriggers || 0,
              lastTriggered: pair.lastTriggered || null
            }));
          }
        });
        
        logger.info('已載入套利監控對', { count: normalized.length }, 'ArbitragePage');
      } else {
        // 如果後端沒有數據，嘗試從本地存儲載入
        const localPairs = storage.load(storage.keys.MONITORING_PAIRS, []);
        if (Array.isArray(localPairs) && localPairs.length > 0) {
          dispatch(setMonitoringPairs(localPairs as any));
          logger.info('從本地存儲載入套利監控對', { count: localPairs.length }, 'ArbitragePage');
        }
      }
    } catch (error) {
      logger.error('載入監控交易對失敗', error, 'ArbitragePage');
      // 如果後端載入失敗，嘗試從本地存儲載入
      try {
        const localPairs = storage.load(storage.keys.MONITORING_PAIRS, []);
        if (Array.isArray(localPairs) && localPairs.length > 0) {
          dispatch(setMonitoringPairs(localPairs as any));
          logger.info('從本地存儲載入套利監控對（後端失敗）', { count: localPairs.length }, 'ArbitragePage');
        }
      } catch (localError) {
        logger.error('從本地存儲載入失敗', localError, 'ArbitragePage');
      }
    }
  }, [dispatch]);

  // 載入執行歷史的函數，可以在組件級別調用
  const fetchExecutions = useCallback(async () => {
    try {
      console.log('🔍 開始載入套利執行歷史...');
      const res = await apiService.getArbitrageExecutions();
      console.log('📡 API 響應:', res);
      console.log('📡 API 響應類型:', typeof res);
      console.log('📡 res.data:', (res as any)?.data);
      
      // 處理兩種可能的響應格式
      let hist: any = {};
      let recent: any[] = [];
      
      // 格式1: { success: true, data: {...}, recent: [...] }
      if ((res as any)?.data && (res as any)?.recent) {
        hist = (res as any).data || {};
        recent = Array.isArray((res as any).recent) ? (res as any).recent : [];
      }
      // 格式2: { success: true, data: { recent: [...] } }
      else if ((res as any)?.data?.recent) {
        hist = (res as any).data || {};
        recent = Array.isArray((res as any).data.recent) ? (res as any).data.recent : [];
      }
      // 格式3: 直接返回 recent 數組
      else if (Array.isArray((res as any)?.recent)) {
        recent = (res as any).recent;
      }
      // 格式4: 直接返回 data.recent 數組
      else if (Array.isArray((res as any)?.data?.recent)) {
        recent = (res as any).data.recent;
      }
      // 格式5: 直接返回 data 數組
      else if (Array.isArray((res as any)?.data)) {
        recent = (res as any).data;
      }
      // 格式6: 直接返回 res 數組
      else if (Array.isArray(res)) {
        recent = res;
      }
      
      console.log('📊 解析後的歷史數據:', hist);
      console.log('📊 解析後的最近記錄:', recent);
      console.log('📊 最近記錄數量:', recent.length);
      
      if (recent.length > 0) {
        console.log('📊 第一條記錄:', recent[0]);
        console.log('📊 第一條記錄的 threshold:', recent[0]?.threshold);
      }
      
      // 將完整的 API 響應數據存儲到 Redux store 和 localStorage 中
      if (recent.length > 0) {
        // 將 API 響應的 recent 數據直接存儲到 Redux store
        // 注意：這裡直接存儲 API 響應的原始數據，不進行格式轉換
        dispatch(setRecentExecutions(recent as any));
        
        // 同時保存到 localStorage，以便重啟後仍可顯示
        try {
          localStorage.setItem('arbitrage_executions_history', JSON.stringify(recent));
          console.log('💾 執行記錄已保存到 localStorage');
        } catch (e) {
          console.error('保存到 localStorage 失敗:', e);
        }
        
        console.log('📦 已將 API 響應數據存儲到 Redux store，記錄數量:', recent.length);
        console.log('📦 第一條記錄的 threshold:', recent[0]?.threshold);
      }

      // 處理過濾後的記錄（用於聚合統計）
      const filteredRecords = recent;
      const agg: Record<string, any> = {};
      
      const processRecord = (r: any) => {
        const pid = r?.pairId;
        if (!pid) return;
        
        if (!agg[pid]) {
          agg[pid] = {
            total: 0,
            success: 0,
            lastTs: 0,
            records: []
          };
        }
        
        agg[pid].total += 1;
        if (r?.status === 'success') {
          agg[pid].success += 1;
        }
        agg[pid].lastTs = Math.max(agg[pid].lastTs, r?.ts || 0);
        agg[pid].records.push(r);
      };
      
      filteredRecords.forEach(processRecord);

      // 將聚合結果同步到觸發統計，讓進度顯示正確
      Object.entries(agg).forEach(([pairId, v]) => {
        dispatch(updatePairTriggerStats({
          pairId,
          totalTriggers: v.total,
          lastTriggered: v.lastTs || null
        }));
      });
      
      console.log('✅ 執行歷史載入完成');
    } catch (error) {
      console.error('❌ 載入執行歷史失敗:', error);
      logger.error('載入執行歷史失敗', error, 'ArbitragePage');
    }
  }, [dispatch]);

  // 處理 WebSocket 推送的價格更新
  useEffect(() => {
    // 計算「可套利」定義的差價：賣腿可成交價 − 買腿可成交價
    const computeProfitableSpread = (pairCfg: any, leg1Price: any, leg2Price: any) => {
      const leg1Side = pairCfg?.leg1?.side || 'buy';
      const leg2Side = pairCfg?.leg2?.side || 'sell';
      const leg1Exec = leg1Side === 'buy' ? leg1Price?.ask1?.price : leg1Price?.bid1?.price;
      const leg2Exec = leg2Side === 'buy' ? leg2Price?.ask1?.price : leg2Price?.bid1?.price;
      // 將兩腿拆成 buyLeg / sellLeg 後計算 sell − buy
      const buyExec = leg1Side === 'buy' ? leg1Exec : leg2Exec;
      const sellExec = leg1Side === 'sell' ? leg1Exec : leg2Exec;
      const spread = (typeof sellExec === 'number' && typeof buyExec === 'number') ? (sellExec - buyExec) : 0;
      const base = (typeof buyExec === 'number' && buyExec > 0) ? buyExec : 1;
      const spreadPct = (spread / base) * 100;
      return { spread, spreadPct };
    };

    const handleWebSocketMessage = (event: any) => {
      try {
        const payload = event.detail || event;
        const msgType = payload?.type;
        const body = payload?.data || payload; // 兼容 {type, data} 與直接傳物件
        
        if (msgType === 'priceUpdate' && body && (body.id || (body.pairConfig && body.pairConfig.id))) {
          const { id, leg1Price, leg2Price, threshold, pairConfig } = body;
          const { spread, spreadPct } = computeProfitableSpread(pairConfig, leg1Price, leg2Price);
          
          // 更新對應監控對的價格數據
          const opportunity = {
            id,
            // 使用後端提供的 pairConfig，若缺失則以安全預設構建，確保型別正確
            pairConfig: (() => {
              if (pairConfig && pairConfig.leg1 && pairConfig.leg2) {
                return {
                  id: pairConfig.id || id,
                  leg1: {
                    exchange: pairConfig.leg1?.exchange || leg1Price.exchange,
                    symbol: pairConfig.leg1?.symbol || leg1Price.symbol,
                    type: (pairConfig.leg1?.type as any) || 'spot',
                    side: (pairConfig.leg1?.side as any) || 'buy'
                  },
                  leg2: {
                    exchange: pairConfig.leg2?.exchange || leg2Price.exchange,
                    symbol: pairConfig.leg2?.symbol || leg2Price.symbol,
                    type: (pairConfig.leg2?.type as any) || 'spot',
                    side: (pairConfig.leg2?.side as any) || 'sell'
                  },
                  threshold: typeof pairConfig.threshold === 'number' ? pairConfig.threshold : threshold,
                  amount: 0,
                  enabled: true,
                  createdAt: Date.now(),
                  lastTriggered: null,
                  totalTriggers: 0
                } as any;
              }
              // 後端未提供 pairConfig 時的保底
              return {
                id,
                leg1: { exchange: leg1Price.exchange, symbol: leg1Price.symbol, type: 'spot', side: 'buy' },
                leg2: { exchange: leg2Price.exchange, symbol: leg2Price.symbol, type: 'spot', side: 'sell' },
                threshold: threshold,
                amount: 0,
                enabled: true,
                createdAt: Date.now(),
                lastTriggered: null,
                totalTriggers: 0
              } as any;
            })(),
            leg1Price,
            leg2Price,
            spread,
            spreadPercent: spreadPct,
            threshold,
            shouldTrigger: spreadPct >= threshold,
            timestamp: Date.now(),
            direction: 'leg1_buy_leg2_sell' as 'leg1_buy_leg2_sell' | 'leg1_sell_leg2_buy'
          };
          
          // 更新 Redux 狀態
          dispatch(updateOpportunity(opportunity));
          
          logger.info('收到價格更新', { id, spreadPercent: spreadPct, threshold }, 'ArbitragePage');
        }
        else if (msgType === 'arbitrageExecuted' && body) {
          // 處理套利執行完成消息
          console.log('🎯 收到套利執行完成消息:', body);
          
          // 延遲刷新執行記錄，確保後端數據已寫入
          setTimeout(() => {
            console.log('🔄 套利執行完成，開始刷新執行記錄...');
            fetchExecutions();
          }, 1000);
          
          // 顯示成功消息
          message.success(`套利執行完成！交易對: ${body.pairId}`);
          
          logger.info('套利執行完成', body, 'ArbitragePage');
        }
        else if (msgType === 'arbitrageFailed' && body) {
          // 處理套利執行失敗消息
          console.log('❌ 收到套利執行失敗消息:', body);
          
          // 延遲刷新執行記錄，確保後端數據已寫入
          setTimeout(() => {
            console.log('🔄 套利執行失敗，開始刷新執行記錄...');
            fetchExecutions();
          }, 1000);
          
          // 顯示錯誤消息
          message.error(`套利執行失敗: ${body.reason}`);
          
          logger.error('套利執行失敗', body, 'ArbitragePage');
        }
        else if (msgType === 'pairRemoved' && body) {
          // 處理監控對移除消息
          console.log('🗑️ 收到監控對移除消息:', body);
          
          // 從 Redux store 中移除對應的監控對
          dispatch(removeMonitoringPair(body.id));
          
          // 顯示信息消息
          message.info(`監控對已移除: ${body.id}`);
          
          logger.info('監控對已移除', body, 'ArbitragePage');
        }
      } catch (error) {
        logger.error('處理 WebSocket 消息失敗', error, 'ArbitragePage');
      }
    };

    // 監聽自定義事件
    window.addEventListener('priceUpdate', handleWebSocketMessage);
    window.addEventListener('arbitrageExecuted', handleWebSocketMessage);
    window.addEventListener('arbitrageFailed', handleWebSocketMessage);
    window.addEventListener('pairRemoved', handleWebSocketMessage);
    
    return () => {
      window.removeEventListener('priceUpdate', handleWebSocketMessage);
      window.removeEventListener('arbitrageExecuted', handleWebSocketMessage);
      window.removeEventListener('arbitrageFailed', handleWebSocketMessage);
      window.removeEventListener('pairRemoved', handleWebSocketMessage);
    };
  }, [dispatch, message, fetchExecutions]);


  // 頁面載入時從 localStorage 恢復執行記錄
  useEffect(() => {
    try {
      const saved = localStorage.getItem('arbitrage_executions_history');
      if (saved) {
        const parsedData = JSON.parse(saved);
        dispatch(setRecentExecutions(parsedData));
        console.log('✅ 從 localStorage 恢復執行記錄，數量:', parsedData.length);
      }
    } catch (e) {
      console.error('從 localStorage 恢復失敗:', e);
    }
  }, [dispatch]);

  // 監聽執行記錄變化，自動刷新界面
  useEffect(() => {
    console.log('🔄 執行記錄已更新，記錄數量:', recentExecutions?.length || 0);
    // 當執行記錄更新時，強制重新渲染
  }, [recentExecutions]);

  // 載入監控交易對和價格數據
  useEffect(() => {
    // 延遲載入，確保後端已啟動
    const loadDelay = setTimeout(async () => {
      try {
        await loadMonitoringPairs();
        setIsInitialized(true);
      } catch (error) {
        console.error('初始化失敗:', error);
        setIsInitialized(true); // 即使失敗也標記為已初始化，避免無限載入
      }
    }, 1000);
    
    // 加載交易所狀態（只有在有連接時才載入）
    if (isConnected) {
      (async () => {
        try {
          const res = await apiService.getExchangeStatus();
          if (res?.data) {
            dispatch(updateExchanges(res.data as any));
          }
        } catch (e) {
          // 忽略錯誤，保留預設 exchanges
        }
      })();
    }
    
    // 設置定時重新載入監控交易對（調整為每1秒，即時更新）
    const reloadInterval = setInterval(() => {
      if (isConnected) {
        loadMonitoringPairs();
      }
    }, 1 * 1000);  // 1秒刷新一次，即時更新
    
    // 簡化價格獲取邏輯，主要依賴WebSocket推送
    const fetchTickerData = async () => {
      try {
        const pairs = monitoringPairsRef.current || [];
        if (pairs.length === 0) {
          dispatch(setOpportunities([] as any));
          return;
        }
        
        // 以本頁面的節流 ref 為準，避免 Redux 閉包造成判斷過期
        for (const pair of pairs) {
          const lastAt = lastUpdateAtRef.current[pair.id] || 0;
          if (lastAt > Date.now() - 1000) {
            continue; // 1 秒內已更新過
          }
          
          try {
            if (!pair || !pair.leg1 || !pair.leg2) continue;
            
            const apiBase = getApiBaseUrl();
            // 根據交易對類型構建正確的API URL
            const getPriceUrl = (exchange: string, symbol: string, type: string) => {
              // Bybit 和 Binance 都需要傳遞 category 參數來區分現貨和合約
              if (exchange === 'bybit' || exchange === 'binance') {
                const category = type === 'linear' ? 'linear' : 'spot';
                return `${apiBase}/api/prices/${exchange}/${symbol}?category=${category}`;
              }
              return `${apiBase}/api/prices/${exchange}/${symbol}`;
            };
            
            const [leg1Res, leg2Res] = await Promise.allSettled([
              fetch(getPriceUrl(pair.leg1.exchange, pair.leg1.symbol, pair.leg1.type)),
              fetch(getPriceUrl(pair.leg2.exchange, pair.leg2.symbol, pair.leg2.type))
            ]);
            
            if (leg1Res.status === 'fulfilled' && leg2Res.status === 'fulfilled') {
              const leg1Data = await leg1Res.value.json();
              const leg2Data = await leg2Res.value.json();
              
              if (leg1Data.success && leg2Data.success) {
                const leg1Bid = Number(leg1Data.data.bids?.[0]?.[0] || 0);
                const leg1Ask = Number(leg1Data.data.asks?.[0]?.[0] || 0);
                const leg2Bid = Number(leg2Data.data.bids?.[0]?.[0] || 0);
                const leg2Ask = Number(leg2Data.data.asks?.[0]?.[0] || 0);
                
                if (leg1Bid > 0 && leg1Ask > 0 && leg2Bid > 0 && leg2Ask > 0) {
                  const leg1Side = pair.leg1.side || 'buy';
                  const leg2Side = pair.leg2.side || 'sell';
                const leg1ExecPrice = leg1Side === 'buy' ? leg1Ask : leg1Bid;
                const leg2ExecPrice = leg2Side === 'buy' ? leg2Ask : leg2Bid;
                // 以「可套利」定義：sell − buy
                const sellExec = leg1Side === 'sell' ? leg1ExecPrice : leg2ExecPrice;
                const buyExec  = leg1Side === 'buy'  ? leg1ExecPrice : leg2ExecPrice;
                const spread = sellExec - buyExec;
                const spreadPercent = buyExec > 0 ? (spread / buyExec) * 100 : 0;
                  
                  const opportunity = {
                    id: pair.id,
                    pairConfig: {
                      ...pair,
                      leg1: {
                        ...pair.leg1,
                        type: (String(pair.leg1.type) === 'future' ? 'linear' : pair.leg1.type) as 'linear' | 'inverse' | 'spot',
                        side: (pair.leg1.side as 'buy' | 'sell') || 'buy'
                      },
                      leg2: {
                        ...pair.leg2,
                        type: (String(pair.leg2.type) === 'future' ? 'linear' : pair.leg2.type) as 'linear' | 'inverse' | 'spot',
                        side: (pair.leg2.side as 'buy' | 'sell') || 'sell'
                      }
                    },
                    leg1Price: {
                      symbol: pair.leg1.symbol,
                      exchange: pair.leg1.exchange,
                      bid1: { price: leg1Bid, amount: 0 },
                      ask1: { price: leg1Ask, amount: 0 }
                    },
                    leg2Price: {
                      symbol: pair.leg2.symbol,
                      exchange: pair.leg2.exchange,
                      bid1: { price: leg2Bid, amount: 0 },
                      ask1: { price: leg2Ask, amount: 0 }
                    },
                    spread,
                    spreadPercent,
                    threshold: pair.threshold ?? 0.1,
                    shouldTrigger: spreadPercent >= (pair.threshold ?? 0.1),
                    timestamp: Date.now(),
                    direction: (leg1Side === 'sell' && leg2Side === 'buy') ? 'leg1_sell_leg2_buy' as 'leg1_buy_leg2_sell' | 'leg1_sell_leg2_buy' : 'leg1_buy_leg2_sell' as 'leg1_buy_leg2_sell' | 'leg1_sell_leg2_buy'
                  };
                  
                  dispatch(updateOpportunity(opportunity));
                  lastUpdateAtRef.current[pair.id] = Date.now();
                }
              }
            }
          } catch (error) {
            logger.error(`獲取交易對 ${pair.id} 價格失敗`, error, 'ArbitragePage');
          }
        }
      } catch (error) {
        logger.error('獲取實時價格失敗', error, 'ArbitragePage');
      }
    };


    // 載入成交均價統計
    const fetchAveragePrices = async () => {
      try {
        console.log('🔍 開始載入成交均價統計...');
        const res = await apiService.getAveragePrices();
        console.log('📡 均價響應:', res);
        console.log('📡 均價響應類型:', typeof res);
        console.log('📡 res.data:', (res as any)?.data);
        
        // 處理多種可能的響應格式
        let averageData: any = null;
        
        // 格式1: { success: true, data: {...} }
        if ((res as any)?.data && typeof (res as any).data === 'object' && !Array.isArray((res as any).data)) {
          averageData = (res as any).data;
          console.log('📦 使用格式1: 直接 data');
        }
        // 格式2: { data: { data: {...} } }
        else if ((res as any)?.data?.data) {
          averageData = (res as any).data.data;
          console.log('📦 使用格式2: data.data');
        }
        // 格式3: 直接是數據對象
        else if ((res as any)?.data && typeof (res as any).data === 'object') {
          averageData = (res as any).data;
          console.log('📦 使用格式3: 直接 data 對象');
        }
        
        if (averageData) {
          setAveragePrices(averageData);
          console.log('✅ 成交均價載入完成:', averageData);
          console.log('🔄 均價數據已更新，觸發重新渲染');
        } else {
          console.log('⚠️ 未找到有效的均價數據');
        }
      } catch (error: any) {
        // 只在非網絡錯誤時記錄錯誤，避免後端未啟動時的噪音日誌
        if (!error?.message?.includes('Network Error') && !error?.message?.includes('ERR_CONNECTION_REFUSED')) {
          console.error('❌ 載入成交均價失敗:', error);
          logger.error('載入成交均價失敗', error, 'ArbitragePage');
        } else {
          console.log('⏳ 後端服務未啟動，稍後重試...');
        }
      }
    };

    // 先立即抓一次，只有在有交易對時才獲取數據
    const pairs = monitoringPairsRef.current || [];
    if (pairs.length > 0) {
      fetchTickerData();
    }
    fetchExecutions();
    
    // 確保均價數據被載入
    console.log('🚀 開始載入均價數據...');
    fetchAveragePrices();

    // 定期獲取價格數據（只有在有交易對時才輪詢，間隔調整為1秒）
    const priceInterval = setInterval(() => {
      const pairs = monitoringPairsRef.current || [];
      // 即使 WS 未連線也啟用 HTTP 後備輪詢；
      // fetchTickerData 內部會檢查 1 秒內是否已有更新，避免浪費請求
      if (pairs.length > 0) {
        fetchTickerData();
      }
    }, 1 * 1000); // 調整為 1 秒，更即時

    // 定期更新均價數據（每5秒更新一次）
    const averagePriceInterval = setInterval(() => {
      console.log('⏰ 定期更新均價數據...');
      fetchAveragePrices();
    }, 5 * 1000); // 每5秒更新一次均價數據

    // 定期刷新執行記錄（每2秒更新一次，參考 TWAP 做法）
    const executionInterval = setInterval(() => {
      console.log('⏰ 定期刷新執行記錄...');
      fetchExecutions();
    }, 2 * 1000); // 每2秒更新一次執行記錄

    // 清理定時器
    return () => {
      clearTimeout(loadDelay);
      clearInterval(reloadInterval);
      clearInterval(priceInterval);
      clearInterval(averagePriceInterval);
      clearInterval(executionInterval);
    };
  }, [dispatch, loadMonitoringPairs, isConnected, fetchExecutions]);

  // 添加/更新監控交易對
  const handleSubmit = async (values: any) => {
    try {
      logger.info('開始提交監控交易對表單', values, 'ArbitragePage');
      setLoading(true);
      
      // 生成唯一 ID（如果沒有編輯中的交易對）
      const pairId = editingPair?.id || `pair_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      // 正規化交易所值：防止選單返回索引 '0' / '1'
      const normalizeExchange = (v: any): string => {
        if (v === '0') return 'bybit';
        if (v === '1') return 'binance';
        return (v || 'bybit').toString();
      };
      
      // 構建符合後端API的請求格式
      const qty = Number(values.qty || values.sliceQty || 0.01);
      const maxExecs = Number(values.orderCount || 1);
      
      // 🔍 調試 threshold 值
      logger.info('提交前的threshold值', {
        raw: values.threshold,
        type: typeof values.threshold,
        isNull: values.threshold === null,
        isUndefined: values.threshold === undefined,
        isEmpty: values.threshold === '',
        converted: Number(values.threshold ?? 0.1)
      }, 'ArbitragePage');
      
      // 類型轉換輔助函數
      const getLeg1Type = (): "spot" | "linear" | "inverse" => {
        const type = values.leg1_type === 'future' ? 'linear' : values.leg1_type;
        return (type || 'spot') as "spot" | "linear" | "inverse";
      };
      
      const getLeg2Type = (): "spot" | "linear" | "inverse" => {
        const type = values.leg2_type === 'future' ? 'linear' : values.leg2_type;
        return (type || 'spot') as "spot" | "linear" | "inverse";
      };
      
      const arbitrageConfig: CreatePairRequest = {
        pairId: pairId,
        leg1: {
          exchange: normalizeExchange(values.leg1_exchange) as "bybit" | "binance" | "okx" | "bitget",
          symbol: values.leg1_symbol || 'BTCUSDT',
          type: getLeg1Type(),
          side: (values.leg1_side || 'buy') as "buy" | "sell",
        },
        leg2: {
          exchange: normalizeExchange(values.leg2_exchange) as "bybit" | "binance" | "okx" | "bitget",
          symbol: values.leg2_symbol || 'BTCUSDT',
          type: getLeg2Type(),
          side: (values.leg2_side || 'sell') as "buy" | "sell",
        },
        threshold: Number(values.threshold ?? 0.1),
        qty: qty,
        enabled: values.enabled ?? true,
        maxExecs: maxExecs
      };

      // 同時構建前端顯示用的配置
      const config: MonitoringPairConfig = {
        id: pairId,
        leg1: arbitrageConfig.leg1,
        leg2: arbitrageConfig.leg2,
        threshold: arbitrageConfig.threshold,
        enabled: arbitrageConfig.enabled,
        executionMode: values.executionMode || 'threshold',
        qty: arbitrageConfig.qty,
        totalAmount: arbitrageConfig.qty * (arbitrageConfig.maxExecs || 1),
        amount: arbitrageConfig.qty
      };

      logger.info('構建的監控配置', config, 'ArbitragePage');

      let response;
      if (editingPair) {
        logger.info('更新現有監控交易對', editingPair.id, 'ArbitragePage');
        // 更新時使用套利引擎API
        const updateData = { 
          enabled: arbitrageConfig.enabled,
          threshold: arbitrageConfig.threshold,
          qty: arbitrageConfig.qty,
          maxExecs: arbitrageConfig.maxExecs
        };
        response = await apiService.updateArbitragePair(editingPair.id, updateData);
        logger.info('更新響應', response, 'ArbitragePage');
      } else {
        logger.info('添加新監控交易對', null, 'ArbitragePage');
        response = await apiService.upsertArbitragePair(arbitrageConfig);
        logger.info('添加響應', response, 'ArbitragePage');
      }

      if (response && (response as any).success !== false) {
        logger.info('操作成功，更新 Redux 狀態', response, 'ArbitragePage');
        
        // 構建完整的ArbitragePair對象
        const fullPair = {
          ...config,
          id: pairId, // 確保id是string類型
          amount: config.qty || 0, // 確保amount是number類型
          enabled: config.enabled ?? true, // 確保enabled是boolean類型
          maxExecs: arbitrageConfig.maxExecs || 1, // 添加必需的maxExecs屬性
          createdAt: Date.now(),
          lastTriggered: null,
          totalTriggers: 0
        };
        
        dispatch(addMonitoringPair(fullPair as any));
        
        message.success(editingPair ? '更新成功' : '添加成功');
        setIsModalVisible(false);
        form.resetFields();
        setEditingPair(null);
        setLeg1Exchange('bybit');
        setLeg2Exchange('bybit');
      }
    } catch (error: any) {
      logger.error('操作失敗', error, 'ArbitragePage');
      message.error(error.message || '操作失敗');
    } finally {
      setLoading(false);
    }
  };

  // 刪除監控交易對
  const handleDelete = (id: string) => {
    confirm({
      title: '確認刪除監控交易對',
      content: (
        <div>
          <p>確定要刪除這個監控交易對嗎？</p>
          <p style={{ color: '#666', fontSize: '12px' }}>
            ℹ️ 刪除後監控將停止，但執行記錄會保留並標記為「手動中止」
          </p>
        </div>
      ),
      icon: <ExclamationCircleOutlined />,
      okText: '確認刪除',
      cancelText: '取消',
      onOk: async () => {
        try {
          await apiService.removeArbitragePair(id);
          dispatch(removeMonitoringPair(id));
          message.success('監控交易對已刪除，執行記錄已保留');
        } catch (error: any) {
          message.error(error.message || '刪除失敗');
        }
      },
    });
  };

  // 切換啟用狀態
  const handleToggleEnabled = async (id: string, enabled: boolean) => {
    try {
      await apiService.updateArbitragePair(id, { enabled });
      dispatch(updateMonitoringPair({ id, updates: { enabled } }));
      message.success(enabled ? '已啟用' : '已停用');
    } catch (error: any) {
      message.error(error.message || '操作失敗');
    }
  };


  // 編輯監控交易對
  const handleEdit = (pair: any) => {
    // 安全檢查：確保 pair 和其屬性存在
    if (!pair || !pair.leg1 || !pair.leg2) {
      message.error('交易對數據不完整，無法編輯');
      return;
    }
    
    setEditingPair(pair);
    
    // 同步更新交易所狀態
    const leg1Exchange = pair.leg1?.exchange || 'bybit';
    const leg2Exchange = pair.leg2?.exchange || 'bybit';
    setLeg1Exchange(leg1Exchange);
    setLeg2Exchange(leg2Exchange);
    
    form.setFieldsValue({
      leg1_exchange: leg1Exchange,
      leg1_symbol: pair.leg1?.symbol || 'BTCUSDT',
      leg1_type: pair.leg1?.type || 'linear',
      leg1_side: pair.leg1?.side || 'buy',
      leg2_exchange: leg2Exchange,
      leg2_symbol: pair.leg2?.symbol || 'BTCUSDT',
      leg2_type: pair.leg2?.type || 'spot',
      leg2_side: pair.leg2?.side || 'sell',
      // 保留原本已設定的數值，避免開啟編輯時被預設值覆蓋
      qty: typeof pair.qty === 'number' ? pair.qty : (typeof pair.amount === 'number' ? pair.amount : undefined),
      orderCount: typeof pair.maxExecs === 'number' ? pair.maxExecs : (typeof pair.orderCount === 'number' ? pair.orderCount : undefined),
      threshold: typeof pair.threshold === 'number' ? pair.threshold : 0.1,
      amount: typeof pair.amount === 'number' ? pair.amount : undefined,
      enabled: pair.enabled ?? true,
      executionMode: pair.executionMode || 'threshold',
    });
    setIsModalVisible(true);
  };

  // 表格列定義
  const columns = [
    {
      title: 'Leg 1',
      key: 'leg1',
      width: 140,
      render: (record: any) => {
        try {
          // 防禦：若資料尚未齊全，不渲染內容以避免報錯
          if (!record || !record.leg1) {
            return <Text type="secondary">數據載入中...</Text>;
          }
          
          const leg1 = record.leg1;
          // 額外檢查 leg1 是否為有效對象
          if (!leg1 || typeof leg1 !== 'object') {
            return <Text type="secondary">數據不完整...</Text>;
          }
          
          // 獲取實時價格
          const opportunity = currentOpportunities.find(o => o.id === record.id);
          const leg1Price = opportunity?.leg1Price;
          const leg1Side = opportunity?.pairConfig?.leg1?.side || leg1?.side || 'buy';
          const price = leg1Side === 'buy' 
            ? leg1Price?.ask1?.price 
            : leg1Price?.bid1?.price;

          return (
            <div style={{ lineHeight: '1.2' }}>
              <div style={{ fontWeight: 'bold', fontSize: '13px' }}>
                {leg1?.symbol || 'N/A'}
              </div>
              <div style={{ fontSize: '11px', color: '#666', marginTop: '2px' }}>
                {exchanges[leg1?.exchange]?.name || leg1?.exchange || 'N/A'}
              </div>
              <div style={{ fontSize: '11px', color: '#666' }}>
                {leg1?.type === 'spot' ? '現貨' : 
                 leg1?.type === 'linear' ? '線性合約' : 
                 leg1?.type === 'inverse' ? '反向合約' : 
                 leg1?.type === 'future' ? '線性合約' : leg1?.type || 'N/A'} · 
                {leg1?.side === 'sell' ? '賣出' : '買入'}
              </div>
              {price && (
                <div style={{ 
                  color: leg1Side === 'buy' ? '#52c41a' : '#ff4d4f',
                  fontWeight: 700,
                  fontSize: '14px',
                  marginTop: '6px',
                  padding: '2px 4px',
                  backgroundColor: leg1Side === 'buy' ? '#f6ffed' : '#fff2f0',
                  borderRadius: '3px',
                  border: `1px solid ${leg1Side === 'buy' ? '#b7eb8f' : '#ffccc7'}`,
                  textAlign: 'center'
                }}>
                  {typeof price === 'number' ? price.toFixed(2) : '-'}
                </div>
              )}
            </div>
          );
        } catch (error) {
          console.error('Leg1 render error:', error, record);
          return <Text type="secondary">渲染錯誤</Text>;
        }
      },
    },
    {
      title: 'Leg 2',
      key: 'leg2',
      width: 140,
      render: (record: any) => {
        try {
          // 防禦：若資料尚未齊全，不渲染內容以避免報錯
          if (!record || !record.leg2) {
            return <Text type="secondary">數據載入中...</Text>;
          }
          
          const leg2 = record.leg2;
          // 額外檢查 leg2 是否為有效對象
          if (!leg2 || typeof leg2 !== 'object') {
            return <Text type="secondary">數據不完整...</Text>;
          }
          
          // 獲取實時價格
          const opportunity = currentOpportunities.find(o => o.id === record.id);
          const leg2Price = opportunity?.leg2Price;
          const leg2Side = opportunity?.pairConfig?.leg2?.side || leg2?.side || 'sell';
          const price = leg2Side === 'buy' 
            ? leg2Price?.ask1?.price 
            : leg2Price?.bid1?.price;

          return (
            <div style={{ lineHeight: '1.2' }}>
              <div style={{ fontWeight: 'bold', fontSize: '13px' }}>
                {leg2?.symbol || 'N/A'}
              </div>
              <div style={{ fontSize: '11px', color: '#666', marginTop: '2px' }}>
                {exchanges[leg2?.exchange]?.name || leg2?.exchange || 'N/A'}
              </div>
              <div style={{ fontSize: '11px', color: '#666' }}>
                {leg2?.type === 'spot' ? '現貨' : 
                 leg2?.type === 'linear' ? '線性合約' : 
                 leg2?.type === 'inverse' ? '反向合約' : 
                 leg2?.type === 'future' ? '線性合約' : leg2?.type || 'N/A'} · 
                {leg2?.side === 'sell' ? '賣出' : '買入'}
              </div>
              {price && (
                <div style={{ 
                  color: leg2Side === 'buy' ? '#52c41a' : '#ff4d4f',
                  fontWeight: 700,
                  fontSize: '14px',
                  marginTop: '6px',
                  padding: '2px 4px',
                  backgroundColor: leg2Side === 'buy' ? '#f6ffed' : '#fff2f0',
                  borderRadius: '3px',
                  border: `1px solid ${leg2Side === 'buy' ? '#b7eb8f' : '#ffccc7'}`,
                  textAlign: 'center'
                }}>
                  {typeof price === 'number' ? price.toFixed(2) : '-'}
                </div>
              )}
            </div>
          );
        } catch (error) {
          console.error('Leg2 render error:', error, record);
          return <Text type="secondary">渲染錯誤</Text>;
        }
      },
    },
    {
      title: '當前價差',
      key: 'currentSpread',
      width: 100,
      align: 'center' as const,
      render: (record: any) => {
        const opportunity = currentOpportunities.find(o => o.id === record.id);
        if (!opportunity || typeof opportunity.spreadPercent !== 'number') {
          return <Text type="secondary">-</Text>;
        }
        
        const isPositive = opportunity.spreadPercent > 0;
        const colorClass = isPositive ? 'price-positive' : 'price-negative';
        
        return (
          <div style={{ textAlign: 'center', lineHeight: '1.2' }}>
            <div className={colorClass} style={{ 
              fontWeight: 'bold', 
              fontSize: '14px',
              padding: '2px 4px',
              backgroundColor: isPositive ? '#f6ffed' : '#fff2f0',
              borderRadius: '3px',
              border: `1px solid ${isPositive ? '#b7eb8f' : '#ffccc7'}`,
              marginBottom: '4px'
            }}>
              {opportunity.spreadPercent.toFixed(2)}%
            </div>
            <div style={{ 
              fontSize: '11px', 
              color: '#666',
              fontWeight: '500'
            }}>
              {opportunity.spread ? opportunity.spread.toFixed(2) : '-'}
            </div>
          </div>
        );
      },
    },
    {
      title: '觸發閾值',
      dataIndex: 'threshold',
      key: 'threshold',
      width: 90,
      align: 'center' as const,
      render: (threshold: number) => (
        <div style={{ 
          textAlign: 'center', 
          fontWeight: 'bold', 
          fontSize: '14px',
          padding: '2px 4px',
          backgroundColor: '#f0f2ff',
          borderRadius: '3px',
          border: '1px solid #d9d9ff',
          color: '#1890ff'
        }}>
          {typeof threshold === 'number' ? `${threshold}%` : '-'}
        </div>
      ),
    },
    {
      title: '交易數量',
      key: 'amount',
      width: 100,
      align: 'center' as const,
      render: (record: ArbitragePairExtended) => {
        // 安全檢查：確保 record 存在
        if (!record) {
          return <Text type="secondary">-</Text>;
        }
        
        // 顯示 base 幣別（如 BTCUSDT -> BTC）
        const symbol = record?.leg1?.symbol || record?.leg2?.symbol || 'BTCUSDT';
        const base = getBaseCurrencyFromSymbol(symbol);
        const amount = record?.amount || record?.qty || 0;
        return (
          <div style={{ 
            textAlign: 'center', 
            fontWeight: 'bold', 
            fontSize: '14px',
            padding: '2px 4px',
            backgroundColor: '#f0f9ff',
            borderRadius: '3px',
            border: '1px solid #bae6fd',
            color: '#0369a1'
          }}>
            {formatAmountWithCurrency(amount, base)}
          </div>
        );
      },
    },
    {
      title: '執行模式',
      dataIndex: 'executionMode',
      key: 'executionMode',
      width: 110,
      align: 'center' as const,
      render: (mode: string) => {
        const modeConfig = {
          market: { text: '市價單', color: 'orange', icon: '⚡' },
          threshold: { text: '等待差價', color: 'blue', icon: '⏳' }
        };
        const config = modeConfig[mode as keyof typeof modeConfig] || modeConfig.threshold;
        
        return (
          <div style={{ textAlign: 'center' }}>
            <Tag 
              color={config.color} 
              style={{ 
                fontSize: '12px',
                fontWeight: '500',
                padding: '2px 8px',
                borderRadius: '4px'
              }}
            >
              {config.icon} {config.text}
            </Tag>
          </div>
        );
      },
    },
    {
      title: '狀態',
      key: 'status',
      width: 120,
      align: 'center' as const,
      render: (record: any) => {
        const opportunity = currentOpportunities.find(o => o.id === record.id);
        const isTriggerable = opportunity?.shouldTrigger;
        
        return (
          <div style={{ textAlign: 'center', lineHeight: '1.2' }}>
            <Switch
              checked={record.enabled}
              size="small"
              onChange={(checked) => handleToggleEnabled(record.id, checked)}
              style={{ marginBottom: '6px' }}
            />
            <div>
              <Tag 
                color={isTriggerable ? 'success' : record.enabled ? 'processing' : 'default'}
                style={{ 
                  fontSize: '11px',
                  fontWeight: '500',
                  padding: '2px 6px',
                  borderRadius: '4px'
                }}
              >
                {isTriggerable ? '可觸發' : record.enabled ? '監控中' : '已停用'}
              </Tag>
            </div>
          </div>
        );
      },
    },
    {
      title: '統計',
      key: 'stats',
      width: 100,
      align: 'center' as const,
      render: (record: any) => (
        <div style={{ textAlign: 'center', lineHeight: '1.2' }}>
          <div style={{ 
            fontSize: '13px', 
            fontWeight: 'bold',
            padding: '2px 4px',
            backgroundColor: '#f0f9ff',
            borderRadius: '3px',
            border: '1px solid #bae6fd',
            color: '#0369a1',
            marginBottom: '4px'
          }}>
            觸發: {record.totalTriggers}次
          </div>
          <div style={{ 
            fontSize: '10px', 
            color: '#666',
            fontWeight: '500'
          }}>
            {record.lastTriggered 
              ? new Date(record.lastTriggered).toLocaleDateString()
              : '未觸發'
            }
          </div>
        </div>
      ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 120,
      align: 'center' as const,
      render: (record: any) => {
        return (
          <div style={{ display: 'flex', justifyContent: 'center', gap: '4px' }}>
            <Tooltip title={record.enabled ? "暫停監控" : "啟用監控"}>
              <Button
                size="small"
                type={record.enabled ? "default" : "primary"}
                icon={record.enabled ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
                onClick={() => handleToggleEnabled(record.id, !record.enabled)}
                style={{
                  color: record.enabled ? '#ff4d4f' : '#52c41a',
                  borderColor: record.enabled ? '#ff4d4f' : '#52c41a'
                }}
              >
                {record.enabled ? '暫停' : '啟用'}
              </Button>
            </Tooltip>
            <Tooltip title="編輯配置">
              <Button
                size="small"
                icon={<SettingOutlined />}
                onClick={() => handleEdit(record)}
              />
            </Tooltip>
            <Tooltip title="刪除">
              <Button
                size="small"
                danger
                icon={<DeleteOutlined />}
                onClick={() => handleDelete(record.id)}
              />
            </Tooltip>
          </div>
        );
      },
    },
  ];

  return (
    <div style={{ background: '#0b0e11', minHeight: '100vh' }}>
      <style>
        {`
          @keyframes pulse {
            0% {
              box-shadow: 0 0 0 0 rgba(82, 196, 26, 0.7);
            }
            70% {
              box-shadow: 0 0 0 10px rgba(82, 196, 26, 0);
            }
            100% {
              box-shadow: 0 0 0 0 rgba(82, 196, 26, 0);
            }
          }
          
          .price-positive {
            color: #52c41a !important;
            font-weight: 600;
          }
          
          .price-negative {
            color: #ff4d4f !important;
            font-weight: 600;
          }
        `}
      </style>
      {/* 頁面標題 */}
      <div style={{ marginBottom: 24 }}>
        <Space align="center" style={{ width: '100%', justifyContent: 'space-between' }}>
          <Title level={2} style={{ margin: 0 }}>
            🔄 雙腿套利交易
          </Title>
          <Space>
            <Button 
              type="primary" 
              icon={<PlusOutlined />}
              onClick={() => {
                setEditingPair(null);
                form.resetFields();
                setLeg1Exchange('bybit');
                setLeg2Exchange('bybit');
                setIsModalVisible(true);
              }}
              disabled={!isConnected}
            >
              添加監控對
            </Button>
          </Space>
        </Space>
      </div>

      {/* 連接狀態提示 */}
      {!isConnected && (
        <Alert
          message="系統未連接"
          description="請檢查網路連接，無法進行交易操作"
          type="warning"
          showIcon
          style={{ marginBottom: 24 }}
        />
      )}




      {/* 監控交易對列表 */}
      <Card title="📊 監控交易對" className="card-shadow">
        {!isInitialized ? (
          <div style={{ textAlign: 'center', padding: '40px' }}>
            <Text type="secondary">正在初始化數據...</Text>
          </div>
        ) : (
          <Table
            columns={columns}
            dataSource={(monitoringPairs || []).filter(pair => {
              // 嚴格的數據驗證
              return pair && 
                     typeof pair === 'object' && 
                     pair.id && 
                     pair.leg1 && 
                     typeof pair.leg1 === 'object' && 
                     pair.leg1.exchange && 
                     pair.leg1.symbol && 
                     pair.leg2 && 
                     typeof pair.leg2 === 'object' && 
                     pair.leg2.exchange && 
                     pair.leg2.symbol;
            }).map(pair => ({
              ...pair,
              // 確保 leg1 和 leg2 是有效對象
              leg1: pair.leg1 && typeof pair.leg1 === 'object' ? pair.leg1 : null,
              leg2: pair.leg2 && typeof pair.leg2 === 'object' ? pair.leg2 : null
            }))}
            rowKey={(record: any) => {
              try {
                if (!record || typeof record !== 'object') {
                  return `fallback_${Math.random().toString(36).substr(2, 9)}`;
                }
                return record.id || record.pairId || `pair_${record.createdAt || Date.now()}` || `fallback_${Math.random().toString(36).substr(2, 9)}`;
              } catch (error) {
                console.error('rowKey error:', error, record);
                return `error_${Math.random().toString(36).substr(2, 9)}`;
              }
            }}
            loading={loading}
            scroll={{ x: 1000 }}
            locale={{ emptyText: '暫無監控交易對，點擊上方按鈕添加' }}
          />
        )}
      </Card>

      {/* 最近執行記錄 */}
      <Card
        title={<Space><span>🕘 最近執行記錄</span><Tag color="blue">最多顯示20筆</Tag></Space>}
        style={{ marginTop: 16 }}
        extra={
          <Space>
            <Button size="small" onClick={() => fetchExecutions()}>刷新執行記錄</Button>
          </Space>
        }
        className="card-shadow"
      >
        <Table
          size="small"
          rowKey={(r: any) => {
            try {
              if (!r || typeof r !== 'object') {
                return `fallback_${Math.random().toString(36).substr(2, 9)}`;
              }
              return r?.pairId || r?.id || String(r?.timestamp) || `fallback_${Math.random().toString(36).substr(2, 9)}`;
            } catch (error) {
              console.error('rowKey error:', error, r);
              return `error_${Math.random().toString(36).substr(2, 9)}`;
            }
          }}
          dataSource={
            (() => {
              // 直接從 API 獲取的 recent 數據進行聚合
              const agg: Record<string, any> = {};
              
              // 從 API 響應中獲取 recent 數據
              let recentData: any[] = [];
              
              // 優先使用 Redux store 中的 recentExecutions，如果沒有則使用 API 響應
              if (Array.isArray(recentExecutions) && recentExecutions.length > 0) {
                recentData = recentExecutions;
                console.log('📊 使用 Redux store 中的 recentExecutions，記錄數量:', recentData.length);
              } else if ((recentExecutions as any)?.data && (recentExecutions as any)?.recent) {
                recentData = Array.isArray((recentExecutions as any).recent) ? (recentExecutions as any).recent : [];
                console.log('📊 使用 API 響應格式1，記錄數量:', recentData.length);
              } else if ((recentExecutions as any)?.data?.recent) {
                recentData = Array.isArray((recentExecutions as any).data.recent) ? (recentExecutions as any).data.recent : [];
                console.log('📊 使用 API 響應格式2，記錄數量:', recentData.length);
              } else {
                console.log('📊 沒有找到有效的 recent 數據');
              }
              
              console.log('📊 使用 recent 數據進行聚合，記錄數量:', recentData.length);
              console.log('📊 recent 數據內容:', recentData);
              
              // 直接檢查第一條記錄的結構
              if (recentData.length > 0) {
                console.log('🔍 第一條記錄的完整結構:', recentData[0]);
                console.log('🔍 第一條記錄的 threshold 字段:', recentData[0]?.threshold);
              }
              
              // 調試：檢查是否包含 threshold 字段
              console.log('🔍 檢查所有記錄的 threshold 字段:');
              recentData.forEach((r: any, index: number) => {
                console.log(`記錄 ${index}: pairId=${r?.pairId}, threshold=${r?.threshold}`);
                if (r?.pairId === 'pair_1760610352045_428cz24wp') {
                  console.log('🔍 找到目標策略記錄:', r);
                  console.log('🔍 觸發閾值:', r?.threshold);
                }
              });
              
              // 調試：檢查每個記錄的策略ID
              const pidCounts: Record<string, number> = {};
              recentData.forEach((r: any, index: number) => {
                const pid = r?.pairId || r?.opportunity?.id;
                if (pid) {
                  pidCounts[pid] = (pidCounts[pid] || 0) + 1;
                  console.log(`📋 記錄 ${index}: pid=${pid}, success=${r?.success}, amount=${r?.amount}, maxExecs=${r?.maxExecs}`);
                }
              });
              console.log('📊 每個策略ID的記錄數量:', pidCounts);
              
              // 按策略ID分組（使用前端格式的數據）
              const strategyGroups: Record<string, any[]> = {};
              recentData.forEach((r: any) => {
                const pid = r?.pairId || r?.opportunity?.id;
                if (!pid) return;
                
                if (!strategyGroups[pid]) {
                  strategyGroups[pid] = [];
                }
                strategyGroups[pid].push(r);
              });
              
              // 處理每個策略組
              Object.entries(strategyGroups).forEach(([pid, records]) => {
                // 按時間戳排序
                records.sort((a, b) => (a?.timestamp || 0) - (b?.timestamp || 0));
                
                // 初始化策略數據
                const firstRecord = records[0];
                
                // 調試：檢查觸發閾值
                console.log('🔍 策略', pid, '的觸發閾值調試:', {
                  firstRecordThreshold: firstRecord?.threshold,
                  firstRecord: firstRecord,
                  records: records
                });
                
                // 從執行記錄中獲取正確的 maxExecs（優先使用記錄中的值，因為它反映實際執行時的配置）
                const monitoringPair = (monitoringPairsRef.current || []).find(p => p.id === pid);
                // 優先使用記錄中的 maxExecs，取所有記錄中的最大值（因為失敗記錄可能有錯誤的值）
                const allMaxExecs = records.map(r => r?.maxExecs).filter(n => typeof n === 'number' && n > 0);
                const recordMaxExecs = allMaxExecs.length > 0 ? Math.max(...allMaxExecs) : null;
                const correctMaxExecs = recordMaxExecs || monitoringPair?.maxExecs || 1;
                
                agg[pid] = {
                  pairId: pid,
                  timestamp: firstRecord?.ts || null,
                  leg1Symbol: firstRecord?.leg1?.symbol || monitoringPair?.leg1?.symbol || '-',
                  leg2Symbol: firstRecord?.leg2?.symbol || monitoringPair?.leg2?.symbol || '-',
                  leg1Exchange: firstRecord?.leg1?.exchange || monitoringPair?.leg1?.exchange || 'N/A',
                  leg2Exchange: firstRecord?.leg2?.exchange || monitoringPair?.leg2?.exchange || 'N/A',
                  leg1Type: firstRecord?.leg1?.type || monitoringPair?.leg1?.type || 'spot',
                  leg2Type: firstRecord?.leg2?.type || monitoringPair?.leg2?.type || 'spot',
                  leg1Side: firstRecord?.leg1?.side || monitoringPair?.leg1?.side || 'buy',
                  leg2Side: firstRecord?.leg2?.side || monitoringPair?.leg2?.side || 'sell',
                  threshold: (() => {
                    // 優先從記錄中查找 threshold，如果沒有則從監控對配置中獲取
                    const recordWithThreshold = records.find(r => typeof r?.threshold === 'number');
                    const threshold = recordWithThreshold?.threshold || monitoringPair?.threshold || 0;
                    console.log('🎯 策略', pid, '最終觸發閾值:', threshold, {
                      recordWithThreshold: recordWithThreshold?.threshold,
                      monitoringPairThreshold: monitoringPair?.threshold,
                      firstRecordThreshold: firstRecord?.threshold,
                      allRecordsThresholds: records.map(r => r?.threshold)
                    });
                    return threshold;
                  })(),
                  totalQty: 0,
                  successCount: 0,
                  totalSpreadPercent: 0,
                  avgSpreadPercent: 0,
                  totalTriggers: 0,
                  maxExecs: correctMaxExecs,
                  enabled: false,
                  completed: false,
                  status: firstRecord?.status || 'unknown'
                };
                
                // 去重處理：使用 Set 來追蹤已處理的記錄
                const processedRecords = new Set<string>();
                let uniqueSuccessCount = 0;
                
                // 累加所有成功記錄（去重）
                records.forEach((r: any, index: number) => {
                  const recordSuccess = r?.status === 'success';
                  const qty = r?.qty || 0;  // 直接從 API 響應中獲取 qty
                  const spreadPercent = r?.spreadPercent || 0;  // 直接從 API 響應中獲取 spreadPercent
                  
                  // 創建記錄的唯一標識符（基於時間戳、數量和訂單ID）
                  const recordKey = `${r?.ts || 0}_${qty}_${recordSuccess}_${r?.leg1?.orderId || ''}_${r?.leg2?.orderId || ''}`;
                  
                  console.log(`📊 處理策略 ${pid} 記錄 ${index}: success=${recordSuccess}, qty=${qty}, maxExecs=${agg[pid].maxExecs}, recordKey=${recordKey}`);
                  
                  // 只處理未重複的成功記錄
                  if (recordSuccess && !processedRecords.has(recordKey)) {
                    processedRecords.add(recordKey);
                    uniqueSuccessCount += 1;
                    agg[pid].totalQty += qty;
                    
                    // 重新計算正確的價差，使用實際成交價格
                    const leg1Price = r?.leg1?.price;
                    const leg2Price = r?.leg2?.price;
                    const leg1Side = r?.leg1?.side;
                    const leg2Side = r?.leg2?.side;
                    
                    let correctSpreadPercent = spreadPercent; // 預設使用原始值
                    
                    if (leg1Price && leg2Price && leg1Side && leg2Side) {
                      if (leg1Side === "sell" && leg2Side === "buy") {
                        // -A+B：A腿賣出，B腿買入
                        const spread = leg1Price - leg2Price;
                        correctSpreadPercent = (spread / (leg1Price + leg2Price)) * 2 * 100;
                      } else if (leg1Side === "buy" && leg2Side === "sell") {
                        // +A-B：A腿買入，B腿賣出
                        const spread = leg2Price - leg1Price;
                        correctSpreadPercent = (spread / (leg2Price + leg1Price)) * 2 * 100;
                      }
                    }
                    
                    agg[pid].totalSpreadPercent += correctSpreadPercent;
                    console.log(`📊 策略 ${pid} 唯一成功記錄累加: uniqueSuccessCount=${uniqueSuccessCount}, totalQty=${agg[pid].totalQty}, originalSpreadPercent=${spreadPercent}, correctSpreadPercent=${correctSpreadPercent}`);
                  }
                  
                  // 更新時間戳和totalTriggers
                  agg[pid].totalTriggers = Math.max(agg[pid].totalTriggers, r?.totalTriggers || 0);
                  agg[pid].timestamp = Math.max(agg[pid].timestamp || 0, r?.ts || 0);
                });
                
                // 設置去重後的成功次數
                agg[pid].successCount = uniqueSuccessCount;
                
                // 修復浮點數精度問題
                agg[pid].totalQty = Math.round(agg[pid].totalQty * 100) / 100;
                
                console.log(`📊 聚合策略 ${pid}: successCount=${agg[pid].successCount}, totalQty=${agg[pid].totalQty}, totalTriggers=${agg[pid].totalTriggers}, maxExecs=${agg[pid].maxExecs}`);
              });
              
              // 計算平均價差和完成狀態
              Object.values(agg).forEach((row: any) => {
                // 計算平均價差
                if (row.successCount > 0) {
                  row.avgSpreadPercent = row.totalSpreadPercent / row.successCount;
                }
                
                // 套利交易是雙腿交易，但總數量不需要除以2，因為每條腿的數量是相同的
                // row.totalQty = row.totalQty / 2; // 移除錯誤的除以2邏輯
                
                // 修復浮點數精度問題
                row.totalQty = Math.round(row.totalQty * 100) / 100;
                row.avgSpreadPercent = Math.round(row.avgSpreadPercent * 10000) / 10000; // 保留4位小數，顯示時格式化為2位
                
                // 根據 maxExecs 和 successCount 判斷是否完成
                if (typeof row.maxExecs === 'number' && row.maxExecs > 0) {
                  row.completed = row.successCount >= row.maxExecs;
                } else {
                  row.completed = row.successCount > 0;
                }
              });
              
              const result = Object.values(agg).sort((a: any, b: any) => b.timestamp - a.timestamp);
              console.log('✅ 聚合完成，最終結果:', result.map(r => ({
                pairId: r.pairId,
                successCount: r.successCount,
                totalQty: r.totalQty,
                totalTriggers: r.totalTriggers,
                maxExecs: r.maxExecs
              })));
              
              // 調試均價數據匹配
              console.log('🔍 當前均價數據:', averagePrices);
              console.log('🔍 執行記錄 pairId 列表:', result.map(r => r.pairId));
              
              return result;
            })()
          }
          pagination={{ pageSize: 10 }}
          locale={{ emptyText: '暫無執行記錄' }}
          columns={[
            {
              title: '時間',
              dataIndex: 'timestamp',
              render: (ts: number) => ts ? new Date(ts).toLocaleString('zh-TW', {
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: false
              }) : '-',
              width: 140
            },
            {
              title: '策略ID',
              key: 'strategyId',
              render: (_: any, r: any) => (
                <Tooltip title={r?.pairId}>
                  <Text code style={{ fontSize: '11px', background: '#f5f5f5', padding: '2px 6px', borderRadius: '4px' }}>
                    {r?.pairId ? r.pairId.slice(-8) : '-'}
                  </Text>
                </Tooltip>
              ),
              width: 100
            },
            {
              title: '交易對',
              key: 'pair',
              render: (_: any, r: any) => {
                const leg1Sym = r?.leg1Symbol || '-';
                const leg2Sym = r?.leg2Symbol || '-';
                const leg1Type = r?.leg1Type || 'spot';
                const leg2Type = r?.leg2Type || 'spot';
                const leg1Exchange = r?.leg1Exchange || 'Bybit';
                const leg2Exchange = r?.leg2Exchange || 'Bybit';
                const typeSuffix = (t: string) => (String(t || '').toLowerCase() === 'linear' || String(t || '').toLowerCase() === 'future') ? '.P' : '';
                
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {/* Leg1 */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <Text type="secondary" style={{ fontSize: '11px' }}>Leg1:</Text>
                      <Text strong style={{ fontSize: '12px', color: '#52c41a' }}>
                        {leg1Exchange} {leg1Sym}{typeSuffix(leg1Type)}
                      </Text>
                    </div>
                    
                    {/* Leg2 */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <Text type="secondary" style={{ fontSize: '11px' }}>Leg2:</Text>
                      <Text strong style={{ fontSize: '12px', color: '#ff4d4f' }}>
                        {leg2Exchange} {leg2Sym}{typeSuffix(leg2Type)}
                      </Text>
                    </div>
                  </div>
                );
              }
            },
            {
              title: '數量',
              key: 'qty',
              render: (_: any, r: any) => {
                const totalQty = r?.totalQty;
                const successCount = r?.successCount || 0;
                const sliceQty = r?.sliceQty || 0;
                const symbol = r?.leg1Symbol || 'BTCUSDT';
                
                if (typeof totalQty === 'number' && totalQty > 0) {
                  // 套利交易是雙腿交易，數量已經在聚合時除以2了
                  // 修復浮點數精度問題，保留2位小數
                  const displayQty = Math.round(totalQty * 100) / 100;
                  const displaySliceQty = Math.round(sliceQty * 100) / 100;
                  
                  return (
                    <div>
                      <Text strong style={{ fontSize: '13px' }}>
                        {displayQty} {symbol}
                      </Text>
                      {successCount > 1 && sliceQty > 0 && (
                        <div>
                          <Text type="secondary" style={{ fontSize: '11px' }}>
                            單次: {displaySliceQty} {symbol}
                          </Text>
                        </div>
                      )}
                    </div>
                  );
                }
                return <Text type="secondary">-</Text>;
              }
            },
            {
              title: '平均價差',
              key: 'avgSpread',
              render: (_: any, r: any) => {
                const avgSpreadPercent = r?.avgSpreadPercent;
                const successCount = r?.successCount || 0;
                
                if (successCount === 0) {
                  return <Text type="secondary">無成交</Text>;
                }
                
                if (typeof avgSpreadPercent === 'number') {
                  // 修復浮點數精度問題，保留2位小數
                  const displaySpread = Math.round(avgSpreadPercent * 100) / 100;
                  
                  return (
                    <div style={{ textAlign: 'center' }}>
                      <Text 
                        strong 
                        className={displaySpread > 0 ? 'price-positive' : displaySpread < 0 ? 'price-negative' : ''}
                        style={{ fontSize: '14px', display: 'block' }}
                      >
                        {displaySpread.toFixed(2)}%
                      </Text>
                      {successCount > 1 && (
                        <Text type="secondary" style={{ fontSize: '10px' }}>
                          平均{successCount}次
                        </Text>
                      )}
                    </div>
                  );
                }
                
                return <Text type="secondary">-</Text>;
              }
            },
            {
              title: '均價',
              key: 'avgPrice',
              render: (_: any, r: any) => {
                const pairId = r?.pairId;
                const avgData = averagePrices[pairId];
                
                // 調試信息
                console.log('🔍 均價渲染調試:', {
                  pairId,
                  avgData,
                  allAveragePrices: Object.keys(averagePrices)
                });
                
                if (!avgData) {
                  return <Text type="secondary">-</Text>;
                }
                
                return (
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ marginBottom: 4 }}>
                      <Text type="secondary" style={{ fontSize: '10px' }}>Leg1: </Text>
                      <Text strong style={{ fontSize: '12px' }}>
                        {avgData.leg1AvgPrice ? avgData.leg1AvgPrice.toFixed(2) : '-'}
                      </Text>
                    </div>
                    <div>
                      <Text type="secondary" style={{ fontSize: '10px' }}>Leg2: </Text>
                      <Text strong style={{ fontSize: '12px' }}>
                        {avgData.leg2AvgPrice ? avgData.leg2AvgPrice.toFixed(2) : '-'}
                      </Text>
                    </div>
                  </div>
                );
              }
            },
              {
                title: '執行參數',
                key: 'params',
                render: (_: any, r: any) => {
                  // 從策略配置中獲取觸發閾值
                  const threshold = r?.threshold;
                  const maxExecs = r?.maxExecs;
                  
                  if (typeof threshold === 'number') {
                    // 根據threshold的正負來判斷套利方向
                    // threshold > 0 表示正向套利（低買高賣）
                    // threshold < 0 表示反向套利（高賣低買）
                    const isNegative = threshold < 0;
                    const color = isNegative ? '#ff4d4f' : '#52c41a';
                    const icon = isNegative ? '🔴' : '🟢';
                    
                    return (
                      <div style={{ textAlign: 'center' }}>
                        <Text 
                          strong 
                          style={{ 
                            fontSize: '13px',
                            color: color
                          }}
                        >
                          {icon} {threshold.toFixed(2)}%
                        </Text>
                        <div style={{ fontSize: '10px', color: '#666', marginTop: '2px' }}>
                          {isNegative ? '反向套利' : '正向套利'}
                        </div>
                        {typeof maxExecs === 'number' && maxExecs > 1 && (
                          <div style={{ fontSize: '9px', color: '#999', marginTop: '1px' }}>
                            最多{maxExecs}次
                          </div>
                        )}
                      </div>
                    );
                  }
                  
                  return (
                    <Text type="secondary" style={{ fontSize: '11px' }}>
                      未設定
                    </Text>
                  );
                }
              },
            {
              title: '執行次數',
              key: 'executions',
              render: (_: any, r: any) => {
                const successCount = r?.successCount || 0;
                const maxExecs = typeof r?.maxExecs === 'number' ? r.maxExecs : 1;
                const totalExecutions = r?.totalExecutions || 0;
                
                return (
                  <div>
                    <Text strong style={{ 
                      color: successCount > 0 ? '#52c41a' : undefined,
                      fontSize: '13px'
                    }}>
                      {successCount}/{maxExecs}
                    </Text>
                    {totalExecutions > 0 && (
                      <div>
                        <Text type="secondary" style={{ fontSize: '10px' }}>
                          ({totalExecutions} 腿執行)
                        </Text>
                      </div>
                    )}
                  </div>
                );
              }
            },
            {
              title: '狀態',
              key: 'status',
              render: (_: any, r: any) => {
                const status = (r?.status || '').toLowerCase();
                const isCompleted = !!r?.completed || (typeof r?.maxExecs === 'number' && r?.successCount >= r?.maxExecs);
                
                // 根據JSONL數據判斷狀態
                if (status === 'failed') return <Tag color="error">失敗</Tag>;
                if (status === 'cancelled') {
                  const reason = r?.reason || 'manual';
                  return (
                    <Tooltip title={reason === 'manual' ? '手動刪除交易對' : `取消原因: ${reason}`}>
                      <Tag color="warning">手動中止</Tag>
                    </Tooltip>
                  );
                }
                if (status === 'rolling_back') return <Tag color="orange">回滾中</Tag>;
                if (status === 'rolled_back') return <Tag color="warning">已回滾</Tag>;
                
                // 套利執行記錄都是歷史記錄，只有完成狀態
                if (typeof r?.maxExecs === 'number' && typeof r?.successCount === 'number') {
                  if (r.successCount >= r.maxExecs) {
                    return <Tag color="success">完成</Tag>;
                  } else {
                    // 如果執行次數未達到目標，可能是部分完成或失敗
                    return <Tag color="warning">部分完成</Tag>;
                  }
                }
                
                // 如果沒有執行次數信息，根據completed狀態判斷
                if (isCompleted) return <Tag color="success">完成</Tag>;
                return <Tag color="default">未知</Tag>;
              }
            }
          ]}
        />
      </Card>

      {/* 添加/編輯對話框 */}
      <Modal
        title={editingPair ? '編輯監控交易對' : '添加監控交易對'}
        open={isModalVisible}
        onCancel={() => {
          setIsModalVisible(false);
          setEditingPair(null);
          form.resetFields();
          setLeg1Exchange('bybit');
          setLeg2Exchange('bybit');
        }}
        footer={null}
        width={800}
      >
        {/* 調試信息 - 顯示可用交易所 */}
        {availableExchanges.length === 0 && (
          <Alert
            message="沒有可用的交易所"
            description="請先配置交易所API密鑰，或檢查系統連接狀態。"
            type="warning"
            showIcon
            style={{ marginBottom: 16 }}
          />
        )}
        
        <Form
          form={form}
          layout="vertical"
          onFinish={handleSubmit}
          initialValues={{
            enabled: true,
            threshold: 0.0,
            amount: 100.0, // 舊參數保留
            qty: 0.01,
            totalAmount: 1000,
            executionMode: 'threshold',
            // 預設：Bybit BTCUSDT，Leg1=合約(線性)；Leg2=現貨
            leg1_exchange: 'bybit',
            leg1_type: 'linear',
            leg1_symbol: 'BTCUSDT',
            leg1_side: 'buy',
            leg2_exchange: 'bybit',
            leg2_type: 'spot',
            leg2_symbol: 'BTCUSDT',
            leg2_side: 'sell',
          }}
        >
          {/* 常用交易對快捷選擇 */}
          <Alert
            message="💡 常用交易對"
            description={
              <div style={{ marginTop: 8 }}>
                <Space wrap>
                  {['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'ADAUSDT', 'SOLUSDT', 'DOGEUSDT', 'XRPUSDT', 'LTCUSDT'].map(symbol => (
                    <Button 
                      key={symbol}
                      size="small"
                      type="dashed"
                      onClick={() => {
                        form.setFieldValue('leg1_symbol', symbol);
                        form.setFieldValue('leg2_symbol', symbol);
                      }}
                      style={{ fontSize: '12px' }}
                    >
                      {symbol}
                    </Button>
                  ))}
                </Space>
                <div style={{ marginTop: 8, fontSize: '12px', color: '#666' }}>
                  點擊可快速填入兩個交易對，您也可以手動輸入其他交易對
                </div>
              </div>
            }
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
          />

          <Row gutter={16}>
            <Col span={12}>
              <Card title="Leg 1 配置" size="small">
                <Form.Item
                  name="leg1_exchange"
                  label="交易所"
                  rules={[{ required: true, message: '請選擇交易所' }]}
                >
                  <Select 
                    placeholder="選擇交易所"
                    onChange={(value) => {
                      setLeg1Exchange(value);
                      // 如果選擇了 Bitget/OKX 且當前是現貨，自動切換為合約
                      if ((value === 'bitget' || value === 'okx') && form.getFieldValue('leg1_type') === 'spot') {
                        form.setFieldsValue({ leg1_type: 'linear' });
                        message.info(`${value === 'bitget' ? 'Bitget' : 'OKX'} 僅支援合約交易，已自動切換為合約`);
                      }
                    }}
                  >
                    {availableExchanges.map(exchange => (
                      <Option 
                        key={exchange.key} 
                        value={exchange.key}
                        disabled={!exchange.connected && !exchange.implemented}
                      >
                        <span>{exchange.name}</span>
                        {(exchange.key === 'bitget' || exchange.key === 'okx') && 
                          <span style={{ color: '#faad14', marginLeft: 4 }}>(僅合約)</span>
                        }
                      </Option>
                    ))}
                  </Select>
                </Form.Item>

                <Form.Item
                  name="leg1_type"
                  label="交易類型"
                  rules={[{ required: true, message: '請選擇交易類型' }]}
                >
                  <Select 
                    placeholder="選擇類型"
                    onChange={(value) => {
                      // 如果選擇了現貨但交易所是 Bitget/OKX，提示錯誤
                      const exchange = form.getFieldValue('leg1_exchange');
                      if (value === 'spot' && (exchange === 'bitget' || exchange === 'okx')) {
                        message.warning(`${exchange === 'bitget' ? 'Bitget' : 'OKX'} 不支援現貨交易，請選擇合約`);
                        form.setFieldsValue({ leg1_type: 'linear' });
                      }
                    }}
                  >
                    <Option value="linear">線性合約</Option>
                    <Option 
                      value="spot" 
                      disabled={leg1Exchange === 'bitget' || leg1Exchange === 'okx'}
                    >
                      現貨
                      {(leg1Exchange === 'bitget' || leg1Exchange === 'okx') && 
                        <span style={{ color: '#ff4d4f', marginLeft: 4 }}>
                          ({leg1Exchange === 'bitget' ? 'Bitget' : 'OKX'} 不支援)
                        </span>
                      }
                    </Option>
                  </Select>
                </Form.Item>

                <Form.Item
                  name="leg1_side"
                  label="買賣方向"
                  rules={[{ required: true, message: '請選擇買/賣方向' }]}
                >
                  <Select placeholder="選擇方向">
                    <Option value="buy">
                      <span style={{ color: '#52c41a', fontWeight: 'bold' }}>🟢 買入</span>
                    </Option>
                    <Option value="sell">
                      <span style={{ color: '#ff4d4f', fontWeight: 'bold' }}>🔴 賣出</span>
                    </Option>
                  </Select>
                </Form.Item>

                <Form.Item
                  name="leg1_symbol"
                  label="交易對"
                  rules={[
                    { required: true, message: '請輸入交易對' },
                    { 
                      pattern: /^[A-Z0-9]+USDT?$/i, 
                      message: '請輸入正確的交易對格式，如：BTCUSDT' 
                    }
                  ]}
                  extra="請輸入交易對符號，如：BTCUSDT, ETHUSDT 等"
                >
                  <Input 
                    placeholder="輸入交易對，如：BTCUSDT"
                    style={{ textTransform: 'uppercase' }}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                      // 自動轉換為大寫
                      const value = e.target.value.toUpperCase();
                      form.setFieldValue('leg1_symbol', value);
                    }}
                  />
                </Form.Item>
              </Card>
            </Col>

            <Col span={12}>
              <Card title="Leg 2 配置" size="small">
                <Form.Item
                  name="leg2_exchange"
                  label="交易所"
                  rules={[{ required: true, message: '請選擇交易所' }]}
                >
                  <Select 
                    placeholder="選擇交易所"
                    onChange={(value) => {
                      setLeg2Exchange(value);
                      // 如果選擇了 Bitget/OKX 且當前是現貨，自動切換為合約
                      if ((value === 'bitget' || value === 'okx') && form.getFieldValue('leg2_type') === 'spot') {
                        form.setFieldsValue({ leg2_type: 'linear' });
                        message.info(`${value === 'bitget' ? 'Bitget' : 'OKX'} 僅支援合約交易，已自動切換為合約`);
                      }
                    }}
                  >
                    {availableExchanges.map(exchange => (
                      <Option 
                        key={exchange.key} 
                        value={exchange.key}
                        disabled={!exchange.connected && !exchange.implemented}
                      >
                        <span>{exchange.name}</span>
                        {(exchange.key === 'bitget' || exchange.key === 'okx') && 
                          <span style={{ color: '#faad14', marginLeft: 4 }}>(僅合約)</span>
                        }
                      </Option>
                    ))}
                  </Select>
                </Form.Item>

                <Form.Item
                  name="leg2_type"
                  label="交易類型"
                  rules={[{ required: true, message: '請選擇交易類型' }]}
                >
                  <Select 
                    placeholder="選擇類型"
                    onChange={(value) => {
                      // 如果選擇了現貨但交易所是 Bitget/OKX，提示錯誤
                      const exchange = form.getFieldValue('leg2_exchange');
                      if (value === 'spot' && (exchange === 'bitget' || exchange === 'okx')) {
                        message.warning(`${exchange === 'bitget' ? 'Bitget' : 'OKX'} 不支援現貨交易，請選擇合約`);
                        form.setFieldsValue({ leg2_type: 'linear' });
                      }
                    }}
                  >
                    <Option value="linear">線性合約</Option>
                    <Option 
                      value="spot" 
                      disabled={leg2Exchange === 'bitget' || leg2Exchange === 'okx'}
                    >
                      現貨
                      {(leg2Exchange === 'bitget' || leg2Exchange === 'okx') && 
                        <span style={{ color: '#ff4d4f', marginLeft: 4 }}>
                          ({leg2Exchange === 'bitget' ? 'Bitget' : 'OKX'} 不支援)
                        </span>
                      }
                    </Option>
                  </Select>
                </Form.Item>

                <Form.Item
                  name="leg2_side"
                  label="買賣方向"
                  rules={[{ required: true, message: '請選擇買/賣方向' }]}
                >
                  <Select placeholder="選擇方向">
                    <Option value="buy">
                      <span style={{ color: '#52c41a', fontWeight: 'bold' }}>🟢 買入</span>
                    </Option>
                    <Option value="sell">
                      <span style={{ color: '#ff4d4f', fontWeight: 'bold' }}>🔴 賣出</span>
                    </Option>
                  </Select>
                </Form.Item>

                <Form.Item
                  name="leg2_symbol"
                  label="交易對"
                  rules={[
                    { required: true, message: '請輸入交易對' },
                    { 
                      pattern: /^[A-Z0-9]+USDT?$/i, 
                      message: '請輸入正確的交易對格式，如：BTCUSDT' 
                    }
                  ]}
                  extra="請輸入交易對符號，如：BTCUSDT, ETHUSDT 等"
                >
                  <Input 
                    placeholder="輸入交易對，如：BTCUSDT"
                    style={{ textTransform: 'uppercase' }}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                      // 自動轉換為大寫
                      const value = e.target.value.toUpperCase();
                      form.setFieldValue('leg2_symbol', value);
                    }}
                  />
                </Form.Item>
              </Card>
            </Col>
          </Row>

          <Divider />


          
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item
                name="qty"
                label="每筆下單數量"
                rules={[
                  { required: true, message: '請輸入每筆下單數量' },
                  { type: 'number', min: 0.001, message: '數量必須大於 0.001' }
                ]}
                extra="每次觸發時的下單數量"
              >
                <InputNumber
                  min={0.001}
                  max={1000000}
                  step={0.001}
                  precision={8}
                  style={{ width: '100%' }}
                  placeholder="1.0"
                  addonAfter="幣"
                  formatter={value => `${value}`.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}
                  parser={value => Number(value!.replace(/\$\s?|(,*)/g, '')) as any}
                />
              </Form.Item>
            </Col>

            <Col span={8}>
              <Form.Item
                name="orderCount"
                label="執行次數"
                rules={[
                  { required: true, message: '請輸入執行次數' },
                  { type: 'number', min: 1, message: '次數必須至少 1 次' }
                ]}
              >
                <InputNumber
                  min={1}
                  max={1000}
                  step={1}
                  precision={0}
                  style={{ width: '100%' }}
                  placeholder="2"
                />
              </Form.Item>
            </Col>

            <Col span={8}>
              <Form.Item
                name="threshold"
                label="觸發閾值 (%)"
                rules={[{ required: true, message: '請輸入觸發閾值' }]}
                initialValue={0.1}
              >
                <InputNumber
                  min={-10}
                  max={10}
                  step={0.01}
                  precision={2}
                  style={{ width: '100%' }}
                  placeholder="0.10（可填負值如 -0.01）"
                  controls={{
                    upIcon: <span>+</span>,
                    downIcon: <span>-</span>
                  }}
                />
              </Form.Item>
            </Col>

          </Row>


          <Form.Item style={{ marginBottom: 0, textAlign: 'right' }}>
            <Space>
              <Button onClick={() => setIsModalVisible(false)}>
                取消
              </Button>
              <Button type="primary" htmlType="submit" loading={loading}>
                {editingPair ? '更新' : '添加'}
              </Button>
            </Space>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default ArbitragePage;
