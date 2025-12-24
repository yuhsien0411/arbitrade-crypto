from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from typing import Literal, List, Dict, Any
import time

from ..utils.http import get_http_client
from ..services.cache_manager import TTLCache


router = APIRouter()
cache = TTLCache(default_ttl_seconds=1.0)


ExchangeName = Literal["bybit", "binance", "okx", "bitget"]


class BatchItem(BaseModel):
    exchange: ExchangeName
    symbol: str


class BatchRequest(BaseModel):
    items: List[BatchItem] = Field(default_factory=list)


async def _fetch_orderbook(exchange: ExchangeName, symbol: str, category: str = None) -> Dict[str, Any]:
    # Bitget 和 OKX 僅支援合約，強制使用 linear
    if exchange in ["bitget", "okx"]:
        categories = ["linear"]
        category = "linear"
    elif category:
        # 如果有指定category，優先使用指定的category
        categories = [category]
    else:
        # 預設嘗試 spot 和 linear
        categories = ["spot", "linear"]
    
    # 確保不同交易所和類型使用不同的緩存鍵
    cache_key = f"orderbook:{exchange}:{symbol}:{category or 'auto'}"
    cached = await cache.get(cache_key)
    if cached is not None:
        return cached

    client = await get_http_client()
    if exchange == "bybit":
        # 先用 tickers 取 bid1/ask1，失敗再回退 orderbook
        payload = None
        for cat in categories:
            tickers_url = f"https://api.bybit.com/v5/market/tickers?category={cat}&symbol={symbol}"
            r = await client.get(tickers_url)
            if r.status_code == 200:
                data = r.json()
                if data.get("retCode") == 0:
                    list_data = data.get("result", {}).get("list", [])
                    if list_data:
                        t = list_data[0]
                        bid = t.get("bid1Price")
                        bid_size = t.get("bid1Size", "0")
                        ask = t.get("ask1Price")
                        ask_size = t.get("ask1Size", "0")
                        ts = int(t.get("ts", int(time.time() * 1000)))
                        if bid and ask:
                            payload = {
                                "exchange": exchange,
                                "symbol": symbol,
                                "bids": [[bid, bid_size]],
                                "asks": [[ask, ask_size]],
                                "ts": ts,
                            }
                            break
            # 回退到 orderbook depth=1
            ob_url = f"https://api.bybit.com/v5/market/orderbook?category={cat}&symbol={symbol}&limit=1"
            r = await client.get(ob_url)
            if r.status_code == 200:
                data = r.json()
                if data.get("retCode") == 0:
                    list_data = data.get("result", {}).get("list", [])
                    if list_data:
                        ob = list_data[0]
                        bids = ob.get("b", [])
                        asks = ob.get("a", [])
                        ts = int(ob.get("ts", int(time.time() * 1000)))
                        payload = {
                            "exchange": exchange,
                            "symbol": symbol,
                            "bids": bids,
                            "asks": asks,
                            "ts": ts,
                        }
                        break
        if payload is None:
            raise HTTPException(status_code=502, detail={"code": "UPSTREAM_ERROR", "message": "bybit unavailable"})
    elif exchange == "binance":
        # 先嘗試從 WebSocket 獲取數據
        try:
            from app.services.orderbook_feeds.binance import binance_orderbook_feed
            if binance_orderbook_feed.is_data_available(symbol):
                # 修正：使用 get_top_of_book_snapshot 而非不存在的 get_book_ticker
                ticker = binance_orderbook_feed.get_top_of_book_snapshot(symbol)
                if ticker:
                    payload = {
                        "exchange": exchange,
                        "symbol": symbol,
                        "bids": [[str(ticker.best_bid_price), str(ticker.best_bid_qty)]],
                        "asks": [[str(ticker.best_ask_price), str(ticker.best_ask_qty)]],
                        "ts": ticker.timestamp,
                    }
                else:
                    raise Exception("WebSocket ticker not available")
            else:
                raise Exception("WebSocket data not available")
        except Exception:
            # 回退到 REST API - 根據 category 選擇端點
            # 判斷是否為合約市場
            is_futures = category == "linear" or (categories and "linear" in categories)
            
            if is_futures:
                # USDT-M 合約端點
                url = f"https://fapi.binance.com/fapi/v1/depth?symbol={symbol}&limit=5"
            else:
                # 現貨端點
                url = f"https://api.binance.com/api/v3/depth?symbol={symbol}&limit=5"
            
            r = await client.get(url)
            if r.status_code != 200:
                raise HTTPException(status_code=502, detail={"code": "UPSTREAM_ERROR", "message": "binance error"})
            data = r.json()
            bids = data.get("bids", [])
            asks = data.get("asks", [])
            ts = int(time.time() * 1000)
            payload = {
                "exchange": exchange,
                "symbol": symbol,
                "bids": bids,
                "asks": asks,
                "ts": ts,
            }
    elif exchange == "bitget":
        # Bitget 優先使用 WebSocket，無數據則使用統一交易所接口
        try:
            from app.services.orderbook_feeds.bitget import bitget_orderbook_feed
            feed = bitget_orderbook_feed()
            
            # 嘗試從 WebSocket 獲取數據
            bid, ask = feed.get_top_of_book(symbol)
            if bid and ask and bid > 0 and ask > 0:
                payload = {
                    "exchange": exchange,
                    "symbol": symbol,
                    "bids": [[str(bid), "0"]],
                    "asks": [[str(ask), "0"]],
                    "ts": int(time.time() * 1000),
                }
            else:
                raise Exception("WebSocket data not available")
        except Exception:
            # 回退到統一交易所接口獲取價格
            try:
                from app.exchanges import ExchangeFactory, TradeType
                exchange_instance = ExchangeFactory.create_from_config("bitget")
                
                # Bitget 僅支援合約，使用 linear 類型
                orderbook = await exchange_instance.get_orderbook(symbol, limit=1, trade_type=TradeType.LINEAR)
                
                if orderbook and orderbook.bids and orderbook.asks:
                    payload = {
                        "exchange": exchange,
                        "symbol": symbol,
                        "bids": orderbook.bids[:1],
                        "asks": orderbook.asks[:1],
                        "ts": orderbook.timestamp,
                    }
                else:
                    raise HTTPException(status_code=502, detail={"code": "UPSTREAM_ERROR", "message": "bitget unavailable"})
            except Exception as e:
                raise HTTPException(status_code=502, detail={"code": "UPSTREAM_ERROR", "message": f"bitget error: {str(e)}"})
    elif exchange == "okx":
        # OKX 優先使用 WebSocket，無數據則使用統一交易所接口
        try:
            from app.services.orderbook_feeds.okx import OKXOrderBookFeed
            from app.exchanges import ExchangeFactory
            
            # 獲取 OKX 交易所實例
            exchange_instance = ExchangeFactory.create_from_config("okx")
            
            # 嘗試從 WebSocket 獲取數據
            if exchange_instance.orderbook_feed._running:
                tob = exchange_instance.orderbook_feed.get_top_of_book(symbol)
                if tob:
                    payload = {
                        "exchange": exchange,
                        "symbol": symbol,
                        "bids": [[str(tob.best_bid_price), str(tob.best_bid_qty)]],
                        "asks": [[str(tob.best_ask_price), str(tob.best_ask_qty)]],
                        "ts": int(tob.timestamp * 1000),
                    }
                else:
                    raise Exception("WebSocket data not available")
            else:
                raise Exception("WebSocket not running")
        except Exception:
            # 回退到統一交易所接口獲取價格
            try:
                from app.exchanges import ExchangeFactory, TradeType
                exchange_instance = ExchangeFactory.create_from_config("okx")
                
                # OKX 僅支援合約，使用 linear 類型
                orderbook = await exchange_instance.get_orderbook(symbol, limit=1, trade_type=TradeType.LINEAR)
                
                if orderbook and orderbook.bids and orderbook.asks:
                    payload = {
                        "exchange": exchange,
                        "symbol": symbol,
                        "bids": [[str(orderbook.bids[0][0]), str(orderbook.bids[0][1])]],
                        "asks": [[str(orderbook.asks[0][0]), str(orderbook.asks[0][1])]],
                        "ts": orderbook.timestamp,
                    }
                else:
                    raise HTTPException(status_code=502, detail={"code": "UPSTREAM_ERROR", "message": "okx unavailable"})
            except Exception as e:
                raise HTTPException(status_code=502, detail={"code": "UPSTREAM_ERROR", "message": f"okx error: {str(e)}"})
    else:
        raise HTTPException(status_code=400, detail={"code": "VALIDATION_ERROR", "message": "unsupported exchange"})

    await cache.set(cache_key, payload, ttl_seconds=1.0)
    return payload


@router.get("/prices/{exchange}/{symbol}")
async def get_price(exchange: ExchangeName, symbol: str, category: str = None):
    data = await _fetch_orderbook(exchange, symbol, category)
    return {"success": True, "data": data}


@router.post("/prices/batch")
async def get_prices_batch(req: BatchRequest):
    results: List[Dict[str, Any]] = []
    for item in req.items:
        data = await _fetch_orderbook(item.exchange, item.symbol)
        results.append(data)
    return {"success": True, "data": results}


