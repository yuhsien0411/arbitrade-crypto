/**
 * 前端統一交易所接口
 * 提供抽象基類和具體實現
 */

// 基礎型別定義
export type ExchangeName = "bybit" | "binance" | "okx" | "bitget";
export type TradeType = "spot" | "linear" | "inverse";
export type OrderSide = "buy" | "sell";
export type OrderType = "market" | "limit";

// 數據結構
export interface TickerData {
  symbol: string;
  bidPrice: number;
  askPrice: number;
  lastPrice: number;
  volume24h: number;
  timestamp: number;
  high24h?: number;
  low24h?: number;
  change24h?: number;
  changePercent24h?: number;
}

export interface OrderBookData {
  symbol: string;
  bids: [number, number][];
  asks: [number, number][];
  timestamp: number;
}

export interface Balance {
  asset: string;
  free: number;
  locked: number;
  total: number;
}

export interface Position {
  symbol: string;
  side: "long" | "short";
  size: number;
  entryPrice: number;
  markPrice: number;
  unrealizedPnl: number;
  notionalValue: number;
}

export interface OrderResult {
  success: boolean;
  orderId?: string;
  price?: number;
  quantity?: number;
  errorMessage?: string;
  fee?: number;
  feeCurrency?: string;
  timestamp?: number;
}

// 抽象基類
export abstract class BaseExchange {
  protected apiKey: string;
  protected apiSecret: string;
  protected testnet: boolean;

  constructor(apiKey: string = "", apiSecret: string = "", testnet: boolean = false) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.testnet = testnet;
  }

  abstract get name(): string;

  get isAuthenticated(): boolean {
    return !!(this.apiKey && this.apiSecret);
  }

  // 市場數據接口（公開）
  abstract getTicker(symbol: string, tradeType?: TradeType): Promise<TickerData>;
  abstract getOrderBook(symbol: string, limit?: number, tradeType?: TradeType): Promise<OrderBookData>;
  abstract getSymbols(tradeType?: TradeType): Promise<string[]>;

  // 交易接口（需要認證）
  abstract placeOrder(
    symbol: string,
    side: OrderSide,
    quantity: number,
    orderType?: OrderType,
    price?: number,
    tradeType?: TradeType,
    options?: any
  ): Promise<OrderResult>;

  abstract cancelOrder(symbol: string, orderId: string, tradeType?: TradeType): Promise<boolean>;
  abstract getOrderStatus(symbol: string, orderId: string, tradeType?: TradeType): Promise<any>;

  // 帳戶接口（需要認證）
  abstract getBalances(): Promise<Balance[]>;
  abstract getPositions(): Promise<Position[]>;

  // 健康檢查
  abstract ping(): Promise<boolean>;
  abstract getServerTime(): Promise<number>;

  // 工具方法
  protected checkAuthentication(): void {
    if (!this.isAuthenticated) {
      throw new Error(`${this.name} 需要 API 密鑰進行認證`);
    }
  }

  protected normalizeSymbol(symbol: string): string {
    return symbol.toUpperCase().trim();
  }

  protected validateQuantity(quantity: number): void {
    if (quantity <= 0) {
      throw new Error("數量必須大於 0");
    }
  }

  protected validatePrice(price?: number): void {
    if (price !== undefined && price <= 0) {
      throw new Error("價格必須大於 0");
    }
  }

  // 批量操作（默認實現）
  async getMultipleTickers(symbols: string[], tradeType?: TradeType): Promise<Record<string, TickerData>> {
    const results: Record<string, TickerData> = {};
    
    // 並行獲取
    const promises = symbols.map(async (symbol) => {
      try {
        const ticker = await this.getTicker(symbol, tradeType);
        results[symbol] = ticker;
      } catch (error) {
        console.error(`獲取 ${symbol} 行情失敗:`, error);
      }
    });

    await Promise.allSettled(promises);
    return results;
  }

  async getMultipleOrderBooks(symbols: string[], limit?: number, tradeType?: TradeType): Promise<Record<string, OrderBookData>> {
    const results: Record<string, OrderBookData> = {};
    
    const promises = symbols.map(async (symbol) => {
      try {
        const orderbook = await this.getOrderBook(symbol, limit, tradeType);
        results[symbol] = orderbook;
      } catch (error) {
        console.error(`獲取 ${symbol} 訂單簿失敗:`, error);
      }
    });

    await Promise.allSettled(promises);
    return results;
  }

  toString(): string {
    const authStatus = this.isAuthenticated ? "已認證" : "未認證";
    const network = this.testnet ? "測試網" : "主網";
    return `${this.name}(${authStatus}, ${network})`;
  }
}

