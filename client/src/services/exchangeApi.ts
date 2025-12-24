/**
 * 交易所直接 API 調用服務
 * 前端直接調用交易所 API，減少後端負載
 */

import axios from 'axios';
import logger from '../utils/logger';

// 創建 axios 實例（公共 API，不需要認證）
const createExchangeClient = (baseURL: string, exchangeName: string) => {
  const client = axios.create({
    baseURL,
    timeout: 5000,
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'ArbitrageBot/1.0.0'
    },
  });

  // 添加請求攔截器
  client.interceptors.request.use(
    (config) => {
      logger.info(`${exchangeName} Request`, {
        method: config.method?.toUpperCase(),
        url: config.url,
        baseURL: config.baseURL,
        fullURL: `${config.baseURL}${config.url}`,
        params: config.params,
        timestamp: new Date().toISOString()
      }, exchangeName);
      return config;
    },
    (error) => {
      logger.error(`${exchangeName} Request Error`, error, exchangeName);
      return Promise.reject(error);
    }
  );

  // 添加響應攔截器
  client.interceptors.response.use(
    (response) => {
      logger.info(`${exchangeName} Response`, {
        method: response.config.method?.toUpperCase(),
        url: response.config.url,
        status: response.status,
        statusText: response.statusText,
        data: response.data,
        timestamp: new Date().toISOString()
      }, exchangeName);
      return response;
    },
    (error) => {
      logger.error(`${exchangeName} Response Error`, {
        method: error.config?.method?.toUpperCase() || 'UNKNOWN',
        url: error.config?.url || 'UNKNOWN',
        status: error.response?.status || 'NO_RESPONSE',
        statusText: error.response?.statusText || 'NETWORK_ERROR',
        message: error.message,
        responseData: error.response?.data,
        timestamp: new Date().toISOString()
      }, exchangeName);
      return Promise.reject(error);
    }
  );

  return client;
};

// Bybit 公共 API 客戶端
const bybitClient = createExchangeClient('https://api.bybit.com', 'Bybit');

// Binance 公共 API 客戶端
const binanceClient = createExchangeClient('https://api.binance.com', 'Binance');

export interface TickerData {
  symbol: string;
  bidPrice: number;
  askPrice: number;
  lastPrice: number;
  volume: number;
  timestamp: number;
}

export interface OrderBookData {
  symbol: string;
  bids: [number, number][];
  asks: [number, number][];
  timestamp: number;
}

