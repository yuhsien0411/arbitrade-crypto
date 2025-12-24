"""
套利交易相關資料模型
統一前後端資料結構，確保型別安全
"""

from __future__ import annotations
import time
import uuid
from typing import Literal, Optional, List
from pydantic import BaseModel, Field


class Leg(BaseModel):
    """交易腿配置"""
    exchange: Literal["bybit", "binance", "okx", "bitget"] = Field(description="交易所")
    symbol: str = Field(pattern=r"^[A-Z0-9]+USDT?$", description="交易對，如 BTCUSDT")
    type: Literal["spot", "linear", "inverse"] = Field(description="交易類型")
    side: Literal["buy", "sell"] = Field(description="買賣方向")
    
    @property
    def is_bitget(self) -> bool:
        """判斷是否為 Bitget 交易所"""
        return self.exchange == "bitget"
    
    @property
    def is_okx(self) -> bool:
        """判斷是否為 OKX 交易所"""
        return self.exchange == "okx"
    
    def validate_bitget_constraints(self) -> None:
        """驗證 Bitget 交易所限制：僅支援合約交易"""
        if self.is_bitget and self.type == "spot":
            raise ValueError("Bitget 交易所僅支援合約交易 (linear/inverse)，不支援現貨交易")
    
    def validate_okx_constraints(self) -> None:
        """驗證 OKX 交易所限制：僅支援合約交易"""
        if self.is_okx and self.type == "spot":
            raise ValueError("OKX 交易所僅支援合約交易 (linear/inverse)，不支援現貨交易")

    class Config:
        json_schema_extra = {
            "example": {
                "exchange": "bybit",
                "symbol": "BTCUSDT", 
                "type": "linear",
                "side": "buy"
            }
        }


class PairConfig(BaseModel):
    """監控對配置"""
    id: str = Field(
        default_factory=lambda: f"pair_{int(time.time()*1000)}_{uuid.uuid4().hex[:8]}",
        description="唯一識別碼"
    )
    leg1: Leg = Field(description="第一腿配置")
    leg2: Leg = Field(description="第二腿配置")
    threshold: float = Field(description="觸發閾值（%），可為負數代表反向套利")
    qty: float = Field(gt=0, description="每次下單數量")
    maxExecs: int = Field(ge=1, description="最大執行次數")
    enabled: bool = Field(default=True, description="是否啟用")
    createdAt: int = Field(
        default_factory=lambda: int(time.time() * 1000),
        description="建立時間戳（毫秒）"
    )
    totalTriggers: Optional[int] = Field(default=0, description="已觸發次數")
    lastTriggered: Optional[int] = Field(default=None, description="最後觸發時間")

    class Config:
        populate_by_name = True  # Pydantic V2: 使用 class Config 時，舊名仍可用，但警告建議改用 validate_by_name
        json_schema_extra = {
            "example": {
                "id": "pair_1234567890_abc123",
                "leg1": {
                    "exchange": "bybit",
                    "symbol": "BTCUSDT",
                    "type": "linear", 
                    "side": "buy"
                },
                "leg2": {
                    "exchange": "bybit",
                    "symbol": "BTCUSDT",
                    "type": "spot",
                    "side": "sell"
                },
                "threshold": 0.1,
                "qty": 0.001,
                "maxExecs": 5,
                "enabled": True,
                "createdAt": 1758832273693,
                "totalTriggers": 0,
                "lastTriggered": None
            }
        }


class ExecutionLeg(BaseModel):
    """執行腿結果"""
    exchange: str = Field(description="交易所")
    symbol: str = Field(description="交易對")
    type: str = Field(description="交易類型")
    side: str = Field(description="買賣方向")
    orderId: Optional[str] = Field(default=None, description="訂單ID，失敗時為null")

    class Config:
        populate_by_name = True  # Pydantic V2: 使用 class Config 時，舊名仍可用，但警告建議改用 validate_by_name