// Bybit 實現
export class BybitExchange extends BaseExchange {
  private baseUrl: string;

  constructor(apiKey: string = "", apiSecret: string = "", testnet: boolean = false) {
    super(apiKey, apiSecret, testnet);
    this.baseUrl = testnet ? "https://api-testnet.bybit.com" : "https://api.bybit.com";
  }

  get name(): string {
    return "Bybit";
  }

  private getCategory(tradeType: TradeType = "spot"): string {
    switch (tradeType) {
      case "spot": return "spot";
      case "linear": return "linear";
      case "inverse": return "inverse";
      default: return "spot";
    }
  }

  async getTicker(symbol: string, tradeType: TradeType = "spot"): Promise<TickerData> {
    try {
      symbol = this.normalizeSymbol(symbol);
      const category = this.getCategory(tradeType);
      
      const response = await fetch(`${this.baseUrl}/v5/market/tickers?category=${category}&symbol=${symbol}`);
      const data = await response.json();

      if (data.retCode !== 0) {
        throw new Error(`Bybit API 錯誤: ${data.retMsg}`);
      }

      const ticker = data.result.list[0];
      if (!ticker) {
        throw new Error(`找不到 ${symbol} 的行情數據`);
      }

      return {
        symbol: ticker.symbol,
        bidPrice: parseFloat(ticker.bid1Price),
        askPrice: parseFloat(ticker.ask1Price),
        lastPrice: parseFloat(ticker.lastPrice),
        volume24h: parseFloat(ticker.volume24h),
        timestamp: parseInt(ticker.time),
        high24h: parseFloat(ticker.highPrice24h) || undefined,
        low24h: parseFloat(ticker.lowPrice24h) || undefined,
        change24h: parseFloat(ticker.price24hPcnt) || undefined
      };
    } catch (error) {
      console.error("Bybit getTicker 失敗:", error);
      throw error;
    }
  }

  async getOrderBook(symbol: string, limit: number = 25, tradeType: TradeType = "spot"): Promise<OrderBookData> {
    try {
      symbol = this.normalizeSymbol(symbol);
      const category = this.getCategory(tradeType);
      
      const response = await fetch(`${this.baseUrl}/v5/market/orderbook?category=${category}&symbol=${symbol}&limit=${limit}`);
      const data = await response.json();

      if (data.retCode !== 0) {
        throw new Error(`Bybit API 錯誤: ${data.retMsg}`);
      }

      const result = data.result;
      
      return {
        symbol: result.s,
        bids: result.b.map(([price, size]: [string, string]) => [parseFloat(price), parseFloat(size)]),
        asks: result.a.map(([price, size]: [string, string]) => [parseFloat(price), parseFloat(size)]),
        timestamp: parseInt(result.ts)
      };
    } catch (error) {
      console.error("Bybit getOrderBook 失敗:", error);
      throw error;
    }
  }

  async getSymbols(tradeType: TradeType = "spot"): Promise<string[]> {
    try {
      const category = this.getCategory(tradeType);
      
      const response = await fetch(`${this.baseUrl}/v5/market/instruments-info?category=${category}`);
      const data = await response.json();

      if (data.retCode !== 0) {
        throw new Error(`Bybit API 錯誤: ${data.retMsg}`);
      }

      return data.result.list
        .filter((inst: any) => inst.status === "Trading")
        .map((inst: any) => inst.symbol);
    } catch (error) {
      console.error("Bybit getSymbols 失敗:", error);
      throw error;
    }
  }

  // 交易接口（需要後端支援）
  async placeOrder(): Promise<OrderResult> {
    throw new Error("前端不支援直接下單，請使用後端 API");
  }

  async cancelOrder(): Promise<boolean> {
    throw new Error("前端不支援直接取消訂單，請使用後端 API");
  }

  async getOrderStatus(): Promise<any> {
    throw new Error("前端不支援直接查詢訂單，請使用後端 API");
  }

  async getBalances(): Promise<Balance[]> {
    throw new Error("前端不支援直接查詢餘額，請使用後端 API");
  }

  async getPositions(): Promise<Position[]> {
    throw new Error("前端不支援直接查詢持倉，請使用後端 API");
  }

