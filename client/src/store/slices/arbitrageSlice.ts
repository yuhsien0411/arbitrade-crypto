/**
 * 套利交易狀態管理
 */

import { createSlice, PayloadAction, createAsyncThunk } from '@reduxjs/toolkit';
import { apiService } from '../../services/api';
import logger from '../../utils/logger';
import storage from '../../utils/storage';
import type { 
  PairConfig, 
  ArbitrageOpportunity, 
  ArbitrageExecution
} from '../../types/arbitrage';

// 向後兼容的型別別名
/** @deprecated 使用 PairConfig 替代 */
interface ArbitragePair extends PairConfig {
  amount: number;  // 向後兼容，等同於 qty
  // 新增參數（向後兼容）
  totalAmount?: number;
  consumedAmount?: number;
}

// ArbitrageOpportunity 和 ArbitrageExecution 已在 types/arbitrage.ts 中定義

interface ArbitrageState {
  monitoringPairs: ArbitragePair[];
  currentOpportunities: ArbitrageOpportunity[];
  recentExecutions: ArbitrageExecution[];
  isAutoExecuteEnabled: boolean;
  executionHistory: ArbitrageExecution[];
}

// 從本地存儲載入初始數據
const loadInitialState = (): ArbitrageState => {
  try {
    // 檢查是否是重新啟動
    const isRestart = sessionStorage.getItem('app_just_started') !== 'true';
    sessionStorage.setItem('app_just_started', 'true');
    
    // 如果是重新啟動，則清空監控對和機會數據，但保留執行記錄
    if (isRestart) {
      console.log('系統重新啟動，清空監控對和機會數據，保留執行記錄');
      storage.remove(storage.keys.MONITORING_PAIRS);
      storage.remove(storage.keys.ARBITRAGE_OPPORTUNITIES);
      // 不清除 RECENT_EXECUTIONS，讓執行記錄永久保存
      
      // 載入執行記錄
      const rawExecutions = storage.load(storage.keys.RECENT_EXECUTIONS, []);
      const validExecutions = Array.isArray(rawExecutions)
        ? rawExecutions.filter((exec: any) => 
            exec && 
            typeof exec === 'object' && 
            exec.opportunity
          ).slice(0, 20)
        : [];
      
      return {
        monitoringPairs: [],
        currentOpportunities: [],
        recentExecutions: validExecutions,
        isAutoExecuteEnabled: false,
        executionHistory: [],
      };
    }
    
    const rawPairs = storage.load(storage.keys.MONITORING_PAIRS, []);
    const rawOpportunities = storage.load(storage.keys.ARBITRAGE_OPPORTUNITIES, []);
    const rawExecutions = storage.load(storage.keys.RECENT_EXECUTIONS, []);
    
    // 驗證並過濾監控交易對數據
    const validPairs = Array.isArray(rawPairs) 
      ? rawPairs.filter((pair: any) => 
          pair && 
          typeof pair === 'object' && 
          pair.leg1 && 
          typeof pair.leg1 === 'object' && 
          pair.leg2 && 
          typeof pair.leg2 === 'object' &&
          pair.id
        )
      : [];
    
    // 驗證並過濾機會數據
    const validOpportunities = Array.isArray(rawOpportunities)
      ? rawOpportunities.filter((opp: any) => 
          opp && 
          typeof opp === 'object' && 
          opp.id
        )
      : [];
    
    // 驗證並過濾執行記錄
    const validExecutions = Array.isArray(rawExecutions)
      ? rawExecutions.filter((exec: any) => 
          exec && 
          typeof exec === 'object' && 
          exec.opportunity
        ).slice(0, 20)  // 只保留最新20筆
      : [];
    
    return {
      monitoringPairs: validPairs,
      currentOpportunities: validOpportunities,
      recentExecutions: validExecutions,
      isAutoExecuteEnabled: false,
      executionHistory: [],
    };
  } catch (error) {
    console.error('載入初始狀態失敗:', error);
    return {
      monitoringPairs: [],
      currentOpportunities: [],
      recentExecutions: [],
      isAutoExecuteEnabled: false,
      executionHistory: [],
    };
  }
};

