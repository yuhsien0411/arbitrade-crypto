"""
交易所抽象基類
定義統一的交易所接口
"""

from abc import ABC, abstractmethod
from typing import Optional, List, Dict, Any, Tuple
from dataclasses import dataclass
from enum import Enum


class OrderSide(Enum):
    """訂單方向"""
    BUY = "buy"
    SELL = "sell"


class OrderType(Enum):
    """訂單類型"""
    MARKET = "market"
    LIMIT = "limit"


class TradeType(Enum):
    """交易類型"""
    SPOT = "spot"
    LINEAR = "linear"
    INVERSE = "inverse"


class AccountMode(Enum):
    """帳戶模式"""
    UNIFIED = "unified"
    CLASSIC = "classic"
    PORTFOLIO = "portfolio"
    UNSUPPORTED = "unsupported"


@dataclass
class OrderResult:
    """訂單執行結果"""
    success: bool
    order_id: Optional[str] = None
    price: Optional[float] = None
    quantity: Optional[float] = None
    error_message: Optional[str] = None
    
    # 額外資訊
    fee: Optional[float] = None
    fee_currency: Optional[str] = None
    timestamp: Optional[int] = None


@dataclass
class TickerData:
    """行情數據"""
    symbol: str
    bid_price: float
    ask_price: float
    last_price: float
    volume_24h: float
    timestamp: int
    
    # 額外資訊
    high_24h: Optional[float] = None
    low_24h: Optional[float] = None
    change_24h: Optional[float] = None
    change_percent_24h: Optional[float] = None


@dataclass
class OrderBookData:
    """訂單簿數據"""
    symbol: str
    bids: List[Tuple[float, float]]  # [(price, quantity), ...]
    asks: List[Tuple[float, float]]  # [(price, quantity), ...]
    timestamp: int
    
    @property
    def best_bid(self) -> Optional[Tuple[float, float]]:
        """最佳買價"""
        return self.bids[0] if self.bids else None
    
    @property
    def best_ask(self) -> Optional[Tuple[float, float]]:
        """最佳賣價"""
        return self.asks[0] if self.asks else None
    
    @property
    def spread(self) -> Optional[float]:
        """價差"""
        if self.best_bid and self.best_ask:
            return self.best_ask[0] - self.best_bid[0]
        return None
    
    @property
    def spread_percent(self) -> Optional[float]:
        """價差百分比"""
        if self.best_bid and self.best_ask and self.best_bid[0] > 0:
            return (self.spread / self.best_bid[0]) * 100
        return None


@dataclass
class Balance:
    """餘額資訊"""
    asset: str
    free: float
    locked: float
    borrowed: float = 0.0
    interest: float = 0.0
    interest_rate_daily: float = 0.0
    usdt_value: float = 0.0
    
    @property
    def total(self) -> float:
        """總額 = walletBalance（錢包總餘額）
        
        對於統一帳戶（如 Bybit、Binance）：
        - free 是餘額 = walletBalance - borrowAmount（錢包目前擁有的幣數）
        - borrowed 是借幣
        - locked 是鎖定
        - 總額 = walletBalance = free + borrowed + locked
        
        對於經典帳戶：
        - free 是可用餘額（錢包目前擁有的幣數）
        - 總額 = 可用餘額 + 鎖定 = free + locked
        
        🔥 支持负数：如果余额为负（做空），总额也可以是负数
        """
        # 🔥 修正：總額 = walletBalance = 餘額 + 借幣 + 鎖定
        # 因為 free = walletBalance - borrowAmount，所以 total = free + borrowed + locked = walletBalance + locked
        # 但根據用戶說明，總額 = walletBalance，所以如果 locked = 0，則 total = walletBalance
        # 為了保持一致性，我們使用 free + borrowed + locked
        if self.borrowed > 0:
            # 統一帳戶：總額 = 餘額 + 借幣 + 鎖定 = walletBalance + locked
            return self.free + self.borrowed + self.locked
        else:
            # 經典帳戶或無借幣：總額 = 可用餘額 + 鎖定
            return self.free + self.locked
    
    @property
    def net_balance(self) -> float:
        """餘額（錢包目前擁有的幣數）
        
        對於統一帳戶（如 Bybit、Binance）：
        - free 已經是餘額 = walletBalance - borrowAmount（錢包目前擁有的幣數）
        
        對於經典帳戶：
        - 餘額 = free（可用餘額，錢包目前擁有的幣數）
        
        🔥 free 字段已經存儲了餘額（錢包目前擁有的幣數），直接返回即可
        """
        return self.free