  async ping(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/v5/market/time`);
      const data = await response.json();
      return data.retCode === 0;
    } catch {
      return false;
    }
  }

  async getServerTime(): Promise<number> {
    try {
      const response = await fetch(`${this.baseUrl}/v5/market/time`);
      const data = await response.json();
      
      if (data.retCode !== 0) {
        throw new Error(`Bybit API 錯誤: ${data.retMsg}`);
      }
      
      return parseInt(data.result.timeSecond) * 1000;
    } catch (error) {
      console.error("Bybit getServerTime 失敗:", error);
      throw error;
    }
  }

  // Bybit 優化的批量獲取
  async getMultipleTickers(symbols: string[], tradeType: TradeType = "spot"): Promise<Record<string, TickerData>> {
    try {
      const category = this.getCategory(tradeType);
      
      // Bybit 支援一次獲取所有 ticker
      const response = await fetch(`${this.baseUrl}/v5/market/tickers?category=${category}`);
      const data = await response.json();

      if (data.retCode !== 0) {
        throw new Error(`Bybit API 錯誤: ${data.retMsg}`);
      }

      const results: Record<string, TickerData> = {};
      const symbolSet = new Set(symbols.map(s => this.normalizeSymbol(s)));

      for (const ticker of data.result.list) {
        if (symbolSet.has(ticker.symbol)) {
          results[ticker.symbol] = {
            symbol: ticker.symbol,
            bidPrice: parseFloat(ticker.bid1Price),
            askPrice: parseFloat(ticker.ask1Price),
            lastPrice: parseFloat(ticker.lastPrice),
            volume24h: parseFloat(ticker.volume24h),
            timestamp: parseInt(ticker.time),
            high24h: parseFloat(ticker.highPrice24h) || undefined,
            low24h: parseFloat(ticker.lowPrice24h) || undefined,
            change24h: parseFloat(ticker.price24hPcnt) || undefined
          };
        }
      }

      return results;
    } catch (error) {
      console.error("Bybit getMultipleTickers 失敗:", error);
      // 回退到基類實現
      return await super.getMultipleTickers(symbols, tradeType);
    }
  }
}

// Binance 實現 - 支持統一交易帳戶（Portfolio Margin）
export class BinanceExchange extends BaseExchange {
  private baseUrl: string;
  private usePortfolioMargin: boolean;

  constructor(
    apiKey: string = "", 
    apiSecret: string = "", 
    testnet: boolean = false, 
    usePortfolioMargin: boolean = true
  ) {
    super(apiKey, apiSecret, testnet);
    this.baseUrl = testnet ? "https://testnet.binance.vision" : "https://api.binance.com";
    this.usePortfolioMargin = usePortfolioMargin;  // 是否使用統一交易帳戶
  }

  get name(): string {
    return "Binance";
  }
  
  /**
   * 是否使用統一交易帳戶（Portfolio Margin）
   * 
   * 統一交易帳戶特性：
   * - 跨市場保證金共享（現貨保證金 + USDT-M + COIN-M）
   * - 風險對沖，降低保證金要求
   * - 統一帳戶管理
   * - 更高資金效率
   * 
   * API 端點：
   * - 現貨保證金下單: POST /papi/v1/margin/order
   * - UM 合約下單: POST /papi/v1/um/order
   * - 查詢帳戶餘額: GET /papi/v1/balance
   * - 查詢帳戶信息: GET /papi/v1/account
   * - UM 持倉風險: GET /papi/v1/um/positionRisk
   * 
   * 注意：
   * - 前端僅用於顯示公開市場數據
   * - 所有交易操作通過後端 API 進行
   * - 後端會自動根據配置使用統一交易帳戶端點
   */
  get isUsingPortfolioMargin(): boolean {
    return this.usePortfolioMargin;
  }

  private getEndpointPrefix(tradeType: TradeType = "spot"): string {
    switch (tradeType) {
      case "spot": return "/api/v3";
      case "linear": return "/fapi/v1";
      case "inverse": return "/dapi/v1";
      default: return "/api/v3";
    }
  }

  async getTicker(symbol: string, tradeType: TradeType = "spot"): Promise<TickerData> {
    try {
      symbol = this.normalizeSymbol(symbol);
      const prefix = this.getEndpointPrefix(tradeType);
      
      const response = await fetch(`${this.baseUrl}${prefix}/ticker/24hr?symbol=${symbol}`);
      const data = await response.json();

      if (data.code) {
        throw new Error(`Binance API 錯誤: ${data.msg}`);
      }

      return {
        symbol: data.symbol,
        bidPrice: parseFloat(data.bidPrice),
        askPrice: parseFloat(data.askPrice),
        lastPrice: parseFloat(data.lastPrice),
        volume24h: parseFloat(data.volume),
        timestamp: parseInt(data.closeTime),
        high24h: parseFloat(data.highPrice),
        low24h: parseFloat(data.lowPrice),
        change24h: parseFloat(data.priceChange),
        changePercent24h: parseFloat(data.priceChangePercent)
      };
    } catch (error) {
      console.error("Binance getTicker 失敗:", error);
      throw error;
    }
  }

  async getOrderBook(symbol: string, limit: number = 25, tradeType: TradeType = "spot"): Promise<OrderBookData> {
    try {
      symbol = this.normalizeSymbol(symbol);
      const prefix = this.getEndpointPrefix(tradeType);
      
      const response = await fetch(`${this.baseUrl}${prefix}/depth?symbol=${symbol}&limit=${Math.min(limit, 1000)}`);
      const data = await response.json();

      if (data.code) {
        throw new Error(`Binance API 錯誤: ${data.msg}`);
      }

      return {
        symbol: symbol,
        bids: data.bids.map(([price, qty]: [string, string]) => [parseFloat(price), parseFloat(qty)]),
        asks: data.asks.map(([price, qty]: [string, string]) => [parseFloat(price), parseFloat(qty)]),
        timestamp: Date.now()
      };
    } catch (error) {
      console.error("Binance getOrderBook 失敗:", error);
      throw error;
    }
  }

  async getSymbols(tradeType: TradeType = "spot"): Promise<string[]> {
    try {
      const prefix = this.getEndpointPrefix(tradeType);
      
      const response = await fetch(`${this.baseUrl}${prefix}/exchangeInfo`);
      const data = await response.json();

      if (data.code) {
        throw new Error(`Binance API 錯誤: ${data.msg}`);
      }

      return data.symbols
        .filter((symbol: any) => symbol.status === "TRADING")
        .map((symbol: any) => symbol.symbol);
    } catch (error) {
      console.error("Binance getSymbols 失敗:", error);
      throw error;
    }
  }

  // 交易接口（需要後端支援）
  // 後端已實現統一交易帳戶 (Portfolio Margin) 支持
  async placeOrder(): Promise<OrderResult> {
    throw new Error(
      "前端不支援直接下單，請使用後端 API\n" +
      "後端支持統一交易帳戶 (Portfolio Margin)：\n" +
      "  - 現貨保證金: POST /papi/v1/margin/order\n" +
      "  - UM 合約: POST /papi/v1/um/order"
    );
  }

  async cancelOrder(): Promise<boolean> {
    throw new Error("前端不支援直接取消訂單，請使用後端 API");
  }

  async getOrderStatus(): Promise<any> {
    throw new Error("前端不支援直接查詢訂單，請使用後端 API");
  }

  async getBalances(): Promise<Balance[]> {
    throw new Error(
      "前端不支援直接查詢餘額，請使用後端 API\n" +
      "後端支持統一交易帳戶餘額查詢: GET /papi/v1/balance"
    );
  }

  async getPositions(): Promise<Position[]> {
    throw new Error(
      "前端不支援直接查詢持倉，請使用後端 API\n" +
      "後端支持統一交易帳戶持倉查詢: GET /papi/v1/um/positionRisk"
    );
  }

  async ping(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/v3/ping`);
      const data = await response.json();
      return !data.code;
    } catch {
      return false;
    }
  }

  async getServerTime(): Promise<number> {
    try {
      const response = await fetch(`${this.baseUrl}/api/v3/time`);
      const data = await response.json();
      
      if (data.code) {
        throw new Error(`Binance API 錯誤: ${data.msg}`);
      }
      
      return parseInt(data.serverTime);
    } catch (error) {
      console.error("Binance getServerTime 失敗:", error);
      throw error;
    }
  }
}

