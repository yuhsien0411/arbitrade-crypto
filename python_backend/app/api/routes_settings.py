from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Literal, List, Dict, Any
import time
import os

from ..utils.http import get_http_client
from ..utils.logger import get_logger
from ..config import config
from ..utils.env_manager import env_manager


router = APIRouter()
logger = get_logger()

# 支援的交易所列表
EXCHANGES = ["bybit", "binance", "okx", "bitget"]

# 簡易快取，避免頻繁呼叫交易所時間端點
_status_cache: dict[str, dict] = {}
_status_cache_ttl_sec = 60


ExchangeName = Literal["bybit", "binance", "okx", "bitget"]


class ExchangeStatus(BaseModel):
    name: str
    connected: bool
    publicOnly: bool


class AccountBalance(BaseModel):
    asset: str
    free: float


class AccountInfo(BaseModel):
    balances: List[AccountBalance]
    positions: List[Dict[str, Any]] = []


async def _check_exchange_status(exchange: str) -> ExchangeStatus:
    """檢查交易所連線狀態"""
    client = await get_http_client()
    now = time.time()
    cached = _status_cache.get(exchange)
    if cached and (now - cached["ts"]) < _status_cache_ttl_sec:
        return cached["value"]
    
    connected = False
    if exchange == "bybit":
        try:
            url = "https://api.bybit.com/v5/market/time"
            r = await client.get(url, timeout=5.0)
            connected = r.status_code == 200
        except Exception:
            connected = False
    elif exchange == "binance":
        try:
            url = "https://api.binance.com/api/v3/time"
            r = await client.get(url, timeout=5.0)
            connected = r.status_code == 200
        except Exception:
            connected = False
    elif exchange == "okx":
        try:
            url = "https://www.okx.com/api/v5/public/time"
            r = await client.get(url, timeout=5.0)
            if r.status_code == 200:
                data = r.json()
                connected = data.get("code") == "0"
        except Exception:
            connected = False
    elif exchange == "bitget":
        try:
            url = "https://api.bitget.com/api/v2/public/time"
            r = await client.get(url, timeout=5.0)
            if r.status_code == 200:
                data = r.json()
                connected = data.get("code") == "00000"
        except Exception:
            connected = False
    
    # 檢查是否有 API 密鑰配置
    from app.config import config
    has_api_key = False
    if exchange == "bybit":
        has_api_key = bool(config.BYBIT_API_KEY)
    elif exchange == "binance":
        has_api_key = bool(config.BINANCE_API_KEY)
    elif exchange == "okx":
        has_api_key = bool(config.OKX_API_KEY)
    elif exchange == "bitget":
        has_api_key = bool(config.BITGET_API_KEY)
    
    result = ExchangeStatus(
        name=exchange,
        connected=connected and has_api_key,  # 需要同時滿足 API 可達和有密鑰
        publicOnly=not has_api_key  # 如果沒有密鑰則只能使用公開 API
    )
    _status_cache[exchange] = {"ts": now, "value": result}
    return result


@router.get("/exchanges")
async def get_exchanges():
    """取得所有支援的交易所狀態"""
    exchanges = []
    for exchange in EXCHANGES:
        status = await _check_exchange_status(exchange)
        # 添加前端需要的額外字段
        exchange_data = {
            "name": status.name,
            "connected": status.connected,
            "publicOnly": status.publicOnly,
            "status": "active" if status.connected else "disconnected",
            "implemented": True,
            "symbols": {
                "spot": ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT"],
                "linear": ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT"],
                "inverse": []
            }
        }
        exchanges.append(exchange_data)
    
    return {"success": True, "data": exchanges}