@dataclass
class Position:
    """持倉資訊"""
    symbol: str
    base_asset: str
    quote_asset: str
    position_type: str  # "spot_cash" | "spot_margin" | "perp_linear" | "perp_inverse" | "futures_linear" | "futures_inverse"
    side: str  # "long" | "short"
    size: float
    entry_price: float
    mark_price: float
    unrealized_pnl: float
    realized_pnl: float = 0.0  # 已實現盈虧
    leverage: float = 1.0
    margin_mode: str = "cross"
    margin_usdt: float = 0.0
    liquidation_price: Optional[float] = None
    funding_rate_8h: Optional[float] = None
    next_funding_time: Optional[int] = None
    realized_pnl_details: Optional[Dict[str, float]] = None
    
    @property
    def notional_value(self) -> float:
        """名義價值"""
        return abs(self.size) * self.mark_price
    
    @property
    def estimated_carry_8h(self) -> float:
        """8小時持有成本/收益估算（已移除，返回 0）"""
        return 0.0


@dataclass
class FundingRate:
    """資金費率資訊"""
    exchange: str
    symbol: str
    category: str  # "linear" | "inverse"
    funding_rate: float
    funding_rate_8h: float
    funding_rate_daily: float
    next_funding_time: int
    predicted_funding_rate: Optional[float] = None
    settlement_interval_hours: int = 8  # 結算週期（小時），例如 8 表示每 8 小時結算一次
    timestamp: int = 0


@dataclass
class BorrowingRate:
    """借幣利率資訊（槓桿現貨）"""
    exchange: str
    asset: str  # 資產名稱（如：USDT, BTC, ETH）
    interest_rate_hourly: float  # 小時利率
    interest_rate_daily: float  # 日利率
    timestamp: int = 0


@dataclass
class AccountSummary:
    """帳戶摘要"""
    exchange: str
    account_mode: str  # "unified" | "unsupported"
    timestamp: int
    total_equity_usdt: float = 0.0
    total_margin_usdt: float = 0.0
    available_balance_usdt: float = 0.0
    margin_ratio: float = 0.0
    maintenance_margin_rate: float = 0.0  # 維持保證金率
    total_initial_margin: float = 0.0     # 總初始保證金
    total_maintenance_margin: float = 0.0 # 總維持保證金
    balances: List[Balance] = None
    positions: List[Position] = None
    unsupported_reason: Optional[str] = None
    
    def __post_init__(self):
        if self.balances is None:
            self.balances = []
        if self.positions is None:
            self.positions = []


