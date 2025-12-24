/**
 * 資料清空服務
 * 提供前後端資料清空功能
 */

// apiService 不再使用，直接使用 axios 實例
import storage from '../utils/storage';
import { store } from '../store';
import { clearAllArbitrageData } from '../store/slices/arbitrageSlice';
import { clearAllTwapData } from '../store/slices/twapSlice';
import { clearAllPricesData } from '../store/slices/pricesSlice';
import { clearAllSystemData } from '../store/slices/systemSlice';
import logger from '../utils/logger';

export class ClearDataService {
  /**
   * 清空所有前端資料
   */
  static clearFrontendData(): void {
    try {
      // 清空 Redux 狀態
      store.dispatch(clearAllArbitrageData());
      store.dispatch(clearAllTwapData());
      store.dispatch(clearAllPricesData());
      store.dispatch(clearAllSystemData());
      
      // 清空 localStorage
      storage.clearAll();
      
      logger.info('前端資料已清空', {}, 'ClearDataService');
    } catch (error) {
      logger.error('清空前端資料失敗', error, 'ClearDataService');
      throw error;
    }
  }

  /**
   * 清空所有後端資料
   */
  static async clearBackendData(): Promise<void> {
    try {
      // 使用 axios 實例直接呼叫 API
      const api = await import('./api').then(module => module.default);
      const response = await api.post('/api/arbitrage/clear-all-data');
      
      // axios 攔截器會將 response.data 作為返回值
      const data = response as any;
      if (data && data.success) {
        logger.info('後端資料已清空', data, 'ClearDataService');
      } else {
        throw new Error('後端資料清空失敗');
      }
    } catch (error) {
      logger.error('清空後端資料失敗', error, 'ClearDataService');
      throw error;
    }
  }

  /**
   * 清空所有資料（前後端）
   */
  static async clearAllData(): Promise<void> {
    try {
      // 先清空後端資料
      await this.clearBackendData();
      
      // 再清空前端資料
      this.clearFrontendData();
      
      logger.info('所有資料已清空', {}, 'ClearDataService');
    } catch (error) {
      logger.error('清空所有資料失敗', error, 'ClearDataService');
      throw error;
    }
  }

  /**
   * 重新啟動時清空資料
   */
  static async clearDataOnRestart(): Promise<void> {
    try {
      logger.info('重新啟動時清空資料', {}, 'ClearDataService');
      await this.clearAllData();
    } catch (error) {
      logger.error('重新啟動時清空資料失敗', error, 'ClearDataService');
      // 即使清空失敗，也不要阻止應用程式啟動
    }
  }
}

export default ClearDataService;