@router.get("/account/{exchange}")
async def get_account(exchange: ExchangeName):
    """取得指定交易所帳戶資訊（真實：若無私鑰則回傳空清單）"""
    # 檢查交易所連線狀態
    status = await _check_exchange_status(exchange)
    if not status.connected:
        raise HTTPException(
            status_code=503, 
            detail={"code": "EXCHANGE_UNAVAILABLE", "message": f"{exchange} unavailable"}
        )
    
    # 若沒有配置私鑰，返回空資產，保持真實狀態
    exchanges_config = config.get_all_exchanges_config()
    has_keys = False
    if exchange in exchanges_config:
        ex_cfg = exchanges_config[exchange]
        has_keys = bool(ex_cfg.get("apiKey")) and bool(ex_cfg.get("secret"))

    if not has_keys:
        return {"success": True, "data": {"balances": [], "positions": []}}

    try:
        if exchange == "bybit":
            from pybit.unified_trading import HTTP
            session = HTTP(testnet=False, api_key=ex_cfg.get("apiKey"), api_secret=ex_cfg.get("secret"))
            spot = session.get_wallet_balance(accountType="UNIFIED")
            balances = []
            if spot.get("retCode") == 0:
                for coin in (spot.get("result", {}).get("list", [])[0].get("coin", [])):
                    balances.append({"asset": coin.get("coin"), "free": float(coin.get("walletBalance", 0))})
            return {"success": True, "data": {"balances": balances, "positions": []}}
        elif exchange == "binance":
            # 使用統一交易所接口
            from ..exchanges.factory import ExchangeFactory
            
            binance_exchange = ExchangeFactory.create_from_config("binance")
            
            # 獲取餘額
            balances_data = await binance_exchange.get_balances()
            balances = []
            for balance in balances_data:
                if balance.free > 0 or balance.locked > 0:
                    balances.append({
                        "asset": balance.asset,
                        "free": balance.free,
                        "locked": balance.locked,
                        "borrowed": getattr(balance, 'borrowed', 0)
                    })
            
            # 獲取持倉
            positions_data = await binance_exchange.get_positions()
            positions = []
            for position in positions_data:
                if position.size > 0:
                    positions.append({
                        "symbol": position.symbol,
                        "side": position.side,
                        "size": position.size,
                        "entry_price": position.entry_price,
                        "mark_price": position.mark_price,
                        "unrealized_pnl": position.unrealized_pnl
                    })
            
            return {"success": True, "data": {"balances": balances, "positions": positions}}
        else:
            raise HTTPException(status_code=400, detail={"code": "VALIDATION_ERROR", "message": "unsupported exchange"})
    except Exception as e:
        raise HTTPException(status_code=502, detail={"code": "UPSTREAM_ERROR", "message": str(e)})


@router.get("/settings/api")
async def get_api_settings():
    """取得 API 設定狀態（從環境變數讀取）"""
    # 從環境變數讀取設定
    exchanges_config = config.get_all_exchanges_config()
    
    # 不返回實際的 API Key 和 Secret
    safe_data = {}
    for exchange, exchange_config in exchanges_config.items():
        safe_data[exchange] = {
            "connected": exchange_config["connected"],
            "publicOnly": exchange_config["publicOnly"],
            "hasApiKey": bool(exchange_config["apiKey"]),
            "hasSecret": bool(exchange_config["secret"])
        }
        # OKX 和 Bitget 需要 password
        if exchange in ["okx", "bitget"]:
            safe_data[exchange]["hasPassword"] = bool(exchange_config.get("password"))
    
    return {"success": True, "data": safe_data}


@router.get("/settings/api/edit")
async def get_api_settings_for_edit():
    """取得 API 設定用於編輯（返回實際的 API Key 和 Secret 值）"""
    exchanges_config = config.get_all_exchanges_config()
    
    # 返回編輯用的資料（包含實際的 API Key 和 Secret）
    edit_data = {}
    for exchange, exchange_config in exchanges_config.items():
        edit_data[exchange] = {
            "apiKey": exchange_config["apiKey"] or "",
            "secret": exchange_config["secret"] or "",
            "hasApiKey": bool(exchange_config["apiKey"]),
            "hasSecret": bool(exchange_config["secret"]),
            "connected": exchange_config["connected"],
            "publicOnly": exchange_config["publicOnly"]
        }
        # OKX 和 Bitget 需要 password
        if exchange in ["okx", "bitget"]:
            edit_data[exchange]["password"] = exchange_config.get("password", "")
            edit_data[exchange]["hasPassword"] = bool(exchange_config.get("password"))
    
    return {"success": True, "data": edit_data}