class ExecutionRecord(BaseModel):
    """執行記錄"""
    ts: int = Field(description="執行時間戳（毫秒）")
    pairId: str = Field(description="對應的監控對ID")
    qty: float = Field(gt=0, description="執行數量")
    status: Literal["success", "failed", "cancelled", "rolling_back", "rolled_back"] = Field(
        description="執行狀態"
    )
    maxExecs: int = Field(ge=1, description="該配置的最大執行次數")
    totalTriggers: int = Field(ge=0, description="執行後的總觸發次數")
    leg1: ExecutionLeg = Field(description="第一腿執行結果")
    leg2: ExecutionLeg = Field(description="第二腿執行結果")
    
    # 向後兼容欄位
    success: Optional[bool] = Field(default=None, description="向後兼容：執行是否成功")
    reason: Optional[str] = Field(default=None, description="失敗原因")
    error: Optional[str] = Field(default=None, description="錯誤訊息")

    class Config:
        populate_by_name = True  # Pydantic V2: 使用 class Config 時，舊名仍可用，但警告建議改用 validate_by_name
        json_schema_extra = {
            "example": {
                "ts": 1758832273693,
                "pairId": "pair_1234567890_abc123",
                "qty": 0.001,
                "status": "success",
                "maxExecs": 5,
                "totalTriggers": 1,
                "leg1": {
                    "exchange": "bybit",
                    "symbol": "BTCUSDT",
                    "type": "linear",
                    "side": "buy",
                    "orderId": "91e060d7-b94b-4329-9f04-a39aa8054c0e"
                },
                "leg2": {
                    "exchange": "bybit", 
                    "symbol": "BTCUSDT",
                    "type": "spot",
                    "side": "sell",
                    "orderId": "2047627954003118592"
                }
            }
        }


# API 請求/回應模型

class CreatePairRequest(BaseModel):
    """建立監控對請求"""
    pairId: Optional[str] = Field(default=None, description="可選的自定義ID")
    leg1: Leg = Field(description="第一腿配置")
    leg2: Leg = Field(description="第二腿配置")
    threshold: float = Field(description="觸發閾值（%）")
    qty: float = Field(gt=0, description="每次下單數量")
    maxExecs: int = Field(ge=1, default=1, description="最大執行次數")
    enabled: bool = Field(default=True, description="是否啟用")

    class Config:
        populate_by_name = True  # Pydantic V2: 使用 class Config 時，舊名仍可用，但警告建議改用 validate_by_name


class UpdatePairRequest(BaseModel):
    """更新監控對請求"""
    enabled: Optional[bool] = Field(default=None, description="是否啟用")
    threshold: Optional[float] = Field(default=None, description="觸發閾值（%）")
    qty: Optional[float] = Field(default=None, gt=0, description="每次下單數量")
    maxExecs: Optional[int] = Field(default=None, ge=1, description="最大執行次數")

    class Config:
        populate_by_name = True  # Pydantic V2: 使用 class Config 時，舊名仍可用，但警告建議改用 validate_by_name


class EngineControlRequest(BaseModel):
    """引擎控制請求"""
    action: Literal["start", "stop"] = Field(description="控制動作")


class PriceUpdate(BaseModel):
    """價格更新訊息"""
    id: str = Field(description="監控對ID")
    pairConfig: PairConfig = Field(description="監控對配置")
    leg1Price: dict = Field(description="第一腿價格")
    leg2Price: dict = Field(description="第二腿價格")
    spread: float = Field(description="價差")
    spreadPercent: float = Field(description="價差百分比")
    threshold: float = Field(description="觸發閾值")
    timestamp: int = Field(description="時間戳")
    refreshed: Optional[bool] = Field(default=False, description="是否為手動刷新")

    class Config:
        populate_by_name = True  # Pydantic V2: 使用 class Config 時，舊名仍可用，但警告建議改用 validate_by_name


# 統一回應格式

class ApiResponse(BaseModel):
    """統一API回應格式"""
    success: bool = Field(description="是否成功")
    data: Optional[dict] = Field(default=None, description="回應資料")
    error: Optional[str] = Field(default=None, description="錯誤訊息")
    message: Optional[str] = Field(default=None, description="提示訊息")


class WebSocketMessage(BaseModel):
    """WebSocket訊息格式"""
    type: str = Field(description="訊息類型")
    data: dict = Field(description="訊息內容")
    timestamp: Optional[int] = Field(default_factory=lambda: int(time.time() * 1000), description="時間戳")


# 執行歷史回應格式

class ExecutionHistoryResponse(BaseModel):
    """執行歷史回應"""
    data: dict = Field(description="記憶體中的執行歷史", default_factory=dict)
    recent: List[ExecutionRecord] = Field(description="最近的執行記錄", default_factory=list)

    class Config:
        json_schema_extra = {
            "example": {
                "data": {
                    "pair_123": [
                        {
                            "ts": 1758832273693,
                            "pairId": "pair_123",
                            "qty": 0.001,
                            "status": "success",
                            "maxExecs": 5,
                            "totalTriggers": 1,
                            "leg1": {
                                "exchange": "bybit",
                                "symbol": "BTCUSDT",
                                "type": "linear",
                                "side": "buy", 
                                "orderId": "order_123"
                            },
                            "leg2": {
                                "exchange": "bybit",
                                "symbol": "BTCUSDT",
                                "type": "spot",
                                "side": "sell",
                                "orderId": "order_456"
                            }
                        }
                    ]
                },
                "recent": []
            }
        }
