/**
 * 本地存儲工具
 * 提供數據持久化功能
 */

const STORAGE_KEYS = {
  MONITORING_PAIRS: 'arbitrage_monitoring_pairs',
  ARBITRAGE_OPPORTUNITIES: 'arbitrage_opportunities',
  RECENT_EXECUTIONS: 'arbitrage_recent_executions',
  TWAP_STRATEGIES: 'twap_strategies',
  SYSTEM_SETTINGS: 'system_settings',
  UI_HIDDEN_POSITIONS: 'ui_hidden_positions',
} as const;

export const storage = {
  // 保存數據到 localStorage
  save: <T>(key: string, data: T): void => {
    try {
      localStorage.setItem(key, JSON.stringify(data));
    } catch (error) {
      console.error('保存數據失敗:', error);
    }
  },

  // 從 localStorage 讀取數據
  load: <T>(key: string, defaultValue: T): T => {
    try {
      const item = localStorage.getItem(key);
      return item ? JSON.parse(item) : defaultValue;
    } catch (error) {
      console.error('讀取數據失敗:', error);
      return defaultValue;
    }
  },

  // 移除數據
  remove: (key: string): void => {
    try {
      localStorage.removeItem(key);
    } catch (error) {
      console.error('移除數據失敗:', error);
    }
  },

  // 清空所有相關數據
  clear: (): void => {
    Object.values(STORAGE_KEYS).forEach(key => {
      storage.remove(key);
    });
  },

  // 清空所有 localStorage 數據（包括非應用程式數據）
  clearAll: (): void => {
    try {
      localStorage.clear();
    } catch (error) {
      console.error('清空所有數據失敗:', error);
    }
  },

  // 獲取存儲鍵
  keys: STORAGE_KEYS,
};

export default storage;