// OKX 實現
export class OkxExchange extends BaseExchange {
  private baseUrl: string;

  constructor(apiKey: string = "", apiSecret: string = "", testnet: boolean = false) {
    super(apiKey, apiSecret, testnet);
    this.baseUrl = testnet ? "https://www.okx.com" : "https://www.okx.com";
  }

  get name(): string {
    return "OKX";
  }

  // OKX 使用帶分隔符格式（ETH-USDT 或 ETH-USDT-SWAP）
  protected normalizeSymbol(symbol: string, tradeType: TradeType = "spot"): string {
    symbol = symbol.toUpperCase().replace(/[/_]/g, "-");
    
    // 如果已經是 OKX 格式（含 -SWAP），直接返回
    if (symbol.includes("-SWAP")) {
      return symbol;
    }
    
    // 如果已經有分隔符，檢查是否需要添加 -SWAP
    if (symbol.includes("-")) {
      if (tradeType !== "spot") {
        return `${symbol}-SWAP`;
      }
      return symbol;
    }
    
    // 統一格式轉 OKX 格式
    // ETHUSDT -> ETH-USDT 或 ETH-USDT-SWAP
    if (symbol.endsWith("USDT")) {
      const base = symbol.slice(0, -4);
      const normalized = `${base}-USDT`;
      return tradeType === "spot" ? normalized : `${normalized}-SWAP`;
    } else if (symbol.endsWith("USD")) {
      const base = symbol.slice(0, -3);
      const normalized = `${base}-USD`;
      return tradeType === "spot" ? normalized : `${normalized}-SWAP`;
    }
    
    // 其他情況返回原值
    return symbol;
  }