@router.put("/settings/api")
async def update_api_settings(settings: dict):
    """更新 API 設定（直接更新 .env 檔案）"""
    try:
        logger.info("api_settings_update_requested", exchanges=list(settings.keys()))
        
        # 更新 .env 檔案中的 API 設定
        for exchange, exchange_config in settings.items():
            if exchange in EXCHANGES:
                api_key = exchange_config.get("apiKey")
                secret = exchange_config.get("secret")
                password = exchange_config.get("password")  # OKX 和 Bitget 需要
                
                # 更新 .env 檔案
                success = env_manager.update_api_keys(
                    exchange=exchange,
                    api_key=api_key,
                    secret=secret,
                    password=password
                )
                
                if not success:
                    raise Exception(f"更新 {exchange} API 設定失敗")
        
        # 重新載入配置
        import os
        from dotenv import load_dotenv
        from pathlib import Path
        
        # 重新載入 .env 檔案
        env_path = Path(__file__).parent.parent.parent.parent / ".env"
        load_dotenv(env_path, override=True)
        
        # 直接更新環境變數
        os.environ['BYBIT_API_KEY'] = os.getenv('BYBIT_API_KEY', '')
        os.environ['BYBIT_SECRET'] = os.getenv('BYBIT_SECRET', '')
        os.environ['BINANCE_API_KEY'] = os.getenv('BINANCE_API_KEY', '')
        os.environ['BINANCE_SECRET'] = os.getenv('BINANCE_SECRET', '')
        os.environ['OKX_API_KEY'] = os.getenv('OKX_API_KEY', '')
        os.environ['OKX_SECRET'] = os.getenv('OKX_SECRET', '')
        os.environ['OKX_PASSWORD'] = os.getenv('OKX_PASSWORD', '')
        os.environ['BITGET_API_KEY'] = os.getenv('BITGET_API_KEY', '')
        os.environ['BITGET_SECRET'] = os.getenv('BITGET_SECRET', '')
        os.environ['BITGET_PASSWORD'] = os.getenv('BITGET_PASSWORD', '')
        
        # 重新載入配置模組
        from ..config import EnvConfig
        import importlib
        import sys
        
        config_module = sys.modules['app.config']
        importlib.reload(config_module)
        
        # 更新全域配置
        global config
        config = config_module.config
        
        logger.info("api_settings_updated", exchanges=list(settings.keys()))
        return {"success": True, "data": {"message": "API 設定已更新並保存到 .env 檔案"}}
        
    except Exception as e:
        logger.error("api_settings_update_failed", error=str(e))
        raise HTTPException(
            status_code=500,
            detail={"code": "INTERNAL_ERROR", "message": f"更新 API 設定失敗: {str(e)}"}
        )


