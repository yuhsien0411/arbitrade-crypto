"""
Bitget 交易所實現
使用原生 REST API，支持 USDT-M 永續合約
"""

import time
import json
import hmac
import hashlib
import base64
import ccxt
import httpx
from typing import Optional, List, Dict, Any, Tuple

from .base import (
    BaseExchange, OrderResult, TickerData, OrderBookData, Balance, Position,
    OrderSide, OrderType, TradeType, FundingRate, AccountSummary, AccountMode
)
from ..utils.logger import get_logger


class BitgetExchange(BaseExchange):
    """Bitget 交易所實現 - 使用原生 REST API
    
    支持：
    - USDT-M 永續合約（單向持倉模式）
    
    注意：
    - 僅支援合約交易，不支援現貨
    - 使用單向持倉模式（省略 tradeSide 參數）
    - 限速：10次/秒（普通用戶）
    """
    
    BASE_URL = "https://api.bitget.com"
    
    def __init__(self, api_key: str = "", api_secret: str = "", password: str = "", testnet: bool = False):
        super().__init__(api_key, api_secret, testnet)
        self.password = password
        self.logger = get_logger()
        self._client = None
        self._http_client = httpx.AsyncClient(timeout=30.0)
        self._init_client()
    
    def _init_client(self):
        """初始化 ccxt.bitget 客戶端"""
        try:
            self._client = ccxt.bitget({
                'apiKey': self.api_key,
                'secret': self.api_secret,
                'password': self.password,
                'enableRateLimit': True,
                'options': {
                    'defaultType': 'spot',  # 默認現貨，下單時可覆蓋
                }
            })
            
            # 測試網設置
            if self.testnet:
                self._client.set_sandbox_mode(True)
            
            self.logger.info("bitget_client_initialized", 
                           testnet=self.testnet, 
                           authenticated=self.is_authenticated)
        except Exception as e:
            self.logger.error("bitget_client_init_failed", error=str(e))
            raise

    def _extract_numeric(self, data: Dict[str, Any], keys: List[str]) -> float:
        """從候選欄位中挑選第一個可轉為 float 的值"""
        for key in keys:
            if key not in data:
                continue
            value = data.get(key)
            if value in (None, "", []):
                continue
            try:
                return float(value)
            except (TypeError, ValueError):
                self.logger.debug(
                    "bitget_position_numeric_parse_failed",
                    field=key,
                    value=value,
                    symbol=data.get("symbol")
                )
        return 0.0
    
    @property
    def name(self) -> str:
        return "Bitget"
    
    def _generate_signature(self, timestamp: str, method: str, request_path: str, body: str = "") -> str:
        """生成 Bitget API 簽名
        
        簽名算法：
        1. 拼接字符串：timestamp + method + request_path + body
        2. 使用 HMAC-SHA256 加密
        3. Base64 編碼
        """
        message = timestamp + method.upper() + request_path + body
        mac = hmac.new(
            self.api_secret.encode('utf-8'),
            message.encode('utf-8'),
            hashlib.sha256
        )
        return base64.b64encode(mac.digest()).decode('utf-8')
    
    def _get_headers(self, method: str, request_path: str, body: str = "") -> Dict[str, str]:
        """構建 Bitget API 請求頭
        
        必需頭部：
        - ACCESS-KEY: API Key
        - ACCESS-SIGN: 簽名
        - ACCESS-PASSPHRASE: API Password
        - ACCESS-TIMESTAMP: 毫秒級時間戳
        - Content-Type: application/json
        """
        timestamp = str(int(time.time() * 1000))
        signature = self._generate_signature(timestamp, method, request_path, body)
        
        return {
            "ACCESS-KEY": self.api_key,
            "ACCESS-SIGN": signature,
            "ACCESS-PASSPHRASE": self.password,
            "ACCESS-TIMESTAMP": timestamp,
            "Content-Type": "application/json",
            "locale": "zh-CN"
        }
    
    def _get_ccxt_type(self, trade_type: TradeType) -> str:
        """轉換 TradeType 為 ccxt 類型
        
        注意：Bitget 僅支援合約交易
        """
        if trade_type == TradeType.SPOT:
            raise ValueError(f"Bitget 不支援現貨交易，請使用合約（LINEAR）")
        elif trade_type == TradeType.LINEAR:
            return "swap"  # USDT-M 永續合約
        elif trade_type == TradeType.INVERSE:
            return "swap"  # 幣本位合約
        else:
            raise ValueError(f"不支援的交易類型: {trade_type}")
    
    def _convert_side(self, side: OrderSide) -> str:
        """轉換訂單方向為 Bitget 格式"""
        return "buy" if side == OrderSide.BUY else "sell"
    
    def _convert_order_type(self, order_type: OrderType) -> str:
        """轉換訂單類型為 Bitget 格式"""
        return "market" if order_type == OrderType.MARKET else "limit"
    
    def _normalize_symbol(self, symbol: str) -> str:
        """標準化交易對符號（僅做基本清理）"""
        return symbol.upper().strip()
    
    def _to_bitget_symbol(self, symbol: str, trade_type: TradeType) -> str:
        """轉換為 Bitget 完整交易對格式
        
        Bitget 僅支援合約，格式：BTC/USDT:USDT
        """
        symbol = self._normalize_symbol(symbol)
        
        # 檢查交易類型
        if trade_type == TradeType.SPOT:
            raise ValueError(f"Bitget 不支援現貨交易，請使用合約（LINEAR）")
        
        # 如果已經是 Bitget 合約格式（含 :），直接返回
        if ':' in symbol:
            return symbol
        
        # 移除可能存在的分隔符
        symbol = symbol.replace('-', '').replace('_', '').replace('/', '')
        
        # 將統一格式（BTCUSDT）轉換為 Bitget 合約格式（BTC/USDT:USDT）
        if symbol.endswith('USDT'):
            base = symbol[:-4]
            return f"{base}/USDT:USDT"
        elif symbol.endswith('USDC'):
            base = symbol[:-4]
            return f"{base}/USDC:USDC"
        elif symbol.endswith('USD'):
            base = symbol[:-3]
            return f"{base}/USD:USD"
        
        # 無法識別，返回原格式
        return symbol
    
    def _from_bitget_symbol(self, bitget_symbol: str) -> str:
        """將 Bitget 格式轉回統一格式
        
        Args:
            bitget_symbol: Bitget 格式 (BTC/USDT 或 BTC/USDT:USDT)
        
        Returns:
            統一格式 (BTCUSDT)
        """
        # 移除 :USDT, :USDC 等後綴（合約格式）
        symbol = bitget_symbol.split(':')[0]
        # 移除分隔符
        symbol = symbol.replace('/', '').replace('-', '').replace('_', '')
        return symbol
    
    async def get_ticker(self, symbol: str, trade_type: TradeType = TradeType.SPOT) -> TickerData:
        """獲取行情數據"""
        try:
            bitget_symbol = self._to_bitget_symbol(symbol, trade_type)
            ccxt_type = self._get_ccxt_type(trade_type)
            
            # 設置市場類型
            self._client.options['defaultType'] = ccxt_type
            
            ticker = self._client.fetch_ticker(bitget_symbol)
            
            # 統一返回格式
            unified_symbol = self._from_bitget_symbol(ticker['symbol'])
            
            return TickerData(
                symbol=unified_symbol,
                last_price=float(ticker['last']) if ticker['last'] else 0.0,
                bid_price=float(ticker['bid']) if ticker['bid'] else 0.0,
                ask_price=float(ticker['ask']) if ticker['ask'] else 0.0,
                volume_24h=float(ticker['quoteVolume']) if ticker.get('quoteVolume') else 0.0,
                timestamp=int(ticker['timestamp']) if ticker.get('timestamp') else int(time.time() * 1000)
            )
        except Exception as e:
            self.logger.error("bitget_get_ticker_failed", symbol=symbol, error=str(e))
            raise
    
    async def get_orderbook(self, symbol: str, limit: int = 25, trade_type: TradeType = TradeType.SPOT) -> OrderBookData:
        """獲取訂單簿數據"""
        try:
            bitget_symbol = self._to_bitget_symbol(symbol, trade_type)
            ccxt_type = self._get_ccxt_type(trade_type)
            
            self._client.options['defaultType'] = ccxt_type
            
            orderbook = self._client.fetch_order_book(bitget_symbol, limit)
            
            unified_symbol = self._from_bitget_symbol(bitget_symbol)
            
            return OrderBookData(
                symbol=unified_symbol,
                bids=[[float(price), float(qty)] for price, qty in orderbook['bids'][:limit]],
                asks=[[float(price), float(qty)] for price, qty in orderbook['asks'][:limit]],
                timestamp=int(orderbook['timestamp']) if orderbook.get('timestamp') else int(time.time() * 1000)
            )
        except Exception as e:
            self.logger.error("bitget_get_orderbook_failed", symbol=symbol, error=str(e))
            raise
    
    async def get_symbols(self, trade_type: TradeType = TradeType.SPOT) -> List[str]:
        """獲取支援的交易對列表"""
        try:
            ccxt_type = self._get_ccxt_type(trade_type)
            self._client.options['defaultType'] = ccxt_type
            
            markets = self._client.load_markets()
            
            # 過濾對應市場類型的交易對
            symbols = []
            for market_id, market in markets.items():
                if market['type'] == ccxt_type and market['active']:
                    # 統一格式返回
                    unified_symbol = self._from_bitget_symbol(market['symbol'])
                    symbols.append(unified_symbol)
            
            return sorted(symbols)
        except Exception as e:
            self.logger.error("bitget_get_symbols_failed", error=str(e))
            raise
    
    async def _place_order_native(
        self,
        symbol: str,
        side: OrderSide,
        order_type: OrderType,
        quantity: float,
        price: Optional[float] = None,
        trade_type: TradeType = TradeType.LINEAR,
        reduce_only: bool = False,
        margin_mode: str = "crossed",
        client_oid: Optional[str] = None,
        **kwargs
    ) -> Dict[str, Any]:
        """使用原生 Bitget API 下單
        
        Args:
            symbol: 交易對名稱，如 "ETHUSDT"
            side: 交易方向（buy/sell）
            order_type: 訂單類型（market/limit）
            quantity: 下單數量
            price: 下單價格（限價單必填）
            trade_type: 交易類型（僅支援 LINEAR）
            reduce_only: 是否僅減倉
            margin_mode: 保證金模式（isolated/crossed）
            client_oid: 自定義訂單ID
            
        Returns:
            Bitget API 響應
            
        Raises:
            ValueError: 參數錯誤
            Exception: API 調用失敗
        """
        # 驗證交易類型
        if trade_type == TradeType.SPOT:
            raise ValueError("Bitget 不支援現貨交易，僅支援合約（LINEAR）")
        
        # 規範化交易對符號：移除任何分隔符，只保留基礎格式
        clean_symbol = symbol.upper().replace("/", "").replace(":", "").replace("-", "")
        
        # 構建請求體
        body_dict = {
            "symbol": clean_symbol,  # 如: "ETHUSDT"
            "productType": "USDT-FUTURES",
            "marginMode": margin_mode,
            "marginCoin": "USDT",
            "size": str(quantity),
            "side": "buy" if side == OrderSide.BUY else "sell",
            "orderType": "market" if order_type == OrderType.MARKET else "limit",
        }
        
        # 限價單需要價格
        if order_type == OrderType.LIMIT:
            if price is None:
                raise ValueError("限價單需要提供價格")
            body_dict["price"] = str(price)
            body_dict["force"] = "gtc"  # 訂單有效期：Good Till Cancel
        
        # 只減倉參數（單向持倉專用）
        if reduce_only:
            body_dict["reduceOnly"] = "YES"
        
        # 自定義訂單ID
        if client_oid:
            body_dict["clientOid"] = client_oid
        
        # 注意：單向持倉模式下，不要添加 tradeSide 參數！
        
        # 構建請求
        request_path = "/api/v2/mix/order/place-order"
        body_json = json.dumps(body_dict)
        headers = self._get_headers("POST", request_path, body_json)
        url = self.BASE_URL + request_path
        
        # 發送請求
        try:
            response = await self._http_client.post(url, headers=headers, content=body_json)
            response_data = response.json()
            
            # 檢查響應
            if response_data.get("code") != "00000":
                error_msg = f"bitget {json.dumps(response_data)}"
                self.logger.error("bitget_place_order_failed",
                                symbol=clean_symbol,
                                side=side.value,
                                error=error_msg,
                                response=response_data)
                raise Exception(error_msg)
            
            self.logger.info("bitget_order_placed_native",
                           symbol=clean_symbol,
                           order_id=response_data.get("data", {}).get("orderId"),
                           client_oid=response_data.get("data", {}).get("clientOid"),
                           side=side.value,
                           type=order_type.value)
            
            return response_data
            
        except httpx.HTTPError as e:
            error_msg = f"bitget HTTP error: {str(e)}"
            self.logger.error("bitget_http_error", error=error_msg)
            raise Exception(error_msg)
    
    async def place_order(
        self,
        symbol: str,
        side: OrderSide,
        order_type: OrderType,
        quantity: float,
        price: Optional[float] = None,
        trade_type: TradeType = TradeType.SPOT,
        reduce_only: bool = False,
        **kwargs
    ) -> OrderResult:
        """下單 - 使用原生 Bitget API"""
        if not self.is_authenticated:
            raise PermissionError("需要 API 金鑰才能下單")
        
        try:
            # 驗證交易類型
            if trade_type == TradeType.SPOT:
                raise ValueError("Bitget 不支援現貨交易，僅支援合約（LINEAR）")
            
            # 規範化交易對符號
            clean_symbol = symbol.upper().replace("/", "").replace(":", "").replace("-", "")
            
            # 使用原生 API 下單
            margin_mode = kwargs.get("margin_mode", "crossed")
            response_data = await self._place_order_native(
                symbol=clean_symbol,
                side=side,
                order_type=order_type,
                quantity=quantity,
                price=price,
                trade_type=trade_type,
                reduce_only=reduce_only,
                margin_mode=margin_mode
            )
            
            # 解析響應
            data = response_data.get("data", {})
            order_id = data.get("orderId")
            client_oid = data.get("clientOid")
            
            # 構建返回結果
            return OrderResult(
                success=True,
                order_id=order_id or client_oid,
                price=price if price else 0.0,
                quantity=quantity,
                timestamp=int(time.time() * 1000)
            )
        except Exception as e:
            self.logger.error("bitget_place_order_failed", 
                            symbol=symbol, 
                            side=side.value,
                            error=str(e))
            raise
    
    async def cancel_order(self, order_id: str, symbol: str, trade_type: TradeType = TradeType.SPOT) -> bool:
        """取消訂單"""
        if not self.is_authenticated:
            raise PermissionError("需要 API 金鑰才能取消訂單")
        
        try:
            bitget_symbol = self._to_bitget_symbol(symbol, trade_type)
            ccxt_type = self._get_ccxt_type(trade_type)
            
            self._client.options['defaultType'] = ccxt_type
            
            result = self._client.cancel_order(order_id, bitget_symbol)
            
            self.logger.info("bitget_order_cancelled", order_id=order_id, symbol=symbol)
            return True
        except Exception as e:
            self.logger.error("bitget_cancel_order_failed", 
                            order_id=order_id, 
                            symbol=symbol,
                            error=str(e))
            return False
    
    async def get_order_status(self, order_id: str, symbol: str, trade_type: TradeType = TradeType.SPOT) -> Dict:
        """查詢訂單狀態"""
        if not self.is_authenticated:
            raise PermissionError("需要 API 金鑰才能查詢訂單")
        
        try:
            bitget_symbol = self._to_bitget_symbol(symbol, trade_type)
            ccxt_type = self._get_ccxt_type(trade_type)
            
            self._client.options['defaultType'] = ccxt_type
            
            order = self._client.fetch_order(order_id, bitget_symbol)
            
            unified_symbol = self._from_bitget_symbol(bitget_symbol)
            
            return {
                "order_id": str(order['id']),
                "symbol": unified_symbol,
                "status": order['status'],
                "side": order['side'],
                "type": order['type'],
                "price": float(order['price']) if order.get('price') else 0.0,
                "quantity": float(order['amount']),
                "filled_quantity": float(order['filled']) if order.get('filled') else 0.0,
                "remaining": float(order['remaining']) if order.get('remaining') else 0.0,
                "timestamp": int(order['timestamp']) if order.get('timestamp') else 0
            }
        except Exception as e:
            self.logger.error("bitget_get_order_status_failed", 
                            order_id=order_id,
                            symbol=symbol,
                            error=str(e))
            raise
    
    async def get_balances(self, trade_type: TradeType = TradeType.SPOT) -> List[Balance]:
        """獲取帳戶餘額"""
        if not self.is_authenticated:
            raise PermissionError("需要 API 金鑰才能查詢餘額")
        
        try:
            ccxt_type = self._get_ccxt_type(trade_type)
            self._client.options['defaultType'] = ccxt_type
            
            balance_data = self._client.fetch_balance()
            
            balances = []
            for currency, amounts in balance_data['total'].items():
                if float(amounts) > 0:
                    balances.append(Balance(
                        asset=currency,
                        free=float(balance_data['free'].get(currency, 0)),
                        locked=float(balance_data['used'].get(currency, 0)),
                        total=float(amounts)
                    ))
            
            return balances
        except Exception as e:
            self.logger.error("bitget_get_balances_failed", error=str(e))
            raise
    
    async def get_positions(self, symbol: Optional[str] = None, trade_type: TradeType = TradeType.LINEAR) -> List[Position]:
        """獲取持倉資訊
        
        使用 Bitget 原生 API /api/v2/mix/position/all-position 獲取持倉
        確保能獲取到 achievedProfits（已實現盈虧）字段
        """
        if not self.is_authenticated:
            raise PermissionError("需要 API 金鑰才能查詢持倉")
        
        if trade_type == TradeType.SPOT:
            return []  # 現貨無持倉
        
        try:
            # 使用 Bitget 原生 API 獲取持倉（而不是 ccxt，因為原生 API 包含 achievedProfits）
            self.logger.info("bitget_get_positions_native_api", 
                           product_type="USDT-FUTURES",
                           margin_coin="USDT",
                           symbol=symbol)
            
            positions_response = self._client.private_mix_get_v2_mix_position_all_position({
                'productType': 'USDT-FUTURES',
                'marginCoin': 'USDT'
            })
            
            if positions_response.get('code') != '00000':
                raise Exception(f"Bitget API 錯誤: {positions_response.get('msg')}")
            
            positions_data = positions_response.get('data', [])
            positions = []
            
            for pos_data in positions_data:
                # 檢查是否有持倉
                total_size = float(pos_data.get('total', 0))
                if total_size == 0:
                    continue
                
                # 如果指定了 symbol，過濾
                bitget_symbol = pos_data.get('symbol', '')
                if symbol:
                    unified_symbol = self._from_bitget_symbol(bitget_symbol)
                    if unified_symbol.upper() != symbol.upper():
                        continue
                
                unified_symbol = self._from_bitget_symbol(bitget_symbol)
                hold_side = pos_data.get('holdSide', 'long')  # "long" 或 "short"
                
                # 轉換為 Position 的 side 格式（字符串 "long" 或 "short"）
                side_str = hold_side
                
                # 提取已實現盈虧（achievedProfits）
                achieved_profits = self._extract_numeric(pos_data, [
                    "achievedProfits", "closeProfit", "realizedPnl"
                ])
                trading_fee = self._extract_numeric(pos_data, [
                    "totalFee", "closeFee", "fee"
                ])
                funding_fee = self._extract_numeric(pos_data, [
                    "totalFunding", "fundingFee", "funding"
                ])
                
                realized_total = achieved_profits + trading_fee + funding_fee
                realized_details = {
                    "total": realized_total,
                    "achievedProfits": achieved_profits,
                    "tradingFee": trading_fee,
                    "fundingFee": funding_fee,
                }
                
                margin_mode_raw = pos_data.get('marginMode', 'crossed')
                margin_mode_lower = str(margin_mode_raw).lower()
                if margin_mode_lower.startswith("cross"):
                    margin_mode_value = "cross"
                elif margin_mode_lower.startswith("isolated"):
                    margin_mode_value = "isolated"
                else:
                    margin_mode_value = "cross"
                
                positions.append(Position(
                    symbol=unified_symbol,
                    base_asset=unified_symbol.replace('USDT', ''),
                    quote_asset='USDT',
                    position_type="perp_linear",
                    side=side_str,
                    size=total_size,
                    entry_price=float(pos_data.get('openPriceAvg', 0)),
                    mark_price=float(pos_data.get('markPrice', 0)),
                    liquidation_price=float(pos_data.get('liquidationPrice', 0)) if pos_data.get('liquidationPrice') else None,
                    unrealized_pnl=float(pos_data.get('unrealizedPL', 0)),
                    realized_pnl=realized_total,
                    leverage=float(pos_data.get('leverage', 1)),
                    margin_mode=margin_mode_value,
                    margin_usdt=float(pos_data.get('marginSize', 0)),
                    realized_pnl_details=realized_details
                ))
                
                self.logger.debug("bitget_position_extracted",
                                symbol=unified_symbol,
                                side=side_str,
                                size=total_size,
                                realized_pnl=achieved_profits,
                                unrealized_pnl=float(pos_data.get('unrealizedPL', 0)))
            
            return positions
            
        except Exception as e:
            self.logger.error("bitget_get_positions_failed", error=str(e))
            raise
    async def get_funding_rate(self, symbol: str) -> FundingRate:
        """獲取單個交易對的資金費率"""
        try:
            bitget_symbol = self._to_bitget_symbol(symbol, TradeType.LINEAR)
            
            # 直接調用 Bitget API
            endpoint = "/api/v2/mix/market/current-fund-rate"
            params = {
                "symbol": bitget_symbol.split(':')[0].replace('/', ''),  # 轉換為 Bitget 格式（如 ETHUSDT）
                "productType": "usdt-futures"
            }
            
            url = f"{self.BASE_URL}{endpoint}"
            response = await self._http_client.get(url, params=params)
            
            if response.status_code != 200:
                raise Exception(f"Bitget API 請求失敗: HTTP {response.status_code}")
            
            api_data = response.json()
            
            if api_data.get("code") != "00000":
                raise Exception(f"Bitget API 錯誤: {api_data.get('msg', '未知錯誤')}")
            
            data_list = api_data.get("data", [])
            if not data_list or len(data_list) == 0:
                raise Exception(f"Bitget API 返回空數據: {symbol}")
            
            funding_data = data_list[0]
            # print('bitget funding:',funding_data)
            unified_symbol = self._from_bitget_symbol(bitget_symbol)
            
            # 安全處理資金費率
            funding_rate = funding_data.get('fundingRate', 0)
            if funding_rate is None:
                funding_rate = 0
            funding_rate = float(funding_rate)
            
            # 獲取下次結算時間
            next_funding_time = funding_data.get('nextUpdate', 0)
            if next_funding_time is None:
                next_funding_time = 0
            next_funding_time = int(next_funding_time)
            
            # 獲取結算週期（單位：小時）
            settlement_interval = 8  # 默認值
            funding_interval = funding_data.get('fundingRateInterval')
            if funding_interval:
                try:
                    settlement_interval = int(float(str(funding_interval)))
                except (ValueError, TypeError):
                    settlement_interval = 8
            
            # 計算標準化費率
            funding_rate_8h = funding_rate * (8 / settlement_interval)
            funding_rate_daily = funding_rate * (24 / settlement_interval)
            
            return FundingRate(
                exchange="bitget",
                symbol=unified_symbol,
                category="linear",
                funding_rate=funding_rate,
                funding_rate_8h=funding_rate_8h,  # 標準化為 8 小時費率
                funding_rate_daily=funding_rate_daily,  # 標準化為每日費率
                next_funding_time=next_funding_time,
                settlement_interval_hours=settlement_interval,  # 從 API 獲取的實際結算週期
                timestamp=int(time.time() * 1000)
            )
        except Exception as e:
            self.logger.error("bitget_get_funding_rate_failed", symbol=symbol, error=str(e))
            raise
    
    async def get_funding_rates(self, symbols: List[str] = None) -> List[FundingRate]:
        """獲取資金費率列表（實現 BaseExchange 抽象方法）"""
        try:
            rates = []
            
            if symbols:
                for symbol in symbols:
                    try:
                        rate = await self.get_funding_rate(symbol)
                        rates.append(rate)
                    except Exception as e:
                        self.logger.warning("bitget_get_funding_rate_skip", 
                                          symbol=symbol, 
                                          error=str(e))
            
            return rates
            
        except Exception as e:
            self.logger.error("bitget_get_funding_rates_failed", error=str(e))
            return []
    
    async def get_account_summary(self, trade_type: TradeType = TradeType.LINEAR) -> AccountSummary:
        """獲取帳戶摘要（包含持倉信息）
        
        Bitget 僅支援合約帳戶查詢
        API: 
        - GET /api/v2/mix/account/accounts?productType=USDT-FUTURES (帳戶信息)
        - GET /api/v2/mix/position/all-position?productType=USDT-FUTURES (持倉信息)
        """
        if not self.is_authenticated:
            raise PermissionError("需要 API 金鑰才能查詢帳戶資訊")
        
        try:
            # Bitget 合約帳戶信息需要使用特定的 API
            # 使用 CCXT 的私有 API 調用
            ccxt_type = self._get_ccxt_type(trade_type)
            self._client.options['defaultType'] = ccxt_type
            
            # 獲取合約帳戶信息
            # productType: USDT-FUTURES (U本位), COIN-FUTURES (幣本位), USDC-FUTURES (USDC)
            response = self._client.private_mix_get_v2_mix_account_accounts({
                'productType': 'USDT-FUTURES'
            })
            
            if response.get('code') != '00000':
                raise Exception(f"Bitget API 錯誤: {response.get('msg', '未知錯誤')}")
            
            accounts = response.get('data', [])
            
            # 計算總權益
            total_equity = 0.0
            available_balance = 0.0
            total_margin = 0.0
            unrealized_pnl = 0.0
            balances = []
            
            for account in accounts:
                margin_coin = account.get('marginCoin', 'USDT')
                
                # 帳戶權益（保證金幣種）
                account_equity = float(account.get('accountEquity', 0))
                # USDT 折算權益
                usdt_equity = float(account.get('usdtEquity', 0))
                # 可用餘額
                available = float(account.get('available', 0))
                # 鎖定數量
                locked = float(account.get('locked', 0))
                # 未實現盈虧
                unrealized_pl = account.get('unrealizedPL', '') or '0'
                unrealized_pl = float(unrealized_pl) if unrealized_pl else 0.0
                
                # 全倉佔用保證金
                crossed_margin = float(account.get('crossedMargin', 0))
                # 逐倉佔用保證金
                isolated_margin = float(account.get('isolatedMargin', 0))
                
                # 累加 USDT 權益
                total_equity += usdt_equity
                available_balance += available if margin_coin == 'USDT' else 0
                total_margin += (crossed_margin + isolated_margin)
                unrealized_pnl += unrealized_pl
                
                # 添加餘額記錄
                balances.append(Balance(
                    asset=margin_coin,
                    free=available,
                    locked=locked,
                    borrowed=0.0,
                    interest=0.0,
                    usdt_value=usdt_equity
                ))
            
            # 獲取聯合保證金配置（獲取全局 MMR）
            global_mmr = 0.05  # 默認值
            try:
                # 使用原生 HTTP 請求獲取 union config
                request_path = "/api/v2/mix/account/union-config"
                headers = self._get_headers("GET", request_path, "")
                url = self.BASE_URL + request_path
                
                response = await self._http_client.get(url, headers=headers)
                union_config_response = response.json()
                
                if union_config_response.get('code') == '00000':
                    union_config = union_config_response.get('data', {})
                    mmr_raw = union_config.get('mmr', '0.05')
                    # 🔥 Bitget API 返回的 mmr 可能是小數（0.05）或百分比（5），需要統一處理
                    try:
                        mmr_value = float(mmr_raw)
                        # 如果值 > 1，可能是百分比形式（例如 5 表示 5%），轉換為小數
                        # 如果值 <= 1，已經是小數形式（例如 0.05 表示 5%）
                        if mmr_value > 1:
                            global_mmr = mmr_value / 100.0
                        else:
                            global_mmr = mmr_value
                    except (ValueError, TypeError):
                        global_mmr = 0.05  # 默認值
                    self.logger.info("bitget_union_config_fetched",
                                   mmr_raw=mmr_raw,
                                   mmr_converted=global_mmr,
                                   imr=union_config.get('imr'))
            except Exception as e:
                self.logger.warning("bitget_union_config_failed",
                                  error=str(e),
                                  message="使用默認 MMR=0.05")
            
            # 獲取所有持倉信息
            positions = []
            try:
                self.logger.info("bitget_fetching_positions", 
                               product_type="USDT-FUTURES",
                               margin_coin="USDT")
                
                positions_response = self._client.private_mix_get_v2_mix_position_all_position({
                    'productType': 'USDT-FUTURES',
                    'marginCoin': 'USDT'
                })
                
                self.logger.info("bitget_positions_api_response",
                               code=positions_response.get('code'),
                               has_data=bool(positions_response.get('data')))
                
                if positions_response.get('code') == '00000':
                    positions_data = positions_response.get('data', [])
                    
                    self.logger.info("bitget_positions_fetched", 
                                   count=len(positions_data),
                                   positions_summary=[{
                                       'symbol': p.get('symbol'),
                                       'holdSide': p.get('holdSide'),
                                       'total': p.get('total'),
                                       'available': p.get('available'),
                                       'locked': p.get('locked')
                                   } for p in positions_data[:5]])  # 只顯示前5個避免日誌過長
                    
                    # 如果沒有任何持倉，記錄警告
                    if len(positions_data) == 0:
                        self.logger.warning("bitget_no_positions_found",
                                          message="API 返回成功但沒有持倉數據")
                    
                    for pos_data in positions_data:
                        # 只處理有持倉的記錄
                        total_size = float(pos_data.get('total', 0))
                        if total_size == 0:
                            continue
                        
                        symbol = pos_data.get('symbol', '')
                        hold_side = pos_data.get('holdSide', '')
                        
                        # 解析基礎資產和報價資產
                        base_asset = symbol.replace('USDT', '') if 'USDT' in symbol else symbol
                        quote_asset = 'USDT'
                        
                        # 轉換方向（Position 類的 side 是字符串 "long" 或 "short"）
                        side_str = hold_side  # "long" 或 "short"
                        
                        # 獲取該交易對的資金費率
                        funding_rate_8h = None
                        next_funding_time = None
                        try:
                            funding_rate_data = await self.get_funding_rate(symbol)
                            funding_rate_8h = funding_rate_data.funding_rate_8h
                            next_funding_time = funding_rate_data.next_funding_time
                        except Exception as e:
                            self.logger.warning("bitget_get_funding_rate_for_position_failed",
                                              symbol=symbol,
                                              error=str(e))
                        
                        achieved_profits = self._extract_numeric(pos_data, [
                            "achievedProfits", "closeProfit", "realizedPnl"
                        ])
                        trading_fee = self._extract_numeric(pos_data, [
                            "totalFee", "closeFee", "fee"
                        ])
                        funding_fee = self._extract_numeric(pos_data, [
                            "totalFunding", "fundingFee", "funding"
                        ])

                        realized_total = achieved_profits + trading_fee + funding_fee
                        realized_details = {
                            "total": realized_total,
                            "achievedProfits": achieved_profits,
                            "tradingFee": trading_fee,
                            "fundingFee": funding_fee,
                        }

                        margin_mode_raw = pos_data.get('marginMode', 'crossed')
                        margin_mode_lower = str(margin_mode_raw).lower()
                        if margin_mode_lower.startswith("cross"):
                            margin_mode_value = "cross"
                        elif margin_mode_lower.startswith("isolated"):
                            margin_mode_value = "isolated"
                        else:
                            margin_mode_value = "cross"

                        # 創建 Position 對象
                        position = Position(
                            symbol=symbol,
                            base_asset=base_asset,
                            quote_asset=quote_asset,
                            position_type="perp_linear",  # Bitget USDT-M 都是 linear
                            side=side_str,
                            size=total_size,
                            entry_price=float(pos_data.get('openPriceAvg', 0)),
                            mark_price=float(pos_data.get('markPrice', 0)),
                            liquidation_price=float(pos_data.get('liquidationPrice', 0)) if pos_data.get('liquidationPrice') else None,
                            leverage=float(pos_data.get('leverage', 1)),
                            margin_mode=margin_mode_value,
                            margin_usdt=float(pos_data.get('marginSize', 0)),
                            unrealized_pnl=float(pos_data.get('unrealizedPL', 0)),
                            realized_pnl=realized_total,
                            realized_pnl_details=realized_details,
                            funding_rate_8h=funding_rate_8h,  # 添加資金費率
                            next_funding_time=next_funding_time  # 添加下次資金費時間
                        )
                        # notional_value 是計算屬性，會自動計算 = size * mark_price
                        
                        positions.append(position)
                        
                        self.logger.info("bitget_position_parsed",
                                       symbol=symbol,
                                       side=side_str,
                                       size=total_size,
                                       entry_price=position.entry_price,
                                       mark_price=position.mark_price,
                                       unrealized_pnl=position.unrealized_pnl,
                                       leverage=position.leverage)
                else:
                    self.logger.warning("bitget_get_positions_failed",
                                      code=positions_response.get('code'),
                                      msg=positions_response.get('msg'))
                    
            except Exception as e:
                self.logger.error("bitget_get_positions_error", error=str(e))
                import traceback
                self.logger.error("bitget_get_positions_traceback", traceback=traceback.format_exc())
            
            # 計算維持保證金（使用每個持倉的 notional_value * keepMarginRate）
            total_maintenance_margin = 0.0
            for position in positions:
                # 從 position 的 margin_mode 和 leverage 計算維持保證金
                # 簡化計算：使用全局 MMR
                total_maintenance_margin += position.notional_value * global_mmr
            
            return AccountSummary(
                exchange="bitget",
                account_mode="classic",  # Bitget 使用經典帳戶模式
                timestamp=int(time.time() * 1000),
                total_equity_usdt=total_equity,
                total_margin_usdt=total_margin,
                available_balance_usdt=available_balance,
                maintenance_margin_rate=global_mmr,  # 添加維持保證金率
                total_maintenance_margin=total_maintenance_margin,  # 添加總維持保證金
                balances=balances,
                positions=positions,  # 添加持倉信息
                unsupported_reason=None
            )
            
        except Exception as e:
            self.logger.error("bitget_get_account_summary_failed", error=str(e))
            import traceback
            self.logger.error("bitget_get_account_summary_traceback", traceback=traceback.format_exc())
            # 返回帶有錯誤信息的 AccountSummary
            return AccountSummary(
                exchange="bitget",
                account_mode="unsupported",
                timestamp=int(time.time() * 1000),
                unsupported_reason=f"獲取帳戶摘要失敗: {str(e)}"
            )
    
    async def get_fill_price(self, order_id: str, symbol: str, trade_type: TradeType = TradeType.SPOT) -> Optional[float]:
        """獲取訂單實際成交價格 - 使用原生 API
        
        Bitget API: GET /api/v2/mix/order/detail
        文檔: https://www.bitget.com/zh-CN/api-doc/contract/trade/Get-Order-Details
        
        重試機制：
        - 最多重試 3 次
        - 每次間隔 500ms（市價單需要時間成交）
        """
        if not self.is_authenticated:
            raise PermissionError("需要 API 金鑰才能查詢成交資訊")
        
        try:
            import asyncio
            
            # 驗證交易類型
            if trade_type == TradeType.SPOT:
                raise ValueError("Bitget 不支援現貨交易，僅支援合約（LINEAR）")
            
            # 規範化交易對符號
            clean_symbol = symbol.upper().replace("/", "").replace(":", "").replace("-", "")
            
            self.logger.info("bitget_fetching_fill_price_native",
                           order_id=order_id,
                           symbol=clean_symbol)
            
            # 重試機制：最多 6 次，每次間隔 1000ms（總計 6 秒）
            # Bitget API 可能需要更多時間來更新訂單狀態和成交價
            max_retries = 6
            retry_delay = 1.0  # 1000ms
            
            for attempt in range(max_retries):
                try:
                    # 構建查詢參數
                    request_path = "/api/v2/mix/order/detail"
                    params = {
                        "symbol": clean_symbol,
                        "productType": "USDT-FUTURES",
                        "orderId": order_id
                    }
                    
                    # 構建查詢字符串
                    query_string = "&".join([f"{k}={v}" for k, v in params.items()])
                    full_path = f"{request_path}?{query_string}"
                    
                    # 獲取請求頭（GET 請求，body 為空）
                    headers = self._get_headers("GET", full_path, "")
                    
                    # 發送請求
                    url = self.BASE_URL + full_path
                    response = await self._http_client.get(url, headers=headers)
                    response_data = response.json()
                    
                    self.logger.info("bitget_order_detail_response",
                                   order_id=order_id,
                                   attempt=attempt + 1,
                                   code=response_data.get("code"),
                                   has_data=bool(response_data.get("data")))
                    
                    # 檢查響應
                    if response_data.get("code") != "00000":
                        self.logger.warning("bitget_order_detail_error",
                                          order_id=order_id,
                                          response=response_data)
                        
                        # 如果不是最後一次嘗試，等待後重試
                        if attempt < max_retries - 1:
                            await asyncio.sleep(retry_delay)
                            continue
                        return None
                    
                    # 解析訂單詳情
                    order_data = response_data.get("data")
                    if not order_data:
                        self.logger.warning("bitget_no_order_data",
                                          order_id=order_id)
                        
                        if attempt < max_retries - 1:
                            await asyncio.sleep(retry_delay)
                            continue
                        return None
                    
                    # 獲取平均成交價
                    # Bitget API 返回的字段（嘗試多種可能的字段名）：
                    # - priceAvg: 平均成交價
                    # - avgPrice: 平均成交價（可能的別名）
                    # - price: 委託價格（作為後備）
                    # - baseVolume: 成交數量
                    # - state: 訂單狀態 (filled, partial_filled, etc.)
                    avg_price = (
                        order_data.get("priceAvg") or 
                        order_data.get("avgPrice") or 
                        order_data.get("price")
                    )
                    state = order_data.get("state")
                    base_volume = order_data.get("baseVolume") or order_data.get("size")
                    
                    self.logger.info("bitget_order_detail_parsed",
                                   order_id=order_id,
                                   avg_price=avg_price,
                                   state=state,
                                   base_volume=base_volume,
                                   raw_order_data=order_data)
                    
                    # 如果有成交價且已完全成交，返回價格
                    # 注意：avg_price 可能是空字符串，需要先檢查
                    if avg_price and str(avg_price).strip() and float(avg_price) > 0:
                        fill_price = float(avg_price)
                        self.logger.info("bitget_fill_price_retrieved_native",
                                       order_id=order_id,
                                       symbol=clean_symbol,
                                       price=fill_price,
                                       state=state)
                        return fill_price
                    
                    # 如果訂單還未成交完成，繼續重試
                    if state in ("new", "partial_filled") and attempt < max_retries - 1:
                        self.logger.info("bitget_order_not_filled_yet",
                                       order_id=order_id,
                                       state=state,
                                       attempt=attempt + 1)
                        await asyncio.sleep(retry_delay)
                        continue
                    
                    # 最後一次嘗試仍未獲取到價格
                    self.logger.warning("bitget_no_fill_price_after_retries",
                                      order_id=order_id,
                                      symbol=clean_symbol,
                                      state=state,
                                      avg_price=avg_price,
                                      max_retries=max_retries)
                    return None
                    
                except httpx.HTTPError as e:
                    self.logger.error("bitget_http_error_get_fill_price",
                                    order_id=order_id,
                                    attempt=attempt + 1,
                                    error=str(e))
                    if attempt < max_retries - 1:
                        await asyncio.sleep(retry_delay)
                        continue
                    return None
            
            return None
            
        except Exception as e:
            self.logger.error("bitget_get_fill_price_failed",
                            order_id=order_id,
                            symbol=symbol,
                            error=str(e))
            import traceback
            self.logger.error("bitget_get_fill_price_traceback",
                            traceback=traceback.format_exc())
            return None
    
    async def check_account_mode(self) -> Tuple[str, bool]:
        """檢查帳戶模式
        
        Bitget 不使用統一帳戶，返回 classic
        
        Returns:
            (account_mode, is_supported)
            - account_mode: 'classic'
            - is_supported: False (不支持統一帳戶)
        """
        return ("classic", False)
    
    async def ping(self) -> bool:
        """測試連接"""
        try:
            self._client.fetch_time()
            return True
        except Exception as e:
            self.logger.error("bitget_ping_failed", error=str(e))
            return False
    
    async def get_server_time(self) -> int:
        """獲取伺服器時間"""
        try:
            server_time = self._client.fetch_time()
            return int(server_time)
        except Exception as e:
            self.logger.error("bitget_get_server_time_failed", error=str(e))
            return int(time.time() * 1000)