  async getTicker(symbol: string, tradeType: TradeType = "spot"): Promise<TickerData> {
    try {
      symbol = this.normalizeSymbol(symbol, tradeType);
      
      // OKX REST API for ticker
      const instType = tradeType === "spot" ? "SPOT" : "SWAP";
      const response = await fetch(`${this.baseUrl}/api/v5/market/ticker?instId=${symbol}&instType=${instType}`);
      const data = await response.json();

      if (data.code !== "0") {
        throw new Error(`OKX API 錯誤: ${data.msg}`);
      }

      const ticker = data.data[0];
      if (!ticker) {
        throw new Error(`找不到 ${symbol} 的行情數據`);
      }

      return {
        symbol: ticker.instId,
        bidPrice: parseFloat(ticker.bidPx),
        askPrice: parseFloat(ticker.askPx),
        lastPrice: parseFloat(ticker.last),
        volume24h: parseFloat(ticker.vol24h),
        timestamp: parseInt(ticker.ts),
        high24h: parseFloat(ticker.high24h) || undefined,
        low24h: parseFloat(ticker.low24h) || undefined
      };
    } catch (error) {
      console.error("OKX getTicker 失敗:", error);
      throw error;
    }
  }

  async getOrderBook(symbol: string, limit: number = 25, tradeType: TradeType = "spot"): Promise<OrderBookData> {
    try {
      symbol = this.normalizeSymbol(symbol, tradeType);
      
      const response = await fetch(`${this.baseUrl}/api/v5/market/books?instId=${symbol}&sz=${limit}`);
      const data = await response.json();

      if (data.code !== "0") {
        throw new Error(`OKX API 錯誤: ${data.msg}`);
      }

      const result = data.data[0];
      
      return {
        symbol: symbol,
        bids: result.bids.map(([price, size]: [string, string]) => [parseFloat(price), parseFloat(size)]),
        asks: result.asks.map(([price, size]: [string, string]) => [parseFloat(price), parseFloat(size)]),
        timestamp: parseInt(result.ts)
      };
    } catch (error) {
      console.error("OKX getOrderBook 失敗:", error);
      throw error;
    }
  }

  async getSymbols(tradeType: TradeType = "spot"): Promise<string[]> {
    try {
      const instType = tradeType === "spot" ? "SPOT" : "SWAP";
      
      const response = await fetch(`${this.baseUrl}/api/v5/public/instruments?instType=${instType}`);
      const data = await response.json();

      if (data.code !== "0") {
        throw new Error(`OKX API 錯誤: ${data.msg}`);
      }

      return data.data
        .filter((inst: any) => inst.state === "live")
        .map((inst: any) => inst.instId);
    } catch (error) {
      console.error("OKX getSymbols 失敗:", error);
      throw error;
    }
  }

  // 交易接口（需要後端支援）
  async placeOrder(): Promise<OrderResult> {
    throw new Error("前端不支援直接下單，請使用後端 API");
  }