class BaseExchange(ABC):
    """交易所抽象基類"""
    
    def __init__(self, api_key: str = "", api_secret: str = "", testnet: bool = False):
        self.api_key = api_key
        self.api_secret = api_secret
        self.testnet = testnet
        self._authenticated = bool(api_key and api_secret)
    
    @property
    @abstractmethod
    def name(self) -> str:
        """交易所名稱"""
        pass
    
    @property
    def is_authenticated(self) -> bool:
        """是否已認證（有API密鑰）"""
        return self._authenticated
    
    # 市場數據接口（公開）
    
    @abstractmethod
    async def get_ticker(self, symbol: str, trade_type: TradeType = TradeType.SPOT) -> TickerData:
        """獲取行情數據"""
        pass
    
    @abstractmethod
    async def get_orderbook(self, symbol: str, limit: int = 25, trade_type: TradeType = TradeType.SPOT) -> OrderBookData:
        """獲取訂單簿"""
        pass
    
    @abstractmethod
    async def get_symbols(self, trade_type: TradeType = TradeType.SPOT) -> List[str]:
        """獲取可用交易對"""
        pass
    
    # 交易接口（需要認證）
    
    @abstractmethod
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
        pass
    
    @abstractmethod
    async def cancel_order(self, symbol: str, order_id: str, trade_type: TradeType = TradeType.SPOT) -> bool:
        """取消訂單"""
        pass
    
    @abstractmethod
    async def get_order_status(self, symbol: str, order_id: str, trade_type: TradeType = TradeType.SPOT) -> Dict[str, Any]:
        """查詢訂單狀態"""
        pass
    
    @abstractmethod
    async def get_fill_price(self, order_id: str, symbol: str, trade_type: TradeType = TradeType.SPOT) -> Optional[float]:
        """查詢訂單實際成交價格"""
        pass
    
    # 帳戶接口（需要認證）
    
    @abstractmethod
    async def get_balances(self) -> List[Balance]:
        """獲取餘額"""
        pass
    
    @abstractmethod
    async def get_positions(self) -> List[Position]:
        """獲取持倉（合約）"""
        pass
    
    @abstractmethod
    async def get_account_summary(self) -> AccountSummary:
        """獲取帳戶摘要（統一格式）"""
        pass
    
    @abstractmethod
    async def get_funding_rates(self, symbols: List[str] = None) -> List[FundingRate]:
        """獲取資金費率"""
        pass
    
    async def get_borrowing_rates(self, assets: List[str] = None) -> List['BorrowingRate']:
        """獲取借幣利率（槓桿現貨）
        
        默認實現返回空列表，子類可覆蓋實現
        只有支援現貨槓桿的交易所才需要實現此方法
        """
        return []
    
    @abstractmethod
    async def check_account_mode(self) -> Tuple[str, bool]:
        """檢查帳戶模式
        Returns:
            (account_mode, is_supported)
            - account_mode: 'unified' | 'classic' | 'portfolio'
            - is_supported: True if unified account
        """
        pass
    
    # 工具方法
    
    def _check_authentication(self):
        """檢查是否已認證"""
        if not self.is_authenticated:
            raise ValueError(f"{self.name} 需要 API 密鑰進行認證")
    
    def _normalize_symbol(self, symbol: str) -> str:
        """標準化交易對符號"""
        return symbol.upper().strip()
    
    def _validate_quantity(self, quantity: float):
        """驗證數量"""
        if quantity <= 0:
            raise ValueError("數量必須大於 0")
    
    def _validate_price(self, price: Optional[float]):
        """驗證價格"""
        if price is not None and price <= 0:
            raise ValueError("價格必須大於 0")
    
    # 健康檢查
    
    @abstractmethod
    async def ping(self) -> bool:
        """檢查連接狀態"""
        pass
    
    @abstractmethod
    async def get_server_time(self) -> int:
        """獲取服務器時間"""
        pass
    
    # 批量操作
    
    async def get_multiple_tickers(self, symbols: List[str], trade_type: TradeType = TradeType.SPOT) -> Dict[str, TickerData]:
        """批量獲取行情（默認實現，子類可覆蓋優化）"""
        results = {}
        for symbol in symbols:
            try:
                ticker = await self.get_ticker(symbol, trade_type)
                results[symbol] = ticker
            except Exception as e:
                # 記錄錯誤但繼續處理其他符號
                print(f"獲取 {symbol} 行情失敗: {e}")
        return results
    
    async def get_multiple_orderbooks(self, symbols: List[str], limit: int = 25, trade_type: TradeType = TradeType.SPOT) -> Dict[str, OrderBookData]:
        """批量獲取訂單簿（默認實現，子類可覆蓋優化）"""
        results = {}
        for symbol in symbols:
            try:
                orderbook = await self.get_orderbook(symbol, limit, trade_type)
                results[symbol] = orderbook
            except Exception as e:
                print(f"獲取 {symbol} 訂單簿失敗: {e}")
        return results
    
    # 字符串表示
    
    def __str__(self) -> str:
        auth_status = "已認證" if self.is_authenticated else "未認證"
        network = "測試網" if self.testnet else "主網"
        return f"{self.name}({auth_status}, {network})"
    
    def __repr__(self) -> str:
        return f"{self.__class__.__name__}(testnet={self.testnet}, authenticated={self.is_authenticated})"
