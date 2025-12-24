"""
Bybit 交易所實現
"""

import asyncio
import time
from typing import Optional, List, Dict, Any, Tuple
from pybit.unified_trading import HTTP

from .base import (
    BaseExchange, OrderResult, TickerData, OrderBookData, Balance, Position,
    OrderSide, OrderType, TradeType, FundingRate, BorrowingRate, AccountSummary, AccountMode
)
from ..utils.logger import get_logger
from ..services.orderbook_feeds.bybit import BybitOrderbookFeed


class BybitExchange(BaseExchange):
    """Bybit 交易所實現"""
    
    def __init__(self, api_key: str = "", api_secret: str = "", testnet: bool = False):
        super().__init__(api_key, api_secret, testnet)
        self.logger = get_logger()
        self._client = None
        
        # OrderBook Feed
        self.orderbook_feed = BybitOrderbookFeed()
        
        self._init_client()
    
    def _init_client(self):
        """初始化客戶端"""
        try:
            self._client = HTTP(
                testnet=self.testnet,
                api_key=self.api_key,
                api_secret=self.api_secret
            )
            self.logger.info("bybit_client_initialized", 
                           testnet=self.testnet, 
                           authenticated=self.is_authenticated)
        except Exception as e:
            self.logger.error("bybit_client_init_failed", error=str(e))
            raise
    
    @staticmethod
    def _safe_float(value, default=0.0) -> float:
        """安全地轉換為浮點數，處理空字符串和 None"""
        if value is None or value == "" or value == "0":
            return default
        try:
            return float(value)
        except (ValueError, TypeError):
            return default
    
    @property
    def name(self) -> str:
        return "Bybit"
    
    def _get_category(self, trade_type: TradeType) -> str:
        """轉換交易類型為 Bybit category"""
        if trade_type == TradeType.SPOT:
            return "spot"
        elif trade_type == TradeType.LINEAR:
            return "linear"
        elif trade_type == TradeType.INVERSE:
            return "inverse"
        else:
            raise ValueError(f"不支援的交易類型: {trade_type}")
    
    def _convert_side(self, side: OrderSide) -> str:
        """轉換訂單方向為 Bybit 格式"""
        return "Buy" if side == OrderSide.BUY else "Sell"
    
    def _convert_order_type(self, order_type: OrderType) -> str:
        """轉換訂單類型為 Bybit 格式"""
        return "Market" if order_type == OrderType.MARKET else "Limit"
    
    # 市場數據接口
    
    async def get_ticker(self, symbol: str, trade_type: TradeType = TradeType.SPOT) -> TickerData:
        """獲取行情數據"""
        try:
            symbol = self._normalize_symbol(symbol)
            category = self._get_category(trade_type)
            
            response = self._client.get_tickers(category=category, symbol=symbol)
            
            if response.get("retCode") != 0:
                raise Exception(f"Bybit API 錯誤: {response.get('retMsg')}")
            
            ticker_list = response.get("result", {}).get("list", [])
            if not ticker_list:
                raise Exception(f"找不到 {symbol} 的行情數據")
            
            ticker = ticker_list[0]
            
            return TickerData(
                symbol=ticker.get("symbol"),
                bid_price=float(ticker.get("bid1Price", 0)),
                ask_price=float(ticker.get("ask1Price", 0)),
                last_price=float(ticker.get("lastPrice", 0)),
                volume_24h=float(ticker.get("volume24h", 0)),
                timestamp=int(ticker.get("time", time.time() * 1000)),
                high_24h=float(ticker.get("highPrice24h", 0)) or None,
                low_24h=float(ticker.get("lowPrice24h", 0)) or None,
                change_24h=float(ticker.get("price24hPcnt", 0)) or None
            )
            
        except Exception as e:
            self.logger.error("bybit_get_ticker_failed", symbol=symbol, error=str(e))
            raise
    
    async def get_orderbook(self, symbol: str, limit: int = 25, trade_type: TradeType = TradeType.SPOT) -> OrderBookData:
        """獲取訂單簿"""
        try:
            symbol = self._normalize_symbol(symbol)
            category = self._get_category(trade_type)
            
            response = self._client.get_orderbook(category=category, symbol=symbol, limit=limit)
            
            if response.get("retCode") != 0:
                raise Exception(f"Bybit API 錯誤: {response.get('retMsg')}")
            
            result = response.get("result", {})
            
            # 轉換格式
            bids = [(float(price), float(size)) for price, size in result.get("b", [])]
            asks = [(float(price), float(size)) for price, size in result.get("a", [])]
            
            return OrderBookData(
                symbol=result.get("s", symbol),
                bids=bids,
                asks=asks,
                timestamp=int(result.get("ts", time.time() * 1000))
            )
            
        except Exception as e:
            self.logger.error("bybit_get_orderbook_failed", symbol=symbol, error=str(e))
            raise
    
    # OrderBook Feed 相關方法
    
    async def start_orderbook_feed(self):
        """啟動 OrderBook Feed"""
        await self.orderbook_feed.start()
    
    async def stop_orderbook_feed(self):
        """停止 OrderBook Feed"""
        await self.orderbook_feed.stop()
    
    async def subscribe_orderbook(self, symbol: str, category: str = "linear"):
        """訂閱 OrderBook 數據"""
        await self.orderbook_feed.subscribe(symbol, category)
    
    async def unsubscribe_orderbook(self, symbol: str, category: str = "linear"):
        """取消訂閱 OrderBook 數據"""
        await self.orderbook_feed.unsubscribe(symbol, category)
    
    def get_realtime_orderbook(self, symbol: str) -> Optional[OrderBookData]:
        """獲取實時 OrderBook 數據"""
        orderbook_snapshot = self.orderbook_feed.get_orderbook(symbol)
        if not orderbook_snapshot:
            return None
        
        return OrderBookData(
            symbol=orderbook_snapshot.symbol,
            bids=orderbook_snapshot.bids,
            asks=orderbook_snapshot.asks,
            timestamp=orderbook_snapshot.timestamp
        )
    
    def get_realtime_top_of_book(self, symbol: str) -> Tuple[Optional[float], Optional[float]]:
        """獲取實時最優買賣價"""
        return self.orderbook_feed.get_top_of_book(symbol)
    
    def is_orderbook_data_available(self, symbol: str) -> bool:
        """檢查 OrderBook 數據是否可用"""
        return self.orderbook_feed.is_data_available(symbol)
    
    async def get_symbols(self, trade_type: TradeType = TradeType.SPOT) -> List[str]:
        """獲取可用交易對"""
        try:
            category = self._get_category(trade_type)
            
            response = self._client.get_instruments_info(category=category)
            
            if response.get("retCode") != 0:
                raise Exception(f"Bybit API 錯誤: {response.get('retMsg')}")
            
            instruments = response.get("result", {}).get("list", [])
            symbols = [inst.get("symbol") for inst in instruments if inst.get("status") == "Trading"]
            
            return symbols
            
        except Exception as e:
            self.logger.error("bybit_get_symbols_failed", trade_type=trade_type.value, error=str(e))
            raise
    
    # 交易接口
    
    async def place_order(
        self, 
        symbol: str, 
        side: OrderSide, 
        quantity: float,
        order_type: OrderType = OrderType.MARKET,
        price: Optional[float] = None,
        trade_type: TradeType = TradeType.SPOT,
        **kwargs
    ) -> OrderResult:
        """下單"""
        try:
            self._check_authentication()
            symbol = self._normalize_symbol(symbol)
            self._validate_quantity(quantity)
            if order_type == OrderType.LIMIT:
                self._validate_price(price)
            
            category = self._get_category(trade_type)
            bybit_side = self._convert_side(side)
            bybit_order_type = self._convert_order_type(order_type)
            
            # 構建訂單參數
            order_params = {
                "category": category,
                "symbol": symbol,
                "side": bybit_side,
                "orderType": bybit_order_type,
                "qty": str(quantity)
            }
            

            # 現貨特殊處理
            if trade_type == TradeType.SPOT:
                order_params["marketUnit"] = "baseCoin"
                # 檢查是否使用槓桿現貨（默認不使用，避免需要開啟Cross Margin Trading）
                if kwargs.get("use_leverage", False):
                    order_params["isLeverage"] = 1
                else:
                    # 顯式設置為0，確保不使用槓桿
                    order_params["isLeverage"] = 0
            
            # 其他參數
            if "time_in_force" in kwargs:
                order_params["timeInForce"] = kwargs["time_in_force"]
            
            # 嘗試下單（捕獲異常並轉換為響應格式）
            try:
                response = self._client.place_order(**order_params)
            except Exception as api_error:
                # pybit 會將 API 錯誤拋出為異常，需要捕獲並轉換為響應格式
                error_str = str(api_error)
                self.logger.warning("bybit_place_order_api_exception", 
                                   symbol=symbol,
                                   error=error_str)
                
                # 從異常信息中提取錯誤碼和錯誤信息
                # 格式：'錯誤信息 (ErrCode: 170344) (ErrTime: 10:14:10).'
                import re
                ret_code_match = re.search(r'ErrCode:\s*(\d+)', error_str)
                ret_code = ret_code_match.group(1) if ret_code_match else ""
                
                # 構造響應對象（模擬 API 錯誤響應）
                response = {
                    "retCode": int(ret_code) if ret_code else -1,
                    "retMsg": error_str
                }
            
            if response.get("retCode") == 0:
                result = response.get("result", {})
                return OrderResult(
                    success=True,
                    order_id=result.get("orderId"),
                    price=price,  # 市價單沒有固定價格
                    quantity=quantity,
                    timestamp=int(time.time() * 1000)
                )
            else:
                error_msg = response.get("retMsg", "Unknown error")
                error_code = str(response.get("retCode", ""))
                
                # 記錄錯誤詳情（用於調試）
                self.logger.warning("bybit_order_error_detected",
                                 symbol=symbol,
                                 retCode=error_code,
                                 retMsg=error_msg,
                                 trade_type=trade_type.value,
                                 use_leverage=kwargs.get("use_leverage"))
                
                # 特殊錯誤處理：現貨槓桿相關錯誤
                # 170036: Cross Margin Trading 未開啟
                # 170344: 現貨不支援槓桿
                leverage_errors = ["170036", "170344"]
                should_retry = (
                    trade_type == TradeType.SPOT and 
                    kwargs.get("use_leverage") and
                    any(err in error_code or err in error_msg for err in leverage_errors)
                )
                
                if should_retry:
                    self.logger.warning("bybit_spot_leverage_error_retry", 
                                       symbol=symbol, 
                                       error_code=error_code,
                                       error_msg=error_msg,
                                       retrying_without_leverage=True)
                    # 重試不使用槓桿（顯式設置為 0）
                    order_params["isLeverage"] = 0
                    
                    try:
                        retry_response = self._client.place_order(**order_params)
                    except Exception as retry_error:
                        # 重試也可能拋出異常
                        error_str = str(retry_error)
                        retry_response = {
                            "retCode": -1,
                            "retMsg": error_str
                        }
                    
                    if retry_response.get("retCode") == 0:
                        result = retry_response.get("result", {})
                        self.logger.info("bybit_spot_retry_success", 
                                        symbol=symbol,
                                        order_id=result.get("orderId"),
                                        used_leverage=False)
                        return OrderResult(
                            success=True,
                            order_id=result.get("orderId"),
                            price=price,
                            quantity=quantity,
                            timestamp=int(time.time() * 1000)
                        )
                    else:
                        error_msg = retry_response.get("retMsg", error_msg)
                
                # 特殊錯誤處理：170207 - 借貸額度不足（現貨槓桿）
                # 重試2次，只有2次都失敗才判定為錯誤
                # 注意：Bybit API 的 retCode 可能不是 "170207"，錯誤碼在 retMsg 中
                is_loan_insufficient_error = (
                    trade_type == TradeType.SPOT and 
                    kwargs.get("use_leverage") and
                    ("170207" in error_code or "170207" in error_msg or 
                     "loan amount" in error_msg.lower() or 
                     "not enough" in error_msg.lower())
                )
                
                # 記錄錯誤檢測結果
                self.logger.debug("bybit_loan_insufficient_error_check",
                                 symbol=symbol,
                                 is_loan_insufficient_error=is_loan_insufficient_error,
                                 trade_type=trade_type.value,
                                 use_leverage=kwargs.get("use_leverage"),
                                 error_code=error_code,
                                 error_msg_contains_170207="170207" in error_msg,
                                 error_msg_contains_loan_amount="loan amount" in error_msg.lower(),
                                 error_msg_contains_not_enough="not enough" in error_msg.lower())
                
                if is_loan_insufficient_error:
                    max_retries = 2
                    retry_delay = 0.2  # 每次重試間隔0.2秒
                    
                    self.logger.warning("bybit_spot_leverage_loan_insufficient", 
                                       symbol=symbol, 
                                       error_code=error_code,
                                       error_msg=error_msg,
                                       max_retries=max_retries)
                    
                    # 重試2次
                    for retry_count in range(1, max_retries + 1):
                        self.logger.info("bybit_spot_leverage_retry_attempt", 
                                        symbol=symbol,
                                        retry_count=retry_count,
                                        max_retries=max_retries)
                        
                        # 等待後重試
                        await asyncio.sleep(retry_delay)
                        
                        # 重新下單（保持相同參數）
                        try:
                            retry_response = self._client.place_order(**order_params)
                        except Exception as retry_error:
                            error_str = str(retry_error)
                            retry_response = {
                                "retCode": -1,
                                "retMsg": error_str
                            }
                        
                        if retry_response.get("retCode") == 0:
                            result = retry_response.get("result", {})
                            self.logger.info("bybit_spot_leverage_retry_success", 
                                            symbol=symbol,
                                            order_id=result.get("orderId"),
                                            retry_count=retry_count)
                            return OrderResult(
                                success=True,
                                order_id=result.get("orderId"),
                                price=price,
                                quantity=quantity,
                                timestamp=int(time.time() * 1000)
                            )
                        else:
                            retry_error_msg = retry_response.get("retMsg", error_msg)
                            retry_error_code = str(retry_response.get("retCode", ""))
                            self.logger.warning("bybit_spot_leverage_retry_failed", 
                                              symbol=symbol,
                                              retry_count=retry_count,
                                              error_code=retry_error_code,
                                              error_msg=retry_error_msg)
                            # 更新錯誤訊息為最新的
                            error_msg = retry_error_msg
                            error_code = retry_error_code
                    
                    # 10次重試都失敗，記錄最終錯誤
                    self.logger.error("bybit_spot_leverage_all_retries_failed", 
                                    symbol=symbol,
                                    max_retries=max_retries,
                                    final_error_code=error_code,
                                    final_error_msg=error_msg)
                
                return OrderResult(
                    success=False,
                    error_message=error_msg
                )
                
        except Exception as e:
            self.logger.error("bybit_place_order_failed", 
                            symbol=symbol, 
                            side=side.value, 
                            quantity=quantity, 
                            error=str(e))
            return OrderResult(
                success=False,
                error_message=str(e)
            )
    
    async def cancel_order(self, symbol: str, order_id: str, trade_type: TradeType = TradeType.SPOT) -> bool:
        """取消訂單"""
        try:
            self._check_authentication()
            symbol = self._normalize_symbol(symbol)
            category = self._get_category(trade_type)
            
            response = self._client.cancel_order(
                category=category,
                symbol=symbol,
                orderId=order_id
            )
            
            return response.get("retCode") == 0
            
        except Exception as e:
            self.logger.error("bybit_cancel_order_failed", 
                            symbol=symbol, 
                            order_id=order_id, 
                            error=str(e))
            return False
    
    async def get_order_status(self, symbol: str, order_id: str, trade_type: TradeType = TradeType.SPOT) -> Dict[str, Any]:
        """查詢訂單狀態"""
        try:
            self._check_authentication()
            symbol = self._normalize_symbol(symbol)
            category = self._get_category(trade_type)
            
            response = self._client.get_open_orders(
                category=category,
                symbol=symbol,
                orderId=order_id
            )
            
            if response.get("retCode") == 0:
                orders = response.get("result", {}).get("list", [])
                return orders[0] if orders else {}
            else:
                raise Exception(f"Bybit API 錯誤: {response.get('retMsg')}")
                
        except Exception as e:
            self.logger.error("bybit_get_order_status_failed", 
                            symbol=symbol, 
                            order_id=order_id, 
                            error=str(e))
            raise
    
    async def get_fill_price(self, order_id: str, symbol: str, trade_type: TradeType = TradeType.SPOT) -> Optional[float]:
        """查詢 Bybit 訂單實際成交價格（混合策略）"""
        try:
            self._check_authentication()
            symbol = self._normalize_symbol(symbol)
            category = self._get_category(trade_type)
            
            # 策略1：先嘗試實時查詢（快速）
            fill_price = await self._get_fill_price_realtime(order_id, symbol, category)
            if fill_price:
                return fill_price
            
            # 策略2：如果實時查詢失敗，使用歷史查詢（穩定）
            self.logger.info("bybit_fallback_to_history_query", 
                           order_id=order_id,
                           symbol=symbol)
            
            fill_price = await self._get_fill_price_history(order_id, symbol, category)
            return fill_price
            
        except Exception as e:
            self.logger.error("bybit_get_fill_price_failed", 
                             order_id=order_id, 
                             symbol=symbol, 
                             error=str(e))
            return None

    async def _get_fill_price_realtime(self, order_id: str, symbol: str, category: str) -> Optional[float]:
        """使用實時查詢獲取成交價格"""
        try:
            # 使用 get_open_orders 查詢訂單詳情，設置 openOnly=1 查詢終態訂單
            response = self._client.get_open_orders(
                category=category,
                symbol=symbol,
                orderId=order_id,
                openOnly=1,  # 查詢終態訂單（已成交、取消、拒絕）
                limit=1
            )
            
            if response.get("retCode") == 0:
                orders = response.get("result", {}).get("list", [])
                if orders:
                    order = orders[0]
                    # 獲取平均成交價格
                    avg_price = order.get("avgPrice")
                    if avg_price and avg_price != "" and float(avg_price) > 0:
                        self.logger.info("bybit_realtime_price_found", 
                                       order_id=order_id,
                                       price=float(avg_price))
                        return float(avg_price)
            
            return None
            
        except Exception as e:
            self.logger.warning("bybit_realtime_query_failed", 
                              order_id=order_id,
                              error=str(e))
            return None

    async def _get_fill_price_history(self, order_id: str, symbol: str, category: str) -> Optional[float]:
        """使用歷史查詢獲取成交價格"""
        try:
            import time
            
            # 計算查詢時間範圍（最近1小時）
            current_time = int(time.time() * 1000)
            start_time = current_time - (60 * 60 * 1000)  # 1小時前
            
            # 使用 get_order_history 查詢歷史訂單
            response = self._client.get_order_history(
                category=category,
                symbol=symbol,
                orderId=order_id,
                startTime=start_time,
                endTime=current_time,
                limit=1
            )
            
            if response.get("retCode") == 0:
                orders = response.get("result", {}).get("list", [])
                if orders:
                    order = orders[0]
                    # 獲取平均成交價格
                    avg_price = order.get("avgPrice")
                    if avg_price and avg_price != "" and float(avg_price) > 0:
                        self.logger.info("bybit_history_price_found", 
                                       order_id=order_id,
                                       price=float(avg_price))
                        return float(avg_price)
                    
                    # 檢查訂單狀態
                    order_status = order.get("orderStatus", "")
                    cum_exec_qty = float(order.get("cumExecQty", 0))
                    
                    if order_status == "Filled" and cum_exec_qty > 0:
                        self.logger.warning("bybit_history_no_avg_price", 
                                          order_id=order_id,
                                          order_status=order_status,
                                          cum_exec_qty=cum_exec_qty)
            
            return None
            
        except Exception as e:
            self.logger.warning("bybit_history_query_failed", 
                              order_id=order_id,
                              error=str(e))
            return None
    
    # 帳戶接口
    
    async def get_balances(self) -> List[Balance]:
        """獲取餘額"""
        try:
            self._check_authentication()
            
            response = self._client.get_wallet_balance(accountType="UNIFIED")
            
            if response.get("retCode") != 0:
                raise Exception(f"Bybit API 錯誤: {response.get('retMsg')}")
            
            balances = []
            account_list = response.get("result", {}).get("list", [])
            
            if account_list:
                coins = account_list[0].get("coin", [])
                for coin in coins:
                    wallet_balance = float(coin.get("walletBalance", 0))
                    locked_balance = float(coin.get("locked", 0))
                    
                    if wallet_balance > 0 or locked_balance > 0:
                        balances.append(Balance(
                            asset=coin.get("coin"),
                            free=wallet_balance - locked_balance,
                            locked=locked_balance
                        ))
            
            return balances
            
        except Exception as e:
            self.logger.error("bybit_get_balances_failed", error=str(e))
            raise
    
    async def get_positions(self) -> List[Position]:
        """獲取持倉（合約）"""
        try:
            self._check_authentication()
            
            positions = []
            
            # 獲取線性合約和反向合約持倉
            for category in ["linear", "inverse"]:
                try:
                    self.logger.info(f"bybit_get_positions_start", category=category)
                    
                    # 根據類別設置結算幣種
                    # linear (USDT永續): 使用 settleCoin=USDT
                    # inverse (幣本位): 不傳 settleCoin（因為每個幣種不同）
                    if category == "linear":
                        response = self._client.get_positions(
                            category=category,
                            settleCoin="USDT"
                        )
                    else:
                        response = self._client.get_positions(category=category)
                    
                    if response.get("retCode") == 0:
                        position_list = response.get("result", {}).get("list", [])
                        self.logger.info(f"bybit_get_positions_response", 
                                       category=category, 
                                       count=len(position_list),
                                       has_positions=len(position_list) > 0)
                        
                        for pos in position_list:
                            # 安全轉換 size（可能是字符串或數字）
                            size_raw = pos.get("size", 0)
                            try:
                                size = float(size_raw) if size_raw else 0.0
                            except (ValueError, TypeError):
                                size = 0.0
                            
                            # 只返回有持倉的（絕對值大於 0）
                            if abs(size) > 0:
                                symbol = pos.get("symbol")
                                if not symbol:
                                    continue
                                
                                # 解析 baseAsset 和 quoteAsset
                                base_asset = symbol.replace("USDT", "").replace("USD", "").replace("PERP", "").strip()
                                quote_asset = "USDT" if "USDT" in symbol else "USD"
                                
                                # 判斷持倉類型
                                position_type = f"perp_{category}"
                                
                                # 獲取資金費率
                                funding_rate = None
                                next_funding = None
                                try:
                                    ticker_resp = self._client.get_tickers(category=category, symbol=symbol)
                                    if ticker_resp.get("retCode") == 0:
                                        ticker_list = ticker_resp.get("result", {}).get("list", [])
                                        if ticker_list:
                                            ticker = ticker_list[0]
                                            funding_rate = float(ticker.get("fundingRate", 0))
                                            next_funding = int(ticker.get("nextFundingTime", 0))
                                except Exception:
                                    pass
                                
                                # 處理 side 字段（可能是 "Buy", "Sell", "None", None, "" 等）
                                side_raw = pos.get("side", "")
                                side_str = str(side_raw).lower().strip() if side_raw else ""
                                
                                # BYBIT API 的 side 字段：
                                # - "Buy" 或 "buy" = 多頭
                                # - "Sell" 或 "sell" = 空頭
                                # - "None" 或 None = 無持倉（但我們已經過濾了 size != 0）
                                # 如果 side 為空或未知，根據 size 的正負判斷（如果 size 帶符號）
                                if side_str in ["buy", "long"]:
                                    side = "long"
                                    size_value = abs(size)  # 確保為正數
                                elif side_str in ["sell", "short"]:
                                    side = "short"
                                    size_value = -abs(size)  # 確保為負數
                                else:
                                    # 如果 side 字段異常，根據 size 的正負判斷
                                    # BYBIT API 的 size 通常是絕對值，但有些情況下可能帶符號
                                    if size > 0:
                                        side = "long"
                                        size_value = size
                                    elif size < 0:
                                        side = "short"
                                        size_value = size  # 保持負數
                                    else:
                                        continue  # size 為 0，跳過
                                
                                # 提取已實現盈虧字段
                                cur_realised_pnl = float(pos.get("curRealisedPnl", 0)) if pos.get("curRealisedPnl") else 0.0
                                cum_realised_pnl = float(pos.get("cumRealisedPnl", 0)) if pos.get("cumRealisedPnl") else 0.0
                                
                                # 記錄調試信息
                                self.logger.debug("bybit_position_parsing",
                                                symbol=symbol,
                                                raw_side=side_raw,
                                                parsed_side=side,
                                                raw_size=size_raw,
                                                parsed_size=size_value,
                                                category=category)
                                
                                positions.append(Position(
                                    symbol=symbol,
                                    base_asset=base_asset,
                                    quote_asset=quote_asset,
                                    position_type=position_type,
                                    side=side,
                                    size=size_value,
                                    entry_price=float(pos.get("avgPrice", 0)) if pos.get("avgPrice") else 0.0,
                                    mark_price=float(pos.get("markPrice", 0)) if pos.get("markPrice") else 0.0,
                                    unrealized_pnl=float(pos.get("unrealisedPnl", 0)) if pos.get("unrealisedPnl") else 0.0,
                                    realized_pnl=cur_realised_pnl,
                                    leverage=float(pos.get("leverage", 1)) if pos.get("leverage") else 1.0,
                                    margin_mode="cross",
                                    margin_usdt=float(pos.get("positionIM", 0)) if pos.get("positionIM") else 0.0,
                                    liquidation_price=float(pos.get("liqPrice", 0)) if pos.get("liqPrice") and pos.get("liqPrice") != "0" else None,
                                    funding_rate_8h=funding_rate,
                                    next_funding_time=next_funding
                                ))
                                
                                # 調試日誌：記錄已實現盈虧數據
                                self.logger.debug("bybit_position_realized_pnl",
                                                symbol=symbol,
                                                curRealisedPnl=cur_realised_pnl,
                                                cumRealisedPnl=cum_realised_pnl,
                                                side=side,
                                                size=size_value,
                                                note="curRealisedPnl 代表當前持倉的已實現盈虧")
                except Exception as e:
                    self.logger.warning(f"獲取 {category} 持倉失敗", error=str(e))
                    continue
            
            return positions
            
        except Exception as e:
            self.logger.error("bybit_get_positions_failed", error=str(e))
            raise
    
    # 健康檢查
    
    async def ping(self) -> bool:
        """檢查連接狀態"""
        try:
            response = self._client.get_server_time()
            return response.get("retCode") == 0
        except Exception:
            return False
    
    async def get_server_time(self) -> int:
        """獲取服務器時間"""
        try:
            response = self._client.get_server_time()
            if response.get("retCode") == 0:
                return int(response.get("result", {}).get("timeSecond", 0)) * 1000
            else:
                raise Exception(f"Bybit API 錯誤: {response.get('retMsg')}")
        except Exception as e:
            self.logger.error("bybit_get_server_time_failed", error=str(e))
            raise
    
    # 批量優化
    
    async def get_multiple_tickers(self, symbols: List[str], trade_type: TradeType = TradeType.SPOT) -> Dict[str, TickerData]:
        """批量獲取行情（Bybit 優化版本）"""
        try:
            category = self._get_category(trade_type)
            
            # Bybit 支援一次獲取所有 ticker
            response = self._client.get_tickers(category=category)
            
            if response.get("retCode") != 0:
                raise Exception(f"Bybit API 錯誤: {response.get('retMsg')}")
            
            ticker_list = response.get("result", {}).get("list", [])
            results = {}
            
            # 過濾出需要的符號
            symbol_set = {self._normalize_symbol(s) for s in symbols}
            
            for ticker in ticker_list:
                symbol = ticker.get("symbol")
                if symbol in symbol_set:
                    results[symbol] = TickerData(
                        symbol=symbol,
                        bid_price=float(ticker.get("bid1Price", 0)),
                        ask_price=float(ticker.get("ask1Price", 0)),
                        last_price=float(ticker.get("lastPrice", 0)),
                        volume_24h=float(ticker.get("volume24h", 0)),
                        timestamp=int(ticker.get("time", time.time() * 1000)),
                        high_24h=float(ticker.get("highPrice24h", 0)) or None,
                        low_24h=float(ticker.get("lowPrice24h", 0)) or None,
                        change_24h=float(ticker.get("price24hPcnt", 0)) or None
                    )
            
            return results
            
        except Exception as e:
            self.logger.error("bybit_get_multiple_tickers_failed", error=str(e))
            # 回退到基類的逐個獲取
            return await super().get_multiple_tickers(symbols, trade_type)
    
    # 倉位監控新增方法
    
    async def check_account_mode(self) -> Tuple[str, bool]:
        """檢查 Bybit 帳戶模式"""
        try:
            self._check_authentication()
            response = self._client.get_wallet_balance(accountType="UNIFIED")
            if response.get("retCode") == 0:
                return ("unified", True)
            else:
                return ("classic", False)
        except Exception as e:
            self.logger.error("bybit_check_account_mode_failed", error=str(e))
            return ("unknown", False)
    
    async def get_funding_rates(self, symbols: List[str] = None) -> List[FundingRate]:
        """獲取 Bybit 資金費率"""
        try:
            funding_rates = []
            
            for category in ["linear", "inverse"]:
                response = self._client.get_tickers(category=category)
                if response.get("retCode") != 0:
                    continue
                
                tickers = response.get("result", {}).get("list", [])
                for ticker in tickers:
                    symbol = ticker.get("symbol")
                    if symbols and symbol not in symbols:
                        continue
                    
                    # 安全地轉換資金費率（處理空字符串）
                    funding_rate = self._safe_float(ticker.get("fundingRate", ""), 0.0)
                    next_funding_time = int(ticker.get("nextFundingTime", 0)) if ticker.get("nextFundingTime") else 0
                    predicted_rate = self._safe_float(ticker.get("predictedFundingRate", ""), funding_rate)
                    
                    # 獲取資金費率間隔（小時），如果沒有則使用默認值 8
                    funding_interval_hour_str = ticker.get("fundingIntervalHour", "")
                    if funding_interval_hour_str:
                        try:
                            settlement_interval = int(float(funding_interval_hour_str))
                        except (ValueError, TypeError):
                            settlement_interval = 8  # 默認值
                    else:
                        settlement_interval = 8  # 默認值
                    
                    # 計算每日結算次數和每日費率
                    daily_count = 24 // settlement_interval if settlement_interval > 0 else 3
                    funding_rate_daily = funding_rate * daily_count
                    funding_rate_8h = funding_rate * (8 / settlement_interval)
                    funding_rate_daily = funding_rate * (24 / settlement_interval)
                    funding_rates.append(FundingRate(
                        exchange="bybit",
                        symbol=symbol,
                        category=category,
                        funding_rate=funding_rate,
                        funding_rate_8h=funding_rate_8h,  # 當前結算週期的費率
                        funding_rate_daily=funding_rate_daily,
                        next_funding_time=next_funding_time,
                        predicted_funding_rate=predicted_rate,
                        settlement_interval_hours=settlement_interval,  # 從 API 獲取的實際結算週期
                        timestamp=int(time.time() * 1000)
                    ))
            
            return funding_rates
            
        except Exception as e:
            self.logger.error("bybit_get_funding_rates_failed", error=str(e))
            raise
    
    async def get_spot_leverage(self, currency: Optional[str] = None) -> Dict[str, float]:
        """獲取現貨借貸槓桿
        
        API: GET /v5/spot-margin-trade/coinstate
        查詢現貨借貸槓桿
        
        注意：此 API 需要認證（API Key）
        
        參數:
            currency: 幣名稱（大寫），如果為 None 則查詢所有幣種
        
        返回:
            Dict[currency, float]: 每個幣種的現貨借貸槓桿
            {
                "BTC": 3.0,
                "ETH": 4.0,
                ...
            }
        """
        try:
            # 檢查認證
            if not self.is_authenticated:
                self.logger.warning("bybit_get_spot_leverage_no_auth", 
                                  message="需要 API 認證才能獲取現貨借貸槓桿")
                return {}
            
            # 🔥 使用 HTTP Headers 認證方式（Bybit v5 API 標準）
            import aiohttp
            import hmac
            import hashlib
            
            base_url = "https://api-testnet.bybit.com" if self.testnet else "https://api.bybit.com"
            endpoint = "/v5/spot-margin-trade/coinstate"
            url = f"{base_url}{endpoint}"
            
            # 生成時間戳
            timestamp = str(int(time.time() * 1000))
            recv_window = "5000"
            
            # 構建查詢參數（只有業務參數，不包含認證參數）
            query_params = {}
            if currency:
                query_params["currency"] = currency.upper()
            
            # 構建查詢字符串（用於簽名）
            from urllib.parse import urlencode
            query_string = urlencode(query_params) if query_params else ""
            
            # 生成簽名
            # Bybit v5 API 簽名算法：timestamp + api_key + recv_window + query_string
            param_str = timestamp + self.api_key + recv_window + query_string
            signature = hmac.new(
                self.api_secret.encode('utf-8'),
                param_str.encode('utf-8'),
                hashlib.sha256
            ).hexdigest()
            
            # 構建 HTTP Headers
            headers = {
                "X-BAPI-API-KEY": self.api_key,
                "X-BAPI-TIMESTAMP": timestamp,
                "X-BAPI-RECV-WINDOW": recv_window,
                "X-BAPI-SIGN": signature,
                "Content-Type": "application/json"
            }
            
            # 構建完整 URL（包含查詢參數）
            full_url = f"{url}?{query_string}" if query_string else url
            
            # 設置超時：總超時 10 秒，連接超時 5 秒
            timeout = aiohttp.ClientTimeout(total=2, connect=2)
            
            # 發送請求
            async with aiohttp.ClientSession(timeout=timeout) as session:
                async with session.get(full_url, headers=headers) as resp:
                    data = await resp.json()
                    
                    if data.get("retCode") != 0:
                        self.logger.error("bybit_get_spot_leverage_api_error",
                                        ret_code=data.get("retCode"),
                                        ret_msg=data.get("retMsg"))
                        return {}
                    
                    result = data.get("result", {})
                    coin_list = result.get("list", [])
                    
                    # 構建返回字典
                    leverage_dict = {}
                    for item in coin_list:
                        currency_name = item.get("currency", "").upper()
                        spot_leverage = item.get("spotLeverage", "")
                        
                        # 如果現貨借貸模式關閉，spotLeverage 為空字符串
                        if currency_name and spot_leverage and spot_leverage != "":
                            try:
                                leverage_dict[currency_name] = float(spot_leverage)
                            except (ValueError, TypeError):
                                continue
                    
                    self.logger.info("bybit_get_spot_leverage_success", count=len(leverage_dict))
                    return leverage_dict
            
        except asyncio.TimeoutError:
            self.logger.error("bybit_get_spot_leverage_failed", 
                            error="請求超時（Timeout）",
                            timeout="10秒")
            return {}
        except aiohttp.ClientError as e:
            self.logger.error("bybit_get_spot_leverage_failed", 
                            error=f"網路連接錯誤: {str(e)}")
            return {}
        except Exception as e:
            self.logger.error("bybit_get_spot_leverage_failed", error=str(e))
            return {}
    
    async def get_position_tiers(self, currency: Optional[str] = None) -> Dict[str, Dict]:
        """獲取借貸倉位風險信息（槓桿等級）
        
        API: GET /v5/spot-margin-trade/position-tiers
        查詢現貨槓桿的槓桿等級信息，包括最大借貸槓桿
        
        注意：此 API 需要認證（API Key）
        
        參數:
            currency: 幣名稱（大寫），如果為 None 則查詢所有幣種
        
        返回:
            Dict[currency, Dict]: 每個幣種的槓桿等級信息
            {
                "BTC": {
                    "tiers": [
                        {
                            "tier": "1",
                            "borrowLimit": "390",
                            "positionMMR": "0.04",
                            "positionIMR": "0.2",
                            "maxLeverage": "5"
                        },
                        ...
                    ]
                },
                ...
            }
        """
        try:
            # 檢查認證
            if not self.is_authenticated:
                self.logger.warning("bybit_get_position_tiers_no_auth", 
                                  message="需要 API 認證才能獲取槓桿等級信息")
                return {}
            
            # 構建參數
            params = {}
            if currency:
                params["currency"] = currency.upper()
            
            # 🔥 使用 HTTP Headers 認證方式（Bybit v5 API 標準）
            # Bybit v5 API 使用 HTTP Headers 而不是查詢參數進行認證
            import aiohttp
            import hmac
            import hashlib
            
            base_url = "https://api-testnet.bybit.com" if self.testnet else "https://api.bybit.com"
            endpoint = "/v5/spot-margin-trade/position-tiers"
            url = f"{base_url}{endpoint}"
            
            # 生成時間戳
            timestamp = str(int(time.time() * 1000))
            recv_window = "5000"
            
            # 構建查詢參數（只有業務參數，不包含認證參數）
            query_params = {}
            if currency:
                query_params["currency"] = currency.upper()
            
            # 構建查詢字符串（用於簽名）
            from urllib.parse import urlencode
            query_string = urlencode(query_params) if query_params else ""
            
            # 生成簽名
            # Bybit v5 API 簽名算法：timestamp + api_key + recv_window + query_string
            param_str = timestamp + self.api_key + recv_window + query_string
            signature = hmac.new(
                self.api_secret.encode('utf-8'),
                param_str.encode('utf-8'),
                hashlib.sha256
            ).hexdigest()
            
            # 構建 HTTP Headers
            headers = {
                "X-BAPI-API-KEY": self.api_key,
                "X-BAPI-TIMESTAMP": timestamp,
                "X-BAPI-RECV-WINDOW": recv_window,
                "X-BAPI-SIGN": signature,
                "Content-Type": "application/json"
            }
            
            # 構建完整 URL（包含查詢參數）
            full_url = f"{url}?{query_string}" if query_string else url
            
            # 發送請求
            async with aiohttp.ClientSession() as session:
                async with session.get(full_url, headers=headers) as resp:
                    data = await resp.json()
                    
                    if data.get("retCode") != 0:
                        self.logger.error("bybit_get_position_tiers_api_error",
                                        ret_code=data.get("retCode"),
                                        ret_msg=data.get("retMsg"))
                        return {}
                    
                    result = data.get("result", {})
                    tiers_list = result.get("list", [])
                    
                    # 構建返回字典
                    tiers_dict = {}
                    for item in tiers_list:
                        currency_name = item.get("currency", "").upper()
                        if not currency_name:
                            continue
                        
                        position_tiers = item.get("positionTiersRatioList", [])
                        tiers_dict[currency_name] = {
                            "tiers": position_tiers
                        }
                    
                    self.logger.info("bybit_get_position_tiers_success", count=len(tiers_dict))
                    return tiers_dict
            
        except Exception as e:
            self.logger.error("bybit_get_position_tiers_failed", error=str(e))
            return {}
    
    async def get_borrowing_rates(self, assets: List[str] = None) -> List[BorrowingRate]:
        """獲取借幣利率（槓桿現貨）
        
        API: GET /v5/spot-margin-trade/data
        查詢統一帳戶下不同VIP等級的槓桿數據（使用 "No VIP" 等級）
        
        注意：Bybit 此 API 不需要認證，不需要 API key
        """
        try:
            import aiohttp
            
            # Bybit API 基礎 URL
            base_url = "https://api-testnet.bybit.com" if self.testnet else "https://api.bybit.com"
            endpoint = "/v5/spot-margin-trade/data"
            url = f"{base_url}{endpoint}"
            
            # 構建參數（使用 "No VIP" 等級）
            params = {
                "vipLevel": "No VIP"
            }
            
            # 如果指定了資產，添加 currency 參數（支持多個幣種，逗號分隔）
            if assets:
                params["currency"] = ",".join([asset.upper() for asset in assets])
            
            # 發送 HTTP 請求（不需要認證）
            async with aiohttp.ClientSession() as session:
                async with session.get(url, params=params) as response:
                    data = await response.json()
                    
                    if data.get("retCode") != 0:
                        self.logger.error("bybit_get_borrowing_rates_api_error",
                                        ret_code=data.get("retCode"),
                                        ret_msg=data.get("retMsg"))
                        return []
                    
                    result = data.get("result", {})
                    vip_coin_list = result.get("vipCoinList", [])
                    
                    borrowing_rates = []
                    # 遍歷 VIP 等級列表（通常只有一個 "No VIP"）
                    for vip_data in vip_coin_list:
                        coin_list = vip_data.get("list", [])
                        
                        for item in coin_list:
                            currency = item.get("currency", "").upper()
                            if not currency:
                                continue
                            
                            # 如果指定了資產列表，過濾
                            if assets and currency not in [a.upper() for a in assets]:
                                continue
                            
                            # 只返回支持借貸的幣種
                            if not item.get("borrowable", False):
                                continue
                            
                            # 獲取小時借貸利率
                            # 注意：Bybit 返回的 hourlyBorrowRate 已經是小時利率，不需要再乘以 24
                            hourly_rate_str = item.get("hourlyBorrowRate", "0")
                            hourly_rate = self._safe_float(hourly_rate_str, 0.0)
                            
                            # Bybit 返回的是小時利率，前端直接顯示小時利率，不計算日利率
                            # 為了保持數據結構一致性，將小時利率直接作為日利率字段（前端會使用小時利率字段）
                            borrowing_rates.append(BorrowingRate(
                                exchange="bybit",
                                asset=currency,
                                interest_rate_hourly=hourly_rate,
                                interest_rate_daily=hourly_rate,  # 不乘以 24，直接使用小時利率
                                timestamp=int(time.time() * 1000)
                            ))
                    
                    self.logger.info("bybit_get_borrowing_rates_success", count=len(borrowing_rates))
                    return borrowing_rates
            
        except Exception as e:
            self.logger.error("bybit_get_borrowing_rates_failed", error=str(e))
            return []
    
    async def get_account_summary(self) -> AccountSummary:
        """獲取 Bybit 統一帳戶摘要"""
        try:
            self._check_authentication()
            
            # 檢查帳戶模式
            account_mode, is_supported = await self.check_account_mode()
            if not is_supported:
                return AccountSummary(
                    exchange="bybit",
                    account_mode="unsupported",
                    timestamp=int(time.time() * 1000),
                    unsupported_reason="需要使用統一交易帳戶（Unified Trading Account）"
                )
            
            # 獲取帳戶資訊
            self.logger.info("bybit_get_wallet_balance_start")
            response = self._client.get_wallet_balance(accountType="UNIFIED")
            if response.get("retCode") != 0:
                raise Exception(f"Bybit API 錯誤: {response.get('retMsg')}")
            
            account_data = response.get("result", {}).get("list", [])[0]
            
            # 解析餘額
            balances = []
            coins = account_data.get("coin", [])
            self.logger.info("bybit_get_wallet_balance_response", 
                           coin_count=len(coins),
                           total_equity=account_data.get("totalEquity"))
            for coin in coins:
                wallet_balance = self._safe_float(coin.get("walletBalance", 0))
                locked = self._safe_float(coin.get("locked", 0))
                borrowed = self._safe_float(coin.get("borrowAmount", 0))
                usdt_value = self._safe_float(coin.get("usdValue", 0))
                
                # 過濾邏輯：只顯示有實際價值的資產
                # 1. USDT 價值絕對值 > 1 美金（主要判斷標準）
                # 2. 或者有借幣（即使價值小也要顯示，因為有負債）
                MIN_DISPLAY_VALUE = 1.0  # 最小顯示閾值 $1
                should_show = abs(usdt_value) > MIN_DISPLAY_VALUE or borrowed > 0
                
                self.logger.info(f"balance_filter_check",
                               asset=coin.get("coin"),
                               wallet_balance=wallet_balance,
                               locked=locked,
                               borrowed=borrowed,
                               usdt_value=usdt_value,
                               abs_usdt_value=abs(usdt_value),
                               should_show=should_show)
                
                if should_show:
                    # 🔥 修正：總額 = walletBalance（錢包總餘額）
                    # walletBalance 是總餘額，餘額 = walletBalance - borrowAmount（錢包目前擁有的幣數）
                    balance = wallet_balance - borrowed
                    balances.append(Balance(
                        asset=coin.get("coin"),
                        free=balance,  # 餘額 = walletBalance - 借幣（錢包目前擁有的幣數）
                        locked=locked,
                        borrowed=borrowed,
                        interest=self._safe_float(coin.get("accruedInterest", 0)),
                        interest_rate_daily=0.0,  # 需額外查詢
                        usdt_value=usdt_value
                    ))
            
            # 獲取合約持倉
            positions = await self.get_positions()
            
            # 🔥 將有借貸的餘額轉換為 spot_margin 持倉（Bybit 統一現貨槓桿）
            # 先收集有借幣的幣種列表
            borrowed_currencies = [bal.asset.upper() for bal in balances if bal.borrowed > 0]
            
            # 🔥 使用 coinstate API 獲取現貨借貸槓桿（更簡單直接）
            spot_leverage_dict = {}
            if borrowed_currencies:
                # 只查詢有借幣的幣種的槓桿
                for currency in borrowed_currencies:
                    leverage = await self.get_spot_leverage(currency=currency)
                    spot_leverage_dict.update(leverage)
            
            spot_margin_positions = []
            for balance in balances:
                # 如果有借貸（borrowed > 0），說明涉及現貨槓桿/借幣
                # 為了正確顯示對沖情況，我們需要將其拆分為兩個持倉：
                # 1. 資產持倉 (Spot Long)：顯示總資產 (walletBalance)
                # 2. 負債持倉 (Margin Short)：顯示總負債 (borrowAmount)
                if balance.borrowed > 0:
                    # 構建交易對符號（例如：BTC -> BTCUSDT）
                    symbol = f"{balance.asset}USDT"
                    base_asset = balance.asset
                    quote_asset = "USDT"
                    
                    # 嘗試獲取標記價格（用於計算名義價值）
                    try:
                        ticker = await self.get_ticker(symbol, TradeType.SPOT)
                        mark_price = ticker.last_price if ticker else 0.0
                    except:
                        mark_price = 0.0
                    
                    # 獲取槓桿信息
                    leverage = 1.0
                    currency_upper = balance.asset.upper()
                    if currency_upper in spot_leverage_dict:
                        leverage = spot_leverage_dict[currency_upper]
                    
                    # 1. 創建負債持倉 (Short)
                    # 負債大小 = borrowed
                    liability_size = balance.borrowed
                    liability_notional = liability_size * mark_price
                    
                    # 計算負債保證金 (名義價值 / 槓桿)
                    liability_margin = (liability_notional / leverage) if leverage > 0 else liability_notional
                    
                    liability_pos = Position(
                        symbol=symbol,
                        base_asset=base_asset,
                        quote_asset=quote_asset,
                        position_type="spot_margin",  # 借貸部分
                        side="short",  # 負債視為空頭
                        size=-liability_size,  # 負數表示空頭
                        entry_price=mark_price,
                        mark_price=mark_price,
                        unrealized_pnl=0.0,
                        realized_pnl=0.0,
                        leverage=leverage,
                        margin_mode="cross",
                        margin_usdt=liability_margin,
                        liquidation_price=None,
                        funding_rate_8h=None,
                        next_funding_time=None
                    )
                    spot_margin_positions.append(liability_pos)
                    
                    self.logger.info("bybit_spot_margin_split_liability", 
                                   asset=base_asset,
                                   borrowed=liability_size,
                                   side="short",
                                   leverage=leverage)

                    # 2. 創建資產持倉 (Long)
                    # 資產大小 = walletBalance (free + borrowed)
                    # 注意：這裡的 free 是我們計算出的 net_balance (wallet - borrowed)
                    # 所以 walletBalance = free + borrowed
                    asset_size = balance.free + balance.borrowed
                    
                    # 只有當資產大於 0 時才創建資產持倉
                    if asset_size > 0:
                        asset_notional = asset_size * mark_price
                        
                        asset_pos = Position(
                            symbol=symbol,
                            base_asset=base_asset,
                            quote_asset=quote_asset,
                            position_type="spot_cash",  # 現貨資產部分
                            side="long",  # 資產視為多頭
                            size=asset_size,
                            entry_price=mark_price,
                            mark_price=mark_price,
                            unrealized_pnl=0.0,
                            realized_pnl=0.0,
                            leverage=1.0,  # 現貨無槓桿
                            margin_mode="cross",
                            margin_usdt=asset_notional,  # 現貨全額佔用
                            liquidation_price=None,
                            funding_rate_8h=None,
                            next_funding_time=None
                        )
                        spot_margin_positions.append(asset_pos)
                        
                        self.logger.info("bybit_spot_margin_split_asset", 
                                       asset=base_asset,
                                       total_asset=asset_size,
                                       side="long")
            
            # 合併合約持倉和現貨槓桿持倉
            all_positions = list(positions) + spot_margin_positions
            
            return AccountSummary(
                exchange="bybit",
                account_mode="unified",
                timestamp=int(time.time() * 1000),
                total_equity_usdt=self._safe_float(account_data.get("totalEquity", 0)),
                total_margin_usdt=self._safe_float(account_data.get("totalMarginBalance", 0)),
                available_balance_usdt=self._safe_float(account_data.get("availableBalance", 0)),
                margin_ratio=self._safe_float(account_data.get("accountIMRate", 0)),
                maintenance_margin_rate=self._safe_float(account_data.get("accountMMRate", 0)),
                total_initial_margin=self._safe_float(account_data.get("totalInitialMargin", 0)),
                total_maintenance_margin=self._safe_float(account_data.get("totalMaintenanceMargin", 0)),
                balances=balances,
                positions=all_positions
            )
            
        except Exception as e:
            self.logger.error("bybit_get_account_summary_failed", error=str(e))
            raise