  async cancelOrder(): Promise<boolean> {
    throw new Error("前端不支援直接取消訂單，請使用後端 API");
  }

  async getOrderStatus(): Promise<any> {
    throw new Error("前端不支援直接查詢訂單，請使用後端 API");
  }

  async getBalances(): Promise<Balance[]> {
    throw new Error("前端不支援直接查詢餘額，請使用後端 API");
  }

  async getPositions(): Promise<Position[]> {
    throw new Error("前端不支援直接查詢持倉，請使用後端 API");
  }

  async ping(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/v5/public/time`);
      const data = await response.json();
      return data.code === "0";
    } catch {
      return false;
    }
  }

  async getServerTime(): Promise<number> {
    try {
      const response = await fetch(`${this.baseUrl}/api/v5/public/time`);
      const data = await response.json();
      
      if (data.code !== "0") {
        throw new Error(`OKX API 錯誤: ${data.msg}`);
      }
      
      return parseInt(data.data[0].ts);
    } catch (error) {
      console.error("OKX getServerTime 失敗:", error);
      throw error;
    }
  }
}

// Bitget 交易所實現
export class BitgetExchange extends BaseExchange {
  private baseUrl: string;

  constructor(apiKey: string = "", apiSecret: string = "", testnet: boolean = false) {
    super(apiKey, apiSecret, testnet);
    this.baseUrl = testnet ? "https://api.bitget.com" : "https://api.bitget.com";
  }

  get name(): string {
    return "Bitget";
  }

  // Bitget 使用統一符號格式（無分隔符），與 Binance/Bybit 一致
  protected normalizeSymbol(symbol: string, tradeType: TradeType = "spot"): string {
    symbol = symbol.toUpperCase().replace(/[-_/]/g, "");
    
    // 現貨和合約格式相同
    if (tradeType === "spot") {
      return symbol;
    } else {
      return symbol; // Bitget 合約使用相同格式
    }
  }

  async getTicker(symbol: string, tradeType: TradeType = "spot"): Promise<TickerData> {
    try {
      symbol = this.normalizeSymbol(symbol, tradeType);
      const productType = tradeType === "spot" ? "spot" : "usdt-futures";
      
      const response = await fetch(`${this.baseUrl}/api/v2/spot/market/tickers?symbol=${symbol}`);
      const data = await response.json();

      if (data.code !== "00000") {
        throw new Error(`Bitget API 錯誤: ${data.msg}`);
      }

      const ticker = data.data[0];
      if (!ticker) {
        throw new Error(`找不到 ${symbol} 的行情數據`);
      }

      return {
        symbol: ticker.symbol,
        bidPrice: parseFloat(ticker.bidPr),
        askPrice: parseFloat(ticker.askPr),
        lastPrice: parseFloat(ticker.lastPr),
        volume24h: parseFloat(ticker.quoteVolume),
        timestamp: parseInt(ticker.ts),
        high24h: parseFloat(ticker.high24h) || undefined,
        low24h: parseFloat(ticker.low24h) || undefined,
        changePercent24h: parseFloat(ticker.changeUtc24h) || undefined
      };
    } catch (error) {
      console.error("Bitget getTicker 失敗:", error);
      throw error;
    }
  }

  async getOrderBook(symbol: string, limit: number = 25, tradeType: TradeType = "spot"): Promise<OrderBookData> {
    try {
      symbol = this.normalizeSymbol(symbol, tradeType);
      const limitParam = limit > 100 ? 100 : limit;
      
      const response = await fetch(`${this.baseUrl}/api/v2/spot/market/orderbook?symbol=${symbol}&limit=${limitParam}&type=step0`);
      const data = await response.json();

      if (data.code !== "00000") {
        throw new Error(`Bitget API 錯誤: ${data.msg}`);
      }

      const result = data.data;
      
      return {
        symbol: symbol,
        bids: result.bids.slice(0, limit).map(([price, size]: [string, string]) => [parseFloat(price), parseFloat(size)]),
        asks: result.asks.slice(0, limit).map(([price, size]: [string, string]) => [parseFloat(price), parseFloat(size)]),
        timestamp: parseInt(result.ts)
      };
    } catch (error) {
      console.error("Bitget getOrderBook 失敗:", error);
      throw error;
    }
  }

  async getSymbols(tradeType: TradeType = "spot"): Promise<string[]> {
    try {
      const productType = tradeType === "spot" ? "spot" : "usdt-futures";
      const endpoint = tradeType === "spot" 
        ? "/api/v2/spot/public/symbols" 
        : "/api/v2/mix/market/contracts?productType=usdt-futures";
      
      const response = await fetch(`${this.baseUrl}${endpoint}`);
      const data = await response.json();

      if (data.code !== "00000") {
        throw new Error(`Bitget API 錯誤: ${data.msg}`);
      }

      if (tradeType === "spot") {
        return data.data
          .filter((inst: any) => inst.status === "online")
          .map((inst: any) => inst.symbol);
      } else {
        return data.data
          .filter((inst: any) => inst.status === "normal")
          .map((inst: any) => inst.symbol);
      }
    } catch (error) {
      console.error("Bitget getSymbols 失敗:", error);
      throw error;
    }
  }

  // 交易接口（需要後端支援）
  async placeOrder(): Promise<OrderResult> {
    throw new Error("前端不支援直接下單，請使用後端 API");
  }

  async cancelOrder(): Promise<boolean> {
    throw new Error("前端不支援直接取消訂單，請使用後端 API");
  }

  async getOrderStatus(): Promise<any> {
    throw new Error("前端不支援直接查詢訂單，請使用後端 API");
  }

  async getBalances(): Promise<Balance[]> {
    throw new Error("前端不支援直接查詢餘額，請使用後端 API");
  }

  async getPositions(): Promise<Position[]> {
    throw new Error("前端不支援直接查詢持倉，請使用後端 API");
  }

  async ping(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/v2/public/time`);
      const data = await response.json();
      return data.code === "00000";
    } catch {
      return false;
    }
  }

  async getServerTime(): Promise<number> {
    try {
      const response = await fetch(`${this.baseUrl}/api/v2/public/time`);
      const data = await response.json();
      
      if (data.code !== "00000") {
        throw new Error(`Bitget API 錯誤: ${data.msg}`);
      }
      
      return parseInt(data.data);
    } catch (error) {
      console.error("Bitget getServerTime 失敗:", error);
      throw error;
    }
  }
}