@router.post("/settings/api/test")
async def test_api_connection(request: dict = None):
    """測試 API 連接（從環境變數讀取）"""
    # 從請求中獲取要測試的交易所，如果沒有指定則測試所有
    target_exchange = None
    if request and "exchange" in request:
        target_exchange = request["exchange"].lower()
    
    exchanges_config = config.get_all_exchanges_config()
    connected_exchanges = []
    test_results = {}
    
    for exchange, exchange_config in exchanges_config.items():
        # 如果指定了特定交易所，只測試該交易所
        if target_exchange and exchange.lower() != target_exchange:
            continue
        if exchange_config["apiKey"] and exchange_config["secret"]:
            try:
                if exchange.lower() == "bybit":
                    # 測試 Bybit API 連接
                    from pybit.unified_trading import HTTP
                    
                    # 檢查是否使用測試網（可以從環境變數讀取）
                    use_testnet = os.getenv('BYBIT_TESTNET', 'false').lower() == 'true'
                    
                    session = HTTP(
                        testnet=use_testnet,
                        api_key=exchange_config["apiKey"],
                        api_secret=exchange_config["secret"]
                    )
                    
                    # 測試 API 連接：獲取帳戶信息
                    account_info = session.get_account_info()
                    
                    if account_info.get("retCode") == 0:
                        connected_exchanges.append(exchange)
                        result = account_info.get("result", {})
                        
                        # 解析帳戶狀態
                        unified_margin_status_map = {
                            1: "經典帳戶",
                            3: "統一帳戶1.0",
                            4: "統一帳戶1.0 (pro版本)",
                            5: "統一帳戶2.0",
                            6: "統一帳戶2.0 (pro版本)"
                        }
                        
                        margin_mode_map = {
                            "ISOLATED_MARGIN": "逐倉保證金",
                            "REGULAR_MARGIN": "全倉保證金",
                            "PORTFOLIO_MARGIN": "組合保證金"
                        }
                        
                        # 獲取帳戶餘額和淨值
                        total_equity = None
                        try:
                            wallet_balance = session.get_wallet_balance(accountType="UNIFIED")
                            if wallet_balance.get("retCode") == 0:
                                account_data = wallet_balance.get("result", {}).get("list", [])
                                if account_data:
                                    total_equity = account_data[0].get("totalEquity")
                        except Exception as e:
                            logger.warning("bybit_get_wallet_balance_failed", error=str(e))
                        
                        account_info_dict = {
                            "marginMode": result.get("marginMode", ""),
                            "marginModeText": margin_mode_map.get(result.get("marginMode", ""), result.get("marginMode", "")),
                            "unifiedMarginStatus": result.get("unifiedMarginStatus", 0),
                            "unifiedMarginStatusText": unified_margin_status_map.get(result.get("unifiedMarginStatus", 0), f"未知狀態({result.get('unifiedMarginStatus', 0)})"),
                            "isMasterTrader": result.get("isMasterTrader", False),
                            "spotHedgingStatus": result.get("spotHedgingStatus", ""),
                            "spotHedgingStatusText": "已開啟" if result.get("spotHedgingStatus") == "ON" else "未開啟",
                            "updatedTime": result.get("updatedTime", ""),
                            "dcpStatus": result.get("dcpStatus", ""),
                            "timeWindow": result.get("timeWindow", 0),
                            "smpGroup": result.get("smpGroup", 0)
                        }
                        
                        # 如果有淨值，添加到返回數據中
                        if total_equity is not None:
                            account_info_dict["totalEquity"] = total_equity
                        
                        test_results[exchange] = {
                            "success": True,
                            "message": "API 連接成功",
                            "account_info": account_info_dict
                        }
                    else:
                        test_results[exchange] = {
                            "success": False,
                            "message": f"API 連接失敗: {account_info.get('retMsg', '未知錯誤')}",
                            "error_code": account_info.get("retCode", -1)
                        }
                        
                elif exchange.lower() == "binance":
                    # 測試 Binance API 連接
                    import requests
                    import time
                    import hmac
                    import hashlib
                    from urllib.parse import urlencode
                    
                    # 創建簽名
                    timestamp = int(time.time() * 1000)
                    query_string = f"timestamp={timestamp}"
                    signature = hmac.new(
                        exchange_config["secret"].encode('utf-8'),
                        query_string.encode('utf-8'),
                        hashlib.sha256
                    ).hexdigest()
                    
                    # 測試 API 連接：獲取帳戶信息
                    url = "https://api.binance.com/api/v3/account"
                    params = {
                        "timestamp": timestamp,
                        "signature": signature
                    }
                    headers = {
                        "X-MBX-APIKEY": exchange_config["apiKey"]
                    }
                    
                    response = requests.get(url, params=params, headers=headers, timeout=10)
                    
                    if response.status_code == 200:
                        connected_exchanges.append(exchange)
                        account_data = response.json()
                        
                        # 檢查是否有 Portfolio Margin
                        portfolio_margin_enabled = False
                        pm_account_info = None
                        
                        # 嘗試獲取 Portfolio Margin 帳戶信息
                        try:
                            pm_timestamp = int(time.time() * 1000)
                            pm_query_string = f"timestamp={pm_timestamp}"
                            pm_signature = hmac.new(
                                exchange_config["secret"].encode('utf-8'),
                                pm_query_string.encode('utf-8'),
                                hashlib.sha256
                            ).hexdigest()
                            
                            pm_url = "https://papi.binance.com/papi/v1/account"
                            pm_params = {
                                "timestamp": pm_timestamp,
                                "signature": pm_signature
                            }
                            
                            pm_response = requests.get(pm_url, params=pm_params, headers=headers, timeout=10)
                            
                            if pm_response.status_code == 200 and pm_response.headers.get('content-type', '').startswith('application/json'):
                                portfolio_margin_enabled = True
                                pm_account_info = pm_response.json()
                                logger.info("binance_portfolio_margin_detected", 
                                          uniMMR=pm_account_info.get('uniMMR'),
                                          accountEquity=pm_account_info.get('accountEquity'))
                            else:
                                logger.info("binance_portfolio_margin_not_available",
                                          status_code=pm_response.status_code,
                                          content_type=pm_response.headers.get('content-type'))
                        except Exception as pm_error:
                            logger.info("binance_portfolio_margin_check_failed", error=str(pm_error))
                        
                        # 解析 Binance 帳戶信息
                        account_info = {
                            "makerCommission": account_data.get("makerCommission", 0),
                            "takerCommission": account_data.get("takerCommission", 0),
                            "buyerCommission": account_data.get("buyerCommission", 0),
                            "sellerCommission": account_data.get("sellerCommission", 0),
                            "canTrade": account_data.get("canTrade", False),
                            "canWithdraw": account_data.get("canWithdraw", False),
                            "canDeposit": account_data.get("canDeposit", False),
                            "updateTime": account_data.get("updateTime", 0),
                            "accountType": account_data.get("accountType", ""),
                            "balances": account_data.get("balances", [])[:5],  # 只顯示前5個餘額
                            "permissions": account_data.get("permissions", []),
                            "portfolioMarginEnabled": portfolio_margin_enabled
                        }
                        
                        # 如果啟用了 Portfolio Margin，添加相關信息
                        if portfolio_margin_enabled and pm_account_info:
                            account_info["accountType"] = "PORTFOLIO_MARGIN"
                            account_info["uniMMR"] = pm_account_info.get("uniMMR")
                            account_info["accountEquity"] = pm_account_info.get("accountEquity")
                            account_info["accountMaintMargin"] = pm_account_info.get("accountMaintMargin")
                            account_info["accountStatus"] = pm_account_info.get("accountStatus")
                        
                        test_results[exchange] = {
                            "success": True,
                            "message": "API 連接成功",
                            "account_info": account_info
                        }
                    else:
                        test_results[exchange] = {
                            "success": False,
                            "message": f"API 連接失敗: {response.text}",
                            "error_code": response.status_code
                        }
                
                elif exchange.lower() == "okx":
                    # 測試 OKX API 連接
                    from ..exchanges.factory import ExchangeFactory
                    from ..exchanges.base import TradeType
                    
                    try:
                        okx_exchange = ExchangeFactory.create_from_config("okx")
                        
                        # 測試獲取帳戶摘要（OKX 不接受參數）
                        account_summary = await okx_exchange.get_account_summary()
                        
                        connected_exchanges.append(exchange)
                        
                        # 格式化餘額信息
                        balances_info = []
                        for balance in account_summary.balances[:5]:  # 只顯示前5個
                            balances_info.append({
                                "asset": balance.asset,
                                "total": f"{balance.total:.8f}",
                                "free": f"{balance.free:.8f}"
                            })
                        
                        test_results[exchange] = {
                            "success": True,
                            "message": "API 連接成功",
                            "account_info": {
                                "accountMode": account_summary.account_mode,
                                "totalEquity": f"{account_summary.total_equity_usdt:.2f} USDT",
                                "balances": balances_info,
                                "balanceCount": len(account_summary.balances)
                            }
                        }
                    except Exception as okx_error:
                        test_results[exchange] = {
                            "success": False,
                            "message": f"OKX API 連接測試失敗: {str(okx_error)}"
                        }
                
                elif exchange.lower() == "bitget":
                    # 測試 Bitget API 連接
                    from ..exchanges.factory import ExchangeFactory
                    from ..exchanges.base import TradeType
                    
                    try:
                        bitget_exchange = ExchangeFactory.create_from_config("bitget")
                        
                        # 檢查帳戶模式
                        account_mode, _ = await bitget_exchange.check_account_mode()
                        
                        # 測試獲取帳戶摘要（Bitget 接受參數）
                        account_summary = await bitget_exchange.get_account_summary(TradeType.LINEAR)
                        
                        connected_exchanges.append(exchange)
                        
                        # 格式化餘額信息
                        balances_info = []
                        for balance in account_summary.balances[:5]:  # 只顯示前5個
                            balances_info.append({
                                "asset": balance.asset,
                                "total": f"{balance.total:.2f}",
                                "free": f"{balance.free:.2f}"
                            })
                        
                        test_results[exchange] = {
                            "success": True,
                            "message": "API 連接成功",
                            "account_info": {
                                "accountMode": account_summary.account_mode,
                                "accountModeText": "經典帳戶" if account_mode == "classic" else account_mode,
                                "totalEquity": f"{account_summary.total_equity_usdt:.2f} USDT",
                                "balances": balances_info,
                                "balanceCount": len(account_summary.balances),
                                "note": "Bitget 僅支援合約交易"
                            }
                        }
                    except Exception as bitget_error:
                        test_results[exchange] = {
                            "success": False,
                            "message": f"Bitget API 連接測試失敗: {str(bitget_error)}"
                        }
                        
            except Exception as e:
                test_results[exchange] = {
                    "success": False,
                    "message": f"API 連接測試失敗: {str(e)}"
                }
        else:
            test_results[exchange] = {
                "success": False,
                "message": "API Key 或 Secret 未配置"
            }
    
    return {
        "success": True, 
        "data": {
            "connected": len(connected_exchanges) > 0,
            "exchanges": connected_exchanges,
            "test_results": test_results
        }
    }