const initialState: ArbitrageState = loadInitialState();

export const addWatchPairThunk = createAsyncThunk(
  'arbitrage/addWatchPair',
  async (payload: any, { rejectWithValue }) => {
    try {
      logger.info('開始添加監控交易對', payload, 'Redux');
      const res = await apiService.addWatchPair(payload);
      logger.info('添加監控交易對響應', res, 'Redux');
      if ((res as any)?.success === false) {
        return rejectWithValue((res as any)?.error || '添加失敗');
      }
      return (res as any).data || res;
    } catch (e: any) {
      logger.error('添加監控交易對失敗', e, 'Redux');
      return rejectWithValue(e.message || '添加失敗');
    }
  }
);

const arbitrageSlice = createSlice({
  name: 'arbitrage',
  initialState,
  reducers: {
    addMonitoringPair: (state, action: PayloadAction<ArbitragePair>) => {
      const existingIndex = state.monitoringPairs.findIndex(p => p.id === action.payload.id);
      if (existingIndex >= 0) {
        state.monitoringPairs[existingIndex] = action.payload;
      } else {
        state.monitoringPairs.push(action.payload);
      }
      // 保存到本地存儲
      storage.save(storage.keys.MONITORING_PAIRS, state.monitoringPairs);
    },
    
    updateMonitoringPair: (state, action: PayloadAction<{ id: string; updates: Partial<ArbitragePair> }>) => {
      const { id, updates } = action.payload;
      const index = state.monitoringPairs.findIndex(p => p.id === id);
      if (index >= 0) {
        state.monitoringPairs[index] = { ...state.monitoringPairs[index], ...updates };
        // 保存到本地存儲
        storage.save(storage.keys.MONITORING_PAIRS, state.monitoringPairs);
      }
    },
    
    removeMonitoringPair: (state, action: PayloadAction<string>) => {
      state.monitoringPairs = state.monitoringPairs.filter(p => p.id !== action.payload);
      // 同時移除相關的機會數據
      state.currentOpportunities = state.currentOpportunities.filter(o => o.id !== action.payload);
      // 保存到本地存儲
      storage.save(storage.keys.MONITORING_PAIRS, state.monitoringPairs);
      storage.save(storage.keys.ARBITRAGE_OPPORTUNITIES, state.currentOpportunities);
    },
    
    setMonitoringPairs: (state, action: PayloadAction<ArbitragePair[]>) => {
      state.monitoringPairs = action.payload;
      // 保存到本地存儲
      storage.save(storage.keys.MONITORING_PAIRS, state.monitoringPairs);
    },
    
    updateOpportunity: (state, action: PayloadAction<ArbitrageOpportunity>) => {
      const existingIndex = state.currentOpportunities.findIndex(o => o.id === action.payload.id);
      if (existingIndex >= 0) {
        state.currentOpportunities[existingIndex] = action.payload;
      } else {
        state.currentOpportunities.push(action.payload);
      }
      // 保存到本地存儲
      storage.save(storage.keys.ARBITRAGE_OPPORTUNITIES, state.currentOpportunities);
    },
    
    setOpportunities: (state, action: PayloadAction<ArbitrageOpportunity[]>) => {
      state.currentOpportunities = action.payload;
      // 保存到本地存儲
      storage.save(storage.keys.ARBITRAGE_OPPORTUNITIES, state.currentOpportunities);
    },
    
    // 覆蓋最近執行記錄（用於手動刷新避免重複累加）
    setRecentExecutions: (state, action: PayloadAction<ArbitrageExecution[]>) => {
      const list = Array.isArray(action.payload) ? action.payload : [];
      // 僅保留最新20筆
      state.recentExecutions = list.slice(0, 20);
      // 保存到本地存儲
      storage.save(storage.keys.RECENT_EXECUTIONS, state.recentExecutions);
    },
    
    addExecution: (state, action: PayloadAction<ArbitrageExecution>) => {
      // 添加到最近執行列表
      state.recentExecutions.unshift(action.payload);
      if (state.recentExecutions.length > 20) {
        state.recentExecutions = state.recentExecutions.slice(0, 20);
      }
      // 保存到本地存儲
      storage.save(storage.keys.RECENT_EXECUTIONS, state.recentExecutions);
      
      // 添加到歷史記錄
      state.executionHistory.unshift(action.payload);
      if (state.executionHistory.length > 1000) {
        state.executionHistory = state.executionHistory.slice(0, 1000);
      }
      
      // 更新對應交易對的觸發統計
      const pairId = action.payload.opportunity.id;
      const pairIndex = state.monitoringPairs.findIndex(p => p.id === pairId);
      if (pairIndex >= 0 && state.monitoringPairs[pairIndex]) {
        state.monitoringPairs[pairIndex].lastTriggered = action.payload.timestamp;
        if (action.payload.success) {
          state.monitoringPairs[pairIndex].totalTriggers = (state.monitoringPairs[pairIndex].totalTriggers || 0) + 1;
        }
      }
    },
    
    updatePairTriggerStats: (state, action: PayloadAction<{pairId: string, totalTriggers: number, lastTriggered: number | null}>) => {
      const pairIndex = state.monitoringPairs.findIndex(p => p.id === action.payload.pairId);
      if (pairIndex >= 0) {
        state.monitoringPairs[pairIndex].totalTriggers = action.payload.totalTriggers;
        state.monitoringPairs[pairIndex].lastTriggered = action.payload.lastTriggered;
      }
    },
    
    setAutoExecute: (state, action: PayloadAction<boolean>) => {
      state.isAutoExecuteEnabled = action.payload;
    },
    
    clearExecutionHistory: (state) => {
      state.executionHistory = [];
      state.recentExecutions = [];
      // 清除本地存儲
      storage.remove(storage.keys.RECENT_EXECUTIONS);
    },
    
    // 清空所有套利資料
    clearAllArbitrageData: (state) => {
      state.monitoringPairs = [];
      state.currentOpportunities = [];
      state.recentExecutions = [];
      state.executionHistory = [];
      state.isAutoExecuteEnabled = false;
      // 清除所有本地存儲
      storage.remove(storage.keys.MONITORING_PAIRS);
      storage.remove(storage.keys.ARBITRAGE_OPPORTUNITIES);
      storage.remove(storage.keys.RECENT_EXECUTIONS);
    },
    
    // 批量更新價格數據
    updatePricesForOpportunities: (state, action: PayloadAction<Array<{ id: string; leg1Price?: any; leg2Price?: any; spread: number; spreadPercent: number }>>) => {
      action.payload.forEach(update => {
        const index = state.currentOpportunities.findIndex(o => o.id === update.id);
        if (index >= 0) {
          if (update.leg1Price) {
            state.currentOpportunities[index].leg1Price = update.leg1Price;
          }
          if (update.leg2Price) {
            state.currentOpportunities[index].leg2Price = update.leg2Price;
          }
          state.currentOpportunities[index].spread = update.spread;
          state.currentOpportunities[index].spreadPercent = update.spreadPercent;
          state.currentOpportunities[index].timestamp = Date.now();
        }
      });
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(addWatchPairThunk.fulfilled, (state, action: PayloadAction<any>) => {
        logger.info('監控交易對添加成功', action.payload, 'Redux');
        if (action.payload) {
          const pair = action.payload;
          const existingIndex = state.monitoringPairs.findIndex(p => p.id === pair.id);
          if (existingIndex >= 0) {
            state.monitoringPairs[existingIndex] = pair;
            logger.info('更新現有監控交易對', pair.id, 'Redux');
          } else {
            state.monitoringPairs.push(pair);
            logger.info('新增監控交易對', pair.id, 'Redux');
          }
        }
      });
  }
});

export const {
  addMonitoringPair,
  updateMonitoringPair,
  removeMonitoringPair,
  setMonitoringPairs,
  updateOpportunity,
  setOpportunities,
  setRecentExecutions,
  addExecution,
  setAutoExecute,
  clearExecutionHistory,
  clearAllArbitrageData,
  updatePricesForOpportunities,
  updatePairTriggerStats,
} = arbitrageSlice.actions;

export default arbitrageSlice.reducer;
