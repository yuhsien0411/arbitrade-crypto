"""
OKX 交易所實現
使用 ccxt 統一接口，僅支持 USDT-M 永續合約（全倉模式）
支持 WebSocket OrderBook Feed（10ms 推送）
"""

import time
import ccxt
import json
import hmac
import base64
import aiohttp
from datetime import datetime
from typing import Optional, List, Dict, Any, Tuple

from .base import (
    BaseExchange, OrderResult, TickerData, OrderBookData, Balance, Position,
    OrderSide, OrderType, TradeType, FundingRate, AccountSummary, AccountMode
)
from ..utils.logger import get_logger
from ..services.orderbook_feeds.okx import OKXOrderBookFeed


class OKXExchange(BaseExchange):
    """OKX 交易所實現 - 使用 ccxt
    
    支持：
    - USDT-M 永續合約（Cross Margin 全倉模式）
    
    注意：
    - 僅支援合約交易，不支援現貨
    - 使用全倉模式（Cross Margin）
    
    數量單位：
    - OKX 合約使用"張"（contracts）作為數量單位
    - API 參數使用 sz (size) 表示張數
    - ccxt 會自動將 amount 轉換為 sz
    - 持倉查詢返回的 contracts 字段即為張數
    - 1張 = 合約面值對應的標的資產數量（例如 BTC-USDT-SWAP，1張 = 0.01 BTC）
    
    數量轉換：
    - 顆數（qty）→ 張數（contracts）：qty ÷ ctVal
    - 張數（contracts）→ 顆數（qty）：contracts × ctVal
    - ctVal（合約面值）通過 Public API 動態獲取並緩存
    """
    
    def __init__(self, api_key: str = "", api_secret: str = "", password: str = "", testnet: bool = False):
        super().__init__(api_key, api_secret, testnet)
        self.password = password
        self.logger = get_logger()
        self._client = None
        self.orderbook_feed = OKXOrderBookFeed()  # WebSocket OrderBook Feed
        self._base_url = "https://www.okx.com" if not testnet else "https://www.okx.com"
        self._contract_sizes_cache = {}  # 合約面值緩存
        self._init_client()
    
    def _generate_signature(self, timestamp: str, method: str, endpoint: str, body: str = "") -> str:
        """生成 OKX API 簽名"""
        message = timestamp + method + endpoint + body
        mac = hmac.new(
            bytes(self.api_secret, encoding='utf8'),
            bytes(message, encoding='utf-8'),
            digestmod='sha256'
        )
        return base64.b64encode(mac.digest()).decode()
    
    def _get_headers(self, timestamp: str, body: str = "") -> Dict[str, str]:
        """獲取 OKX API 請求頭"""
        return {
            'OK-ACCESS-KEY': self.api_key,
            'OK-ACCESS-SIGN': self._generate_signature(timestamp, 'POST', '/api/v5/trade/order', body),
            'OK-ACCESS-TIMESTAMP': timestamp,
            'OK-ACCESS-PASSPHRASE': self.password,
            'Content-Type': 'application/json'
        }
    
    async def _get_instrument_info(self, inst_id: str) -> Dict[str, Any]:
        """獲取交易產品基礎信息"""
        endpoint = "/api/v5/public/instruments"
        
        # 從 inst_id 判斷產品類型
        if "-SWAP" in inst_id:
            inst_type = "SWAP"
        elif "-FUTURES" in inst_id:
            inst_type = "FUTURES"
        elif "-MARGIN" in inst_id:
            inst_type = "MARGIN"
        else:
            inst_type = "SPOT"
        
        # 構建查詢參數
        query_params = f"?instType={inst_type}&instId={inst_id}"
        full_endpoint = endpoint + query_params
        
        # 生成簽名
        timestamp = datetime.utcnow().isoformat(timespec='milliseconds') + 'Z'
        message = timestamp + 'GET' + full_endpoint
        mac = hmac.new(
            bytes(self.api_secret, encoding='utf8'),
            bytes(message, encoding='utf-8'),
            digestmod='sha256'
        )
        signature = base64.b64encode(mac.digest()).decode()
        
        # 準備請求頭
        headers = {
            'OK-ACCESS-KEY': self.api_key,
            'OK-ACCESS-SIGN': signature,
            'OK-ACCESS-TIMESTAMP': timestamp,
            'OK-ACCESS-PASSPHRASE': self.password,
            'Content-Type': 'application/json'
        }
        
        # 發送請求
        async with aiohttp.ClientSession() as session:
            async with session.get(
                f"{self._base_url}{full_endpoint}",
                headers=headers
            ) as response:
                response_text = await response.text()
                result = json.loads(response_text)
                
                if result.get('code') == '0' and result.get('data'):
                    return result['data'][0]
                else:
                    raise Exception(f"獲取產品信息失敗: {result.get('msg', 'Unknown error')}")
    
    def _convert_quantity_to_contracts(self, quantity: float, ct_val: str, lot_sz: str, min_sz: str) -> str:
        """將數量轉換為合約張數"""
        ct_val_float = float(ct_val)
        lot_sz_float = float(lot_sz)
        min_sz_float = float(min_sz)
        
        # 計算需要的張數
        contracts = quantity / ct_val_float
        
        # 根據精度調整
        if lot_sz_float >= 1:
            # 整數精度，向上取整
            contracts = int(contracts + 0.5)
        else:
            # 小數精度，根據精度調整
            precision = len(lot_sz.split('.')[-1]) if '.' in lot_sz else 0
            contracts = round(contracts, precision)
        
        # 確保不小於最小下單數量
        contracts = max(contracts, min_sz_float)
        
        return str(int(contracts) if lot_sz_float >= 1 else contracts)
    
    def _init_client(self):
        """初始化 ccxt.okx 客戶端"""
        try:
            # 构建配置，只在有API密钥时才添加认证信息
            config = {
                'enableRateLimit': True,
                'options': {
                    'defaultType': 'swap',  # 默認合約
                }
            }
            
            # 只有在提供了完整的API密钥时才添加认证
            if self.api_key and self.api_secret and self.password:
                config['apiKey'] = self.api_key
                config['secret'] = self.api_secret
                config['password'] = self.password
            
            self._client = ccxt.okx(config)
            
            # 🔧 關鍵修復：完全禁用自動加載市場功能
            # CCXT 的 okx.parse_market 有 bug，當 base 為 None 時會崩潰
            # TypeError: unsupported operand type(s) for +: 'NoneType' and 'str'
            # 我們不依賴 markets 數據，因此直接設置空字典避免自動加載
            self._client.markets = {}
            self._client.markets_by_id = {}
            
            # Monkey-patch load_markets 方法，防止 CCXT 自動調用
            # 同時確保 markets 不會被檢查失敗
            original_load_markets = self._client.load_markets
            def no_op_load_markets(reload=False, params={}):
                """空操作，不加載市場數據，但確保 markets 結構有效"""
                if not self._client.markets:
                    self._client.markets = {}
                    self._client.markets_by_id = {}
                # 標記為已加載，避免 CCXT 重複嘗試
                self._client.markets_loaded = True
                return self._client.markets
            
            self._client.load_markets = no_op_load_markets
            # 標記為已加載
            self._client.markets_loaded = True
            
            # Monkey-patch market 方法，避免 "does not have market symbol" 錯誤
            original_market = self._client.market
            def fake_market(symbol):
                """返回假的 market 信息，避免 CCXT 檢查失敗"""
                # 如果 markets 中沒有這個 symbol，創建一個最小的 market 對象
                if symbol not in self._client.markets:
                    # 創建最小的 market 結構
                    self._client.markets[symbol] = {
                        'id': symbol,
                        'symbol': symbol,
                        'base': symbol.split('-')[0] if '-' in symbol else symbol.split('/')[0],
                        'quote': 'USDT',
                        'active': True,
                        'type': 'swap',
                        'spot': False,
                        'margin': False,
                        'swap': True,
                        'future': False,
                        'option': False,
                        'contract': True,
                        'linear': True,
                        'inverse': False,
                        'contractSize': 0.01,  # 默認值
                        'precision': {  # 🔧 添加 precision 欄位
                            'amount': 8,
                            'price': 2
                        },
                        'info': {}
                    }
                return self._client.markets[symbol]
            
            self._client.market = fake_market
            
            # 🔧 修復 precision 錯誤：Monkey-patch parse_order 方法
            original_parse_order = self._client.parse_order
            def safe_parse_order(order, market=None):
                """安全的 parse_order 方法，處理 precision 錯誤"""
                try:
                    # 確保 market 有 precision 欄位
                    if market and 'precision' not in market:
                        market['precision'] = {
                            'amount': 8,
                            'price': 2
                        }
                    return original_parse_order(order, market)
                except KeyError as e:
                    if 'precision' in str(e):
                        # 如果 precision 錯誤，創建一個安全的 market
                        safe_market = market.copy() if market else {}
                        safe_market['precision'] = {
                            'amount': 8,
                            'price': 2
                        }
                        return original_parse_order(order, safe_market)
                    else:
                        raise
            
            self._client.parse_order = safe_parse_order
            
            self.logger.info("okx_markets_loading_disabled", 
                           reason="避免 CCXT parse_market bug")
            
            # 測試網設置
            if self.testnet:
                self._client.set_sandbox_mode(True)
            
            self.logger.info("okx_client_initialized", 
                           testnet=self.testnet, 
                           authenticated=self.is_authenticated)
        except Exception as e:
            self.logger.error("okx_client_init_failed", error=str(e))
            raise
    
    @property
    def name(self) -> str:
        return "OKX"

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
                    "okx_numeric_parse_failed",
                    field=key,
                    value=value,
                    symbol=data.get("symbol")
                )
        return 0.0
    
    def _get_ccxt_type(self, trade_type: TradeType) -> str:
        """轉換 TradeType 為 ccxt 類型"""
        if trade_type == TradeType.LINEAR:
            return "swap"  # USDT-M 永續合約
        else:
            raise ValueError(f"OKX 僅支援合約交易: {trade_type}")
    
    def _convert_side(self, side: OrderSide) -> str:
        """轉換訂單方向為 OKX 格式"""
        return "buy" if side == OrderSide.BUY else "sell"
    
    def _convert_order_type(self, order_type: OrderType) -> str:
        """轉換訂單類型為 OKX 格式"""
        return "market" if order_type == OrderType.MARKET else "limit"
    
    def _normalize_symbol(self, symbol: str) -> str:
        """標準化交易對符號
        
        統一格式轉換為 OKX 格式：
        - 統一輸入: ETHUSDT, BTCUSDT (Binance/Bybit 格式)
        - OKX 合約: ETH-USDT-SWAP, BTC-USDT-SWAP
        """
        symbol = symbol.upper().strip().replace('/', '-')
        
        # 如果已經是 OKX 格式（含 -SWAP），直接返回
        if '-SWAP' in symbol:
            return symbol
        
        # 如果已經是 OKX 格式（含 -），添加 -SWAP
        if '-' in symbol and '-SWAP' not in symbol:
            return f"{symbol}-SWAP"
        
        # 統一格式轉 OKX 格式
        # ETHUSDT -> ETH-USDT-SWAP
        # BTCUSD -> BTC-USD-SWAP
        if symbol.endswith('USDT'):
            base = symbol[:-4]
            return f"{base}-USDT-SWAP"
        elif symbol.endswith('USD'):
            base = symbol[:-3]
            return f"{base}-USD-SWAP"
        else:
            # 其他情況嘗試智能分割
            if len(symbol) > 6:
                return f"{symbol[:-4]}-{symbol[-4:]}-SWAP"
            return f"{symbol}-SWAP"
    
    def _to_okx_symbol(self, symbol: str, trade_type: TradeType) -> str:
        """轉換為 OKX 完整交易對格式
        
        Args:
            symbol: 標準化後的符號 (如 ETH-USDT)
            trade_type: 交易類型（僅支援 LINEAR）
        
        Returns:
            OKX 格式交易對 (合約: ETH-USDT-SWAP)
        """
        if trade_type != TradeType.LINEAR:
            raise ValueError(f"OKX 僅支援合約交易，不支援: {trade_type}")
        
        return self._normalize_symbol(symbol)
    
    def _from_okx_symbol(self, okx_symbol: str) -> str:
        """將 OKX 格式轉回統一格式
        
        Args:
            okx_symbol: OKX 格式 (ETH-USDT-SWAP)
        
        Returns:
            統一格式 (ETHUSDT)
        """
        # 移除 -SWAP 後綴和 - 分隔符
        symbol = okx_symbol.replace('-SWAP', '').replace('-', '')
        return symbol
    
    # ========== 數量單位轉換（顆數 ↔ 張數）==========
    
    def _get_contract_size(self, inst_id: str) -> float:
        """動態獲取合約面值（ctVal）
        
        Args:
            inst_id: OKX 交易對ID，如 "ETH-USDT-SWAP"
        
        Returns:
            float: 每張合約對應的顆數（ctVal）
            
        Examples:
            - ETH-USDT-SWAP: 0.01 (1張 = 0.01 ETH)
            - BTC-USDT-SWAP: 0.01 (1張 = 0.01 BTC)
            - SOL-USDT-SWAP: 1 (1張 = 1 SOL)
        """
        # 如果緩存中有，直接返回
        if inst_id in self._contract_sizes_cache:
            return self._contract_sizes_cache[inst_id]
        
        try:
            # 🔧 修復：直接使用 OKX Public API 獲取合約信息
            # 避免依賴 CCXT 的 load_markets()（已被我們禁用以繞過 parse_market bug）
            response = self._client.public_get_public_instruments({
                'instType': 'SWAP',
                'instId': inst_id
            })
            
            if response and response.get('code') == '0':
                data = response.get('data', [])
                if data and len(data) > 0:
                    ct_val = data[0].get('ctVal', '0.01')
                    contract_size = float(ct_val)
                    self._contract_sizes_cache[inst_id] = contract_size
                    self.logger.debug("okx_contract_size_fetched", 
                                    instId=inst_id, 
                                    ctVal=contract_size)
                    return contract_size
            
            # 如果沒找到，使用默認值 0.01（大多數合約的標準值）
            self.logger.warning("okx_contract_size_not_found", 
                              instId=inst_id, 
                              using_default=0.01,
                              response=response)
            self._contract_sizes_cache[inst_id] = 0.01
            return 0.01
            
        except Exception as e:
            self.logger.error("okx_get_contract_size_failed", 
                            instId=inst_id, 
                            error=str(e))
            # 出錯時使用默認值
            self._contract_sizes_cache[inst_id] = 0.01
            return 0.01
    
    def qty_to_contracts(self, symbol: str, qty: float) -> float:
        """將顆數轉換為張數
        
        Args:
            symbol: 統一格式交易對，如 "ETHUSDT"
            qty: 顆數（實際數量），如 0.1 ETH
        
        Returns:
            float: 張數，如 10.0
            
        Example:
            >>> self.qty_to_contracts("ETHUSDT", 0.1)
            10.0  # 假設 ETH 1張 = 0.01 ETH
        """
        # 轉換為 OKX 格式
        inst_id = self._normalize_symbol(symbol)
        
        # 獲取合約面值
        contract_size = self._get_contract_size(inst_id)
        
        # 計算張數：顆數 ÷ 每張面值
        contracts = qty / contract_size
        
        # 修復浮點數精度問題
        contracts_rounded = round(contracts, 8)
        
        self.logger.debug("okx_qty_to_contracts", 
                         symbol=symbol,
                         qty=qty,
                         contracts=contracts_rounded,
                         ctVal=contract_size)
        
        return contracts_rounded
    
    def contracts_to_qty(self, symbol: str, contracts: float) -> float:
        """將張數轉換為顆數
        
        Args:
            symbol: 統一格式交易對，如 "ETHUSDT"
            contracts: 張數，如 10.0
        
        Returns:
            float: 顆數（實際數量），如 0.1 ETH
            
        Example:
            >>> self.contracts_to_qty("ETHUSDT", 10.0)
            0.1  # 假設 ETH 1張 = 0.01 ETH
        """
        # 轉換為 OKX 格式
        inst_id = self._normalize_symbol(symbol)
        
        # 獲取合約面值
        contract_size = self._get_contract_size(inst_id)
        
        # 計算顆數：張數 × 每張面值
        qty = contracts * contract_size
        
        # 修復浮點數精度問題
        qty_rounded = round(qty, 8)
        
        self.logger.debug("okx_contracts_to_qty",
                         symbol=symbol,
                         contracts=contracts,
                         qty=qty_rounded,
                         ctVal=contract_size)
        
        return qty_rounded
    
    # ========== 市場數據接口 ==========
    
    async def get_ticker(self, symbol: str, trade_type: TradeType = TradeType.LINEAR) -> TickerData:
        """獲取行情數據（僅合約）
        
        優先使用 WebSocket 數據（如果可用），回退到 REST API
        """
        try:
            # 嘗試從 WebSocket 獲取實時數據
            if self.orderbook_feed._running:
                tob = self.orderbook_feed.get_top_of_book(symbol)
                if tob:
                    return TickerData(
                        symbol=symbol,
                        bid_price=tob.bid_price,
                        ask_price=tob.ask_price,
                        last_price=(tob.bid_price + tob.ask_price) / 2,
                        volume_24h=0.0,  # WebSocket 不提供
                        timestamp=int(tob.timestamp * 1000),
                        high_24h=None,
                        low_24h=None,
                        change_24h=None,
                        change_percent_24h=None
                    )
            
            # 回退到 REST API
            # 轉換為 OKX 格式
            okx_symbol = self._to_okx_symbol(symbol, trade_type)
            
            # 使用同步方法（ccxt 內部處理）
            ticker = self._client.fetch_ticker(okx_symbol)
            
            # 返回時使用統一格式
            unified_symbol = self._from_okx_symbol(ticker['symbol'])
            
            # 安全處理時間戳
            timestamp = int(time.time() * 1000)
            if ticker.get('timestamp') is not None:
                try:
                    timestamp = int(ticker.get('timestamp'))
                except (ValueError, TypeError):
                    pass
            
            return TickerData(
                symbol=unified_symbol,
                bid_price=float(ticker.get('bid', 0)),
                ask_price=float(ticker.get('ask', 0)),
                last_price=float(ticker.get('last', 0)),
                volume_24h=float(ticker.get('baseVolume', 0)),
                timestamp=timestamp,
                high_24h=float(ticker.get('high', 0)) or None,
                low_24h=float(ticker.get('low', 0)) or None,
                change_24h=float(ticker.get('change', 0)) or None,
                change_percent_24h=float(ticker.get('percentage', 0)) or None
            )
            
        except Exception as e:
            self.logger.error("okx_get_ticker_failed", symbol=symbol, error=str(e))
            raise
    
    async def get_orderbook(self, symbol: str, limit: int = 25, trade_type: TradeType = TradeType.LINEAR) -> OrderBookData:
        """獲取訂單簿（僅合約）
        
        優先使用 WebSocket 數據（如果可用且 limit=1），回退到 REST API
        """
        try:
            # 如果只需要 1 檔深度且 WebSocket 可用，使用 WebSocket
            if limit == 1 and self.orderbook_feed._running:
                tob = self.orderbook_feed.get_top_of_book(symbol)
                if tob:
                    return OrderBookData(
                        symbol=symbol,
                        bids=[(tob.bid_price, tob.bid_qty)],
                        asks=[(tob.ask_price, tob.ask_qty)],
                        timestamp=int(tob.timestamp * 1000)
                    )
            
            # 回退到 REST API
            if not self._client:
                raise Exception("OKX client not initialized")
            
            okx_symbol = self._to_okx_symbol(symbol, trade_type)
            if not okx_symbol:
                raise Exception(f"Failed to convert symbol: {symbol}")
            
            self.logger.info("okx_fetching_orderbook", 
                           symbol=symbol,
                           okx_symbol=okx_symbol,
                           limit=limit)
            
            # 直接使用REST API，避免ccxt的load_markets bug
            import aiohttp
            async with aiohttp.ClientSession() as session:
                url = f"https://www.okx.com/api/v5/market/books?instId={okx_symbol}&sz={limit}"
                async with session.get(url) as response:
                    if response.status != 200:
                        raise Exception(f"OKX API error: {response.status}")
                    
                    data = await response.json()
                    if data.get('code') != '0':
                        raise Exception(f"OKX API error: {data.get('msg')}")
                    
                    result = data.get('data', [])
                    if not result:
                        raise Exception("No orderbook data returned")
                    
                    book_data = result[0]
                    
                    # 转换为统一格式
                    orderbook = {
                        'bids': [[float(b[0]), float(b[1])] for b in book_data.get('bids', [])],
                        'asks': [[float(a[0]), float(a[1])] for a in book_data.get('asks', [])],
                        'timestamp': int(book_data.get('ts', 0))
                    }
            
            # OKX 格式: [price, quantity, orders_count]，我們只需要前2個
            bids = [(float(item[0]), float(item[1])) for item in orderbook.get('bids', [])]
            asks = [(float(item[0]), float(item[1])) for item in orderbook.get('asks', [])]
            
            # 返回統一格式 symbol
            unified_symbol = self._from_okx_symbol(okx_symbol)
            
            # 安全處理時間戳
            timestamp = int(time.time() * 1000)
            if orderbook.get('timestamp') is not None:
                try:
                    timestamp = int(orderbook.get('timestamp'))
                except (ValueError, TypeError):
                    pass
            
            return OrderBookData(
                symbol=unified_symbol,
                bids=bids,
                asks=asks,
                timestamp=timestamp
            )
            
        except Exception as e:
            self.logger.error("okx_get_orderbook_failed", symbol=symbol, error=str(e))
            raise
    
    async def get_symbols(self, trade_type: TradeType = TradeType.LINEAR) -> List[str]:
        """獲取可用交易對（僅合約，返回統一格式）"""
        try:
            # 🔧 修復：直接使用 OKX Public API 獲取交易對列表
            # 避免依賴 CCXT 的 load_markets()
            response = self._client.public_get_public_instruments({
                'instType': 'SWAP'
            })
            
            symbols = []
            if response and response.get('code') == '0':
                data = response.get('data', [])
                for instrument in data:
                    # 只返回活躍的交易對
                    if instrument.get('state') == 'live':
                        inst_id = instrument.get('instId')
                        # 轉換為統一格式（ETH-USDT-SWAP -> ETHUSDT）
                        if inst_id and '-USDT-SWAP' in inst_id:
                            base = inst_id.replace('-USDT-SWAP', '')
                            unified_symbol = f"{base}USDT"
                            symbols.append(unified_symbol)
            
            self.logger.info("okx_symbols_fetched", count=len(symbols))
            return symbols
            
        except Exception as e:
            self.logger.error("okx_get_symbols_failed", trade_type=trade_type.value, error=str(e))
            raise
    
    # ========== 交易接口 ==========
    
    async def place_order(
        self, 
        symbol: str, 
        side: OrderSide, 
        quantity: float,
        order_type: OrderType = OrderType.MARKET,
        price: Optional[float] = None,
        trade_type: TradeType = TradeType.LINEAR,
        **kwargs
    ) -> OrderResult:
        """下單（僅合約）- 使用直接 OKX API
        
        OKX 特定參數：
        - tdMode: 'cross'（全倉）
        - posSide: 'net'（單向持倉）
        """
        try:
            self._check_authentication()
            
            # OKX 僅支援合約
            if trade_type != TradeType.LINEAR:
                raise ValueError(f"OKX 僅支援合約交易，不支援: {trade_type}")
            
            # 轉換為 OKX 格式
            okx_symbol = self._to_okx_symbol(symbol, trade_type)
            self._validate_quantity(quantity)
            if order_type == OrderType.LIMIT:
                self._validate_price(price)
            
            # 獲取產品信息
            try:
                instrument_info = await self._get_instrument_info(okx_symbol)
                self.logger.debug("okx_instrument_info", 
                                ctVal=instrument_info.get('ctVal'),
                                lotSz=instrument_info.get('lotSz'),
                                minSz=instrument_info.get('minSz'))
            except Exception as e:
                self.logger.warning("okx_get_instrument_info_failed", error=str(e))
                # 使用默認值
                instrument_info = {
                    'ctVal': '0.1',
                    'lotSz': '1',
                    'minSz': '1'
                }
            
            # 轉換數量為張數
            contracts = self._convert_quantity_to_contracts(
                quantity=quantity,
                ct_val=instrument_info.get('ctVal', '0.1'),
                lot_sz=instrument_info.get('lotSz', '1'),
                min_sz=instrument_info.get('minSz', '1')
            )
            
            # 轉換訂單參數
            side_str = "buy" if side == OrderSide.BUY else "sell"
            ord_type = "market" if order_type == OrderType.MARKET else "limit"
            
            # 記錄下單參數
            self.logger.info("okx_place_order_params",
                           symbol=okx_symbol,
                           side=side_str,
                           type=ord_type,
                           quantity_in_coins=quantity,
                           quantity_in_contracts=contracts,
                           trade_type=trade_type.value)
            
            # 構建訂單參數
            order_params = {
                "instId": okx_symbol,
                "tdMode": "cross",           # 全倉模式
                "side": side_str,            # 買入/賣出
                "ordType": ord_type,         # 市價單/限價單
                "sz": contracts,             # 張數
                "posSide": "net"             # 單向持倉模式
            }
            

            # 生成時間戳和簽名
            timestamp = datetime.utcnow().isoformat(timespec='milliseconds') + 'Z'
            body = json.dumps(order_params)
            
            # 發送訂單請求
            endpoint = "/api/v5/trade/order"
            async with aiohttp.ClientSession() as session:
                async with session.post(
                    f"{self._base_url}{endpoint}",
                    headers=self._get_headers(timestamp, body),
                    data=body
                ) as response:
                    response_text = await response.text()
                    result = json.loads(response_text)
                    
                    if result.get('code') == '0':
                        # 訂單成功
                        order_data = result['data'][0] if result.get('data') else {}
                        order_id = order_data.get('ordId', '')
                        
                        self.logger.info("okx_order_created",
                                       order_id=order_id,
                                       symbol=symbol,
                                       sCode=order_data.get('sCode'),
                                       sMsg=order_data.get('sMsg'))
                        
                        # 對於市價單，嘗試獲取成交價格
                        fill_price = None
                        if order_type == OrderType.MARKET:
                            # 短暫延遲後查詢訂單狀態
                            import asyncio
                            try:
                                # 這裡可以添加查詢訂單狀態的邏輯
                                fill_price = price  # 暫時使用傳入價格
                            except Exception as e:
                                self.logger.warning("okx_get_fill_price_failed", error=str(e))
                        
                        return OrderResult(
                            success=True,
                            order_id=order_id,
                            price=fill_price,
                            quantity=quantity,
                            timestamp=int(time.time() * 1000)
                        )
                    else:
                        # 訂單失敗
                        error_msg = result.get('msg', 'Unknown error')
                        self.logger.error("okx_place_order_failed",
                                        symbol=symbol,
                                        side=side.value,
                                        quantity=quantity,
                                        error=error_msg,
                                        code=result.get('code'))
                        
                        return OrderResult(
                            success=False,
                            error_message=f"OKX API Error: {error_msg}"
                        )
            
        except Exception as e:
            self.logger.error("okx_place_order_failed", 
                            symbol=symbol, 
                            side=side.value, 
                            quantity=quantity, 
                            error=str(e))
            return OrderResult(
                success=False,
                error_message=str(e)
            )
    
    async def cancel_order(self, symbol: str, order_id: str, trade_type: TradeType = TradeType.LINEAR) -> bool:
        """取消訂單（僅合約）"""
        try:
            self._check_authentication()
            okx_symbol = self._to_okx_symbol(symbol, trade_type)
            
            self._client.cancel_order(order_id, okx_symbol)
            return True
            
        except Exception as e:
            self.logger.error("okx_cancel_order_failed", 
                            symbol=symbol, 
                            order_id=order_id, 
                            error=str(e))
            return False
    
    async def get_order_status(self, symbol: str, order_id: str, trade_type: TradeType = TradeType.LINEAR) -> Dict[str, Any]:
        """查詢訂單狀態（僅合約）"""
        try:
            self._check_authentication()
            okx_symbol = self._to_okx_symbol(symbol, trade_type)
            
            order = self._client.fetch_order(order_id, okx_symbol)
            return order
                
        except Exception as e:
            self.logger.error("okx_get_order_status_failed", 
                            symbol=symbol, 
                            order_id=order_id, 
                            error=str(e))
            raise
    
    async def get_fill_price(self, order_id: str, symbol: str, trade_type: TradeType = TradeType.LINEAR) -> Optional[float]:
        """查詢訂單實際成交價格（僅合約）
        
        OKX 市價單成交後，成交價格可能需要通過以下方式獲取：
        1. 訂單的 average 字段（最可靠）
        2. 從 cost / filled 計算
        3. 查詢成交記錄（trades）
        """
        try:
            order = await self.get_order_status(symbol, order_id, trade_type)
            
            # 方法1: 優先使用 average 字段（成交均價）
            avg_price = order.get('average')
            if avg_price is not None and avg_price != 0:
                try:
                    avg_price_float = float(avg_price)
                    if avg_price_float > 0:
                        self.logger.info("okx_fill_price_from_average",
                                       order_id=order_id,
                                       price=avg_price_float)
                        return avg_price_float
                except (ValueError, TypeError):
                    pass
            
            # 方法2: 從 cost 和 filled 計算平均價格
            filled = 0
            cost = 0
            if order.get('filled') is not None:
                try:
                    filled = float(order.get('filled'))
                except (ValueError, TypeError):
                    pass
            
            if order.get('cost') is not None:
                try:
                    cost = float(order.get('cost'))
                except (ValueError, TypeError):
                    pass
            
            if filled > 0 and cost > 0:
                calculated_price = cost / filled
                self.logger.info("okx_fill_price_calculated",
                               order_id=order_id,
                               price=calculated_price,
                               filled=filled,
                               cost=cost)
                return calculated_price
            
            # 方法3: 查詢成交記錄（trades）
            try:
                okx_symbol = self._to_okx_symbol(symbol, trade_type)
                trades = self._client.fetch_my_trades(okx_symbol, params={'ordId': order_id})
                
                if trades and len(trades) > 0:
                    # 計算加權平均價格
                    total_cost = 0
                    total_amount = 0
                    for trade in trades:
                        if trade.get('price') and trade.get('amount'):
                            try:
                                price = float(trade['price'])
                                amount = float(trade['amount'])
                                total_cost += price * amount
                                total_amount += amount
                            except (ValueError, TypeError):
                                continue
                    
                    if total_amount > 0:
                        weighted_avg_price = total_cost / total_amount
                        self.logger.info("okx_fill_price_from_trades",
                                       order_id=order_id,
                                       price=weighted_avg_price,
                                       trades_count=len(trades))
                        return weighted_avg_price
            except Exception as e:
                self.logger.warning("okx_fetch_trades_failed",
                                  order_id=order_id,
                                  error=str(e))
            
            # 方法4: 最後回退，使用訂單的 price 字段（可能是限價）
            price = order.get('price')
            if price is not None and price != 0:
                try:
                    price_float = float(price)
                    if price_float > 0:
                        self.logger.warning("okx_fill_price_from_order_price",
                                          order_id=order_id,
                                          price=price_float,
                                          message="使用訂單價格作為回退，可能不準確")
                        return price_float
                except (ValueError, TypeError):
                    pass
            
            self.logger.error("okx_fill_price_not_found",
                            order_id=order_id,
                            symbol=symbol,
                            order_data=order)
            return None
            
        except Exception as e:
            self.logger.error("okx_get_fill_price_failed", 
                            order_id=order_id,
                            symbol=symbol,
                            error=str(e))
            return None
    
    # ========== 帳戶接口 ==========
    
    async def get_balances(self) -> List[Balance]:
        """獲取合約帳戶餘額
        
        OKX 合約帳戶使用 fetch_balance({'type': 'swap'})
        """
        try:
            self._check_authentication()
            
            self.logger.info("okx_fetching_balance", account_type="swap")
            
            # 獲取合約帳戶餘額
            balance_data = self._client.fetch_balance({'type': 'swap'})
            
            self.logger.info("okx_balance_fetched", 
                           keys=list(balance_data.keys()) if balance_data else [],
                           has_total=bool(balance_data.get('total')),
                           has_free=bool(balance_data.get('free')),
                           has_used=bool(balance_data.get('used')))
            
            balances = []
            
            # 處理 USDT 餘額
            if 'USDT' in balance_data.get('total', {}):
                usdt_total = float(balance_data['total'].get('USDT', 0))
                usdt_free = float(balance_data.get('free', {}).get('USDT', 0))
                usdt_used = float(balance_data.get('used', {}).get('USDT', 0))
                
                if usdt_total > 0 or usdt_used > 0:
                    balances.append(Balance(
                        asset='USDT',
                        free=usdt_free,
                        locked=usdt_used,
                        borrowed=0.0,
                        interest=0.0,
                        usdt_value=usdt_total
                    ))
            
            # 處理其他幣種（如果有）
            for currency, total_balance in balance_data.get('total', {}).items():
                if currency == 'USDT':
                    continue
                
                total = float(total_balance)
                if total > 0:
                    balances.append(Balance(
                        asset=currency,
                        free=float(balance_data.get('free', {}).get(currency, 0)),
                        locked=float(balance_data.get('used', {}).get(currency, 0)),
                        borrowed=0.0,
                        interest=0.0
                    ))
            
            self.logger.info("okx_balances_parsed", count=len(balances))
            return balances
            
        except Exception as e:
            self.logger.error("okx_get_balances_failed", error=str(e))
            import traceback
            self.logger.error("okx_get_balances_traceback", traceback=traceback.format_exc())
            # 返回空列表而不是拋出異常，讓帳戶摘要可以繼續
            return []
    
    async def get_positions(self) -> List[Position]:
        """獲取合約持倉"""
        try:
            self._check_authentication()
            
            self.logger.info("okx_fetching_positions")
            
            # 獲取所有合約持倉
            positions_data = self._client.fetch_positions()
            # print("--------------------------------")
            # print("okx_positions_data", positions_data)
            self.logger.info("okx_positions_fetched", 
                           count=len(positions_data) if positions_data else 0,
                           type=type(positions_data).__name__)
            
            positions = []
            
            for pos in positions_data:
                raw_info = pos.get('info', {}) if isinstance(pos, dict) else {}
                # OKX 返回的是張數（contracts），需要安全處理
                contracts = 0
                if pos.get('contracts') is not None:
                    try:
                        contracts = float(pos.get('contracts'))
                    except (ValueError, TypeError):
                        self.logger.warning("okx_invalid_contracts", 
                                          symbol=pos.get('symbol'),
                                          contracts=pos.get('contracts'))
                        continue
                
                # 只處理有持倉的記錄
                if contracts == 0:
                    continue
                
                # 解析方向
                side = pos.get('side', 'long')
                if side not in ['long', 'short']:
                    # ccxt 可能返回 'buy' 或 'sell'
                    side = 'long' if side == 'buy' else 'short'
                
                # 解析交易對
                symbol_raw = pos.get('symbol', '')
                base_asset = symbol_raw.split('/')[0] if '/' in symbol_raw else symbol_raw.replace('-USDT-SWAP', '')
                
                # 安全處理各種價格和數量
                entry_price = 0
                if pos.get('entryPrice') is not None:
                    try:
                        entry_price = float(pos.get('entryPrice'))
                    except (ValueError, TypeError):
                        pass
                
                mark_price = 0
                if pos.get('markPrice') is not None:
                    try:
                        mark_price = float(pos.get('markPrice'))
                    except (ValueError, TypeError):
                        if pos.get('lastPrice') is not None:
                            try:
                                mark_price = float(pos.get('lastPrice'))
                            except (ValueError, TypeError):
                                pass
                
                unrealized_pnl = 0
                if pos.get('unrealizedPnl') is not None:
                    try:
                        unrealized_pnl = float(pos.get('unrealizedPnl'))
                    except (ValueError, TypeError):
                        pass
                
                # 提取已實現盈虧：OKX 官方說明 realizedPnl = pnl + fee + fundingFee + liqPenalty + settledPnl
                reported_realized = self._extract_numeric(pos, ["realizedPnl"])
                pnl_component = {
                    "pnl": self._extract_numeric(pos, ["pnl"]),
                    "tradingFee": self._extract_numeric(pos, ["fee"]),
                    "fundingFee": self._extract_numeric(pos, ["fundingFee"]),
                    "liquidationPenalty": self._extract_numeric(pos, ["liqPenalty"]),
                    "settledPnl": self._extract_numeric(pos, ["settledPnl"]),
                }
                components_sum = sum(pnl_component.values())
                realized_pnl = reported_realized if reported_realized != 0.0 else components_sum
                if realized_pnl == 0.0:
                    # 若官方欄位為零但個別組件有值，仍以組件總和為準
                    for value in pnl_component.values():
                        if value != 0.0:
                            realized_pnl = components_sum
                            break
                realized_details = {}
                if realized_pnl != 0.0 or reported_realized != 0.0 or components_sum != 0.0:
                    realized_details["total"] = realized_pnl
                    if reported_realized != 0.0:
                        realized_details["reportedRealizedPnl"] = reported_realized
                    for key, value in pnl_component.items():
                        if value != 0.0:
                            realized_details[key] = value
                
                leverage = 1.0
                if pos.get('leverage') is not None:
                    try:
                        leverage = float(pos.get('leverage'))
                    except (ValueError, TypeError):
                        pass

                margin_mode_raw = (
                    pos.get('marginMode')
                    or pos.get('mgnMode')
                    or raw_info.get('mgnMode')
                    or "cross"
                )
                margin_mode_lower = str(margin_mode_raw).lower()
                if margin_mode_lower.startswith("isolated"):
                    margin_mode_value = "isolated"
                else:
                    margin_mode_value = "cross"
                margin_usdt = self._extract_numeric(pos, ["margin", "posMargin", "initialMargin"])
                if margin_usdt == 0.0:
                    margin_usdt = self._extract_numeric(raw_info, ["margin", "posMargin", "imr"])
                
                liquidation_price = None
                if pos.get('liquidationPrice') is not None:
                    try:
                        liquidation_price = float(pos.get('liquidationPrice'))
                        if liquidation_price == 0:
                            liquidation_price = None
                    except (ValueError, TypeError):
                        pass
                
                # 🔥 關鍵：將張數（contracts）轉回顆數（qty）
                # OKX 持倉返回的是張數，系統需要顆數
                unified_symbol = self._from_okx_symbol(symbol_raw)
                size_in_coins = self.contracts_to_qty(unified_symbol, abs(contracts))
                
                # 記錄持倉信息（用於調試）
                self.logger.debug("okx_position_parsed",
                                symbol=symbol_raw,
                                side=side,
                                size_contracts=abs(contracts),
                                size_coins=size_in_coins,
                                entry_price=entry_price,
                                unrealized_pnl=unrealized_pnl,
                                realized_pnl=realized_pnl)
                
                positions.append(Position(
                    symbol=unified_symbol,
                    base_asset=base_asset,
                    quote_asset='USDT',
                    position_type="perp_linear",
                    side=side,
                    size=size_in_coins,  # 🔥 使用顆數，而不是張數
                    entry_price=entry_price,
                    mark_price=mark_price,
                    unrealized_pnl=unrealized_pnl,
                    realized_pnl=realized_pnl,
                    realized_pnl_details=realized_details,
                    leverage=leverage,
                    margin_mode=margin_mode_value,
                    margin_usdt=margin_usdt,
                    liquidation_price=liquidation_price
                ))
            
            self.logger.info("okx_positions_parsed", count=len(positions))
            return positions
            
        except Exception as e:
            self.logger.error("okx_get_positions_failed", error=str(e))
            import traceback
            self.logger.error("okx_get_positions_traceback", traceback=traceback.format_exc())
            # 返回空列表而不是拋出異常
            return []
    
    async def get_account_summary(self) -> AccountSummary:
        """獲取帳戶摘要（僅合約）
        
        獲取維持保證金率（MMR）和維持保證金數據
        """
        try:
            self._check_authentication()
            
            # 獲取餘額和持倉（已在初始化時處理了 load_markets 錯誤）
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
                        self.logger.debug("okx_fill_funding_rate_failed", 
                                        symbol=pos.symbol, 
                                        error=str(e))
            
            # 使用 fetch_balance 獲取完整帳戶數據（包含 MMR）
            # 由於已在初始化時處理了 markets 加載問題，這裡應該不會報錯
            try:
                account_data = self._client.fetch_balance({'type': 'swap'})
            except Exception as balance_error:
                # 如果還是失敗，使用空數據繼續
                self.logger.warning("okx_fetch_balance_fallback", error=str(balance_error))
                account_data = {'info': {'data': []}}
            
            # 從 info 中提取 MMR 數據
            info = account_data.get('info', {})
            data_list = info.get('data', [])
            
            # OKX API 返回格式: {data: [{...}]}
            account_info = data_list[0] if data_list else {}
            
            # 安全轉換函數
            def safe_float(value, default=0.0):
                """安全轉換為 float"""
                if value is None or value == '':
                    return default
                try:
                    return float(value)
                except (ValueError, TypeError):
                    return default
            
            # ⚠️ 重要：MMR 數據在 details 中，不在最外層
            # 最外層的 mmr/imr/mgnRatio 通常是空字符串
            details = account_info.get('details', [])
            usdt_detail = None
            
            # 找到 USDT 的詳細數據
            for detail in details:
                if detail.get('ccy') == 'USDT':
                    usdt_detail = detail
                    break
            
            if usdt_detail:
                # 從 USDT details 中提取 MMR 數據
                mmr = safe_float(usdt_detail.get('mmr'))  # 維持保證金
                imr = safe_float(usdt_detail.get('imr'))  # 初始保證金
                mgn_ratio_str = usdt_detail.get('mgnRatio', '')  # 維持保證金率
            else:
                # 回退到最外層（可能為空）
                mmr = safe_float(account_info.get('mmr'))
                imr = safe_float(account_info.get('imr'))
                mgn_ratio_str = account_info.get('mgnRatio', '')
            
            total_eq = safe_float(account_info.get('totalEq'))  # 總權益
            
            # 計算維持保證金率（轉換為 Bybit 格式，返回小數 0-1）
            # OKX: mgnRatio = (totalEq / mmr)，例如 38.44 = 總權益是維持保證金的 38.44 倍
            # Bybit: MMR = (mmr / totalEq)，例如 0.026 = 2.6% = 維持保證金占總權益的 2.6%
            # 轉換公式: Bybit_MMR = 1 / OKX_mgnRatio
            maintenance_margin_rate = 0.0
            if mgn_ratio_str and mgn_ratio_str != '':
                try:
                    okx_mgn_ratio = float(mgn_ratio_str)
                    if okx_mgn_ratio > 0:
                        # 🔥 修正：OKX mgnRatio 是倍數（totalEq/mmr），不是百分比
                        # 轉換為 Bybit 格式（小數形式）：維持保證金率 = 1 / mgnRatio
                        maintenance_margin_rate = 1.0 / okx_mgn_ratio
                except (ValueError, TypeError):
                    pass
            elif total_eq > 0 and mmr > 0:
                # 備用計算：(mmr / totalEq)，返回小數形式
                maintenance_margin_rate = (mmr / total_eq) if total_eq > 0 else 0.0
            
            # 計算總權益
            total_equity = sum(b.free + b.locked for b in balances if b.asset == 'USDT')
            
            # 加上未實現盈虧
            total_unrealized_pnl = sum(p.unrealized_pnl for p in positions)
            total_equity += total_unrealized_pnl
            
            # 計算總保證金
            total_margin = sum(p.margin_usdt for p in positions) if positions else 0.0
            
            # 計算可用餘額
            available_balance = sum(b.free for b in balances if b.asset == 'USDT')
            
            self.logger.info("okx_account_summary_mmr",
                           mmr=mmr,
                           imr=imr,
                           total_eq=total_eq,
                           mgn_ratio=mgn_ratio_str,
                           calculated_mmr=maintenance_margin_rate)
            
            return AccountSummary(
                exchange="okx",
                account_mode="classic",  # OKX 使用經典帳戶模式（全倉）
                timestamp=int(time.time() * 1000),
                total_equity_usdt=total_equity,
                total_margin_usdt=total_margin,
                available_balance_usdt=available_balance,
                maintenance_margin_rate=maintenance_margin_rate,  # 添加 MMR
                total_initial_margin=imr,  # 添加初始保證金
                total_maintenance_margin=mmr,  # 添加維持保證金
                balances=balances,
                positions=positions,
                unsupported_reason=None  # 完全支援
            )
            
        except Exception as e:
            self.logger.error("okx_get_account_summary_failed", error=str(e))
            import traceback
            self.logger.error("okx_get_account_summary_traceback", traceback=traceback.format_exc())
            
            return AccountSummary(
                exchange="okx",
                account_mode="unsupported",
                timestamp=int(time.time() * 1000),
                unsupported_reason=f"獲取帳戶摘要失敗: {str(e)}"
            )
    
    async def get_funding_rates(self, symbols: List[str] = None) -> List[FundingRate]:
        """獲取資金費率（僅合約）"""
        try:
            rates = []
            
            if symbols:
                for symbol in symbols:
                    try:
                        okx_symbol = self._to_okx_symbol(symbol, TradeType.LINEAR)
                        funding = self._client.fetch_funding_rate(okx_symbol)

                        # 從 CCXT 返回的標準字段獲取時間戳
                        timestamp = funding.get('timestamp')
                        if not timestamp:
                            # 如果標準字段沒有，嘗試從 fundingTimestamp 獲取
                            timestamp = funding.get('fundingTimestamp', int(time.time() * 1000))
                        
                        funding_rate = float(funding.get('fundingRate', 0))
                        fundingTime = funding.get('fundingTimestamp', 0)  # 當前資金費率時間
                        nextFundingTime = funding.get('nextFundingTimestamp', 0)  # 下次資金費率時間
                        
                        # 計算結算週期（小時）
                        if fundingTime == 0 or nextFundingTime == 0:
                            # 如果時間戳缺失，使用 OKX 默認的 8 小時週期
                            settlement_interval = 8
                            self.logger.warning("okx_funding_time_missing", 
                                              symbol=symbol,
                                              funding_time=fundingTime,
                                              next_funding_time=nextFundingTime)
                        else:
                            # 計算兩次結算之間的小時數
                            settlement_interval = int((nextFundingTime - fundingTime) / (1000 * 60 * 60))
                            
                            # 驗證結算週期是否合理（OKX 通常是 8 小時）
                            if settlement_interval <= 0 or settlement_interval > 24:
                                self.logger.warning("okx_invalid_settlement_interval",
                                                  symbol=symbol,
                                                  calculated_interval=settlement_interval,
                                                  funding_time=fundingTime,
                                                  next_funding_time=nextFundingTime)
                                settlement_interval = 8  # 使用默認值

                        # 計算標準化費率
                        funding_rate_8h = funding_rate * (8 / settlement_interval) if settlement_interval > 0 else funding_rate
                        funding_rate_daily = funding_rate * (24 / settlement_interval) if settlement_interval > 0 else funding_rate * 3
                        
                        rates.append(FundingRate(
                            exchange="okx",
                            symbol=self._from_okx_symbol(funding['symbol']),
                            category="linear",
                            funding_rate=funding_rate,
                            funding_rate_8h=funding_rate_8h,  # 標準化為 8 小時費率
                            funding_rate_daily=funding_rate_daily,  # 標準化為每日費率
                            next_funding_time=fundingTime, # 當前資金費率時間,nextFundingTime是下下次資金費率時間
                            settlement_interval_hours=settlement_interval,  # 從 API 獲取的實際結算週期
                            timestamp=int(time.time() * 1000)
                        ))
                    except Exception as e:
                        self.logger.warning("okx_get_funding_rate_skip", 
                                          symbol=symbol, 
                                          error=str(e))
            return rates
            
        except Exception as e:
            self.logger.error("okx_get_funding_rates_failed", error=str(e))
            return []
    
    async def check_account_mode(self) -> Tuple[str, bool]:
        """檢查帳戶模式
        
        OKX 使用經典帳戶模式（全倉），返回 classic
        """
        return ("classic", False)
    
    # ========== 健康檢查 ==========
    
    async def ping(self) -> bool:
        """檢查連接狀態"""
        try:
            self._client.fetch_time()
            return True
        except Exception:
            return False
    
    async def get_server_time(self) -> int:
        """獲取服務器時間"""
        try:
            return self._client.fetch_time()
        except Exception as e:
            self.logger.error("okx_get_server_time_failed", error=str(e))
            return 0