@router.delete("/settings/api/{exchange}")
async def delete_api_settings(exchange: str):
    """刪除指定交易所的 API 設定（從 .env 檔案中清除）"""
    try:
        logger.info("api_settings_delete_requested", exchange=exchange)
        
        if exchange in EXCHANGES:
            # 清除 .env 檔案中的 API 設定
            success = env_manager.clear_api_keys(exchange)
            
            if not success:
                raise Exception(f"清除 {exchange} API 設定失敗")
            
            # 重新載入配置
            import os
            from dotenv import load_dotenv
            from pathlib import Path
            
            # 重新載入 .env 檔案
            env_path = Path(__file__).parent.parent.parent.parent / ".env"
            load_dotenv(env_path, override=True)
            
            # 直接更新環境變數
            os.environ['BYBIT_API_KEY'] = os.getenv('BYBIT_API_KEY', '')
            os.environ['BYBIT_SECRET'] = os.getenv('BYBIT_SECRET', '')
            os.environ['BINANCE_API_KEY'] = os.getenv('BINANCE_API_KEY', '')
            os.environ['BINANCE_SECRET'] = os.getenv('BINANCE_SECRET', '')
            os.environ['OKX_API_KEY'] = os.getenv('OKX_API_KEY', '')
            os.environ['OKX_SECRET'] = os.getenv('OKX_SECRET', '')
            os.environ['OKX_PASSWORD'] = os.getenv('OKX_PASSWORD', '')
            os.environ['BITGET_API_KEY'] = os.getenv('BITGET_API_KEY', '')
            os.environ['BITGET_SECRET'] = os.getenv('BITGET_SECRET', '')
            os.environ['BITGET_PASSWORD'] = os.getenv('BITGET_PASSWORD', '')
            
            # 重新載入配置模組
            from ..config import EnvConfig
            import importlib
            import sys
            
            config_module = sys.modules['app.config']
            importlib.reload(config_module)
            
            # 更新全域配置
            global config
            config = config_module.config
            
            logger.info("api_settings_deleted", exchange=exchange)
            return {"success": True, "data": {"message": f"{exchange} API 設定已從 .env 檔案中刪除"}}
        else:
            raise HTTPException(
                status_code=404,
                detail={"code": "NOT_FOUND", "message": f"交易所 {exchange} 不存在"}
            )
            
    except Exception as e:
        logger.error("api_settings_delete_failed", error=str(e))
        raise HTTPException(
            status_code=500,
            detail={"code": "INTERNAL_ERROR", "message": f"刪除 API 設定失敗: {str(e)}"}
        )