export const exchangeApi = {
  // Bybit API
  bybit: {
    // 獲取 ticker 數據
    getTicker: async (symbol: string): Promise<TickerData> => {
      try {
        const response = await bybitClient.get('/v5/market/tickers', {
          params: {
            category: 'spot',
            symbol: symbol
          }
        });

        const ticker = response.data.result.list[0];
        return {
          symbol: ticker.symbol,
          bidPrice: parseFloat(ticker.bid1Price),
          askPrice: parseFloat(ticker.ask1Price),
          lastPrice: parseFloat(ticker.lastPrice),
          volume: parseFloat(ticker.volume24h),
          timestamp: parseInt(ticker.time)
        };
      } catch (error) {
        console.error('Bybit ticker 獲取失敗:', error);
        throw error;
      }
    },

    // 獲取訂單簿數據
    getOrderBook: async (symbol: string, limit: number = 25): Promise<OrderBookData> => {
      try {
        const response = await bybitClient.get('/v5/market/orderbook', {
          params: {
            category: 'spot',
            symbol: symbol,
            limit: limit
          }
        });

        const orderBook = response.data.result;
        return {
          symbol: orderBook.s,
          bids: orderBook.b.map(([price, size]: [string, string]) => [parseFloat(price), parseFloat(size)]),
          asks: orderBook.a.map(([price, size]: [string, string]) => [parseFloat(price), parseFloat(size)]),
          timestamp: parseInt(orderBook.ts)
        };
      } catch (error) {
        console.error('Bybit orderbook 獲取失敗:', error);
        throw error;
      }
    }
  },

  // Binance API
  binance: {
    // 獲取 ticker 數據
    getTicker: async (symbol: string): Promise<TickerData> => {
      try {
        const response = await binanceClient.get('/api/v3/ticker/bookTicker', {
          params: {
            symbol: symbol
          }
        });

        const ticker = response.data;
        return {
          symbol: ticker.symbol,
          bidPrice: parseFloat(ticker.bidPrice),
          askPrice: parseFloat(ticker.askPrice),
          lastPrice: 0, // Binance bookTicker 不提供 lastPrice
          volume: 0, // Binance bookTicker 不提供 volume
          timestamp: Date.now()
        };
      } catch (error) {
        console.error('Binance ticker 獲取失敗:', error);
        throw error;
      }
    },

    // 獲取訂單簿數據
    getOrderBook: async (symbol: string, limit: number = 25): Promise<OrderBookData> => {
      try {
        const response = await binanceClient.get('/api/v3/depth', {
          params: {
            symbol: symbol,
            limit: limit
          }
        });

        const orderBook = response.data;
        return {
          symbol: symbol,
          bids: orderBook.bids.map(([price, size]: [string, string]) => [parseFloat(price), parseFloat(size)]),
          asks: orderBook.asks.map(([price, size]: [string, string]) => [parseFloat(price), parseFloat(size)]),
          timestamp: Date.now()
        };
      } catch (error) {
        console.error('Binance orderbook 獲取失敗:', error);
        throw error;
      }
    }
  },

  // 批量獲取多個交易所的 ticker 數據
  getBatchTickers: async (symbol: string, exchanges: string[] = ['bybit', 'binance']): Promise<Record<string, TickerData>> => {
    const results: Record<string, TickerData> = {};
    
    const promises = exchanges.map(async (exchange) => {
      try {
        if (exchange === 'bybit') {
          results.bybit = await exchangeApi.bybit.getTicker(symbol);
        } else if (exchange === 'binance') {
          results.binance = await exchangeApi.binance.getTicker(symbol);
        }
      } catch (error) {
        console.error(`${exchange} ticker 獲取失敗:`, error);
        // 嚴格真實數據：失敗時丟出錯誤，由上層處理
        throw error;
      }
    });

    await Promise.allSettled(promises);
    return results;
  },

  // 計算套利機會
  calculateArbitrageOpportunity: (
    leg1Ticker: TickerData,
    leg2Ticker: TickerData,
    leg1Side: 'buy' | 'sell',
    leg2Side: 'buy' | 'sell',
    leg1Exchange: string,
    leg2Exchange: string
  ) => {
    // 根據交易方向獲取正確的價格
    const leg1Price = leg1Side === 'buy' ? leg1Ticker.askPrice : leg1Ticker.bidPrice;
    const leg2Price = leg2Side === 'buy' ? leg2Ticker.askPrice : leg2Ticker.bidPrice;
    
    // 計算價差 - 賣出價格 - 買入價格
    let spread: number;
    let spreadPercent: number;
    
    if (leg1Side === 'buy' && leg2Side === 'sell') {
      // leg1 買入，leg2 賣出：leg2 的賣出價格 - leg1 的買入價格
      spread = leg2Price - leg1Price;
      spreadPercent = leg1Price > 0 ? (spread / leg1Price) * 100 : 0;
    } else if (leg1Side === 'sell' && leg2Side === 'buy') {
      // leg1 賣出，leg2 買入：leg1 的賣出價格 - leg2 的買入價格
      spread = leg1Price - leg2Price;
      spreadPercent = leg2Price > 0 ? (spread / leg2Price) * 100 : 0;
    } else {
      // 預設情況
      spread = leg2Price - leg1Price;
      spreadPercent = leg1Price > 0 ? (spread / leg1Price) * 100 : 0;
    }
    
    return {
      leg1Price: {
        symbol: leg1Ticker.symbol,
        exchange: leg1Exchange,
        bid1: { price: leg1Ticker.bidPrice },
        ask1: { price: leg1Ticker.askPrice }
      },
      leg2Price: {
        symbol: leg2Ticker.symbol,
        exchange: leg2Exchange,
        bid1: { price: leg2Ticker.bidPrice },
        ask1: { price: leg2Ticker.askPrice }
      },
      spread,
      spreadPercent,
      shouldTrigger: spreadPercent > 0.1, // 只考慮正價差
      timestamp: Date.now()
    };
  }
};

export default exchangeApi;
