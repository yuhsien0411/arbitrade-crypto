/**
 * TWAP策略頁面
 * 用戶自定義標的、數量、時間間隔
 */

import React, { useState, useEffect, useCallback } from 'react';
import { 
  Row, Col, Card, Form, Select, InputNumber, Button, Table, Space, 
  Typography, Tag, Switch, Modal, Progress, Alert, Tooltip, Divider, App as AntdApp
} from 'antd';
import { 
  PlusOutlined, DeleteOutlined, PlayCircleOutlined, PauseCircleOutlined,
  SettingOutlined, ReloadOutlined, ExclamationCircleOutlined, StopOutlined
} from '@ant-design/icons';
import { useSelector, useDispatch } from 'react-redux';
import { RootState, AppDispatch } from '../store';
import { apiService } from '../services/api';
import type { ApiResponse } from '../types/arbitrage';
import { addStrategy, updateStrategy, removeStrategy, setStrategies, pauseStrategy, resumeStrategy, cancelStrategy } from '../store/slices/twapSlice';
import { formatAmountWithCurrency } from '../utils/formatters';
import logger from '../utils/logger';
import DebounceService from '../services/debounceService';

const { Title, Text } = Typography;
const { Option } = Select;
const { confirm } = Modal;

const TwapPage: React.FC = () => {
  const dispatch = useDispatch<AppDispatch>();
  const { message } = AntdApp.useApp();
  const { exchanges, isConnected } = useSelector((state: RootState) => state.system);
  const { strategies, executions } = useSelector((state: RootState) => state.twap);
  
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [editingStrategy, setEditingStrategy] = useState<any>(null);
  const [twapExecutions, setTwapExecutions] = useState<any[]>([]);
  const [leg1Exchange, setLeg1Exchange] = useState<string>('bybit');
  const [leg2Exchange, setLeg2Exchange] = useState<string>('bybit');

  // 將已完成的策略轉換為執行記錄格式
  const completedStrategiesAsExecutions = strategies
    .filter(strategy => strategy.status === 'completed' || strategy.status === 'cancelled' || strategy.status === 'failed')
    .map(strategy => ({
      strategyId: strategy.id,
      timestamp: strategy.createdAt,
      amount: strategy.totalAmount,
      leg1Price: null,
      leg2Price: null,
      success: strategy.status === 'completed',
      orderId: `${strategy.status}_${strategy.id}`,
      legIndex: 0,
      status: strategy.status,
      executionType: strategy.status === 'completed' ? '完成' : 
                    strategy.status === 'cancelled' ? '錯誤' : 
                    strategy.status === 'failed' ? '錯誤' : '未知'
    }));
  
  // ✅ V3 改進：將 JSONL 格式的 TWAP 執行記錄轉換為前端格式（支援新舊格式）
  const convertedTwapExecutions = (twapExecutions || [])
    .filter((record: any) => {
      const isValid = record && record.planId;
      if (!isValid) {
        console.warn('⚠️ 過濾掉無效記錄:', record);
      }
      return isValid;
    }) // 過濾掉無效記錄
    .map((record: any) => {
      // ✅ V3 向後兼容：檢測是舊格式（單腿）還是新格式（完整）
      const isLegacyFormat = 'legIndex' in record;
      
      // 調試日誌：檢查特定策略的記錄
      const debugPlanIds = ['twap_cc573139', 'twap_d687d83e', 'twap_b99e5989', 'twap_17bcb780'];
      if (debugPlanIds.includes(record.planId)) {
        console.log(`🔍 轉換 ${record.planId} 記錄:`, {
          isLegacyFormat,
          status: record.status,
          leg1: record.leg1,
          leg2: record.leg2,
          hasLegIndex: 'legIndex' in record,
          sliceIndex: record.sliceIndex
        });
      }
      
      if (isLegacyFormat) {
        // 舊格式：單腿記錄
        return {
          strategyId: record.planId,
          timestamp: record.ts,
          amount: record.qty,
          success: record.success,
          orderId: record.orderId,
          legIndex: record.legIndex,
          sliceIndex: record.sliceIndex,
          price: record.price,
          symbol: record.symbol,
          exchange: record.exchange,
          type: record.type,
          side: record.side,
          error: record.error,
          _isLegacyFormat: true
        };
      } else {
        // ✅ V3 新格式：完整記錄（包含 leg1 和 leg2）
        return {
          strategyId: record.planId,
          timestamp: record.ts,
          amount: record.qty,
          sliceQty: record.sliceQty || record.qty,
          totalAmount: record.totalAmount,
          orderCount: record.orderCount,
          status: record.status || 'unknown',
          success: record.status === 'success',
          sliceIndex: record.sliceIndex,
          spread: record.spread,
          spreadPercent: record.spreadPercent,
          intervalMs: record.intervalMs,
          // leg1 信息
          leg1: record.leg1,
          // leg2 信息
          leg2: record.leg2,
          // 回滾相關
          isRollback: record.isRollback || false,
          originalSliceIndex: record.originalSliceIndex,
          _isUnifiedFormat: true
        };
      }
    });

  // 合併原始執行記錄、已完成的策略和 JSONL 記錄
  const allExecutions = [...executions, ...completedStrategiesAsExecutions, ...convertedTwapExecutions]
    .sort((a, b) => b.timestamp - a.timestamp);

  // 可用的交易所
  const availableExchanges = Object.entries(exchanges)
    .filter(([_, exchange]) => exchange.connected)
    .map(([key, exchange]) => ({ key, name: exchange.name, symbols: exchange.symbols }));
    
  // 常用交易對列表
  const commonSymbols = [
    'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'SOLUSDT', 'DOGEUSDT',
    'DOTUSDT', 'MATICUSDT', 'LTCUSDT', 'AVAXUSDT', 'LINKUSDT', 'UNIUSDT', 'ATOMUSDT',
    'ETCUSDT', 'FILUSDT', 'XLMUSDT', 'TRXUSDT', 'NEARUSDT', 'AAVEUSDT'
  ];

  // 載入 TWAP 執行記錄和策略配置
  const fetchTwapData = useCallback(async () => {
    try {
      console.log('🔍 開始載入 TWAP 數據...');
      
      // 同時載入執行記錄和策略配置
      const [executionsRes, strategiesRes] = await Promise.all([
        apiService.getTwapExecutions(),
        apiService.getTwapStrategies()
      ]);
      
      console.log('📡 TWAP 執行記錄響應:', executionsRes);
      console.log('📡 TWAP 策略配置響應:', strategiesRes);
      
      // 處理執行記錄
      let recent: any[] = [];
      // ✅ 修復：後端返回格式為 {success: true, data: {executions: {...}, recent: [...]}}
      if ((executionsRes as any)?.data?.recent) {
        recent = Array.isArray((executionsRes as any).data.recent) ? (executionsRes as any).data.recent : [];
      } else if ((executionsRes as any)?.recent) {
        // 向後兼容：如果直接在根級別有 recent 字段
        recent = Array.isArray((executionsRes as any).recent) ? (executionsRes as any).recent : [];
      }
      
      // 處理策略配置
      let strategiesData: any[] = [];
      if ((strategiesRes as any)?.data) {
        strategiesData = Array.isArray((strategiesRes as any).data) ? (strategiesRes as any).data : [];
      }
      
      // 轉換後端格式到前端格式
      const convertedStrategies = strategiesData.map((plan: any) => {
        const leg1 = plan.legs?.[0] || {};
        const leg2 = plan.legs?.[1] || {};
        return {
          id: plan.planId,
          leg1: {
            exchange: leg1.exchange,
            symbol: leg1.symbol,
            side: leg1.side,
            // 正規化：後端給的是 category ('spot' | 'linear')，前端統一成 'spot' | 'future'
            type: (leg1.category === 'linear' ? 'future' : 'spot') as 'spot' | 'future',
          },
          leg2: {
            exchange: leg2.exchange,
            symbol: leg2.symbol,
            side: leg2.side,
            type: (leg2.category === 'linear' ? 'future' : 'spot') as 'spot' | 'future',
          },
          totalAmount: plan.totalQty,
          timeInterval: plan.intervalMs ? Math.floor(plan.intervalMs / 1000) : 10, // 預設10秒
          orderCount: plan.progress?.slicesTotal || Math.floor(plan.totalQty / plan.sliceQty),
          amountPerOrder: plan.sliceQty,
          priceType: 'market' as const,
          enabled: true,
          createdAt: plan.createdAt || Date.now(),
          executedOrders: plan.progress?.slicesDone || 0,
          remainingAmount: Math.max(0, plan.progress?.remaining || plan.totalQty),
          nextExecutionTime: plan.progress?.nextExecutionTs || 0,
          // 優先使用 plan.status（後端返回的狀態），如果沒有則使用 plan.state（向後兼容）
          status: (() => {
            const stateValue = plan.status || plan.state || 'pending';
            if (stateValue === 'running' || stateValue === 'active') {
              return 'active' as const;
            } else if (stateValue === 'paused') {
              return 'paused' as const;
            } else if (stateValue === 'completed') {
              return 'completed' as const;
            } else if (stateValue === 'cancelled') {
              return 'cancelled' as const;
            } else if (stateValue === 'failed') {
              return 'failed' as const;
            } else {
              return 'pending' as const;
            }
          })()
        };
      });
      
      console.log('📊 TWAP 持久化記錄數量:', recent.length);
      console.log('📊 TWAP 策略配置數量:', convertedStrategies.length);
      console.log('📄 TWAP 持久化記錄內容:', recent);
      console.log('📄 TWAP 策略配置內容:', convertedStrategies);
      
      // 檢查策略配置是否包含執行記錄中的策略
      const executionPlanIds = Array.from(new Set(recent.map(r => r.planId)));
      const strategyIds = convertedStrategies.map(s => s.id);
      console.log('🔍 執行記錄中的策略ID:', executionPlanIds);
      console.log('🔍 策略配置中的策略ID:', strategyIds);
      console.log('🔍 缺失的策略配置:', executionPlanIds.filter(id => !strategyIds.includes(id)));
      
      setTwapExecutions(recent);
      
      // 更新 Redux 中的策略配置
      if (convertedStrategies.length > 0) {
        dispatch(setStrategies(convertedStrategies));
      }
    } catch (error) {
      console.error('❌ 載入 TWAP 數據失敗:', error);
    }
  }, [dispatch]);

  useEffect(() => {
    fetchTwapData();
  }, [fetchTwapData]);
  
  // 從交易所獲取可用交易對
  const [availableSymbols, setAvailableSymbols] = useState<string[]>(commonSymbols);
  const [symbolsLoaded, setSymbolsLoaded] = useState(false);
  
  // 載入交易所支持的交易對
  useEffect(() => {
    const loadSymbols = async () => {
      // 避免重複載入
      if (symbolsLoaded) return;
      
      try {
        // 獲取第一個連接的交易所
        const connectedExchange = availableExchanges[0]?.key;
        if (connectedExchange) {
          const response = await apiService.getSymbols(connectedExchange) as unknown as ApiResponse;
          if (response.success && Array.isArray(response.data)) {
            // 合併常用交易對和交易所支持的交易對
            const symbolSet = new Set([...commonSymbols, ...response.data]);
            const allSymbols = Array.from(symbolSet);
            setAvailableSymbols(allSymbols);
            setSymbolsLoaded(true);
            logger.info('已載入交易對列表', { count: allSymbols.length }, 'TwapPage');
          }
        }
      } catch (error) {
        logger.error('載入交易對列表失敗', error, 'TwapPage');
        setSymbolsLoaded(true); // 即使失敗也標記為已載入，避免重複嘗試
      }
    };
    
    // 只在有連接的交易所且未載入時才載入
    if (availableExchanges.length > 0 && !symbolsLoaded) {
      // 使用防抖服務，1秒延遲，最多每分鐘10次請求
      const debouncedLoadSymbols = DebounceService.debounce(
        'load-symbols',
        loadSymbols,
        { delay: 1000, maxCalls: 10, timeWindow: 60000 }
      );
      
      debouncedLoadSymbols();
    }
    
    // 清理函數
    return () => {
      DebounceService.cancel('load-symbols');
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availableExchanges.length, symbolsLoaded]); // 依賴交易所數量和載入狀態

  const loadTwapStrategies = useCallback(async () => {
    try {
      const response = await apiService.getTwapStrategies() as unknown as ApiResponse;
      if (response.success && response.data) {
        // 轉換後端數據為前端格式
        const strategies = response.data.map((plan: any) => ({
          id: plan.planId,
          leg1: {
            exchange: plan.legs?.[0]?.exchange || 'bybit',
            symbol: plan.legs?.[0]?.symbol || 'BTCUSDT',
            type: (plan.legs?.[0]?.category === 'linear' ? 'future' : 'spot') as 'spot' | 'future',
            side: plan.legs?.[0]?.side || 'buy'
          },
          leg2: {
            exchange: plan.legs?.[1]?.exchange || 'bybit',
            symbol: plan.legs?.[1]?.symbol || 'BTCUSDT',
            type: (plan.legs?.[1]?.category === 'linear' ? 'future' : 'spot') as 'spot' | 'future',
            side: plan.legs?.[1]?.side || 'sell'
          },
          totalAmount: plan.totalQty,
          timeInterval: plan.intervalMs,
          orderCount: plan.slicesTotal,
          amountPerOrder: plan.sliceQty,
          priceType: 'market' as const,
          enabled: true,
          createdAt: plan.createdAt || Date.now(),
          executedOrders: plan.progress?.slicesDone || 0,
          remainingAmount: Math.max(0, plan.progress?.remaining || plan.totalQty),
          nextExecutionTime: plan.progress?.nextExecutionTs || 0,
          status: plan.state === 'running' ? 'active' as const : 
                 plan.state === 'paused' ? 'paused' as const :
                 plan.state === 'completed' ? 'completed' as const :
                 plan.state === 'cancelled' ? 'cancelled' as const :
                 plan.state === 'failed' ? 'failed' as const : 'active' as const
        }));
        
        // 一次性設置所有策略
        dispatch(setStrategies(strategies));
      }
    } catch (error) {
      logger.error('載入TWAP策略失敗', error, 'TwapPage');
    }
  }, [dispatch]);

  // 載入TWAP策略
  useEffect(() => {
    loadTwapStrategies();
    
    // 設置定時重新載入策略（每1秒）
    const reloadInterval = setInterval(() => {
      fetchTwapData(); // 獲取完整的執行記錄和策略配置
    }, 1000);
    
    return () => clearInterval(reloadInterval);
  }, [loadTwapStrategies, fetchTwapData]);

  // 添加/更新TWAP策略（後端僅需單腿：symbol/side/totalAmount/timeInterval/orderCount）
  const handleSubmit = async (values: any) => {
    try {
      setLoading(true);
      
      // 構建符合後端 API 格式的請求數據
      const normalizeExchange = (v: any) => {
        if (!v && v !== 0) return v;
        // 1) 已是正確字串
        const s = String(v).toLowerCase();
        if (s === 'bybit' || s === 'binance' || s === 'okx' || s === 'bitget') return s;
        // 2) 防禦：若收到數字索引（如 '0'、'1'），嘗試用可用交易所列表映射
        if (/^\d+$/.test(s)) {
          const idx = parseInt(s, 10);
          const mapped = availableExchanges[idx]?.key;
          if (mapped) return String(mapped).toLowerCase();
        }
        // 3) 防禦：若是物件或未知字串，嘗試在已知鍵中找到最接近的
        const candidates = availableExchanges.map(ex => String(ex.key).toLowerCase());
        if (candidates.includes(s)) return s;
        // 4) 回退：預設 bybit，避免 422
        return 'bybit';
      };

      const payload = {
        name: `TWAP策略_${Date.now()}`,
        totalQty: values.sliceQty * values.orderCount, // 總數量 = 單次數量 × 執行次數
        sliceQty: values.sliceQty, // 單次數量
        intervalMs: Math.max((values.timeInterval || 10), 10) * 1000,
        legs: [
          {
            exchange: normalizeExchange(values.leg1_exchange || "bybit"),
            symbol: Array.isArray(values.leg1_symbol) ? values.leg1_symbol[0] : values.leg1_symbol,
            side: values.leg1_side,
            type: "market",
            category: values.leg1_type === 'future' ? 'linear' : 'spot'
          },
          {
            exchange: normalizeExchange(values.leg2_exchange || "bybit"),
            symbol: Array.isArray(values.leg2_symbol) ? values.leg2_symbol[0] : values.leg2_symbol,
            side: values.leg2_side,
            type: "market",
            category: values.leg2_type === 'future' ? 'linear' : 'spot'
          }
        ]
      };

      let response: ApiResponse;
      if (editingStrategy) {
        // 更新現有策略
        response = await apiService.updateTwapStrategy(editingStrategy.id, payload) as unknown as ApiResponse;
      } else {
        // 創建新策略
        response = await apiService.addTwapStrategy(payload) as unknown as ApiResponse;
      }

      if (response.success) {
        // 構建完整的策略對象
        const strategyData = {
          id: editingStrategy ? editingStrategy.id : response.data.planId,
          leg1: {
            exchange: payload.legs[0].exchange,
            symbol: payload.legs[0].symbol,
            type: (payload.legs[0].category === 'linear' ? 'future' : 'spot') as 'spot' | 'future',
            side: payload.legs[0].side as 'buy' | 'sell'
          },
          leg2: {
            exchange: payload.legs[1].exchange,
            symbol: payload.legs[1].symbol,
            type: (payload.legs[1].category === 'linear' ? 'future' : 'spot') as 'spot' | 'future',
            side: payload.legs[1].side as 'buy' | 'sell'
          },
          totalAmount: payload.totalQty,
          timeInterval: payload.intervalMs,
          orderCount: Math.round(payload.totalQty / payload.sliceQty),
          amountPerOrder: payload.sliceQty,
          priceType: 'market' as const,
          enabled: true,
          createdAt: editingStrategy ? editingStrategy.createdAt : Date.now(),
          executedOrders: editingStrategy ? editingStrategy.executedOrders : 0,
          remainingAmount: Math.max(0, payload.totalQty),
          nextExecutionTime: 0,
          status: editingStrategy ? editingStrategy.status : 'active' as const
        };
        
        if (editingStrategy) {
          // 更新現有策略
          dispatch(updateStrategy({ id: editingStrategy.id, updates: strategyData }));
        } else {
          // 添加新策略
          dispatch(addStrategy(strategyData));
          
          // 如果啟用了自動執行，則自動啟動策略
          if (values.enabled && response.data.planId) {
            try {
              const startResponse = await apiService.controlTwapStrategy(response.data.planId, 'start') as unknown as ApiResponse;
              if (startResponse.success) {
                dispatch(resumeStrategy(response.data.planId));
                message.success('策略已創建並自動啟動');
              } else {
                message.success('策略創建成功，請手動啟動');
              }
            } catch (error) {
              message.success('策略創建成功，請手動啟動');
            }
          } else {
            message.success('策略創建成功，請手動啟動');
          }
        }
        
        if (editingStrategy) {
          message.success('更新成功');
        }
        
        setIsModalVisible(false);
        form.resetFields();
        setEditingStrategy(null);
        setLeg1Exchange('bybit');
        setLeg2Exchange('bybit');
      }
    } catch (error: any) {
      message.error(error.message || '操作失敗');
    } finally {
      setLoading(false);
    }
  };

  // 刪除TWAP策略
  const handleDelete = (id: string) => {
    confirm({
      title: '確認刪除',
      content: '確定要刪除這個TWAP策略嗎？',
      icon: <ExclamationCircleOutlined />,
      onOk: async () => {
        try {
          const response = await apiService.removeTwapStrategy(id) as unknown as ApiResponse;
          if (response.success !== false) {
            dispatch(removeStrategy(id));
            message.success('刪除成功');
            // 刷新策略列表
            setTimeout(() => {
              loadTwapStrategies();
            }, 500);
          } else {
            message.error(response.error || response.message || '刪除失敗');
          }
        } catch (error: any) {
          const errorMsg = error.response?.data?.error || 
                          error.response?.data?.detail?.message || 
                          error.message || 
                          '刪除失敗';
          message.error(errorMsg);
          console.error('TWAP delete error:', error);
        }
      },
    });
  };

  // 啟動策略
  const handleStart = async (strategy: any) => {
    try {
      const response = await apiService.controlTwapStrategy(strategy.id, 'start') as unknown as ApiResponse;
      
      if (response.success) {
        dispatch(resumeStrategy(strategy.id)); // 使用 resume 來更新狀態為 running
        message.success('策略已啟動');
        
        // 操作成功後立即刷新狀態
        setTimeout(() => {
          loadTwapStrategies();
        }, 500);
      } else {
        message.error(response.message || '啟動失敗');
      }
    } catch (error: any) {
      message.error(error.message || '啟動失敗');
    }
  };

  // 暫停/恢復策略
  const handleTogglePause = async (strategy: any) => {
    try {
      // 統一狀態判斷：前端可能使用 'active'，後端使用 'running'
      const isRunning = strategy.status === 'running' || strategy.status === 'active';
      const action = isRunning ? 'pause' : 'resume';
      
      const response = await apiService.controlTwapStrategy(strategy.id, action) as unknown as ApiResponse;
      
      if (response.success) {
        if (isRunning) {
          dispatch(pauseStrategy(strategy.id));
          message.success('策略已暫停');
        } else if (strategy.status === 'paused') {
          dispatch(resumeStrategy(strategy.id));
          message.success('策略已恢復');
        }
        
        // 操作成功後立即刷新狀態
        setTimeout(() => {
          loadTwapStrategies();
        }, 500);
      } else {
        let errorMsg = response.message || response.error || '操作失敗';
        
        // 針對狀態不匹配提供更友好的錯誤消息
        if (errorMsg.includes('INVALID_STATE') || errorMsg.includes('Cannot perform action in current state')) {
          if (action === 'pause') {
            errorMsg = `無法暫停策略：當前狀態為 ${strategy.status}，只有運行中的策略可以暫停`;
          } else if (action === 'resume') {
            errorMsg = `無法恢復策略：當前狀態為 ${strategy.status}，只有暫停的策略可以恢復`;
          }
        }
        
        message.error(errorMsg);
        console.error('TWAP control error:', response);
      }
    } catch (error: any) {
      let errorMsg = error.response?.data?.detail?.message || 
                     error.response?.data?.error || 
                     error.message || 
                     '操作失敗';
      
      // 針對狀態不匹配提供更友好的錯誤消息
      if (errorMsg.includes('INVALID_STATE') || errorMsg.includes('Cannot perform action in current state')) {
        const isRunning = strategy.status === 'running' || strategy.status === 'active';
        const action = isRunning ? 'pause' : 'resume';
        if (action === 'pause') {
          errorMsg = `無法暫停策略：當前狀態為 ${strategy.status}，只有運行中的策略可以暫停`;
        } else if (action === 'resume') {
          errorMsg = `無法恢復策略：當前狀態為 ${strategy.status}，只有暫停的策略可以恢復`;
        }
      }
      
      message.error(errorMsg);
      console.error('TWAP control exception:', error);
    }
  };

  // 取消策略
  const handleCancel = (id: string) => {
    confirm({
      title: '確認取消',
      content: '確定要取消這個TWAP策略嗎？取消後無法恢復。',
      icon: <ExclamationCircleOutlined />,
      onOk: async () => {
        try {
          const response = await apiService.controlTwapStrategy(id, 'cancel') as unknown as ApiResponse;
          if (response.success) {
            dispatch(cancelStrategy(id));
            message.success('策略已取消');
            
            // 操作成功後立即刷新狀態
            setTimeout(() => {
              loadTwapStrategies();
            }, 500);
          } else {
            message.error(response.message || '取消失敗');
          }
        } catch (error: any) {
          message.error(error.message || '取消失敗');
        }
      },
    });
  };

  // 緊急回滾
  const handleEmergencyRollback = (id: string) => {
    confirm({
      title: '緊急回滾',
      content: '確定要執行緊急回滾嗎？這將對所有成功的腿執行反向平倉操作，無法撤銷。',
      icon: <StopOutlined style={{ color: '#ff4d4f' }} />,
      okText: '確認回滾',
      okType: 'danger',
      onOk: async () => {
        try {
          const response = await apiService.emergencyRollbackTwap(id) as unknown as ApiResponse;
          if (response.success) {
            message.success('緊急回滾已執行');
            // 重新載入策略列表
            loadTwapStrategies();
          } else {
            message.error(response.message || '緊急回滾失敗');
          }
        } catch (error: any) {
          message.error(error.message || '緊急回滾失敗');
        }
      },
    });
  };

  // 編輯策略
  const handleEdit = (strategy: any) => {
    setEditingStrategy(strategy);
    const leg1Exchange = strategy?.leg1?.exchange || 'bybit';
    const leg1Symbol = strategy?.leg1?.symbol || strategy?.symbol || 'BTCUSDT';
    const leg1Type = strategy?.leg1?.type || 'future';
    const leg1Side = strategy?.leg1?.side || strategy?.side || 'buy';
    const leg2Exchange = strategy?.leg2?.exchange || 'bybit';
    const leg2Symbol = strategy?.leg2?.symbol || leg1Symbol;
    const leg2Type = strategy?.leg2?.type || 'future';
    const leg2Side = strategy?.leg2?.side || 'sell';
    const timeIntervalSec = Math.max(1, Math.round(((strategy?.timeInterval ?? 1000) as number) / 1000));

    // 同步更新交易所狀態
    setLeg1Exchange(leg1Exchange);
    setLeg2Exchange(leg2Exchange);

    form.setFieldsValue({
      leg1_exchange: leg1Exchange,
      leg1_symbol: leg1Symbol,
      leg1_type: leg1Type,
      leg1_side: leg1Side,
      leg2_exchange: leg2Exchange,
      leg2_symbol: leg2Symbol,
      leg2_type: leg2Type,
      leg2_side: leg2Side,
      sliceQty: strategy.sliceQty || (strategy.totalAmount / strategy.orderCount), // 單次數量
      timeInterval: timeIntervalSec,
      orderCount: strategy.orderCount,
      enabled: strategy.enabled ?? true,
    });
    setIsModalVisible(true);
  };

  // 計算進度百分比
  const getProgress = (strategy: any) => {
    if (strategy.status === 'completed') {
      return 100;
    }
    
    // 如果策略配置中的進度數據有效，使用策略配置
    if (strategy.executedOrders > 0 && strategy.orderCount > 0) {
      return (strategy.executedOrders / strategy.orderCount) * 100;
    }
    
    // 否則基於執行記錄計算進度
    const strategyExecutions = allExecutions.filter((exec: any) => 
      exec.strategyId === strategy.id && exec.legIndex === 0
    );
    
    const completedExecutions = strategyExecutions.length;
    const targetExecutions = strategy.orderCount || 1;
    
    return targetExecutions > 0 ? (completedExecutions / targetExecutions) * 100 : 0;
  };

  // 格式化時間間隔
  const formatTimeInterval = (timeInterval: number) => {
    let seconds: number;
    
    // 判斷時間間隔的單位
    if (timeInterval >= 1000) {
      // 如果大於等於1000，說明是毫秒，需要轉換為秒
      seconds = timeInterval / 1000;
    } else {
      // 如果小於1000，說明已經是秒為單位
      seconds = timeInterval;
    }
    
    if (seconds < 60) return `${Math.round(seconds)}秒`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}分鐘`;
    return `${Math.floor(seconds / 3600)}小時`;
  };

  // 策略表格列定義
  const strategyColumns = [
    {
      title: 'Leg 1',
      key: 'leg1',
      render: (_: any, record: any) => {
        if (!record.leg1) {
          return <Text type="secondary">數據載入中...</Text>;
        }
        return (
          <Space direction="vertical" size="small">
            <Text strong>{record.leg1.symbol || 'N/A'}</Text>
            <Text type="secondary" style={{ fontSize: '12px' }}>
              {exchanges[record.leg1.exchange]?.name} {record.leg1.type === 'future' ? 'PERP' : 'SPOT'}
            </Text>
            <Tag color={record.leg1.side === 'buy' ? 'green' : 'red'}>
              {record.leg1.side === 'buy' ? '買入' : '賣出'}
            </Tag>
          </Space>
        );
      },
    },
    {
      title: 'Leg 2',
      key: 'leg2',
      render: (_: any, record: any) => {
        if (!record.leg2) {
          return <Text type="secondary">數據載入中...</Text>;
        }
        return (
          <Space direction="vertical" size="small">
            <Text strong>{record.leg2.symbol || 'N/A'}</Text>
            <Text type="secondary" style={{ fontSize: '12px' }}>
              {exchanges[record.leg2.exchange]?.name} {record.leg2.type === 'future' ? 'PERP' : 'SPOT'}
            </Text>
            <Tag color={record.leg2.side === 'buy' ? 'green' : 'red'}>
              {record.leg2.side === 'buy' ? '買入' : '賣出'}
            </Tag>
          </Space>
        );
      },
    },
    {
      title: '總數量',
      key: 'totalAmount',
      render: (_: any, record: any) => {
        // 使用 leg1 的交易對符號來確定幣種
        const symbol = record.leg1?.symbol || record.leg2?.symbol || 'BTCUSDT';
        return formatAmountWithCurrency(record.totalAmount, symbol);
      },
    },
    {
      title: '執行進度',
      key: 'progress',
      render: (_: any, record: any) => {
        const progress = getProgress(record);
        
        // 計算實際的執行次數
        let executedCount = record.executedOrders || 0;
        let targetCount = record.orderCount || 1;
        
        // 如果策略配置數據無效，基於執行記錄計算
        if (executedCount === 0 && targetCount <= 1) {
          const strategyExecutions = allExecutions.filter((exec: any) => 
            exec.strategyId === record.id && exec.legIndex === 0
          );
          executedCount = strategyExecutions.length;
          targetCount = Math.max(1, targetCount);
        }
        
        return (
          <Space direction="vertical" size="small" style={{ width: '100%' }}>
            <Progress 
              percent={progress} 
              size="small" 
              status={record.status === 'completed' ? 'success' : 'active'}
            />
            <Text style={{ fontSize: '12px' }}>
              {executedCount}/{targetCount} 次
            </Text>
          </Space>
        );
      },
    },
    {
      title: '時間間隔',
      key: 'timeInterval',
      render: (_: any, record: any) => formatTimeInterval(record.timeInterval),
    },
    {
      title: '剩餘數量',
      key: 'remainingAmount',
      render: (_: any, record: any) => {
        // 使用 leg1 的交易對符號來確定幣種
        const symbol = record.leg1?.symbol || record.leg2?.symbol || 'BTCUSDT';
        // 確保剩餘數量不會顯示負數
        const remainingAmount = Math.max(0, record.remainingAmount || 0);
        return formatAmountWithCurrency(remainingAmount, symbol);
      },
    },
    {
      title: '狀態',
      key: 'status',
      render: (_: any, record: any) => {
        const statusMap: Record<string, { color: string; text: string }> = {
          pending: { color: 'default', text: '待處理' },
          active: { color: 'processing', text: '執行中' },
          running: { color: 'processing', text: '執行中' },
          paused: { color: 'warning', text: '已暫停' },
          completed: { color: 'success', text: '已完成' },
          cancelled: { color: 'warning', text: '手動刪除' }, // ✅ 手動取消/刪除
          failed: { color: 'error', text: '執行失敗' }, // ✅ 執行失敗
        };
        
        const status = statusMap[record.status] || { color: 'default', text: '未知' };
        
        return (
          <Space direction="vertical" size="small">
            <Tag color={status.color}>{status.text}</Tag>
            <Text type="secondary" style={{ fontSize: '12px' }}>
              {record.nextExecutionTime && record.status === 'active' 
                ? `下次: ${new Date(record.nextExecutionTime).toLocaleTimeString()}`
                : ''
              }
            </Text>
          </Space>
        );
      },
    },
    {
      title: '操作',
      key: 'actions',
      render: (_: any, record: any) => (
        <Space>
          {record.status === 'pending' && (
            <Tooltip title="啟動">
              <Button
                size="small"
                type="primary"
                icon={<PlayCircleOutlined />}
                onClick={() => handleStart(record)}
              />
            </Tooltip>
          )}
          
          {(record.status === 'running' || record.status === 'active') && (
            <Tooltip title="暫停">
              <Button
                size="small"
                icon={<PauseCircleOutlined />}
                onClick={() => handleTogglePause(record)}
              />
            </Tooltip>
          )}
          
          {record.status === 'paused' && (
            <Tooltip title="恢復">
              <Button
                size="small"
                type="primary"
                icon={<PlayCircleOutlined />}
                onClick={() => handleTogglePause(record)}
              />
            </Tooltip>
          )}
          
          {/* 取消按鈕：所有狀態都可以取消，除了已完成和已取消 */}
          {!['completed', 'cancelled'].includes(record.status) && (
            <Tooltip title="取消策略">
              <Button
                size="small"
                danger
                icon={<ExclamationCircleOutlined />}
                onClick={() => handleCancel(record.id)}
              />
            </Tooltip>
          )}
          
          {/* 緊急回滾：只有運行中、暫停或失敗的策略可以回滾 */}
          {['running', 'paused', 'active', 'failed'].includes(record.status) && (
            <Tooltip title="緊急回滾">
              <Button
                size="small"
                danger
                icon={<StopOutlined />}
                onClick={() => handleEmergencyRollback(record.id)}
                style={{ backgroundColor: '#ff4d4f', borderColor: '#ff4d4f' }}
              />
            </Tooltip>
          )}
          
          {record.status === 'failed' && (
            <Tooltip title="重新啟動">
              <Button
                size="small"
                type="primary"
                icon={<PlayCircleOutlined />}
                onClick={() => handleStart(record)}
              />
            </Tooltip>
          )}
          
          <Tooltip title="編輯">
            <Button
              size="small"
              icon={<SettingOutlined />}
              onClick={() => handleEdit(record)}
              disabled={record.status === 'completed' || record.status === 'cancelled' || record.status === 'failed'}
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
        </Space>
      ),
    },
  ];

  // 按策略ID聚合執行記錄
  const aggregatedExecutions = (() => {
    const agg: Record<string, any> = {};
    
    console.log('🔄 開始聚合執行記錄，總記錄數:', allExecutions.length);
    console.log('📋 所有執行記錄:', allExecutions);
    
    // 檢查 twap_734e9a81 的記錄
    const targetRecords = allExecutions.filter((r: any) => r.strategyId === 'twap_734e9a81');
    console.log('🎯 twap_734e9a81 的記錄:', targetRecords);
    
    // 調試用策略ID列表
    const debugPlanIds = ['twap_cc573139', 'twap_d687d83e', 'twap_b99e5989', 'twap_17bcb780'];
    
    allExecutions.forEach((record: any) => {
      const strategyId = record.strategyId;
      if (!strategyId) return;
      
      // 調試日誌：檢查特定策略的記錄
      if (debugPlanIds.includes(strategyId)) {
        console.log(`🔍 聚合邏輯處理 ${strategyId}:`, {
          sliceIndex: record.sliceIndex,
          hasExecutionType: !!record.executionType,
          hasLegIndex: record.legIndex !== undefined,
          hasOrderId: !!record.orderId,
          hasStatus: !!record.status,
          status: record.status,
          leg1Present: !!record.leg1,
          leg2Present: !!record.leg2,
          _isUnifiedFormat: record._isUnifiedFormat
        });
      }
      
      // 判斷記錄類型
      const isStrategyLevelRecord = !!record.executionType;  // 策略級別的記錄（完成/取消/失敗）
      // ✅ V3 改進：支持新格式記錄（有leg1/leg2或_isUnifiedFormat標記，或有status字段且沒有legIndex）
      // 對於cancelled記錄，leg1和leg2可能是null，但仍有status字段，應該被識別為新格式
      const isUnifiedFormat = record._isUnifiedFormat || 
                              (record.leg1 !== undefined || record.leg2 !== undefined) ||
                              (record.status && record.legIndex === undefined && !record.executionType);
      const isLegExecution = !record.executionType && (
        record.legIndex !== undefined || 
        record.orderId || 
        isUnifiedFormat
      );  // 腿級別的執行記錄（包括新格式的完整記錄）
      
      // 調試日誌：檢查判斷結果
      if (debugPlanIds.includes(strategyId)) {
        console.log(`🔍 ${strategyId} (slice ${record.sliceIndex}) 判斷結果:`, {
          isStrategyLevelRecord,
          isUnifiedFormat,
          isLegExecution,
          willProcess: isLegExecution
        });
      }
      
      if (!agg[strategyId]) {
        const strategy = strategies.find(s => s.id === strategyId);
        console.log(`🔍 查找策略配置 - ID: ${strategyId}, 找到:`, strategy);
        
        // ✅ V3 改進：根據記錄狀態初始化狀態
        let initialStatus = '完成'; // 預設為完成
        if (isUnifiedFormat && record.status) {
          if (record.status === 'failed') {
            initialStatus = 'failed';
          } else if (record.status === 'cancelled') {
            initialStatus = 'cancelled';
          } else if (record.status === 'rolled_back' || record.isRollback) {
            initialStatus = 'rolled_back';
          } else if (record.status === 'success') {
            initialStatus = '完成';
          }
        } else if (record.executionType) {
          initialStatus = record.executionType;
        }
        
        // ✅ 修復：當策略配置不存在時，從執行記錄中提取信息
        // 對於新格式記錄，信息在 leg1/leg2 中；對於舊格式記錄，在頂層
        const fallbackSymbol = record.leg1?.symbol || record.leg2?.symbol || record.symbol || 'ETHUSDT';
        const fallbackExchange = record.leg1?.exchange || record.leg2?.exchange || record.exchange || 'bybit';
        const fallbackLeg1Type = record.leg1?.type || (record.legIndex === 0 ? record.type : null) || 'linear';
        const fallbackLeg2Type = record.leg2?.type || (record.legIndex === 1 ? record.type : null) || 'linear';
        
        agg[strategyId] = {
          strategyId,
          timestamp: record.timestamp,
          totalQty: 0,
          successCount: 0,
          totalExecutions: 0,
          status: initialStatus,
          strategy: strategy,
          leg1Symbol: strategy?.leg1?.symbol || fallbackSymbol,
          leg2Symbol: strategy?.leg2?.symbol || fallbackSymbol,
          leg1Exchange: strategy?.leg1?.exchange || record.leg1?.exchange || fallbackExchange,
          leg2Exchange: strategy?.leg2?.exchange || record.leg2?.exchange || fallbackExchange,
          leg1Side: strategy?.leg1?.side || record.leg1?.side || 'buy',
          leg2Side: strategy?.leg2?.side || record.leg2?.side || 'sell',
          leg1Type: strategy?.leg1?.type || fallbackLeg1Type, // 將在後續處理中更新
          leg2Type: strategy?.leg2?.type || fallbackLeg2Type, // 將在後續處理中更新
          sliceQty: strategy?.amountPerOrder || record.sliceQty || 0.01,
          orderCount: strategy?.orderCount || record.orderCount || 0,
          timeInterval: strategy?.timeInterval || record.intervalMs || 10000, // 預設10秒（毫秒單位）
          totalAmount: strategy?.totalAmount || record.totalAmount || 0,
        };
      }
      
      // 更新最後時間
      agg[strategyId].timestamp = Math.max(agg[strategyId].timestamp, record.timestamp);
      
      // 處理腿級別的執行記錄
      if (isLegExecution) {
        // ✅ V3 改進：處理新格式記錄（統一格式，包含leg1和leg2）
        if (isUnifiedFormat) {
          const recordStatus = record.status || 'unknown';
          const isSuccess = recordStatus === 'success';
          const isCancelled = recordStatus === 'cancelled';
          const isFailed = recordStatus === 'failed';
          const isRolledBack = recordStatus === 'rolled_back' || record.isRollback;
          
          console.log(`📦 處理新格式執行記錄 - 策略ID: ${strategyId}, status: ${recordStatus}, sliceIndex: ${record.sliceIndex}`);
          
          // 更新策略狀態（優先級：failed > cancelled > rolled_back > success）
          // ✅ 確保 cancelled 狀態能正確覆蓋其他狀態（包括"完成"）
          if (isFailed) {
            agg[strategyId].status = 'failed';
          } else if (isCancelled) {
            // cancelled 狀態優先，覆蓋之前的任何狀態（包括"完成"）
            agg[strategyId].status = 'cancelled';
          } else if (isRolledBack) {
            // 回滾狀態不覆蓋其他狀態，只在沒有其他狀態時設置
            if (agg[strategyId].status === '完成' || !agg[strategyId].status) {
              agg[strategyId].status = 'rolled_back';
            }
          } else if (isSuccess) {
            // 只有在當前狀態不是 cancelled 或 failed 時才更新為"完成"
            if (agg[strategyId].status !== 'cancelled' && agg[strategyId].status !== 'failed') {
              agg[strategyId].status = '完成';
            }
          }
          
          // 如果成功，累加數量和執行次數
          if (isSuccess) {
            const qty = record.qty || record.amount || 0;
            agg[strategyId].totalQty += qty;
            // 新格式記錄代表一次完整的執行（包含兩腿），所以totalExecutions += 2
            agg[strategyId].totalExecutions += 2;
          } else if (isCancelled || isFailed) {
            // 被取消或失敗的記錄也計入總執行次數（但不算成功）
            agg[strategyId].totalExecutions += 2;
          } else if (isRolledBack) {
            // 回滾記錄計入總執行次數
            agg[strategyId].totalExecutions += 2;
          }
          
          // 從leg1和leg2中提取信息
          // ✅ 對於 cancelled 記錄，leg1 和 leg2 可能為 null，這是正常的
          if (record.leg1 && record.leg1 !== null) {
            agg[strategyId].leg1Exchange = record.leg1.exchange || agg[strategyId].leg1Exchange;
            agg[strategyId].leg1Symbol = record.leg1.symbol || agg[strategyId].leg1Symbol;
            agg[strategyId].leg1Side = record.leg1.side || agg[strategyId].leg1Side;
            // 轉換category為type（linear -> future, spot -> spot）
            if (record.leg1.type) {
              agg[strategyId].leg1Type = record.leg1.type === 'linear' ? 'future' : 'spot';
            } else if (record.leg1.category) {
              agg[strategyId].leg1Type = record.leg1.category === 'linear' ? 'future' : 'spot';
            }
          }
          
          if (record.leg2 && record.leg2 !== null) {
            agg[strategyId].leg2Exchange = record.leg2.exchange || agg[strategyId].leg2Exchange;
            agg[strategyId].leg2Symbol = record.leg2.symbol || agg[strategyId].leg2Symbol;
            agg[strategyId].leg2Side = record.leg2.side || agg[strategyId].leg2Side;
            // 轉換category為type（linear -> future, spot -> spot）
            if (record.leg2.type) {
              agg[strategyId].leg2Type = record.leg2.type === 'linear' ? 'future' : 'spot';
            } else if (record.leg2.category) {
              agg[strategyId].leg2Type = record.leg2.category === 'linear' ? 'future' : 'spot';
            }
          }
          
          // 更新其他信息（優先使用記錄中的信息，因為它更準確）
          if (record.sliceQty && record.sliceQty > 0) {
            agg[strategyId].sliceQty = record.sliceQty;
          }
          if (record.totalAmount && record.totalAmount > 0) {
            agg[strategyId].totalAmount = record.totalAmount;
          }
          if (record.orderCount && record.orderCount > 0) {
            agg[strategyId].orderCount = record.orderCount;
          }
          if (record.intervalMs && record.intervalMs > 0) {
            agg[strategyId].timeInterval = record.intervalMs;
          }
        } else {
          // 舊格式：單腿記錄
          const isSuccess = record.success === true;
          console.log(`🦵 處理腿執行記錄 - 策略ID: ${strategyId}, 成功: ${isSuccess}, legIndex: ${record.legIndex}, sliceIndex: ${record.sliceIndex}, type: ${record.type}`);
          if (isSuccess) {
            agg[strategyId].totalQty += record.amount || record.qty || 0;
          }
          agg[strategyId].totalExecutions += 1;
          
          // 從執行記錄中提取類型信息
          if (record.legIndex === 0) {
            agg[strategyId].leg1Type = record.type;
            agg[strategyId].leg1Side = record.side;
            if (record.exchange) {
              agg[strategyId].leg1Exchange = record.exchange;
            }
          } else if (record.legIndex === 1) {
            agg[strategyId].leg2Type = record.type;
            agg[strategyId].leg2Side = record.side;
            if (record.exchange) {
              agg[strategyId].leg2Exchange = record.exchange;
            }
          }
        }
      }
      
      // 處理策略級別的記錄（完成/取消/失敗）
      if (isStrategyLevelRecord) {
        agg[strategyId].status = record.executionType;
        console.log(`📋 處理策略級別記錄 - ID: ${strategyId}, 類型: ${record.executionType}`);
        
        // 如果策略完成且有成交記錄，使用策略的配置信息
        if (record.executionType === '完成' && record.success) {
          // 從策略獲取總數量和執行次數
          const strategy = strategies.find(s => s.id === strategyId);
          if (strategy) {
            console.log(`✅ 策略完成 - ID: ${strategyId}, 策略配置:`, strategy);
            // 策略完成時，使用策略配置的信息
            agg[strategyId].totalQty = strategy.totalAmount || record.amount || 0;
            // 注意：不要覆蓋 successCount，讓後面的邏輯基於實際腿執行記錄計算
            // 注意：不要覆蓋已經累加的 totalExecutions，即使為 0 也不覆蓋
            // 因為腿執行記錄可能還沒有被處理，或者策略配置獲取失敗
          }
        }
      }
    });
    
    // 基於實際腿執行記錄計算成功次數
    Object.values(agg).forEach((item: any) => {
      if (item.totalExecutions > 0) {
        // 成功次數 = 總腿執行數 / 2（每次執行包含兩腿）
        item.successCount = Math.floor(item.totalExecutions / 2);
        console.log(`📊 策略 ${item.strategyId} - 總腿執行: ${item.totalExecutions}, 成功次數: ${item.successCount}, 策略配置:`, item.strategy);
      } else {
        console.log(`⚠️ 策略 ${item.strategyId} - 沒有腿執行記錄, 策略配置:`, item.strategy);
      }
    });
    
    const result = Object.values(agg).sort((a: any, b: any) => b.timestamp - a.timestamp);
    console.log('✅ 聚合完成，結果:', result);
    
    // 調試日誌：檢查特定策略的聚合結果
    debugPlanIds.forEach(planId => {
      const planResult = result.find((r: any) => r.strategyId === planId);
      if (planResult) {
        console.log(`🎯 ${planId} 聚合結果:`, {
          status: planResult.status,
          successCount: planResult.successCount,
          totalExecutions: planResult.totalExecutions,
          orderCount: planResult.orderCount,
          totalQty: planResult.totalQty
        });
      } else {
        console.warn(`⚠️ ${planId} 未在聚合結果中找到！`);
      }
    });
    
    return result;
  })();

  // 執行記錄表格列定義（按策略聚合）
  const executionColumns = [
    {
      title: '時間',
      key: 'timestamp',
      render: (_: any, record: any) => (
        <Text style={{ fontSize: '12px' }}>
          {new Date(record.timestamp).toLocaleString('zh-TW', {
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false
          })}
        </Text>
      ),
      width: 140,
    },
    {
      title: '策略ID',
      key: 'strategyId',
      render: (_: any, record: any) => (
        <Tooltip title={record.strategyId}>
          <Text code style={{ fontSize: '11px' }}>
            {record.strategyId.slice(-8)}
          </Text>
        </Tooltip>
      ),
    },
    {
      title: '交易對',
      key: 'pair',
      render: (_: any, record: any) => {
        const leg1Sym = record?.leg1Symbol || '-';
        const leg2Sym = record?.leg2Symbol || '-';
        const leg1Type = record?.leg1Type || 'spot';
        const leg2Type = record?.leg2Type || 'spot';
        const leg1Exchange = record?.leg1Exchange || 'Bybit';
        const leg2Exchange = record?.leg2Exchange || 'Bybit';
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
      },
    },
    {
      title: '數量',
      key: 'amount',
      render: (_: any, record: any) => {
        const symbol = record.leg1Symbol || 'BTCUSDT';
        // 數量顯示單腿的總執行數量
        const displayAmount = record.totalAmount || record.totalQty;
        return (
          <Space direction="vertical" size={0}>
            <Text strong>
              {formatAmountWithCurrency(displayAmount, symbol)}
            </Text>
            {record.successCount > 0 && (
              <Text type="secondary" style={{ fontSize: '11px' }}>
                單次: {formatAmountWithCurrency(record.sliceQty, symbol)}
              </Text>
            )}
          </Space>
        );
      },
    },
    {
      title: '執行次數',
      key: 'executions',
      render: (_: any, record: any) => {
        const successCount = record.successCount || 0;
        const totalLegs = record.totalExecutions || 0;
        const targetCount = record.orderCount || 0;
        
        // 計算成功的策略執行次數
        // 始終使用基於腿執行記錄計算的成功次數
        const successfulOrders = successCount;
        
        // 如果策略配置獲取失敗（targetCount 為 0），使用實際執行次數作為預設執行次數
        const displayTargetCount = targetCount > 0 ? targetCount : successfulOrders;
        
        return (
          <Space direction="vertical" size={0}>
            <Text strong style={{ color: successfulOrders > 0 ? '#52c41a' : undefined }}>
              {successfulOrders}/{displayTargetCount}
            </Text>
            {totalLegs > 0 && (
              <Text type="secondary" style={{ fontSize: '10px' }}>
                ({totalLegs} 腿執行)
              </Text>
            )}
          </Space>
        );
      },
    },
    {
      title: '執行參數',
      key: 'params',
      render: (_: any, record: any) => {
        // 修復時間間隔顯示邏輯
        let intervalSeconds = 0;
        
        // 優先使用策略配置中的時間間隔
        if (record.timeInterval && record.timeInterval > 0) {
          // 如果 timeInterval 大於等於 1000，說明是毫秒，需要轉換為秒
          if (record.timeInterval >= 1000) {
            intervalSeconds = Math.round(record.timeInterval / 1000);
          } else {
            // 如果小於 1000，說明已經是秒為單位
            intervalSeconds = record.timeInterval;
          }
        }
        
        // 如果策略配置中的時間間隔為 0 或無效，嘗試從執行記錄計算實際間隔
        if (intervalSeconds === 0) {
          // 獲取該策略的所有執行記錄
          const strategyExecutions = allExecutions.filter((exec: any) => 
            exec.strategyId === record.strategyId && exec.legIndex === 0
          ).sort((a: any, b: any) => a.timestamp - b.timestamp);
          
          if (strategyExecutions.length >= 2) {
            // 計算前兩次執行的間隔
            const interval = strategyExecutions[1].timestamp - strategyExecutions[0].timestamp;
            intervalSeconds = Math.round(interval / 1000);
          }
        }
        
        // 如果仍然無法獲取間隔，使用預設值
        if (intervalSeconds === 0) {
          intervalSeconds = 10; // 預設10秒
        }
        
        return (
          <Text style={{ fontSize: '11px' }}>
            間隔: {intervalSeconds}秒
          </Text>
        );
      },
    },
    {
      title: '成交價',
      key: 'prices',
      render: (_: any, record: any) => {
        // 獲取該策略的成交價格信息
        const strategyExecutions = allExecutions.filter((exec: any) => 
          exec.strategyId === record.strategyId && exec.price && exec.price > 0
        );
        
        if (strategyExecutions.length === 0) {
          return <Text type="secondary" style={{ fontSize: '11px' }}>-</Text>;
        }
        
        // 計算平均成交價
        const leg1Prices = strategyExecutions.filter((exec: any) => exec.legIndex === 0).map((exec: any) => exec.price);
        const leg2Prices = strategyExecutions.filter((exec: any) => exec.legIndex === 1).map((exec: any) => exec.price);
        
        const avgLeg1Price = leg1Prices.length > 0 ? leg1Prices.reduce((sum, price) => sum + price, 0) / leg1Prices.length : 0;
        const avgLeg2Price = leg2Prices.length > 0 ? leg2Prices.reduce((sum, price) => sum + price, 0) / leg2Prices.length : 0;
        
        return (
          <Space direction="vertical" size={0}>
            {avgLeg1Price > 0 && (
              <Text style={{ fontSize: '11px' }}>
                Leg1: {avgLeg1Price.toFixed(4)}
              </Text>
            )}
            {avgLeg2Price > 0 && (
              <Text style={{ fontSize: '11px' }}>
                Leg2: {avgLeg2Price.toFixed(4)}
              </Text>
            )}
          </Space>
        );
      },
    },
    {
      title: '狀態',
      key: 'status',
      render: (_: any, record: any) => {
        const statusMap: Record<string, { text: string; color: string }> = {
          '完成': { text: '完成', color: 'success' },
          'completed': { text: '完成', color: 'success' },
          'success': { text: '成功', color: 'success' }, // ✅ 執行成功
          '錯誤': { text: '錯誤', color: 'error' },
          'cancelled': { text: '手動刪除', color: 'warning' }, // ✅ 手動取消/刪除
          '失敗': { text: '失敗', color: 'error' },
          'failed': { text: '失敗', color: 'error' }, // ✅ 執行失敗
          'rolled_back': { text: '失敗', color: 'error' }, // ✅ 回滾狀態併入失敗
          'running': { text: '執行中', color: 'processing' },
          'paused': { text: '暫停', color: 'default' },
        };
        
        const statusInfo = statusMap[record.status] || { text: record.status, color: 'default' };
        
        return (
          <Tag color={statusInfo.color}>
            {statusInfo.text}
          </Tag>
        );
      },
    },
  ];

  return (
    <div style={{ background: '#0b0e11', minHeight: '100vh' }}>
      {/* 頁面標題 */}
      <div style={{ marginBottom: 24 }}>
        <Space align="center" style={{ width: '100%', justifyContent: 'space-between' }}>
          <Title level={2} style={{ margin: 0, color: '#fff' }}>
            ⏰ TWAP策略管理
          </Title>
          <Space>
            <Button 
              icon={<ReloadOutlined />} 
              onClick={fetchTwapData}
            >
              刷新
            </Button>
            <Button 
              type="primary" 
              icon={<PlusOutlined />}
              onClick={() => {
                setEditingStrategy(null);
                form.resetFields();
                setLeg1Exchange('bybit');
                setLeg2Exchange('bybit');
                setIsModalVisible(true);
              }}
              disabled={!isConnected}
            >
              新建策略
            </Button>
          </Space>
        </Space>
      </div>

      {/* 連接狀態提示 */}
      {!isConnected && (
        <Alert
          message="系統未連接"
          description="請檢查網路連接，無法創建TWAP策略"
          type="warning"
          showIcon
          style={{ marginBottom: 24 }}
        />
      )}

  

      {/* TWAP策略列表 */}
      <Row gutter={[16, 16]}>
        <Col span={24}>
          <Card title="📋 TWAP策略列表" className="card-shadow">
            <Table
              columns={strategyColumns}
              dataSource={strategies.filter(strategy => 
                strategy.status !== 'completed' && 
                strategy.status !== 'cancelled' && 
                strategy.status !== 'failed'
              )}
              rowKey="id"
              loading={loading}
              scroll={{ x: 1000 }}
              locale={{ emptyText: '暫無TWAP策略，點擊上方按鈕創建' }}
            />
          </Card>
        </Col>
      </Row>

      {/* 執行記錄 */}
      <Row style={{ marginTop: 16 }}>
        <Col span={24}>
          <Card 
            title={<Space><span>📊 執行記錄</span><Tag color="blue">按策略聚合</Tag></Space>}
            className="card-shadow"
          >
            <Table
              columns={executionColumns}
              dataSource={aggregatedExecutions.filter((record: any) => record && record.strategyId)}
              rowKey={(record: any) => {
                try {
                  if (!record || typeof record !== 'object') {
                    return `fallback_${Math.random().toString(36).substr(2, 9)}`;
                  }
                  return record.strategyId || `strategy_${record.timestamp || Date.now()}` || `fallback_${Math.random().toString(36).substr(2, 9)}`;
                } catch (error) {
                  console.error('rowKey error:', error, record);
                  return `error_${Math.random().toString(36).substr(2, 9)}`;
                }
              }}
              size="small"
              pagination={{ pageSize: 10 }}
              locale={{ emptyText: '暫無執行記錄' }}
            />
          </Card>
        </Col>
      </Row>

      {/* 添加/編輯對話框 */}
      <Modal
        title={editingStrategy ? '編輯TWAP策略' : '新建TWAP策略'}
        open={isModalVisible}
        onCancel={() => {
          setIsModalVisible(false);
          setEditingStrategy(null);
          form.resetFields();
          setLeg1Exchange('bybit');
          setLeg2Exchange('bybit');
        }}
        footer={null}
        width={600}
      >
        <Alert
          message="TWAP 策略配置說明"
          description="建議配置為現貨+合約組合：Leg 1 選擇現貨，Leg 2 選擇合約，這樣可以實現現貨與合約之間的價差套利。"
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
        />
        <Form
          form={form}
          layout="vertical"
          onFinish={handleSubmit}
          initialValues={{
            leg1_exchange: 'bybit',
            leg1_type: 'spot',
            leg1_side: 'buy',
            leg1_symbol: ['BTCUSDT'], // 使用數組以支持 mode="tags"
            leg2_exchange: 'bybit',
            leg2_type: 'future',
            leg2_side: 'sell',
            leg2_symbol: ['BTCUSDT'], // 使用數組以支持 mode="tags"
            enabled: true,
            timeInterval: 10,
            orderCount: 2,
            sliceQty: 0.01,
          }}
        >
          <Row gutter={16}>
            <Col span={12}>
              <Card title="Leg 1 配置 (建議：現貨)" size="small">
                <Form.Item
                  name="leg1_exchange"
                  label="交易所"
                  rules={[{ required: true, message: '請選擇交易所' }]}
                >
                  <Select 
                    placeholder="選擇交易所"
                    onChange={(value) => {
                      setLeg1Exchange(value);
                      // 如果選擇了 Bitget 且當前是現貨，自動切換為合約
                      if (value === 'bitget' && form.getFieldValue('leg1_type') === 'spot') {
                        form.setFieldsValue({ leg1_type: 'future' });
                        message.info('Bitget 僅支援合約交易，已自動切換為合約');
                      }
                    }}
                  >
                    {availableExchanges.map(exchange => (
                      <Option key={exchange.key} value={exchange.key}>
                        {exchange.name}
                        {exchange.key === 'bitget' && <span style={{ color: '#faad14', marginLeft: 4 }}>(僅合約)</span>}
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
                      // 如果選擇了現貨但交易所是 Bitget，提示錯誤
                      const exchange = form.getFieldValue('leg1_exchange');
                      if (value === 'spot' && exchange === 'bitget') {
                        message.warning('Bitget 不支援現貨交易，請選擇合約');
                        form.setFieldsValue({ leg1_type: 'future' });
                      }
                    }}
                  >
                    <Option value="future">線性合約</Option>
                    <Option 
                      value="spot" 
                      disabled={leg1Exchange === 'bitget'}
                    >
                      現貨
                      {leg1Exchange === 'bitget' && 
                        <span style={{ color: '#ff4d4f', marginLeft: 4 }}>(Bitget 不支援)</span>
                      }
                    </Option>
                  </Select>
                </Form.Item>

                <Form.Item
                  name="leg1_symbol"
                  label="交易對"
                  rules={[
                    { required: true, message: '請輸入交易對' },
                    { 
                      pattern: /^[A-Z0-9]+[A-Z0-9]*$/i, 
                      message: '請輸入正確的交易對格式，如：BTCUSDT' 
                    }
                  ]}
                  extra="請輸入交易對符號，如：BTCUSDT, ETHUSDT 等"
                >
                  <Select 
                    placeholder="選擇或輸入交易對"
                    showSearch
                    allowClear
                    mode="tags" // 允許自定義輸入
                    tokenSeparators={[',']} // 允許使用逗號分隔
                    maxTagCount={1} // 只顯示一個標籤
                    filterOption={(input, option) => {
                      if (!option?.children) return false;
                      const children = String(option.children);
                      return children.toLowerCase().includes(input.toLowerCase());
                    }}
                    onChange={(value) => {
                      // 確保只有一個值
                      if (Array.isArray(value) && value.length > 0) {
                        const symbol = value[value.length - 1].toUpperCase(); // 轉為大寫
                        form.setFieldsValue({ leg1_symbol: symbol });
                        
                        // 同步更新 leg2 的交易對，保持一致
                        if (form.getFieldValue('leg2_symbol') === form.getFieldValue('leg1_symbol')) {
                          form.setFieldsValue({ leg2_symbol: symbol });
                        }
                      }
                    }}
                  >
                    {availableSymbols.map(symbol => (
                      <Option key={`leg1_${symbol}`} value={symbol}>{symbol}</Option>
                    ))}
                  </Select>
                </Form.Item>

                <Form.Item
                  name="leg1_side"
                  label="交易方向"
                  rules={[{ required: true, message: '請選擇交易方向' }]}
                >
                  <Select placeholder="選擇方向">
                    <Option value="buy">買入</Option>
                    <Option value="sell">賣出</Option>
                  </Select>
                </Form.Item>
              </Card>
            </Col>

            <Col span={12}>
              <Card title="Leg 2 配置 (建議：合約)" size="small">
                <Form.Item
                  name="leg2_exchange"
                  label="交易所"
                  rules={[{ required: true, message: '請選擇交易所' }]}
                >
                  <Select 
                    placeholder="選擇交易所"
                    onChange={(value) => {
                      setLeg2Exchange(value);
                      // 如果選擇了 Bitget 且當前是現貨，自動切換為合約
                      if (value === 'bitget' && form.getFieldValue('leg2_type') === 'spot') {
                        form.setFieldsValue({ leg2_type: 'future' });
                        message.info('Bitget 僅支援合約交易，已自動切換為合約');
                      }
                    }}
                  >
                    {availableExchanges.map(exchange => (
                      <Option key={exchange.key} value={exchange.key}>
                        {exchange.name}
                        {exchange.key === 'bitget' && <span style={{ color: '#faad14', marginLeft: 4 }}>(僅合約)</span>}
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
                      // 如果選擇了現貨但交易所是 Bitget，提示錯誤
                      const exchange = form.getFieldValue('leg2_exchange');
                      if (value === 'spot' && exchange === 'bitget') {
                        message.warning('Bitget 不支援現貨交易，請選擇合約');
                        form.setFieldsValue({ leg2_type: 'future' });
                      }
                    }}
                  >
                    <Option value="future">線性合約</Option>
                    <Option 
                      value="spot" 
                      disabled={leg2Exchange === 'bitget'}
                    >
                      現貨
                      {leg2Exchange === 'bitget' && 
                        <span style={{ color: '#ff4d4f', marginLeft: 4 }}>(Bitget 不支援)</span>
                      }
                    </Option>
                  </Select>
                </Form.Item>

                <Form.Item
                  name="leg2_symbol"
                  label="交易對"
                  rules={[
                    { required: true, message: '請輸入交易對' },
                    { 
                      pattern: /^[A-Z0-9]+[A-Z0-9]*$/i, 
                      message: '請輸入正確的交易對格式，如：BTCUSDT' 
                    }
                  ]}
                  extra="請輸入交易對符號，如：BTCUSDT, ETHUSDT 等"
                >
                  <Select 
                    placeholder="選擇或輸入交易對"
                    showSearch
                    allowClear
                    mode="tags" // 允許自定義輸入
                    tokenSeparators={[',']} // 允許使用逗號分隔
                    maxTagCount={1} // 只顯示一個標籤
                    filterOption={(input, option) => {
                      if (!option?.children) return false;
                      const children = String(option.children);
                      return children.toLowerCase().includes(input.toLowerCase());
                    }}
                    onChange={(value) => {
                      // 確保只有一個值
                      if (Array.isArray(value) && value.length > 0) {
                        const symbol = value[value.length - 1].toUpperCase(); // 轉為大寫
                        form.setFieldsValue({ leg2_symbol: symbol });
                      }
                    }}
                  >
                    {availableSymbols.map(symbol => (
                      <Option key={`leg2_${symbol}`} value={symbol}>{symbol}</Option>
                    ))}
                  </Select>
                </Form.Item>

                <Form.Item
                  name="leg2_side"
                  label="交易方向"
                  rules={[{ required: true, message: '請選擇交易方向' }]}
                >
                  <Select placeholder="選擇方向">
                    <Option value="buy">買入</Option>
                    <Option value="sell">賣出</Option>
                  </Select>
                </Form.Item>
              </Card>
            </Col>
          </Row>

          <Divider />

          {/* 僅允許市價單，UI 不提供切換 */}

          {/* 固定使用市價單，不顯示選擇 */}

          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                name="sliceQty"
                label="單次數量"
                rules={[{ required: true, message: '請輸入單次數量' }]}
                extra="每次執行的下單數量"
              >
                <InputNumber
                  min={0.0001}
                  step={0.0001}
                  style={{ width: '100%' }}
                  placeholder="0.001"
                  addonAfter="幣"
                />
              </Form.Item>
            </Col>

            <Col span={12}>
              <Form.Item
                name="orderCount"
                label="執行次數"
                rules={[{ required: true, message: '請輸入執行次數' }]}
                extra="總共執行多少次"
              >
                <InputNumber
                  min={1}
                  max={100}
                  step={1}
                  style={{ width: '100%' }}
                  placeholder="2"
                />
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                name="timeInterval"
                label="執行間隔 (秒)"
                rules={[{ required: true, message: '請輸入執行間隔' }]}
              >
                <InputNumber
                  min={1}
                  max={3600}
                  step={1}
                  style={{ width: '100%' }}
                  placeholder="10"
                />
              </Form.Item>
            </Col>

            <Col span={12}>
              <Form.Item
                name="enabled"
                label="立即啟用"
                valuePropName="checked"
                initialValue={true}
              >
                <Switch checkedChildren="是" unCheckedChildren="否" />
              </Form.Item>
            </Col>
          </Row>

          <Form.Item style={{ marginBottom: 0, textAlign: 'right' }}>
            <Space>
              <Button onClick={() => setIsModalVisible(false)}>
                取消
              </Button>
              <Button type="primary" htmlType="submit" loading={loading}>
                {editingStrategy ? '更新' : '創建'}
              </Button>
            </Space>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default TwapPage;
