"""
Binance 交易所實現
"""

import time
import hashlib
import hmac
import aiohttp
import asyncio
from typing import Optional, List, Dict, Any, Tuple
from urllib.parse import urlencode

from .base import (
    BaseExchange, OrderResult, TickerData, OrderBookData, Balance, Position,
    OrderSide, OrderType, TradeType, FundingRate, BorrowingRate, AccountSummary, AccountMode
)
from ..utils.logger import get_logger
from ..services.orderbook_feeds.binance import BinanceOrderBookFeed


class BinanceExchange(BaseExchange):
    """Binance 交易所實現 - 支持統一交易帳戶（Portfolio Margin）"""
    
    def __init__(self, api_key: str = "", api_secret: str = "", testnet: bool = False, use_portfolio_margin: bool = True):
        super().__init__(api_key, api_secret, testnet)
        self.logger = get_logger()
        self.use_portfolio_margin = use_portfolio_margin  # 是否使用統一交易帳戶
        
        # OrderBook Feed
        self.orderbook_feed = BinanceOrderBookFeed()
        
        # API 端點
        if testnet:
            self.base_url = "https://testnet.binance.vision"
            self.pm_base_url = "https://testnet.binance.vision"  # Portfolio Margin 測試網
            self.fapi_base_url = "https://testnet.binancefuture.com"  # Futures API 測試網
        else:
            self.base_url = "https://api.binance.com"  # 現貨 API
            self.pm_base_url = "https://papi.binance.com"  # Portfolio Margin 生產環境使用獨立域名
            self.fapi_base_url = "https://fapi.binance.com"  # Futures API (USDT-M) 生產環境
    
    @property
    def name(self) -> str:
        return "Binance"
    
    def _get_endpoint_prefix(self, trade_type: TradeType) -> str:
        """根據交易類型獲取端點前綴"""
        if trade_type == TradeType.SPOT:
            return "/api/v3"
        elif trade_type == TradeType.LINEAR:
            return "/fapi/v1"  # USDT-M Futures
        elif trade_type == TradeType.INVERSE:
            return "/dapi/v1"  # COIN-M Futures
        else:
            raise ValueError(f"不支援的交易類型: {trade_type}")
    
    def _convert_side(self, side: OrderSide) -> str:
        """轉換訂單方向為 Binance 格式"""
        return "BUY" if side == OrderSide.BUY else "SELL"
    
    def _convert_order_type(self, order_type: OrderType) -> str:
        """轉換訂單類型為 Binance 格式"""
        return "MARKET" if order_type == OrderType.MARKET else "LIMIT"
    
    def _generate_signature(self, params: str) -> str:
        """生成 API 簽名"""
        return hmac.new(
            self.api_secret.encode('utf-8'),
            params.encode('utf-8'),
            hashlib.sha256
        ).hexdigest()
    
    async def _make_request(self, method: str, endpoint: str, params: Dict = None, signed: bool = False, use_pm_url: bool = False) -> Dict:
        """發送 HTTP 請求
        
        Args:
            method: HTTP 方法 (GET, POST, DELETE)
            endpoint: API 端點路徑
            params: 請求參數
            signed: 是否需要簽名
            use_pm_url: 是否使用 Portfolio Margin 專用 URL (papi.binance.com)
        """
        params = params or {}
        
        if signed:
            if not self.is_authenticated:
                raise ValueError("需要 API 密鑰進行認證")
            
            # 使用服務器時間同步，避免時間戳錯誤
            server_time = await self.get_server_time()
            if server_time:
                params['timestamp'] = server_time
            else:
                # 如果無法獲取服務器時間，使用本地時間
                params['timestamp'] = int(time.time() * 1000)
            
            # 添加 recvWindow 參數，增加時間窗口容錯
            if 'recvWindow' not in params:
                params['recvWindow'] = 10000  # 10秒窗口
            
            query_string = urlencode(params)
            params['signature'] = self._generate_signature(query_string)
        
        headers = {}
        if self.api_key:
            headers['X-MBX-APIKEY'] = self.api_key
        
        # 根據端點類型選擇正確的基礎 URL
        if use_pm_url:
            # Portfolio Margin API 使用 papi.binance.com
            base_url = self.pm_base_url
        elif endpoint.startswith("/fapi/") or endpoint.startswith("/dapi/"):
            # Futures API (FAPI/DAPI) 使用 fapi.binance.com 或 dapi.binance.com
            if endpoint.startswith("/dapi/"):
                # COIN-M Futures (暫不支持，使用 FAPI URL)
                base_url = self.fapi_base_url.replace("fapi", "dapi") if hasattr(self, 'fapi_base_url') else "https://dapi.binance.com"
            else:
                base_url = self.fapi_base_url
        else:
            # 現貨 API 使用 api.binance.com
            base_url = self.base_url
        url = f"{base_url}{endpoint}"
        
        # 設置超時（連接超時 10 秒，總超時 30 秒）
        # 對於公共 API（如資金費率），使用更短的超時
        if not signed:
            timeout = aiohttp.ClientTimeout(total=15, connect=5)
        else:
            timeout = aiohttp.ClientTimeout(total=30, connect=10)
        
        async with aiohttp.ClientSession(timeout=timeout) as session:
            if method.upper() == "GET":
                async with session.get(url, params=params, headers=headers) as response:
                    # 檢查狀態碼
                    if response.status != 200:
                        error_text = await response.text()
                        raise Exception(f"{response.status}, message='{error_text[:200]}', url='{url}'")
                    # 檢查 Content-Type
                    content_type = response.headers.get('Content-Type', '')
                    if 'application/json' not in content_type:
                        error_text = await response.text()
                        raise Exception(f"{response.status}, message='Attempt to decode JSON with unexpected mimetype: {content_type}', url='{url}', body='{error_text[:200]}'")
                    return await response.json()
            elif method.upper() == "POST":
                async with session.post(url, data=params, headers=headers) as response:
                    if response.status != 200:
                        error_text = await response.text()
                        raise Exception(f"{response.status}, message='{error_text[:200]}', url='{url}'")
                    content_type = response.headers.get('Content-Type', '')
                    if 'application/json' not in content_type:
                        error_text = await response.text()
                        raise Exception(f"{response.status}, message='Attempt to decode JSON with unexpected mimetype: {content_type}', url='{url}', body='{error_text[:200]}'")
                    return await response.json()
            elif method.upper() == "DELETE":
                async with session.delete(url, params=params, headers=headers) as response:
                    if response.status != 200:
                        error_text = await response.text()
                        raise Exception(f"{response.status}, message='{error_text[:200]}', url='{url}'")
                    content_type = response.headers.get('Content-Type', '')
                    if 'application/json' not in content_type:
                        error_text = await response.text()
                        raise Exception(f"{response.status}, message='Attempt to decode JSON with unexpected mimetype: {content_type}', url='{url}', body='{error_text[:200]}'")
                    return await response.json()
            else:
                raise ValueError(f"不支援的 HTTP 方法: {method}")
    
    # 市場數據接口
    
    async def get_ticker(self, symbol: str, trade_type: TradeType = TradeType.SPOT) -> TickerData:
        """獲取行情數據"""
        try:
            symbol = self._normalize_symbol(symbol)
            endpoint_prefix = self._get_endpoint_prefix(trade_type)
            
            # 獲取 24hr ticker
            endpoint = f"{endpoint_prefix}/ticker/24hr"
            params = {"symbol": symbol}
            
            response = await self._make_request("GET", endpoint, params)
            
            if "code" in response:
                raise Exception(f"Binance API 錯誤: {response.get('msg')}")
            
            return TickerData(
                symbol=response.get("symbol"),
                bid_price=float(response.get("bidPrice", 0)),
                ask_price=float(response.get("askPrice", 0)),
                last_price=float(response.get("lastPrice", 0)),
                volume_24h=float(response.get("volume", 0)),
                timestamp=int(response.get("closeTime", time.time() * 1000)),
                high_24h=float(response.get("highPrice", 0)),
                low_24h=float(response.get("lowPrice", 0)),
                change_24h=float(response.get("priceChange", 0)),
                change_percent_24h=float(response.get("priceChangePercent", 0))
            )
            
        except Exception as e:
            self.logger.error("binance_get_ticker_failed", symbol=symbol, error=str(e))
            raise
    
    async def get_orderbook(self, symbol: str, limit: int = 25, trade_type: TradeType = TradeType.SPOT) -> OrderBookData:
        """獲取訂單簿"""
        try:
            symbol = self._normalize_symbol(symbol)
            endpoint_prefix = self._get_endpoint_prefix(trade_type)
            
            endpoint = f"{endpoint_prefix}/depth"
            params = {"symbol": symbol, "limit": min(limit, 1000)}
            
            response = await self._make_request("GET", endpoint, params)
            
            if "code" in response:
                raise Exception(f"Binance API 錯誤: {response.get('msg')}")
            
            # 轉換格式
            bids = [(float(price), float(qty)) for price, qty in response.get("bids", [])]
            asks = [(float(price), float(qty)) for price, qty in response.get("asks", [])]
            
            return OrderBookData(
                symbol=symbol,
                bids=bids,
                asks=asks,
                timestamp=int(time.time() * 1000)
            )
            
        except Exception as e:
            self.logger.error("binance_get_orderbook_failed", symbol=symbol, error=str(e))
            raise
    
    # OrderBook Feed 相關方法
    
    async def start_orderbook_feed(self):
        """啟動 OrderBook Feed"""
        await self.orderbook_feed.start()
    
    async def stop_orderbook_feed(self):
        """停止 OrderBook Feed"""
        await self.orderbook_feed.stop()
    
    async def subscribe_orderbook(self, symbol: str):
        """訂閱 OrderBook 數據"""
        await self.orderbook_feed.subscribe(symbol)
    
    async def unsubscribe_orderbook(self, symbol: str):
        """取消訂閱 OrderBook 數據"""
        await self.orderbook_feed.unsubscribe(symbol)
    
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
            endpoint_prefix = self._get_endpoint_prefix(trade_type)
            
            if trade_type == TradeType.SPOT:
                endpoint = f"{endpoint_prefix}/exchangeInfo"
            else:
                endpoint = f"{endpoint_prefix}/exchangeInfo"
            
            response = await self._make_request("GET", endpoint)
            
            if "code" in response:
                raise Exception(f"Binance API 錯誤: {response.get('msg')}")
            
            symbols = []
            for symbol_info in response.get("symbols", []):
                if symbol_info.get("status") == "TRADING":
                    symbols.append(symbol_info.get("symbol"))
            
            return symbols
            
        except Exception as e:
            self.logger.error("binance_get_symbols_failed", trade_type=trade_type.value, error=str(e))
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
        """下單 - 支持統一交易帳戶"""
        try:
            self._check_authentication()
            symbol = self._normalize_symbol(symbol)
            self._validate_quantity(quantity)
            if order_type == OrderType.LIMIT:
                self._validate_price(price)
            
            # 如果啟用統一交易帳戶，先嘗試 /papi/v1/* 端點
            if self.use_portfolio_margin:
                try:
                    return await self._place_order_portfolio_margin(
                        symbol, side, quantity, order_type, price, trade_type, **kwargs
                    )
                except Exception as pm_error:
                    # 如果統一帳戶端點失敗，自動回退
                    error_msg = str(pm_error)
                    if "404" in error_msg or "text/html" in error_msg:
                        self.logger.warning(
                            "binance_portfolio_margin_order_not_available",
                            error=error_msg,
                            message="統一交易帳戶下單端點不可用，自動回退到傳統端點"
                        )
                        # 不修改 use_portfolio_margin，保持配置不變
                    else:
                        # 其他錯誤直接返回失敗結果
                        return OrderResult(
                            success=False,
                            error_message=f"Portfolio Margin 下單失敗: {error_msg}"
                        )
            
            # 否則使用傳統端點
            endpoint_prefix = self._get_endpoint_prefix(trade_type)
            binance_side = self._convert_side(side)
            binance_order_type = self._convert_order_type(order_type)
            
            # 構建訂單參數
            params = {
                "symbol": symbol,
                "side": binance_side,
                "type": binance_order_type
            }
            # 數量參數
            params["quantity"] = str(quantity)
            
            # 限價單需要價格
            if order_type == OrderType.LIMIT and price:
                params["price"] = str(price)
                params["timeInForce"] = kwargs.get("time_in_force", "GTC")
            
            # 現貨槓桿交易：添加 sideEffectType 參數支援自動借還幣
            # NO_SIDE_EFFECT: 普通現貨交易（默認）
            # MARGIN_BUY: 僅借入資產（買入時借幣）
            # AUTO_REPAY: 僅自動還幣（賣出時還幣）
            # AUTO_BORROW_REPAY: 自動借還幣（推薦，買入自動借幣、賣出自動還幣）
            if trade_type == TradeType.SPOT:
                # 優先使用傳入的 sideEffectType，否則默認使用 AUTO_BORROW_REPAY 啟用自動借還幣
                side_effect_type = kwargs.get("side_effect_type", "AUTO_BORROW_REPAY")
                if side_effect_type != "NO_SIDE_EFFECT":
                    params["sideEffectType"] = side_effect_type
                    self.logger.info(f"Binance SPOT 訂單啟用自動借還幣: {side_effect_type}")
            
            endpoint = f"{endpoint_prefix}/order"
            response = await self._make_request("POST", endpoint, params, signed=True)
            
            if "code" in response:
                error_msg = response.get("msg", "Unknown error")
                return OrderResult(
                    success=False,
                    error_message=error_msg
                )
            else:
                return OrderResult(
                    success=True,
                    order_id=str(response.get("orderId")),
                    price=float(response.get("price", 0)) if response.get("price") else price,
                    quantity=float(response.get("executedQty", quantity)),
                    timestamp=int(response.get("transactTime", time.time() * 1000))
                )
                
        except Exception as e:
            self.logger.error("binance_place_order_failed", 
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
            endpoint_prefix = self._get_endpoint_prefix(trade_type)
            
            endpoint = f"{endpoint_prefix}/order"
            params = {
                "symbol": symbol,
                "orderId": order_id
            }
            
            response = await self._make_request("DELETE", endpoint, params, signed=True)
            
            return "code" not in response
            
        except Exception as e:
            self.logger.error("binance_cancel_order_failed", 
                            symbol=symbol, 
                            order_id=order_id, 
                            error=str(e))
            return False
    
    async def get_order_status(self, symbol: str, order_id: str, trade_type: TradeType = TradeType.SPOT) -> Dict[str, Any]:
        """查詢訂單狀態"""
        try:
            self._check_authentication()
            symbol = self._normalize_symbol(symbol)
            endpoint_prefix = self._get_endpoint_prefix(trade_type)
            
            endpoint = f"{endpoint_prefix}/order"
            params = {
                "symbol": symbol,
                "orderId": order_id
            }
            
            response = await self._make_request("GET", endpoint, params, signed=True)
            
            if "code" in response:
                raise Exception(f"Binance API 錯誤: {response.get('msg')}")
            
            return response
                
        except Exception as e:
            self.logger.error("binance_get_order_status_failed", 
                            symbol=symbol, 
                            order_id=order_id, 
                            error=str(e))
            raise
    
    async def get_fill_price(self, order_id: str, symbol: str, trade_type: TradeType = TradeType.SPOT) -> Optional[float]:
        """查詢 Binance 訂單實際成交價格（僅使用統一交易帳戶）"""
        try:
            self._check_authentication()
            symbol = self._normalize_symbol(symbol)
            
            # 只使用統一交易帳戶（Portfolio Margin API）
            if not self.use_portfolio_margin:
                self.logger.error("binance_portfolio_margin_required", 
                                message="統一交易帳戶未啟用，請啟用 Portfolio Margin")
                return None
            
            # 使用 Portfolio Margin API
            return await self._get_fill_price_portfolio_margin(order_id, symbol, trade_type)
            
        except Exception as e:
            self.logger.error("binance_get_fill_price_failed", 
                            order_id=order_id,
                            symbol=symbol,
                            error=str(e))
            return None
    
    async def _get_fill_price_portfolio_margin(self, order_id: str, symbol: str, trade_type: TradeType) -> Optional[float]:
        """使用 Portfolio Margin API 查詢成交價格"""
        # 根據交易類型選擇端點
        if trade_type == TradeType.SPOT:
            # 槓桿現貨訂單查詢 - 使用 /papi/v1/margin/order
            endpoint = "/papi/v1/margin/order"
            params = {
                "symbol": symbol,
                "orderId": order_id,
                "timestamp": int(time.time() * 1000)
            }
        elif trade_type in (TradeType.LINEAR, TradeType.INVERSE):
            # UM 合約訂單查詢 - 使用 /papi/v1/um/order
            endpoint = "/papi/v1/um/order"
            params = {
                "symbol": symbol,
                "orderId": order_id,
                "timestamp": int(time.time() * 1000)
            }
        else:
            self.logger.warning("binance_get_fill_price_unsupported_trade_type", 
                               trade_type=trade_type.value)
            return None
        
        # 發送請求
        response = await self._make_request("GET", endpoint, params, signed=True, use_pm_url=True)
        
        # 如果 orderId 查詢失敗，嘗試時間範圍查詢
        if not response or (isinstance(response, dict) and "code" in response):
            self.logger.info("binance_orderid_query_failed_try_time_range", 
                           order_id=order_id,
                           symbol=symbol,
                           trade_type=trade_type.value)
            
            # 嘗試使用時間範圍查詢（最近7天）
            current_time = int(time.time() * 1000)
            start_time = current_time - (7 * 24 * 60 * 60 * 1000)  # 7天前
            
            time_params = {
                "symbol": symbol,
                "startTime": start_time,
                "endTime": current_time,
                "limit": 500,
                "timestamp": int(time.time() * 1000)
            }
            
            try:
                # 使用 allOrders 端點進行時間範圍查詢
                if trade_type == TradeType.SPOT:
                    time_endpoint = "/papi/v1/margin/allOrders"
                else:
                    time_endpoint = "/papi/v1/um/allOrders"
                    
                response = await self._make_request("GET", time_endpoint, time_params, signed=True, use_pm_url=True)
                self.logger.info("binance_time_range_query_attempted", 
                               order_id=order_id,
                               symbol=symbol,
                               start_time=start_time,
                               end_time=current_time)
            except Exception as e:
                self.logger.warning("binance_time_range_query_failed", 
                                  order_id=order_id,
                                  symbol=symbol,
                                  error=str(e))
                # 如果 Portfolio Margin API 完全失敗，拋出異常讓主函數回退到傳統 API
                raise Exception(f"Portfolio Margin API failed: {str(e)}")
        
        return self._parse_fill_price_response(response, order_id, symbol, trade_type)
    
    async def _get_fill_price_classic(self, order_id: str, symbol: str, trade_type: TradeType) -> Optional[float]:
        """使用傳統 API 查詢成交價格"""
        try:
            # 根據交易類型選擇端點
            if trade_type == TradeType.SPOT:
                # 現貨訂單查詢 - 使用 /api/v3/order
                endpoint = "/api/v3/order"
                params = {
                    "symbol": symbol,
                    "orderId": order_id,
                    "timestamp": int(time.time() * 1000)
                }
            elif trade_type == TradeType.LINEAR:
                # USDT-M 合約訂單查詢 - 使用 /fapi/v1/order
                endpoint = "/fapi/v1/order"
                params = {
                    "symbol": symbol,
                    "orderId": order_id,
                    "timestamp": int(time.time() * 1000)
                }
            elif trade_type == TradeType.INVERSE:
                # COIN-M 合約訂單查詢 - 使用 /dapi/v1/order
                endpoint = "/dapi/v1/order"
                params = {
                    "symbol": symbol,
                    "orderId": order_id,
                    "timestamp": int(time.time() * 1000)
                }
            else:
                self.logger.warning("binance_get_fill_price_unsupported_trade_type", 
                                   trade_type=trade_type.value)
                return None
            
            # 發送請求
            response = await self._make_request("GET", endpoint, params, signed=True, use_pm_url=False)
            
            return self._parse_fill_price_response(response, order_id, symbol, trade_type)
            
        except Exception as e:
            self.logger.error("binance_classic_fill_price_failed", 
                            order_id=order_id,
                            symbol=symbol,
                            error=str(e))
            return None
    
    def _parse_fill_price_response(self, response, order_id: str, symbol: str, trade_type: TradeType) -> Optional[float]:
        """解析成交價格響應"""
        try:
            # 處理單個訂單對象（/papi/v1/um/order 和 /papi/v1/margin/order 返回單個對象）
            if isinstance(response, dict) and "orderId" in response:
                order = response
            elif isinstance(response, list) and response:
                # 處理訂單列表（/papi/v1/um/allOrders 和 /papi/v1/margin/allOrders 返回列表）
                order = response[0]  # 取第一個訂單
            else:
                self.logger.warning("binance_fill_price_no_response", 
                                  order_id=order_id,
                                  symbol=symbol)
                return None
            
            # 獲取基本訂單信息
            executed_qty = float(order.get('executedQty', 0))
            order_status = order.get('status', '')
            
            if trade_type == TradeType.SPOT:
                # 現貨訂單：優先使用 cummulativeQuoteQty / executedQty，如果無效則使用 price 字段
                cummulative_quote_qty = float(order.get('cummulativeQuoteQty', 0))
                
                # 檢查 cummulativeQuoteQty 是否 < 0（數據不存在）
                if cummulative_quote_qty < 0:
                    self.logger.warning("binance_spot_historical_data_missing", 
                                       order_id=order_id,
                                       symbol=symbol,
                                       cummulative_quote_qty=cummulative_quote_qty,
                                       message="歷史訂單數據不存在，嘗試使用 price 字段")
                    # 嘗試使用 price 字段作為備用
                    price = float(order.get('price', 0))
                    if price > 0:
                        avg_price = price
                        self.logger.info("binance_spot_using_price_field", 
                                       order_id=order_id,
                                       symbol=symbol,
                                       price=price)
                    else:
                        avg_price = 0
                elif executed_qty > 0 and cummulative_quote_qty > 0:
                    avg_price = cummulative_quote_qty / executed_qty
                    self.logger.info("binance_spot_price_calculated", 
                                   order_id=order_id,
                                   symbol=symbol,
                                   cummulative_quote_qty=cummulative_quote_qty,
                                   executed_qty=executed_qty,
                                   calculated_avg_price=avg_price)
                else:
                    avg_price = 0
                    
                self.logger.info("binance_spot_price_calculation", 
                               order_id=order_id,
                               symbol=symbol,
                               executed_qty=executed_qty,
                               cummulative_quote_qty=cummulative_quote_qty,
                               calculated_avg_price=avg_price,
                               status=order_status)
            else:
                # UM 合約訂單：直接使用 avgPrice 字段，但需要檢查是否為空字符串
                avg_price_str = order.get('avgPrice', '')
                
                # 檢查 avgPrice 是否為空字符串或無效值
                if avg_price_str and avg_price_str != "" and avg_price_str != "0.00000":
                    avg_price = float(avg_price_str)
                    self.logger.info("binance_contract_price_found", 
                                   order_id=order_id,
                                   symbol=symbol,
                                   avg_price_str=avg_price_str,
                                   avg_price=avg_price,
                                   executed_qty=executed_qty,
                                   status=order_status)
                else:
                    avg_price = 0
                    self.logger.warning("binance_contract_price_invalid", 
                                      order_id=order_id,
                                      symbol=symbol,
                                      avg_price_str=avg_price_str,
                                      executed_qty=executed_qty,
                                      status=order_status,
                                      reason="avgPrice_empty_or_zero")
            
            # 檢查是否有有效的成交價格
            if avg_price > 0 and executed_qty > 0:
                self.logger.info("binance_fill_price_retrieved", 
                               order_id=order_id,
                               symbol=symbol,
                               avg_price=avg_price,
                               executed_qty=executed_qty,
                               status=order_status,
                               trade_type=trade_type.value)
                return avg_price
            else:
                # 詳細記錄為什麼沒有成交價格
                self.logger.warning("binance_fill_price_no_execution", 
                                   order_id=order_id,
                                   symbol=symbol,
                                   avg_price=avg_price,
                                   executed_qty=executed_qty,
                                   status=order_status,
                                   trade_type=trade_type.value,
                                   reason="avg_price_or_executed_qty_zero")
                return None
                
        except Exception as e:
            self.logger.error("binance_get_fill_price_failed", 
                            order_id=order_id,
                            symbol=symbol,
                            error=str(e))
            return None
    
    # 帳戶接口
    
    async def get_balances(self) -> List[Balance]:
        """獲取餘額 - 支持統一交易帳戶，自動回退到傳統端點"""
        try:
            self._check_authentication()
            
            # 如果啟用統一交易帳戶，先嘗試專用端點
            if self.use_portfolio_margin:
                try:
                    return await self.get_portfolio_margin_balance()
                except Exception as pm_error:
                    # 如果統一帳戶端點失敗（404 或其他錯誤），自動回退
                    error_msg = str(pm_error)
                    if "404" in error_msg or "text/html" in error_msg:
                        self.logger.info(
                            "binance_portfolio_margin_fallback_to_classic",
                            message="統一交易帳戶端點不可用（可能未開通），使用傳統現貨帳戶端點"
                        )
                        # 不修改 use_portfolio_margin，保持配置不變
                    else:
                        # 其他錯誤，重新拋出
                        raise
            
            # 使用傳統現貨帳戶端點
            endpoint = "/api/v3/account"
            response = await self._make_request("GET", endpoint, signed=True)
            
            if "code" in response:
                raise Exception(f"Binance API 錯誤: {response.get('msg')}")
            
            balances = []
            for balance in response.get("balances", []):
                free = float(balance.get("free", 0))
                locked = float(balance.get("locked", 0))
                
                if free > 0 or locked > 0:
                    balances.append(Balance(
                        asset=balance.get("asset"),
                        free=free,
                        locked=locked
                    ))
            
            return balances
            
        except Exception as e:
            self.logger.error("binance_get_balances_failed", error=str(e))
            raise
    
    async def get_positions(self) -> List[Position]:
        """獲取持倉（合約）- 支持統一交易帳戶，自動回退到傳統端點"""
        try:
            self._check_authentication()
            
            # 如果啟用統一交易帳戶，先嘗試專用端點
            if self.use_portfolio_margin:
                try:
                    return await self.get_portfolio_margin_um_positions()
                except Exception as pm_error:
                    # 如果統一帳戶端點失敗，自動回退
                    error_msg = str(pm_error)
                    if "404" in error_msg or "text/html" in error_msg:
                        self.logger.warning(
                            "binance_portfolio_margin_positions_not_available",
                            error=error_msg,
                            message="統一交易帳戶持倉端點不可用，自動回退到傳統合約端點"
                        )
                        # 不修改 use_portfolio_margin，保持配置不變
                    else:
                        raise
            
            # 否則使用傳統合約端點
            positions = []
            
            # 獲取 USDT-M 合約持倉
            try:
                endpoint = "/fapi/v2/positionRisk"
                response = await self._make_request("GET", endpoint, signed=True)
                
                if "code" not in response:
                    for pos in response:
                        position_amt = float(pos.get("positionAmt", 0))
                        if position_amt != 0:
                            # ⚠️ Binance API 限制：
                            # - /fapi/v2/positionRisk 端點不提供單個倉位的已實現盈虧
                            # - /fapi/v2/account 端點也不提供 per-position 的已實現盈虧
                            # - 已實現盈虧只有在平倉後才會記錄在交易歷史中
                            # - 對於開倉中的倉位，已實現盈虧始終為 0
                            # 這是 Binance API 的設計限制，不是系統錯誤
                            realized_pnl = 0.0
                            
                            positions.append(Position(
                                symbol=pos.get("symbol"),
                                base_asset=pos.get("symbol", "").replace("USDT", ""),
                                quote_asset="USDT",
                                position_type="perp_linear",
                                side="long" if position_amt > 0 else "short",
                                size=abs(position_amt),
                                entry_price=float(pos.get("entryPrice", 0)),
                                mark_price=float(pos.get("markPrice", 0)),
                                unrealized_pnl=float(pos.get("unRealizedProfit", 0)),
                                realized_pnl=realized_pnl  # Binance API 不提供此數據
                            ))
            except Exception as e:
                self.logger.warning("獲取 USDT-M 合約持倉失敗", error=str(e))
            
            # 獲取 COIN-M 合約持倉
            try:
                endpoint = "/dapi/v1/positionRisk"
                response = await self._make_request("GET", endpoint, signed=True)
                
                if "code" not in response:
                    for pos in response:
                        position_amt = float(pos.get("positionAmt", 0))
                        if position_amt != 0:
                            # ⚠️ Binance API 限制：COIN-M 合約端點也不提供單個倉位的已實現盈虧
                            # 已實現盈虧只有在平倉後才會記錄在交易歷史中
                            realized_pnl = 0.0
                            
                            positions.append(Position(
                                symbol=pos.get("symbol"),
                                base_asset=pos.get("symbol", "").split("_")[0] if "_" in pos.get("symbol", "") else "",
                                quote_asset="USD",
                                position_type="perp_inverse",
                                side="long" if position_amt > 0 else "short",
                                size=abs(position_amt),
                                entry_price=float(pos.get("entryPrice", 0)),
                                mark_price=float(pos.get("markPrice", 0)),
                                unrealized_pnl=float(pos.get("unRealizedProfit", 0)),
                                realized_pnl=realized_pnl  # Binance API 不提供此數據
                            ))
            except Exception as e:
                self.logger.warning("獲取 COIN-M 合約持倉失敗", error=str(e))
            
            return positions
            
        except Exception as e:
            self.logger.error("binance_get_positions_failed", error=str(e))
            raise
    
    # 健康檢查
    
    async def ping(self) -> bool:
        """檢查連接狀態"""
        try:
            endpoint = "/api/v3/ping"
            response = await self._make_request("GET", endpoint)
            return "code" not in response
        except Exception:
            return False
    
    async def get_server_time(self) -> int:
        """獲取服務器時間"""
        try:
            endpoint = "/api/v3/time"
            # 直接發送請求，避免遞歸調用
            base_url = self.pm_base_url if False else self.base_url  # 不使用 PM URL
            url = f"{base_url}{endpoint}"
            
            # 設置超時（連接超時 10 秒，總超時 30 秒）
            timeout = aiohttp.ClientTimeout(total=30, connect=10)
            
            async with aiohttp.ClientSession(timeout=timeout) as session:
                async with session.get(url) as response:
                    data = await response.json()
                    
                    if "code" in data:
                        raise Exception(f"Binance API 錯誤: {data.get('msg')}")
                    
                    return int(data.get("serverTime", 0))
            
        except Exception as e:
            self.logger.error("binance_get_server_time_failed", error=str(e))
            return 0  # 返回 0 表示獲取失敗，讓調用方使用本地時間
    
    # ========== 統一交易帳戶 (Portfolio Margin) 專用方法 ==========
    
    async def _place_order_portfolio_margin(
        self,
        symbol: str,
        side: OrderSide,
        quantity: float,
        order_type: OrderType,
        price: Optional[float],
        trade_type: TradeType,
        **kwargs
    ) -> OrderResult:
        """使用統一交易帳戶下單"""
        try:
            binance_side = self._convert_side(side)
            binance_order_type = self._convert_order_type(order_type)
            
            # 根據交易類型選擇端點
            if trade_type == TradeType.SPOT:
                # 杠桿帳戶下單 (現貨保證金)
                endpoint = "/papi/v1/margin/order"
                params = {
                    "symbol": symbol,
                    "side": binance_side,
                    "type": binance_order_type,
                    "quantity": str(quantity),
                }
                
                # 限價單需要價格和 timeInForce
                if order_type == OrderType.LIMIT and price:
                    params["price"] = str(price)
                    params["timeInForce"] = kwargs.get("time_in_force", "GTC")
                
                # 可選參數
                if "side_effect_type" in kwargs:
                    params["sideEffectType"] = kwargs["side_effect_type"]  # MARGIN_BUY, AUTO_REPAY, AUTO_BORROW_REPAY
                
            elif trade_type in (TradeType.LINEAR, TradeType.INVERSE):
                # UM 合約下單 (USDT-M / COIN-M)
                endpoint = "/papi/v1/um/order"
                params = {
                    "symbol": symbol,
                    "side": binance_side,
                    "type": binance_order_type,
                    "quantity": str(quantity),
                }
                
                # positionSide: BOTH (單向持倉) / LONG / SHORT (雙向持倉)
                params["positionSide"] = kwargs.get("position_side", "BOTH")
                
                # 限價單需要價格和 timeInForce
                if order_type == OrderType.LIMIT and price:
                    params["price"] = str(price)
                    params["timeInForce"] = kwargs.get("time_in_force", "GTC")
                
                # 可選參數
                if "reduce_only" in kwargs:
                    params["reduceOnly"] = str(kwargs["reduce_only"]).lower()
                
            else:
                raise ValueError(f"統一交易帳戶不支援的交易類型: {trade_type}")
            
            # 發送請求前印出詳細參數
            self.logger.info("binance_portfolio_margin_order_debug", 
                           endpoint=endpoint,
                           symbol=symbol,
                           side=binance_side,
                           type=binance_order_type,
                           quantity=quantity,
                           trade_type=trade_type.value,
                           all_params=params,
                           kwargs=kwargs)
            
            # 發送請求
            self.logger.info("binance_portfolio_margin_order", 
                           endpoint=endpoint,
                           symbol=symbol,
                           side=binance_side,
                           type=binance_order_type,
                           quantity=quantity,
                           trade_type=trade_type.value)
            
            response = await self._make_request("POST", endpoint, params, signed=True, use_pm_url=True)
            
            if "code" in response:
                error_msg = response.get("msg", "Unknown error")
                self.logger.error("binance_portfolio_margin_order_failed", 
                                error_code=response.get("code"),
                                error_msg=error_msg)
                return OrderResult(
                    success=False,
                    error_message=f"[{response.get('code')}] {error_msg}"
                )
            
            # 成功響應
            order_id = str(response.get("orderId"))
            initial_price = float(response.get("avgPrice", 0)) if response.get("avgPrice") else (price or 0)
            
            # 如果初始價格為 0，立即查詢成交價格
            if initial_price == 0 and order_id:
                self.logger.info("binance_order_price_zero_immediate_query", 
                               order_id=order_id,
                               symbol=symbol,
                               trade_type=trade_type.value)
                
                try:
                    # 立即查詢成交價格
                    fill_price = await self.get_fill_price(order_id, symbol, trade_type)
                    if fill_price and fill_price > 0:
                        initial_price = fill_price
                        self.logger.info("binance_order_price_retrieved_immediately", 
                                       order_id=order_id,
                                       symbol=symbol,
                                       retrieved_price=fill_price)
                    else:
                        self.logger.warning("binance_order_price_query_failed_immediately", 
                                          order_id=order_id,
                                          symbol=symbol,
                                          fill_price=fill_price)
                except Exception as e:
                    self.logger.warning("binance_order_price_query_exception_immediately", 
                                      order_id=order_id,
                                      symbol=symbol,
                                      error=str(e))
            
            return OrderResult(
                success=True,
                order_id=order_id,
                price=initial_price,
                quantity=float(response.get("executedQty", 0)),
                timestamp=int(response.get("transactTime", time.time() * 1000))
            )
            
        except Exception as e:
            self.logger.error("binance_portfolio_margin_order_exception", 
                            symbol=symbol,
                            error=str(e))
            return OrderResult(
                success=False,
                error_message=str(e)
            )
    
    async def get_portfolio_margin_balance(self, asset: Optional[str] = None) -> List[Balance]:
        """獲取統一交易帳戶餘額
        
        API: GET /papi/v1/balance
        參考 balece.py 的實現，正確解析所有字段
        """
        try:
            self._check_authentication()
            
            endpoint = "/papi/v1/balance"
            params = {}
            if asset:
                params["asset"] = asset.upper()
            
            response = await self._make_request("GET", endpoint, params, signed=True, use_pm_url=True)
            
            if "code" in response:
                raise Exception(f"Binance API 錯誤: {response.get('msg')}")
            
            # 處理響應（可能是列表或單個對象）
            balances_data = response if isinstance(response, list) else [response]
            
            balances = []
            for bal in balances_data:
                asset_name = bal.get("asset")
                
                # 解析所有字段（參考 balece.py）
                total_wallet = float(bal.get("totalWalletBalance", 0))  # 錢包總餘額
                cross_asset = float(bal.get("crossMarginAsset", 0))      # 全倉資產
                cross_borrowed = float(bal.get("crossMarginBorrowed", 0)) # 全倉借貸
                cross_free = float(bal.get("crossMarginFree", 0))        # 全倉未鎖定
                cross_interest = float(bal.get("crossMarginInterest", 0)) # 全倉利息
                cross_locked = float(bal.get("crossMarginLocked", 0))    # 全倉鎖定
                um_wallet = float(bal.get("umWalletBalance", 0))         # U本位合約錢包餘額
                um_unrealized_pnl = float(bal.get("umUnrealizedPNL", 0)) # U本位未實現盈虧
                cm_wallet = float(bal.get("cmWalletBalance", 0))        # 幣本位合約錢包餘額
                cm_unrealized_pnl = float(bal.get("cmUnrealizedPNL", 0)) # 幣本位未實現盈虧
                negative_balance = float(bal.get("negativeBalance", 0))  # 負餘額
                
                # 🔥 修正：計算餘額（考慮借貸）
                # 根據總額 = walletBalance - borrowAmount 的邏輯：
                # - totalWalletBalance 是總餘額
                # - cross_borrowed 是借幣
                # - 現貨餘額 = totalWalletBalance - cross_borrowed（錢包目前擁有的幣數）
                # 如果 cross_free 已經是餘額，則不需要再減去 cross_borrowed
                # 但為了保險，我們使用 totalWalletBalance - cross_borrowed 作為現貨餘額
                spot_balance = total_wallet - cross_borrowed
                # 總餘額 = 現貨餘額 + 合約餘額
                net_balance = spot_balance + um_wallet + cm_wallet

                # 若所有關鍵數值皆為 0，直接略過（避免噪音與無效資料）
                if (
                    total_wallet == 0.0 and
                    cross_asset == 0.0 and
                    cross_borrowed == 0.0 and
                    cross_free == 0.0 and
                    cross_locked == 0.0 and
                    um_wallet == 0.0 and
                    cm_wallet == 0.0 and
                    negative_balance == 0.0
                ):
                    continue

                # 記錄詳細的餘額信息（僅在非 0 時）
                self.logger.info(
                    "binance_portfolio_margin_balance_detail",
                    asset=asset_name,
                    total_wallet=total_wallet,
                    cross_asset=cross_asset,
                    cross_borrowed=cross_borrowed,
                    cross_free=cross_free,
                    cross_interest=cross_interest,
                    cross_locked=cross_locked,
                    um_wallet=um_wallet,
                    um_unrealized_pnl=um_unrealized_pnl,
                    cm_wallet=cm_wallet,
                    cm_unrealized_pnl=cm_unrealized_pnl,
                    net_balance=net_balance,
                    negative_balance=negative_balance,
                )

                # 🔥 修复：记录所有有余额、借币、锁定或负余额的资产
                # 包括现货余额（cross_free, cross_locked）、合约余额（um_wallet, cm_wallet）等
                if (total_wallet > 0 or 
                    cross_borrowed > 0 or 
                    negative_balance != 0 or
                    cross_free > 0 or 
                    cross_locked > 0 or
                    um_wallet > 0 or
                    cm_wallet > 0):
                    # 🔥 修复：计算 USDT 价值时，应该基于余额（net_balance），而不是 total_wallet
                    # 如果有借币，net_balance 可能是负数，价值也应该是负数
                    if asset_name == "USDT":
                        # USDT 直接使用余额
                        usdt_value = net_balance
                    else:
                        # 對於非 USDT 資產，需要獲取價格
                        try:
                            price = await self._get_asset_price(asset_name)
                            # 🔥 使用余额计算价值（支持负数）
                            usdt_value = net_balance * price
                        except:
                            # 如果無法獲取價格，尝试使用 total_wallet 作为后备
                            try:
                                price = await self._get_asset_price(asset_name)
                                usdt_value = total_wallet * price
                            except:
                                usdt_value = 0
                    
                    # 🔥 修正：对于 Binance Portfolio Margin
                    # 根據總額 = walletBalance - borrowAmount 的邏輯：
                    # - totalWalletBalance 是總餘額
                    # - cross_borrowed 是借幣
                    # - 餘額 = totalWalletBalance - cross_borrowed（錢包目前擁有的幣數）
                    # free 應該只包含現貨餘額，不包括合約餘額（um_wallet, cm_wallet）
                    # 合約餘額應該通過合約持倉來顯示，而不是現貨餘額
                    spot_balance = total_wallet - cross_borrowed
                    balances.append(Balance(
                        asset=asset_name,
                        free=spot_balance,  # 🔥 現貨餘額 = 總餘額 - 借幣（錢包目前擁有的幣數）
                        locked=cross_locked,  # 鎖定餘額
                        borrowed=cross_borrowed,  # 借貸
                        interest=cross_interest,  # 利息
                        usdt_value=usdt_value  # 以 USDT 計價的總值（借幣時為負值）
                    ))
            
            return balances
            
        except Exception as e:
            self.logger.error("binance_get_portfolio_margin_balance_failed", error=str(e))
            raise
    
    async def _get_asset_price(self, asset: str) -> float:
        """獲取資產價格（簡化版本，用於計算借幣價值）"""
        try:
            if asset == "USDT":
                return 1.0
            
            # 構建交易對符號
            symbol = f"{asset}USDT"
            
            # 獲取價格
            endpoint = "/api/v3/ticker/price"
            params = {"symbol": symbol}
            response = await self._make_request("GET", endpoint, params, signed=False)
            
            if "price" in response:
                price = float(response["price"])
                self.logger.info("binance_asset_price_success", asset=asset, symbol=symbol, price=price)
                return price
            else:
                self.logger.warning("binance_asset_price_no_price_field", asset=asset, response=response)
                return 0.0
                
        except Exception as e:
            self.logger.error("binance_get_asset_price_failed", asset=asset, error=str(e))
            return 0.0
    
    async def get_portfolio_margin_account_info(self) -> Dict[str, Any]:
        """獲取統一交易帳戶信息
        
        API: GET /papi/v1/account
        """
        try:
            self._check_authentication()
            
            endpoint = "/papi/v1/account"
            response = await self._make_request("GET", endpoint, signed=True, use_pm_url=True)
            
            if "code" in response:
                raise Exception(f"Binance API 錯誤: {response.get('msg')}")
            
            return {
                "uniMMR": float(response.get("uniMMR", 0)),  # 統一帳戶維持保證金率
                "accountEquity": float(response.get("accountEquity", 0)),  # 以USD計價的帳戶權益
                "actualEquity": float(response.get("actualEquity", 0)),  # 不考慮質押率的以USD計價帳戶權益
                "accountInitialMargin": float(response.get("accountInitialMargin", 0)),
                "accountMaintMargin": float(response.get("accountMaintMargin", 0)),  # 以USD計價統一帳戶維持保證金
                "accountStatus": response.get("accountStatus", "UNKNOWN"),  # NORMAL, MARGIN_CALL, etc.
                "virtualMaxWithdrawAmount": float(response.get("virtualMaxWithdrawAmount", 0)),  # 以USD計價的最大可轉出
                "updateTime": int(response.get("updateTime", 0))
            }
            
        except Exception as e:
            self.logger.error("binance_get_portfolio_margin_account_info_failed", error=str(e))
            raise
    
    async def get_portfolio_margin_um_positions(self, symbol: Optional[str] = None) -> List[Position]:
        """獲取統一交易帳戶的 UM 持倉風險
        
        API: GET /papi/v1/um/positionRisk
        """
        try:
            self._check_authentication()
            
            endpoint = "/papi/v1/um/positionRisk"
            params = {}
            if symbol:
                params["symbol"] = symbol.upper()
            
            response = await self._make_request("GET", endpoint, params, signed=True, use_pm_url=True)
            
            if "code" in response:
                raise Exception(f"Binance API 錯誤: {response.get('msg')}")
            
            positions = []
            for pos in response:
                position_amt = float(pos.get("positionAmt", 0))
                
                # 只記錄有持倉的
                if position_amt != 0:
                    symbol_name = pos.get("symbol")
                    entry_price = float(pos.get("entryPrice", 0))
                    mark_price = float(pos.get("markPrice", 0))
                    unrealized_pnl = float(pos.get("unRealizedProfit", 0))
                    leverage = float(pos.get("leverage", 1))
                    position_side = pos.get("positionSide", "BOTH")
                    
                    # 計算名義價值
                    notional = abs(position_amt) * mark_price
                    
                    # 判斷方向
                    if position_side == "LONG" or (position_side == "BOTH" and position_amt > 0):
                        side = "long"
                    elif position_side == "SHORT" or (position_side == "BOTH" and position_amt < 0):
                        side = "short"
                    else:
                        side = "long" if position_amt > 0 else "short"
                    
                    # ⚠️ Binance Portfolio Margin 端點也不提供單個倉位的已實現盈虧
                    # 這是 Binance API 的設計限制，已實現盈虧需要在平倉後從交易歷史中計算
                    realized_pnl = 0.0
                    
                    positions.append(Position(
                        symbol=symbol_name,
                        base_asset=symbol_name.replace("USDT", ""),
                        quote_asset="USDT",
                        position_type="perp_linear",
                        side=side,
                        size=abs(position_amt),
                        entry_price=entry_price,
                        mark_price=mark_price,
                        unrealized_pnl=unrealized_pnl,
                        realized_pnl=realized_pnl,
                        leverage=leverage,
                        margin_mode="cross",  # 統一帳戶默認全倉
                        liquidation_price=float(pos.get("liquidationPrice", 0))
                    ))
            
            return positions
            
        except Exception as e:
            self.logger.error("binance_get_portfolio_margin_um_positions_failed", error=str(e))
            raise
    
    # ========== 倉位監控接口實現 ==========
    
    async def check_account_mode(self) -> Tuple[str, bool]:
        """檢查 Binance 帳戶模式"""
        try:
            if not self.use_portfolio_margin:
                return ("classic", False)
            
            # 嘗試調用統一帳戶API來檢查是否啟用（設置超時避免長時間阻塞）
            try:
                # 設置 5 秒超時，避免阻塞資金費率等公共 API
                info = await asyncio.wait_for(
                    self.get_portfolio_margin_account_info(),
                    timeout=5.0
                )
                # 如果成功獲取，說明是統一帳戶
                return ("portfolio", True)
            except asyncio.TimeoutError:
                self.logger.warning("binance_check_account_mode_timeout", message="檢查帳戶模式超時，回退到傳統模式")
                return ("classic", False)
            except Exception as pm_error:
                error_msg = str(pm_error)
                if "404" in error_msg or "text/html" in error_msg:
                    # 統一帳戶未開通，使用傳統模式
                    self.logger.info(
                        "binance_using_classic_account",
                        message="Binance 帳戶未開通 Portfolio Margin，使用傳統帳戶模式"
                    )
                    return ("classic", False)
                elif "timeout" in error_msg.lower() or "Connection timeout" in error_msg:
                    self.logger.warning("binance_check_account_mode_timeout_from_error", error=error_msg)
                    return ("classic", False)
                else:
                    self.logger.warning("binance_check_account_mode_failed", error=str(pm_error))
                    return ("classic", False)
            
        except Exception as e:
            self.logger.warning("binance_check_account_mode_exception", error=str(e))
        return ("classic", False)
    
    async def get_borrowing_rates(self, assets: List[str] = None) -> List[BorrowingRate]:
        """獲取借幣利率（槓桿現貨）
        
        API: GET /sapi/v1/margin/next-hourly-interest-rate
        注意：Binance API 要求必須提供 assets 參數，不支持查詢所有幣種
        """
        try:
            self._check_authentication()
            
            # Binance API 要求必須提供 assets 參數
            if not assets or len(assets) == 0:
                self.logger.warning("binance_get_borrowing_rates_no_assets",
                                  message="Binance API requires assets parameter")
                return []
            
            endpoint = "/sapi/v1/margin/next-hourly-interest-rate"
            
            # 構建參數（必須包含 assets）
            params = {
                "assets": ",".join([asset.upper() for asset in assets]),
                "isIsolated": "FALSE",  # 全倉槓桿
                "timestamp": int(time.time() * 1000)
            }
            
            response = await self._make_request("GET", endpoint, params, signed=True)
            
            if "code" in response:
                self.logger.error("binance_get_borrowing_rates_api_error", 
                                error_code=response.get("code"),
                                error_msg=response.get("msg"))
                return []
            
            borrowing_rates = []
            for item in response:
                asset = item.get("asset", "").upper()
                if not asset:
                    continue
                
                # 如果指定了資產列表，過濾
                if assets and asset not in [a.upper() for a in assets]:
                    continue
                
                # 獲取小時利率
                hourly_rate_str = item.get("nextHourlyInterestRate", "0")
                try:
                    hourly_rate = float(hourly_rate_str)
                except (ValueError, TypeError):
                    self.logger.warning("binance_borrowing_rate_parse_error",
                                      asset=asset,
                                      rate_str=hourly_rate_str)
                    hourly_rate = 0.0
                
                # 計算日利率（小時利率 * 24）
                daily_rate = hourly_rate * 24
                
                borrowing_rates.append(BorrowingRate(
                    exchange="binance",
                    asset=asset,
                    interest_rate_hourly=hourly_rate,
                    interest_rate_daily=daily_rate,
                    timestamp=int(time.time() * 1000)
                ))
            
            self.logger.info("binance_get_borrowing_rates_success", count=len(borrowing_rates))
            return borrowing_rates
            
        except Exception as e:
            self.logger.error("binance_get_borrowing_rates_failed", error=str(e))
            return []
    
    async def get_funding_rates(self, symbols: List[str] = None) -> List[FundingRate]:
        """獲取 Binance 資金費率（使用 FAPI 端點）"""
        try:
            # 步驟1：獲取資金費率數據（使用 /fapi/v1/premiumIndex）
            endpoint = "/fapi/v1/premiumIndex"
            params = {}
            
            if symbols and len(symbols) == 1:
                params["symbol"] = symbols[0].upper()
            
            # 資金費率 API 不需要簽名，使用 signed=False
            # 注意：FAPI 端點使用 futures API 域名
            response = await self._make_request("GET", endpoint, params, signed=False, use_pm_url=False)
            
            # Binance API 錯誤響應格式：{"code": -1121, "msg": "Invalid symbol."}
            if isinstance(response, dict) and "code" in response:
                error_msg = response.get("msg", "Unknown error")
                error_code = response.get("code")
                self.logger.warning("binance_get_funding_rates_api_error", 
                                code=error_code,
                                error=error_msg,
                                symbols=symbols)
                return []
            
            # 步驟2：獲取資金費率信息（包含結算週期等信息）
            # 使用 /fapi/v1/fundingInfo 獲取被特殊調整過的交易對信息
            funding_info_map = {}
            try:
                info_endpoint = "/fapi/v1/fundingInfo"
                info_response = await self._make_request("GET", info_endpoint, {}, signed=False, use_pm_url=False)
                
                if isinstance(info_response, list):
                    for info_item in info_response:
                        symbol = info_item.get("symbol", "").upper()
                        if symbol:
                            funding_info_map[symbol] = {
                                "funding_interval_hours": int(info_item.get("fundingIntervalHours", 8)),
                                "adjusted_funding_rate_cap": float(info_item.get("adjustedFundingRateCap", 0)),
                                "adjusted_funding_rate_floor": float(info_item.get("adjustedFundingRateFloor", 0))
                            }
            except Exception as info_error:
                # 如果獲取 fundingInfo 失敗，使用默認值
                self.logger.debug("binance_funding_info_failed", error=str(info_error))
            
            # 處理響應（可能是列表或單個對象）
            funding_data = response if isinstance(response, list) else [response]
            
            rates = []
            for data in funding_data:
                symbol = data.get("symbol")
                if not symbol:
                    continue
                
                symbol_upper = symbol.upper()
                
                # 如果指定了 symbols 過濾，只返回匹配的（大小寫不敏感）
                if symbols:
                    symbols_upper = [s.upper() for s in symbols]
                    if symbol_upper not in symbols_upper:
                        continue
                
                # 安全地轉換數值
                try:
                    funding_rate = float(data.get("lastFundingRate", 0))
                    next_funding_time = int(data.get("nextFundingTime", 0))
                except (ValueError, TypeError) as e:
                    self.logger.warning("binance_funding_rate_parse_error", 
                                      symbol=symbol,
                                      error=str(e),
                                      data=data)
                    continue
                
                # 從 fundingInfo 獲取結算週期，如果沒有則使用默認值 8
                settlement_interval = 8  # 默認值
                if symbol_upper in funding_info_map:
                    settlement_interval = funding_info_map[symbol_upper]["funding_interval_hours"]
                
                funding_rate_8h = funding_rate * (8 / settlement_interval)  # 當前結算週期的費率
                funding_rate_daily = funding_rate * (24 / settlement_interval)  # 每日費率
                
                rates.append(FundingRate(
                    exchange="binance",
                    symbol=symbol,
                    category="linear",
                    funding_rate=funding_rate,
                    funding_rate_8h=funding_rate_8h,  # 使用當前結算週期的費率
                    funding_rate_daily=funding_rate_daily,
                    next_funding_time=next_funding_time,
                    settlement_interval_hours=settlement_interval,  # 從 API 獲取的實際結算週期
                    timestamp=int(time.time() * 1000)
                ))
            
            self.logger.info("binance_get_funding_rates_success", count=len(rates))
            return rates
            
        except Exception as e:
            self.logger.error("binance_get_funding_rates_failed", error=str(e))
            return []
    
    async def get_account_summary(self) -> AccountSummary:
        """獲取 Binance 帳戶摘要，自動適配統一帳戶或傳統帳戶"""
        try:
            # 先檢查帳戶模式（設置較短的超時，避免阻塞）
            try:
                account_mode, is_supported = await self.check_account_mode()
            except Exception as check_error:
                error_str = str(check_error)
                # 如果是超時錯誤，直接回退到傳統模式
                if "timeout" in error_str.lower() or "Connection timeout" in error_str:
                    self.logger.warning("binance_check_account_mode_timeout_fallback", error=error_str)
                    account_mode = "classic"
                    is_supported = False
                else:
                    raise
            
            if account_mode == "portfolio" and is_supported:
                # 使用統一帳戶端點
                try:
                    account_info = await self.get_portfolio_margin_account_info()
                    balances = await self.get_portfolio_margin_balance()
                    positions = await self.get_portfolio_margin_um_positions()
                    
                    # 🔥 將有借貸的餘額轉換為 spot_margin 持倉（Binance 統一現貨槓桿）
                    spot_margin_positions = []
                    for balance in balances:
                        # 如果有借貸（borrowed > 0），說明是現貨槓桿持倉
                        # 🔥 修复：即使 net_balance = 0，只要有借币，也应该创建持仓
                        if balance.borrowed > 0:
                            # 構建交易對符號（例如：BTC -> BTCUSDT）
                            symbol = f"{balance.asset}USDT"
                            base_asset = balance.asset
                            quote_asset = "USDT"
                            
                            # 🔥 修复：持仓大小应该是借币数量，而不是净余额
                            # 如果 net_balance != 0，使用净余额；如果 net_balance = 0，使用借币数量
                            if balance.net_balance != 0:
                                size_base = abs(balance.net_balance)
                            else:
                                # net_balance = 0 但 borrowed > 0，说明是纯做空（借币卖出）
                                # 持仓大小应该是借币数量
                                size_base = balance.borrowed
                            
                            # 嘗試獲取標記價格（用於計算名義價值）
                            try:
                                ticker = await self.get_ticker(symbol, TradeType.SPOT)
                                mark_price = ticker.last_price if ticker else 0.0
                            except:
                                mark_price = 0.0
                            
                            # 計算名義價值
                            notional_usdt = size_base * mark_price if mark_price > 0 else balance.usdt_value
                            
                            # 🔥 修复：判斷方向
                            # 如果 net_balance > 0，為 long（做多）
                            # 如果 net_balance <= 0，為 short（做空，包括 net_balance = 0 但 borrowed > 0 的情况）
                            side = "long" if balance.net_balance > 0 else "short"
                            
                            # 🔥 添加调试日志
                            self.logger.info("binance_spot_margin_position_created",
                                           asset=balance.asset,
                                           symbol=symbol,
                                           borrowed=balance.borrowed,
                                           net_balance=balance.net_balance,
                                           size_base=size_base,
                                           side=side,
                                           note="创建 Binance 现货杠杆持仓")
                            
                            # 計算槓桿（簡單估算：名義價值 / 保證金）
                            # 保證金可以用 borrowed 的 USDT 價值來估算
                            borrowed_usdt_value = abs(balance.usdt_value) if balance.net_balance < 0 else (balance.borrowed * mark_price if mark_price > 0 else 0)
                            leverage = (notional_usdt / borrowed_usdt_value) if borrowed_usdt_value > 0 else 1.0
                            
                            # 計算未實現盈虧（現貨槓桿的盈虧需要從價格變化計算，這裡先設為 0）
                            # 實際應該用當前價格與開倉價格比較，但統一帳戶餘額 API 沒有提供開倉價格
                            unrealized_pnl = 0.0  # TODO: 可以通過查詢交易歷史計算
                            
                            # 🔥 修复：size 字段应该反映方向（空单为负数）
                            # size_base 是绝对值，size 应该根据方向设置正负
                            position_size = size_base if side == "long" else -size_base
                            
                            # 創建 spot_margin 持倉
                            spot_margin_pos = Position(
                                symbol=symbol,
                                base_asset=base_asset,
                                quote_asset=quote_asset,
                                position_type="spot_margin",
                                side=side,
                                size=position_size,  # 🔥 空单为负数
                                entry_price=mark_price,  # 暫用標記價格，實際應該從交易歷史獲取
                                mark_price=mark_price,
                                unrealized_pnl=unrealized_pnl,
                                realized_pnl=0.0,
                                leverage=leverage,
                                margin_mode="cross",
                                margin_usdt=borrowed_usdt_value,  # 保證金約等於借貸價值
                                liquidation_price=None,  # 現貨槓桿沒有強平價格
                                funding_rate_8h=None,
                                next_funding_time=None
                            )
                            spot_margin_positions.append(spot_margin_pos)
                    
                    # 🔥 為合約持倉填充資金費率
                    for pos in positions:
                        if pos.position_type in ['perp_linear', 'perp_inverse', 'futures_linear', 'futures_inverse']:
                            try:
                                funding_rates = await self.get_funding_rates([pos.symbol])
                                if funding_rates:
                                    fr = funding_rates[0]
                                    pos.funding_rate_8h = fr.funding_rate_8h
                                    pos.next_funding_time = fr.next_funding_time
                            except Exception as e:
                                self.logger.debug("binance_fill_funding_rate_failed", 
                                                symbol=pos.symbol, 
                                                error=str(e))
                    
                    # 合併合約持倉和現貨槓桿持倉
                    all_positions = list(positions) + spot_margin_positions
                    
                    return AccountSummary(
                        exchange="binance",
                        account_mode="portfolio",
                        timestamp=int(time.time() * 1000),
                        total_equity_usdt=account_info.get("accountEquity", 0),
                        total_margin_usdt=account_info.get("accountMaintMargin", 0),
                        available_balance_usdt=account_info.get("virtualMaxWithdrawAmount", 0),
                        margin_ratio=account_info.get("uniMMR", 0),
                        maintenance_margin_rate=account_info.get("uniMMR", 0),
                        total_initial_margin=account_info.get("accountInitialMargin", 0),
                        total_maintenance_margin=account_info.get("accountMaintMargin", 0),
                        balances=balances,
                        positions=all_positions
                    )
                except Exception as pm_error:
                    error_str = str(pm_error)
                    # 如果是超時錯誤，記錄但不拋出
                    if "timeout" in error_str.lower() or "Connection timeout" in error_str:
                        self.logger.warning("binance_portfolio_summary_timeout_fallback", error=error_str)
                    else:
                        self.logger.warning("binance_portfolio_summary_failed_fallback", error=error_str)
                    # 回退到傳統模式（不修改全域旗標，避免快取的實例永久降級）
            
            # 使用傳統帳戶端點
            balances = await self.get_balances()
            positions = await self.get_positions()
            
            # 🔥 為合約持倉填充資金費率
            for pos in positions:
                if pos.position_type in ['perp_linear', 'perp_inverse', 'futures_linear', 'futures_inverse']:
                    try:
                        funding_rates = await self.get_funding_rates([pos.symbol])
                        if funding_rates:
                            fr = funding_rates[0]
                            pos.funding_rate_8h = fr.funding_rate_8h
                            pos.next_funding_time = fr.next_funding_time
                    except Exception as e:
                        self.logger.debug("binance_fill_funding_rate_failed", 
                                        symbol=pos.symbol, 
                                        error=str(e))
            
            # 計算總權益（簡單加總 USDT 和合約未實現盈虧）
            total_equity = sum(b.free + b.locked for b in balances if b.asset == "USDT")
            total_equity += sum(p.unrealized_pnl for p in positions)
            
            return AccountSummary(
                exchange="binance",
                account_mode="classic",
                timestamp=int(time.time() * 1000),
                total_equity_usdt=total_equity,
                balances=balances,
                positions=positions,
                unsupported_reason="使用傳統帳戶模式（未開通 Portfolio Margin）"
            )
            
        except Exception as e:
            self.logger.error("binance_get_account_summary_failed", error=str(e))
            return AccountSummary(
                exchange="binance",
                account_mode="unsupported",
                timestamp=int(time.time() * 1000),
                unsupported_reason=f"獲取帳戶摘要失敗: {str(e)}"
                )