// 交易所工廠
export class ExchangeFactory {
  private static exchanges: Record<ExchangeName, new (apiKey: string, apiSecret: string, testnet: boolean) => BaseExchange> = {
    bybit: BybitExchange,
    binance: BinanceExchange,
    okx: OkxExchange,
    bitget: BitgetExchange
  };

  private static instances: Record<string, BaseExchange> = {};

  static getSupportedExchanges(): ExchangeName[] {
    return Object.keys(this.exchanges) as ExchangeName[];
  }

  static createExchange(
    name: ExchangeName,
    apiKey: string = "",
    apiSecret: string = "",
    testnet: boolean = false,
    useCache: boolean = true
  ): BaseExchange {
    const cacheKey = `${name}_${testnet}_${!!apiKey}`;
    
    if (useCache && this.instances[cacheKey]) {
      return this.instances[cacheKey];
    }

    const ExchangeClass = this.exchanges[name];
    if (!ExchangeClass) {
      throw new Error(`不支援的交易所: ${name}`);
    }

    const instance = new ExchangeClass(apiKey, apiSecret, testnet);
    
    if (useCache) {
      this.instances[cacheKey] = instance;
    }

    return instance;
  }

  static clearCache(): void {
    this.instances = {};
  }
}

// 便利函數
export function getExchange(name: ExchangeName, testnet: boolean = false): BaseExchange {
  return ExchangeFactory.createExchange(name, "", "", testnet);
}

export function getBybit(testnet: boolean = false): BybitExchange {
  return ExchangeFactory.createExchange("bybit", "", "", testnet) as BybitExchange;
}

export function getBinance(testnet: boolean = false): BinanceExchange {
  return ExchangeFactory.createExchange("binance", "", "", testnet) as BinanceExchange;
}

export function getOkx(testnet: boolean = false): OkxExchange {
  return ExchangeFactory.createExchange("okx", "", "", testnet) as OkxExchange;
}

export function getBitget(testnet: boolean = false): BitgetExchange {
  return ExchangeFactory.createExchange("bitget", "", "", testnet) as BitgetExchange;
}

export function listExchanges(): ExchangeName[] {
  return ExchangeFactory.getSupportedExchanges();
}

export function checkExchangeSupport(name: string): boolean {
  return ExchangeFactory.getSupportedExchanges().includes(name as ExchangeName);
}
