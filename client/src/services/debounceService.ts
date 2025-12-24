/**
 * API 請求防抖服務
 * 用於控制 API 請求頻率，避免過於頻繁的請求
 */

interface DebounceOptions {
  delay?: number; // 延遲時間（毫秒）
  maxCalls?: number; // 最大調用次數
  timeWindow?: number; // 時間窗口（毫秒）
}

class DebounceService {
  private static timers: Map<string, NodeJS.Timeout> = new Map();
  private static callCounts: Map<string, { count: number; resetTime: number }> = new Map();

  /**
   * 防抖函數
   * @param key 唯一標識符
   * @param fn 要執行的函數
   * @param options 配置選項
   */
  static debounce<T extends (...args: any[]) => any>(
    key: string,
    fn: T,
    options: DebounceOptions = {}
  ): T {
    const { delay = 1000, maxCalls = 10, timeWindow = 60000 } = options;

    return ((...args: any[]) => {
      // 檢查調用頻率限制
      const now = Date.now();
      const callInfo = this.callCounts.get(key);
      
      if (callInfo) {
        // 如果超過時間窗口，重置計數
        if (now - callInfo.resetTime > timeWindow) {
          callInfo.count = 0;
          callInfo.resetTime = now;
        }
        
        // 如果超過最大調用次數，忽略請求
        if (callInfo.count >= maxCalls) {
          console.warn(`API 請求頻率過高，忽略請求: ${key}`);
          return;
        }
        
        callInfo.count++;
      } else {
        this.callCounts.set(key, { count: 1, resetTime: now });
      }

      // 清除之前的定時器
      const existingTimer = this.timers.get(key);
      if (existingTimer) {
        clearTimeout(existingTimer);
      }

      // 設置新的定時器
      const timer = setTimeout(() => {
        fn(...args);
        this.timers.delete(key);
      }, delay);

      this.timers.set(key, timer);
    }) as T;
  }

  /**
   * 立即執行（取消防抖）
   * @param key 唯一標識符
   */
  static flush(key: string): void {
    const timer = this.timers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(key);
    }
  }

  /**
   * 取消防抖
   * @param key 唯一標識符
   */
  static cancel(key: string): void {
    this.flush(key);
  }

  /**
   * 清理所有定時器
   */
  static cleanup(): void {
    this.timers.forEach(timer => clearTimeout(timer));
    this.timers.clear();
    this.callCounts.clear();
  }
}

export default DebounceService;
