from __future__ import annotations

import asyncio
import time
from typing import Dict, Optional, Any
import os

from app.utils.logger import get_logger
import json
try:
    # 用於即時推播到前端
    from app.utils.websocket_manager import manager as ws_manager
except Exception:
    ws_manager = None  # 避免導入循環在測試時出錯

# V2统一架构：使用统一价格服务
from app.services.unified_price_service import unified_price_service
from app.config.env import config

# 使用統一的資料模型
from app.models.arbitrage import Leg, PairConfig, ExecutionRecord
from app.models.execution import UnifiedExecutionRecord, ExecutionLeg


class ArbitrageEngine:
    """簡化版套利引擎：維護監控對、輪詢行情、達閾值時觸發執行（此版本先記錄 log）。"""

    def __init__(self) -> None:
        self.logger = get_logger()
        self._pairs: Dict[str, PairConfig] = {}
        self._task: Optional[asyncio.Task] = None
        self._running: bool = False
        self._interval_sec: float = 0.25
        self._executions_count: Dict[str, int] = {}
        self._executing_pairs: set[str] = set()
        self._executions_history: Dict[str, list] = {}
        # 準備 JSONL 持久化目錄 data/arbitrage
        try:
            base_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), '../../..'))
            self._data_dir = os.path.join(base_dir, 'data', 'arbitrage')
            os.makedirs(self._data_dir, exist_ok=True)
            # 新版彙總檔（統一格式）：data/pair.jsonl
            self._pair_summary_path = os.path.join(base_dir, 'data', 'pair.jsonl')
        except Exception:
            self._data_dir = os.path.join(os.getcwd(), 'data', 'arbitrage')
            try:
                os.makedirs(self._data_dir, exist_ok=True)
            except Exception:
                pass
            # 回退彙總檔路徑
            self._pair_summary_path = os.path.join(os.getcwd(), 'data', 'pair.jsonl')

    def _jsonl_path(self) -> str:
        day_str = time.strftime('%Y%m%d')
        return os.path.join(self._data_dir, f'executions_{day_str}.jsonl')

    def _json_path(self) -> str:
        day_str = time.strftime('%Y%m%d')
        return os.path.join(self._data_dir, f'executions_{day_str}.json')

    def _append_jsonl(self, record: Dict[str, Any]) -> None:
        try:
            # 寫入日檔
            path = self._jsonl_path()
            with open(path, 'a', encoding='utf-8') as f:
                f.write(json.dumps(record, ensure_ascii=False) + '\n')
            # 同時寫入彙總檔
            self._append_pair_summary(record)
        except Exception as e:
            self.logger.error("jsonl_append_failed", error=str(e))

    def _append_pair_summary(self, record) -> None:
        """
        將統一格式的執行記錄追加到 data/pair.jsonl

        不影響既有日檔（data/arbitrage/executions_*.jsonl），
        僅提供給前端 / 報表做彙總使用。
        
        Args:
            record: UnifiedExecutionRecord 實例或 dict
        """
        try:
            if isinstance(record, UnifiedExecutionRecord):
                line = record.model_dump()
            else:
                line = record
            with open(self._pair_summary_path, 'a', encoding='utf-8') as f:
                f.write(json.dumps(line, ensure_ascii=False) + '\n')
        except Exception as e:
            self.logger.error("pair_summary_append_failed", error=str(e))

    def _update_jsonl_price(self, order_id: str, fill_price: float) -> None:
        """更新 JSONL 文件中的成交價格"""
        try:
            path = self._jsonl_path()
            if not os.path.exists(path):
                return
            
            # 讀取所有記錄
            records = []
            with open(path, 'r', encoding='utf-8') as f:
                for line in f:
                    try:
                        record = json.loads(line.strip())
                        records.append(record)
                    except:
                        continue
            
            # 更新包含該訂單ID的記錄
            updated = False
            for record in records:
                leg1_order_id = record.get('leg1', {}).get('orderId')
                leg2_order_id = record.get('leg2', {}).get('orderId')
                
                if leg1_order_id == order_id:
                    record['leg1']['price'] = fill_price
                    record['leg1']['priceUpdated'] = True
                    updated = True
                    
                    # 重新計算價差
                    leg1_price = record.get('leg1', {}).get('price')
                    leg2_price = record.get('leg2', {}).get('price')
                    if leg1_price and leg2_price:
                        spread = leg1_price - leg2_price
                        spread_pct = (spread / leg2_price) * 100 if leg2_price > 0 else 0
                        record['spread'] = spread
                        record['spreadPercent'] = spread_pct
                
                if leg2_order_id == order_id:
                    record['leg2']['price'] = fill_price
                    record['leg2']['priceUpdated'] = True
                    updated = True
                    
                    # 重新計算價差
                    leg1_price = record.get('leg1', {}).get('price')
                    leg2_price = record.get('leg2', {}).get('price')
                    if leg1_price and leg2_price:
                        spread = leg1_price - leg2_price
                        spread_pct = (spread / leg2_price) * 100 if leg2_price > 0 else 0
                        record['spread'] = spread
                        record['spreadPercent'] = spread_pct
            
            # 如果有更新，重寫文件
            if updated:
                with open(path, 'w', encoding='utf-8') as f:
                    for record in records:
                        f.write(json.dumps(record, ensure_ascii=False) + '\n')
                
                self.logger.info("jsonl_price_updated", 
                               order_id=order_id,
                               price=fill_price)
                
        except Exception as e:
            self.logger.error("jsonl_price_update_failed", 
                             order_id=order_id, 
                             error=str(e))

    def get_persisted_recent_jsonl(self, limit: int = 200) -> list[dict]:
        """讀取所有歷史 JSONL 檔案最近 limit 筆（倒序）。"""
        try:
            # 找出 data/arbitrage 目錄下所有 executions_*.jsonl 文件
            import glob
            pattern = os.path.join(self._data_dir, 'executions_*.jsonl')
            jsonl_files = glob.glob(pattern)
            
            if not jsonl_files:
                return []
            
            # 按文件名排序（日期降序，最新的在前）
            jsonl_files.sort(reverse=True)
            
            # 從所有文件中收集記錄
            all_items = []
            for file_path in jsonl_files:
                try:
                    with open(file_path, 'r', encoding='utf-8') as f:
                        lines = f.readlines()
                    for line in lines:
                        try:
                            item = json.loads(line.strip())
                            if item:  # 過濾空記錄
                                all_items.append(item)
                        except Exception:
                            continue
                except Exception as e:
                    self.logger.error("jsonl_file_read_failed", file=file_path, error=str(e))
                    continue
            
            # 依時間倒序排序
            all_items.sort(key=lambda x: x.get('ts', 0), reverse=True)
            
            # 返回最近 limit 筆
            return all_items[:limit]
            
        except Exception as e:
            self.logger.error("jsonl_read_failed", error=str(e))
            return []

    def get_persisted_recent(self, limit: int = 200) -> list[dict]:
        """優先讀取 JSON 陣列檔，若不存在則回退 JSONL（皆以 ts 倒序返回最多 limit 筆）。"""
        # 1) 優先嘗試 JSON 陣列檔案
        json_path = self._json_path()
        if os.path.exists(json_path):
            try:
                with open(json_path, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                if isinstance(data, list):
                    # 僅保留 dict 並排序
                    items = [x for x in data if isinstance(x, dict)]
                    items.sort(key=lambda x: x.get('ts', 0), reverse=True)
                    return items[:limit]
            except Exception as e:
                self.logger.error("json_array_read_failed", error=str(e))
                # 若 JSON 讀取失敗則改用 JSONL

        # 2) 回退 JSONL
        return self.get_persisted_recent_jsonl(limit=limit)

    # -------- 外部介面 --------
    def get_status(self) -> Dict[str, Any]:
        return {
            "running": self._running,
            "pairs": list(self._pairs.keys()),
            "intervalSec": self._interval_sec,
        }

    async def start(self) -> bool:
        if self._running:
            return True
        
        # 自動載入監控對
        await self._load_monitoring_pairs()
        
        self._running = True
        self._task = asyncio.create_task(self._run_loop())
        self.logger.info("arb_engine_started", success=True, pairsCount=len(self._pairs))
        return True

    async def stop(self) -> bool:
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        self.logger.info("arb_engine_stopped", success=True)
        return True

    def clear_all_data(self) -> None:
        """清空所有套利引擎資料"""
        # 只清空執行相關數據，保留監控對配置
        self._executions_count.clear()
        self._executing_pairs.clear()
        self._executions_history.clear()
        self.logger.info("arb_engine_execution_data_cleared", success=True)
    
    def clear_monitoring_pairs(self) -> None:
        """清空監控對資料（用於完全重置）"""
        self._pairs.clear()
        self.logger.info("arb_engine_monitoring_pairs_cleared", success=True)

    def upsert_pair(self, pair_id: str, config: PairConfig) -> None:
        """
        添加或更新监控对（V2统一架构）
        
        V2改进：
        - 移除交易所特定的WebSocket订阅逻辑
        - 价格获取统一由UnifiedPriceService管理
        """
        # 驗證交易所限制
        try:
            config.leg1.validate_bitget_constraints()
            config.leg1.validate_okx_constraints()
            config.leg2.validate_bitget_constraints()
            config.leg2.validate_okx_constraints()
        except ValueError as e:
            self.logger.error("arb_pair_validation_failed", pairId=pair_id, error=str(e))
            raise
        
        self._pairs[pair_id] = config
        self.logger.info("arb_pair_upserted", pairId=pair_id, enabled=config.enabled)
        
        # 重置統計（重新配置視為新的執行配額）
        self._executions_count[pair_id] = 0
        
        # 新增監控對後立即刷新價格數據
        asyncio.create_task(self._refresh_pair_prices(pair_id, config))

    def remove_pair(self, pair_id: str, reason: str = "manual") -> None:
        if pair_id in self._pairs:
            pair_config = self._pairs[pair_id]
            del self._pairs[pair_id]
            self.logger.info("arb_pair_removed", pairId=pair_id, reason=reason)
            
            # 紀錄到歷史和JSONL：已取消/移除
            # 如果是因為完成或失敗而移除，不需要記錄（已經在執行時記錄了）
            if reason not in ("completed", "failed"):
                try:
                    # 獲取 maxExecs、totalTriggers 和 threshold 資訊
                    try:
                        from ..api.routes_monitoring import monitoring_pairs
                        pair_data = monitoring_pairs.get(pair_id, {})
                        max_execs = pair_data.get('maxExecs', pair_config.maxExecs)
                        total_triggers = pair_data.get('totalTriggers', pair_config.totalTriggers or 0)
                        threshold = pair_data.get('threshold', pair_config.threshold)
                    except:
                        max_execs = pair_config.maxExecs
                        total_triggers = pair_config.totalTriggers or 0
                        threshold = pair_config.threshold
                    
                    # 創建執行記錄（統一格式）
                    execution_record = {
                        "ts": int(time.time() * 1000),
                        "mode": "pair",
                        "strategyId": pair_id,
                        "pairId": pair_id,
                        "twapId": None,
                        # 手動刪除時視為「下一次」執行狀態快照
                        "totalTriggers": (total_triggers or 0) + 1,  # 統一：第幾次執行
                        "status": "cancelled" if reason == "manual" else reason,
                        "reason": reason,
                        "error": None,
                        "qty": pair_config.qty,  # 記錄原本設定的數量
                        "spread": None,
                        "spreadPercent": None,
                        # 統一數量/配置欄位
                        "totalAmount": float(max_execs * pair_config.qty),
                        "orderCount": max_execs,
                        "threshold": threshold,
                        "intervalMs": None,
                        # 回滾相關欄位
                        "isRollback": False,
                        "leg1": {
                            "exchange": pair_config.leg1.exchange,
                            "symbol": pair_config.leg1.symbol,
                            "type": pair_config.leg1.type,
                            "side": pair_config.leg1.side,
                            "orderId": None,  # 手動刪除時沒有訂單ID
                            "price": None,
                            "priceUpdated": False,
                            "originalOrderId": None
                        },
                        "leg2": {
                            "exchange": pair_config.leg2.exchange,
                            "symbol": pair_config.leg2.symbol,
                            "type": pair_config.leg2.type,
                            "side": pair_config.leg2.side,
                            "orderId": None,  # 手動刪除時沒有訂單ID
                            "price": None,
                            "priceUpdated": False,
                            "originalOrderId": None
                        }
                    }
                    
                    # 添加到內存歷史
                    history = self._executions_history.setdefault(pair_id, [])
                    history.append(execution_record)
                    
                    # 寫入JSONL文件持久化
                    self._append_jsonl(execution_record)
                    
                    self.logger.info("arb_pair_removal_recorded", 
                                   pairId=pair_id, 
                                   reason=reason, 
                                   totalTriggers=total_triggers,
                                   maxExecs=max_execs)
                    
                except Exception as e:
                    self.logger.error("arb_pair_removal_record_failed", 
                                    pairId=pair_id, 
                                    reason=reason, 
                                    error=str(e))
        # 清理執行鎖與計數
        self._executions_count.pop(pair_id, None)
        if pair_id in self._executing_pairs:
            self._executing_pairs.discard(pair_id)

    async def _load_monitoring_pairs(self) -> None:
        """從監控對系統載入所有啟用的交易對"""
        try:
            # 避免循環導入，直接從模組獲取
            import app.api.routes_monitoring as routes_monitoring
            monitoring_pairs = routes_monitoring.monitoring_pairs
            
            loaded_count = 0
            for pair_id, config in monitoring_pairs.items():
                if config.get("enabled", True):  # 只載入啟用的對
                    try:
                        # 轉換為 PairConfig，使用配置中的side或預設值
                        leg1 = Leg(
                            exchange=config["leg1"]["exchange"],
                            symbol=config["leg1"]["symbol"],
                            type=config["leg1"]["type"],
                            side=config["leg1"].get("side", "buy")  # 使用配置的side或預設為買入
                        )
                        leg2 = Leg(
                            exchange=config["leg2"]["exchange"],
                            symbol=config["leg2"]["symbol"],
                            type=config["leg2"]["type"],
                            side=config["leg2"].get("side", "sell")  # 使用配置的side或預設為賣出
                        )
                        
                        # 添加載入時的驗證日誌
                        self.logger.info("arb_pair_loaded_debug", 
                                       pairId=pair_id,
                                       leg1Type=leg1.type,
                                       leg1Symbol=leg1.symbol,
                                       leg1Side=leg1.side,
                                       leg2Type=leg2.type,
                                       leg2Symbol=leg2.symbol,
                                       leg2Side=leg2.side)
                        
                        pair_config = PairConfig(
                            leg1=leg1,
                            leg2=leg2,
                            threshold=config["threshold"],
                            qty=config["qty"],
                            enabled=config.get("enabled", True),
                            maxExecs=config.get("maxExecs", 1)
                        )
                        
                        self._pairs[pair_id] = pair_config
                        loaded_count += 1
                        
                    except Exception as e:
                        self.logger.error("arb_load_pair_failed", pairId=pair_id, error=str(e))
            
            self.logger.info("arb_pairs_loaded", count=loaded_count, total=len(monitoring_pairs))
            
        except Exception as e:
            self.logger.error("arb_load_monitoring_pairs_failed", error=str(e))

    async def _refresh_pair_prices(self, pair_id: str, config: PairConfig) -> None:
        """
        刷新指定監控對的價格數據（V2统一架构）
        
        V2改进：
        - 使用UnifiedPriceService统一获取价格
        - 移除交易所特定的if-else判断
        """
        try:
            self.logger.info("arb_refresh_prices_start", pairId=pair_id)
            
            # 使用统一价格服务获取 Leg1 价格
            leg1_price = await unified_price_service.get_top_of_book(
                exchange=config.leg1.exchange,
                symbol=config.leg1.symbol,
                category=config.leg1.type
            )
            
            if not leg1_price or not leg1_price.is_valid():
                self.logger.warning("arb_leg1_price_unavailable", 
                                  pairId=pair_id,
                                  exchange=config.leg1.exchange,
                                  symbol=config.leg1.symbol)
                return
            
            # 使用统一价格服务获取 Leg2 价格
            leg2_price = await unified_price_service.get_top_of_book(
                exchange=config.leg2.exchange,
                symbol=config.leg2.symbol,
                category=config.leg2.type
            )
            
            if not leg2_price or not leg2_price.is_valid():
                self.logger.warning("arb_leg2_price_unavailable", 
                                  pairId=pair_id,
                                  exchange=config.leg2.exchange,
                                  symbol=config.leg2.symbol)
                return
            
            leg1_bid = leg1_price.bid_price
            leg1_ask = leg1_price.ask_price
            leg2_bid = leg2_price.bid_price
            leg2_ask = leg2_price.ask_price
            
            # 計算價差
            if config.leg1.side == "sell" and config.leg2.side == "buy":
                spread = leg1_bid - leg2_ask
                spread_pct = (spread / (leg1_bid + leg2_ask)) * 2 * 100.0
            elif config.leg1.side == "buy" and config.leg2.side == "sell":
                spread = leg2_bid - leg1_ask
                spread_pct = (spread / (leg2_bid + leg1_ask)) * 2 * 100.0
            else:
                spread = leg1_bid - leg2_ask
                spread_pct = (spread / leg2_ask) * 100.0 if leg2_ask > 0 else 0
            
            # 推播價格更新到前端
            if ws_manager is not None:
                payload = json.dumps({
                    "type": "priceUpdate",
                    "data": {
                        "id": pair_id,
                        "pairConfig": {
                            "id": pair_id,
                            "leg1": {"exchange": config.leg1.exchange, "symbol": config.leg1.symbol, "type": config.leg1.type, "side": config.leg1.side},
                            "leg2": {"exchange": config.leg2.exchange, "symbol": config.leg2.symbol, "type": config.leg2.type, "side": config.leg2.side},
                            "threshold": config.threshold
                        },
                        "leg1Price": {"symbol": config.leg1.symbol, "exchange": config.leg1.exchange, "bid1": {"price": leg1_bid}, "ask1": {"price": leg1_ask}},
                        "leg2Price": {"symbol": config.leg2.symbol, "exchange": config.leg2.exchange, "bid1": {"price": leg2_bid}, "ask1": {"price": leg2_ask}},
                        "spread": spread,
                        "spreadPercent": spread_pct,
                        "threshold": config.threshold,
                        "timestamp": int(time.time() * 1000),
                        "refreshed": True  # 標記為手動刷新
                    }
                })
                await ws_manager.broadcast(payload)
                
            self.logger.info("arb_prices_refreshed", 
                           pairId=pair_id,
                           leg1Bid=leg1_bid,
                           leg1Ask=leg1_ask,
                           leg2Bid=leg2_bid,
                           leg2Ask=leg2_ask,
                           spread=spread,
                           spreadPct=spread_pct)
                
        except Exception as e:
            self.logger.error("arb_refresh_prices_error", pairId=pair_id, error=str(e))

    # -------- 內部邏輯 --------
    async def _run_loop(self) -> None:
        try:
            while self._running:
                started = time.time()
                await self._tick()
                elapsed = time.time() - started
                await asyncio.sleep(max(0.0, self._interval_sec - elapsed))
        except asyncio.CancelledError:
            self.logger.info("arb_engine_loop_cancelled")
        except Exception as e:
            self.logger.error("arb_engine_loop_error", error=str(e))
            self._running = False

    async def _tick(self) -> None:
        """
        主循环tick方法（V2统一架构）
        
        V2改进：
        - 使用UnifiedPriceService统一获取价格
        - 移除所有交易所特定的if-else判断
        - 代码简洁，易于维护
        """
        if not self._pairs:
            return
        
        for pair_id, cfg in list(self._pairs.items()):
            if not cfg.enabled:
                continue
            try:
                # 使用统一价格服务获取 Leg1 价格
                leg1_price = await unified_price_service.get_top_of_book(
                    exchange=cfg.leg1.exchange,
                    symbol=cfg.leg1.symbol,
                    category=cfg.leg1.type
                )
                
                if not leg1_price or not leg1_price.is_valid():
                    self.logger.warning("arb_leg1_price_unavailable", 
                                      pairId=pair_id,
                                      exchange=cfg.leg1.exchange,
                                      symbol=cfg.leg1.symbol)
                    continue
                
                # 使用统一价格服务获取 Leg2 价格
                leg2_price = await unified_price_service.get_top_of_book(
                    exchange=cfg.leg2.exchange,
                    symbol=cfg.leg2.symbol,
                    category=cfg.leg2.type
                )
                
                if not leg2_price or not leg2_price.is_valid():
                    self.logger.warning("arb_leg2_price_unavailable", 
                                      pairId=pair_id,
                                      exchange=cfg.leg2.exchange,
                                      symbol=cfg.leg2.symbol)
                    continue
                
                # 提取价格
                leg1_bid = leg1_price.bid_price
                leg1_ask = leg1_price.ask_price
                leg2_bid = leg2_price.bid_price
                leg2_ask = leg2_price.ask_price

                # 計算「可套利」定義的價差：使用標準化計算方式
                # -A+B（A腿賣出，B腿買入）：(A Bid 1 - B Ask 1) / (A Bid 1 + B Ask 1) * 2 * 100
                # +A-B（A腿買入，B腿賣出）：(B Bid 1 - A Ask 1) / (B Bid 1 + A Ask 1) * 2 * 100
                
                if cfg.leg1.side == "sell" and cfg.leg2.side == "buy":
                    # -A+B：A腿賣出，B腿買入
                    sell_exec = leg1_bid  # A腿賣出價格
                    buy_exec = leg2_ask   # B腿買入價格
                    spread = leg1_bid - leg2_ask
                    spread_pct = (spread / (leg1_bid + leg2_ask)) * 2 * 100.0
                elif cfg.leg1.side == "buy" and cfg.leg2.side == "sell":
                    # +A-B：A腿買入，B腿賣出
                    buy_exec = leg1_ask   # A腿買入價格
                    sell_exec = leg2_bid  # B腿賣出價格
                    spread = leg2_bid - leg1_ask
                    spread_pct = (spread / (leg2_bid + leg1_ask)) * 2 * 100.0
                    
                    # 詳細的價格數據日誌
                    self.logger.info("arb_price_calculation", 
                                   pairId=pair_id,
                                   leg1_side=cfg.leg1.side,
                                   leg2_side=cfg.leg2.side,
                                   leg1_bid=leg1_bid,
                                   leg1_ask=leg1_ask,
                                   leg2_bid=leg2_bid,
                                   leg2_ask=leg2_ask,
                                   buyExec=buy_exec,
                                   sellExec=sell_exec,
                                   spread=spread,
                                   spreadPct=spread_pct)
                else:
                    # 其他情況，使用舊的計算方式作為備用
                    buy_exec = leg1_ask if cfg.leg1.side == "buy" else leg2_ask
                    sell_exec = leg1_bid if cfg.leg1.side == "sell" else leg2_bid
                    spread = sell_exec - buy_exec
                    spread_pct = (spread / buy_exec) * 100.0 if buy_exec > 0 else 0

                # 價格數據已在前面檢查過，這裡不需要重複檢查

                # 只在觸發時才記錄日誌，避免過多輸出
                # 低頻詳情日誌（僅在有價差且有價時輸出，可協助診斷觸發門檻）
                if spread_pct != 0 and (int(time.time()) % 3 == 0):
                    self.logger.info(
                        "arb_tick_brief",
                        pairId=pair_id,
                        buyExec=buy_exec,
                        sellExec=sell_exec,
                        spread=spread,
                        spreadPct=spread_pct,
                        threshold=cfg.threshold,
                    )

                # 透過 WS 推送即時價格，減少前端等待
                try:
                    if ws_manager is not None:
                        payload = json.dumps({
                            "type": "priceUpdate",
                            "data": {
                                "id": pair_id,
                                "pairConfig": {
                                    "id": pair_id,
                                    "leg1": {"exchange": cfg.leg1.exchange, "symbol": cfg.leg1.symbol, "type": cfg.leg1.type, "side": cfg.leg1.side},
                                    "leg2": {"exchange": cfg.leg2.exchange, "symbol": cfg.leg2.symbol, "type": cfg.leg2.type, "side": cfg.leg2.side},
                                    "threshold": cfg.threshold
                                },
                                "leg1Price": {"symbol": cfg.leg1.symbol, "exchange": cfg.leg1.exchange, "bid1": {"price": leg1_bid}, "ask1": {"price": leg1_ask}},
                                "leg2Price": {"symbol": cfg.leg2.symbol, "exchange": cfg.leg2.exchange, "bid1": {"price": leg2_bid}, "ask1": {"price": leg2_ask}},
                                "spread": spread,
                                "spreadPercent": spread_pct,
                                "threshold": cfg.threshold,
                                "timestamp": int(time.time() * 1000)
                            }
                        })
                        import asyncio
                        asyncio.create_task(ws_manager.broadcast(payload))
                except Exception:
                    pass

                # 觸發邏輯：統一使用 spreadPct >= threshold（正差價才觸發）
                # - threshold = 0.0 → 任何正價差都會觸發
                # - threshold > 0 → 價差 >= 閾值時觸發
                # - threshold < 0 → 價差 >= 負閾值時觸發（負向套利）
                should_trigger = (spread_pct >= cfg.threshold)
                
                # 詳細的觸發條件檢查日誌
                self.logger.info("arb_trigger_check", 
                               pairId=pair_id,
                               spreadPct=spread_pct,
                               threshold=cfg.threshold,
                               shouldTrigger=should_trigger,
                               buyExec=buy_exec,
                               sellExec=sell_exec,
                               currentExecutions=self._executions_count.get(pair_id, 0),
                               maxExecs=cfg.maxExecs,
                               isExecuting=pair_id in self._executing_pairs)
                
                # 執行次數與冷卻/鎖檢查
                if self._executions_count.get(pair_id, 0) >= cfg.maxExecs:
                    should_trigger = False
                    self.logger.info("arb_trigger_blocked_max_execs", pairId=pair_id, 
                                   currentExecutions=self._executions_count.get(pair_id, 0), 
                                   maxExecs=cfg.maxExecs)
                if pair_id in self._executing_pairs:
                    should_trigger = False
                    self.logger.info("arb_trigger_blocked_executing", pairId=pair_id)
                    
                if should_trigger:
                    # 自動執行套利交易
                    self.logger.info(
                        "arb_auto_execute_triggered",
                        pairId=pair_id,
                        threshold=cfg.threshold,
                        spreadPct=spread_pct,
                        qty=cfg.qty,
                    )
                    
                    # 執行自動套利
                    await self._execute_arbitrage(pair_id, cfg, sell_exec, buy_exec)
            except Exception as e:
                self.logger.error("arb_tick_error", pairId=pair_id, error=str(e))

    async def _execute_arbitrage(self, pair_id: str, config: PairConfig, sell_exec: float, buy_exec: float) -> None:
        """
        執行自動套利交易
        
        Args:
            pair_id: 交易對ID
            config: 交易對配置
            sell_exec: 賣出腿的執行價格（賣出時使用的價格）
            buy_exec: 買入腿的執行價格（買入時使用的價格）
        """
        try:
            from .twap_engine import OrderResult
            
            # 計算執行時的價差（用於記錄）
            spread_at_execution = sell_exec - buy_exec
            spread_pct_at_execution = (spread_at_execution / buy_exec) * 100.0 if buy_exec > 0 else 0
            
            # 記錄開始執行
            self.logger.info("arb_execute_start", 
                           pairId=pair_id, 
                           buyExec=buy_exec, 
                           sellExec=sell_exec, 
                           spread=spread_at_execution, 
                           spreadPct=spread_pct_at_execution)
            # 標記執行鎖，避免並發
            self._executing_pairs.add(pair_id)
            
            # 執行 Leg1 訂單
            leg1_result = await self._place_order(config.leg1, config.qty)
            if not leg1_result.success:
                self.logger.error("arb_leg1_failed", pairId=pair_id, error=leg1_result.error_message)
                # Leg1 失敗，標記執行失敗並結束
                self._mark_execution_failed(pair_id, "leg1_failed", leg1_result.error_message)
                return
                
            # 執行 Leg2 訂單
            leg2_result = await self._place_order(config.leg2, config.qty)
            if not leg2_result.success:
                # Leg2 失敗，回滾 Leg1
                self.logger.warning("arb_leg2_failed_rollback", pairId=pair_id, leg1OrderId=leg1_result.order_id)
                rollback_result = await self._rollback_order(config.leg1, config.qty, leg1_result.order_id)
                
                # 回滾完成後，標記執行失敗並結束
                self._mark_execution_failed(pair_id, "leg2_failed_rollback_completed", 
                                          f"Leg2 failed: {leg2_result.error_message}, Rollback: {'success' if rollback_result else 'failed'}")
                return
                
            # 兩腿都成功
            self.logger.info("arb_execute_success", 
                           pairId=pair_id, 
                           leg1OrderId=leg1_result.order_id,
                           leg2OrderId=leg2_result.order_id,
                           leg1Price=leg1_result.price,
                           leg2Price=leg2_result.price)
            
            # WebSocket 推播將在後面的完整版本中處理
            # 增加次數
            self._executions_count[pair_id] = self._executions_count.get(pair_id, 0) + 1
            
            # 更新監控對的觸發統計
            try:
                from ..api.routes_monitoring import update_pair_trigger_stats
                update_pair_trigger_stats(pair_id, success=True)
            except Exception as e:
                self.logger.error("arb_update_trigger_stats_failed", pairId=pair_id, error=str(e))
            
            # 獲取最新的觸發次數（確保與監控對統計同步）
            try:
                from ..api.routes_monitoring import monitoring_pairs
                current_triggers = monitoring_pairs.get(pair_id, {}).get('totalTriggers', 0)
            except:
                current_triggers = self._executions_count.get(pair_id, 0)

            # 記錄到執行歷史（包含價格）
            history = self._executions_history.setdefault(pair_id, [])
            history.append({
                "ts": int(time.time() * 1000),
                "pairId": pair_id,
                "qty": config.qty,
                "status": "success",
                "spread": spread_at_execution,
                "spreadPercent": spread_pct_at_execution,
                "leg1": {
                    "exchange": config.leg1.exchange,
                    "symbol": config.leg1.symbol,
                    "type": config.leg1.type,
                    "side": config.leg1.side,
                    "orderId": leg1_result.order_id,
                    "price": float(leg1_result.price) if leg1_result.price is not None else None,
                    "priceUpdated": leg1_result.price is not None and float(leg1_result.price) > 0,
                },
                "leg2": {
                    "exchange": config.leg2.exchange,
                    "symbol": config.leg2.symbol,
                    "type": config.leg2.type,
                    "side": config.leg2.side,
                    "orderId": leg2_result.order_id,
                    "price": float(leg2_result.price) if leg2_result.price is not None else None,
                    "priceUpdated": leg2_result.price is not None and float(leg2_result.price) > 0,
                }
            })
            # 持久化成功記錄到 JSONL
            try:
                # 獲取 maxExecs 與實際執行次數
                max_execs = config.maxExecs
                # 使用更新後的執行次數（確保是累加後的值）
                total_triggers = self._executions_count.get(pair_id, 0)
                # 如果計數為 0，使用監控對的統計資料
                if total_triggers == 0:
                    try:
                        from ..api.routes_monitoring import monitoring_pairs
                        pair_data = monitoring_pairs.get(pair_id, {})
                        total_triggers = pair_data.get('totalTriggers', 1)
                    except:
                        total_triggers = 1  # 至少是 1，因為這次執行成功了
                
                # 日檔（統一格式）
                self._append_jsonl({
                    "ts": int(time.time() * 1000),
                    "mode": "pair",
                    "strategyId": pair_id,
                    "pairId": pair_id,
                    "twapId": None,
                    "totalTriggers": total_triggers,  # 統一：第幾次執行
                    "status": "success",
                    "reason": None,
                    "error": None,
                    "qty": config.qty,
                    "spread": spread_at_execution,
                    "spreadPercent": spread_pct_at_execution,
                    # 統一數量/配置欄位
                    "totalAmount": float(max_execs * config.qty),
                    "orderCount": max_execs,
                    "threshold": config.threshold,
                    "intervalMs": None,
                    # 回滾相關欄位
                    "isRollback": False,
                    "leg1": {
                        "exchange": config.leg1.exchange,
                        "symbol": config.leg1.symbol,
                        "type": config.leg1.type,
                        "side": config.leg1.side,
                        "orderId": leg1_result.order_id,
                        "price": leg1_result.price if leg1_result.price is not None else None,
                        "priceUpdated": leg1_result.price is not None and leg1_result.price > 0,
                        "originalOrderId": None
                    },
                    "leg2": {
                        "exchange": config.leg2.exchange,
                        "symbol": config.leg2.symbol,
                        "type": config.leg2.type,
                        "side": config.leg2.side,
                        "orderId": leg2_result.order_id,
                        "price": leg2_result.price if leg2_result.price is not None else None,
                        "priceUpdated": leg2_result.price is not None and leg2_result.price > 0,
                        "originalOrderId": None
                    }
                })
            except Exception as e:
                self.logger.error("jsonl_write_success_failed", error=str(e))

            # 🔧 如果有任何價格為 0.0 或 None，啟動異步補查機制
            need_retry_leg1 = not leg1_result.price or float(leg1_result.price) == 0
            need_retry_leg2 = not leg2_result.price or float(leg2_result.price) == 0
            
            if need_retry_leg1 or need_retry_leg2:
                self.logger.warning("arb_price_missing_will_retry",
                                  pairId=pair_id,
                                  leg1_need_retry=need_retry_leg1,
                                  leg2_need_retry=need_retry_leg2,
                                  leg1_price=leg1_result.price,
                                  leg2_price=leg2_result.price)
                
                # 轉換交易類型
                if config.leg1.type == "spot":
                    from ..exchanges import TradeType
                    trade_type_leg1 = TradeType.SPOT
                elif config.leg1.type in ("linear", "future", "futures"):
                    from ..exchanges import TradeType
                    trade_type_leg1 = TradeType.LINEAR
                else:
                    from ..exchanges import TradeType
                    trade_type_leg1 = TradeType.SPOT
                
                if config.leg2.type == "spot":
                    from ..exchanges import TradeType
                    trade_type_leg2 = TradeType.SPOT
                elif config.leg2.type in ("linear", "future", "futures"):
                    from ..exchanges import TradeType
                    trade_type_leg2 = TradeType.LINEAR
                else:
                    from ..exchanges import TradeType
                    trade_type_leg2 = TradeType.SPOT
                
                # 啟動異步補查（不等待結果）
                if need_retry_leg1:
                    asyncio.create_task(
                        self._fetch_fill_price_async(config.leg1, leg1_result.order_id, leg1_result, trade_type_leg1)
                    )
                
                if need_retry_leg2:
                    asyncio.create_task(
                        self._fetch_fill_price_async(config.leg2, leg2_result.order_id, leg2_result, trade_type_leg2)
                    )

            # WebSocket 推播：即時通知前端顯示執行結果
            try:
                self.logger.info("arb_websocket_debug", pairId=pair_id, ws_manager_type=type(ws_manager).__name__, ws_manager_none=ws_manager is None)
                if ws_manager is not None:
                    payload = json.dumps({
                        "type": "arbitrageExecuted",
                        "data": {
                            "pairId": pair_id,
                            "leg1OrderId": leg1_result.order_id,
                            "leg2OrderId": leg2_result.order_id,
                            "qty": config.qty,
                            "ts": int(time.time() * 1000),
                            "totalTriggers": current_triggers,
                            "maxExecs": config.maxExecs,
                            "threshold": config.threshold,
                            "spread": spread_at_execution,
                            "spreadPercent": spread_pct_at_execution,
                            "leg1": {
                                "exchange": config.leg1.exchange,
                                "symbol": config.leg1.symbol,
                                "type": config.leg1.type,
                                "side": config.leg1.side,
                            },
                            "leg2": {
                                "exchange": config.leg2.exchange,
                                "symbol": config.leg2.symbol,
                                "type": config.leg2.type,
                                "side": config.leg2.side,
                            }
                        }
                    })
                    import asyncio
                    asyncio.create_task(ws_manager.broadcast(payload))
                    self.logger.info("arb_websocket_broadcast_sent", pairId=pair_id, type="arbitrageExecuted")
                else:
                    self.logger.warning("arb_websocket_manager_null", pairId=pair_id)
            except Exception as e:
                self.logger.error("arb_websocket_broadcast_failed", pairId=pair_id, error=str(e))

            # 若達到最大執行次數：停用監控（但保留記錄，不刪除）
            if self._executions_count[pair_id] >= config.maxExecs:
                self.logger.info("arb_pair_completed_disabled", pairId=pair_id, executions=self._executions_count[pair_id])
                # 只停用，不刪除
                config.enabled = False
                # 更新到 monitoring_pairs
                try:
                    from ..api.routes_monitoring import monitoring_pairs, save_monitoring_pairs
                    if pair_id in monitoring_pairs:
                        monitoring_pairs[pair_id]["enabled"] = False
                        save_monitoring_pairs()
                except Exception as e:
                    self.logger.error("arb_disable_pair_failed", pairId=pair_id, error=str(e))
                # 推播停用事件，讓前端更新狀態（但不移除）
                try:
                    if ws_manager is not None:
                        payload = json.dumps({
                            "type": "pairDisabled",
                            "data": {"id": pair_id, "reason": "completed"}
                        })
                        import asyncio
                        asyncio.create_task(ws_manager.broadcast(payload))
                except Exception:
                    pass
                           
        except Exception as e:
            self.logger.error("arb_execute_error", pairId=pair_id, error=str(e))
            # 發生異常時標記執行失敗
            self._mark_execution_failed(pair_id, "execution_exception", str(e))
        finally:
            # 釋放執行鎖
            if pair_id in self._executing_pairs:
                self._executing_pairs.discard(pair_id)

    # 供 API 讀取執行歷史
    def get_executions_history(self) -> Dict[str, list]:
        return self._executions_history

    async def _place_order(self, leg: Leg, qty: float):
        """下單（現貨或合約）- 使用統一交易所接口"""
        try:
            from ..exchanges import ExchangeFactory, OrderSide, OrderType, TradeType
            
            # 獲取交易所實例
            exchange = ExchangeFactory.create_from_config(leg.exchange)
            
            if not exchange.is_authenticated:
                self.logger.warning("arb_exchange_not_authenticated", 
                                 exchange=leg.exchange,
                                 message=f"{leg.exchange} API 密鑰未配置，無法執行實際交易")
                from .twap_engine import OrderResult
                return OrderResult(
                    success=False,
                    price=None,
                    order_id=None,
                    error_message=f"{leg.exchange} API 密鑰未配置"
                )

            # 轉換參數
            side = OrderSide.BUY if leg.side == "buy" else OrderSide.SELL
            
            # 轉換交易類型
            if leg.type == "spot":
                trade_type = TradeType.SPOT
            elif leg.type in ("linear", "future", "futures"):
                trade_type = TradeType.LINEAR
            elif leg.type == "inverse":
                trade_type = TradeType.INVERSE
            else:
                self.logger.error("arb_invalid_leg_type", 
                                legType=leg.type, 
                                symbol=leg.symbol,
                                message="未知的 Leg 類型，默認使用現貨")
                trade_type = TradeType.SPOT

            self.logger.info("arb_placing_order_unified", 
                           exchange=leg.exchange,
                           symbol=leg.symbol,
                           side=leg.side,
                           type=leg.type,
                           qty=qty)
            
            # 使用統一接口下單
            kwargs = {}
            if trade_type == TradeType.SPOT and leg.exchange == "bybit":
                # Bybit 現貨特殊處理：啟用槓桿現貨交易
                kwargs["use_leverage"] = True
            elif trade_type == TradeType.SPOT and leg.exchange == "binance":
                # Binance 現貨槓桿特殊處理：統一使用自動借幣還款
                kwargs["side_effect_type"] = "AUTO_BORROW_REPAY"  # 買入和賣出都使用自動借幣還款

            # 印出詳細的參數信息
            self.logger.info("arb_order_params_debug",
                           exchange=leg.exchange,
                           symbol=leg.symbol,
                           side=leg.side,
                           type=leg.type,
                           qty=qty,
                           trade_type=trade_type.value,
                           side_enum=side.value,
                           kwargs=kwargs)

            result = await exchange.place_order(
                symbol=leg.symbol,
                side=side,
                quantity=qty,
                order_type=OrderType.MARKET,
                trade_type=trade_type,
                **kwargs
            )

            # 若市價單無回傳價格，嘗試即時回查成交均價（參考 TWAP 做法）
            fetched_price: Optional[float] = None
            try:
                if result.success and (not result.price or float(result.price) == 0):
                    self.logger.info(
                        "arb_attempting_fill_price_query",
                        exchange=leg.exchange,
                        symbol=leg.symbol,
                        order_id=result.order_id,
                        has_get_fill_price=hasattr(exchange, "get_fill_price")
                    )
                    # 交易所擴展：若實作 get_fill_price，則回查
                    if hasattr(exchange, "get_fill_price") and result.order_id:
                        fetched_price = await exchange.get_fill_price(
                            order_id=result.order_id,
                            symbol=leg.symbol,
                            trade_type=trade_type
                        )
                        self.logger.info(
                            "arb_fill_price_query_result",
                            exchange=leg.exchange,
                            symbol=leg.symbol,
                            order_id=result.order_id,
                            fetched_price=fetched_price
                        )
                        if fetched_price and fetched_price > 0:
                            self.logger.info(
                                "arb_fill_price_retrieved",
                                exchange=leg.exchange,
                                symbol=leg.symbol,
                                price=fetched_price
                            )
            except Exception as e:
                self.logger.warning(
                    "arb_fill_price_query_failed",
                    exchange=leg.exchange,
                    symbol=leg.symbol,
                    error=str(e)
                )

            # 使用成功獲取的價格（優先使用 result.price，其次使用 fetched_price）
            # 參考 TWAP 實現：使用 final_price 而不是 result.price
            final_price = None
            if result.price and float(result.price) > 0:
                final_price = result.price
            elif fetched_price and fetched_price > 0:
                final_price = fetched_price

            self.logger.info("arb_order_placed_with_price",
                           exchange=leg.exchange,
                           symbol=leg.symbol,
                           order_id=result.order_id,
                           original_price=result.price,
                           fetched_price=fetched_price,
                           final_price=final_price)

            # 轉換回舊格式（向後兼容）
            from .twap_engine import OrderResult
            return OrderResult(
                success=result.success,
                price=final_price,  # ✅ 使用 final_price，不是 result.price
                order_id=result.order_id,
                error_message=result.error_message
            )

        except Exception as e:
            self.logger.error("arb_place_order_unified_failed", 
                            exchange=leg.exchange,
                            symbol=leg.symbol, 
                            side=leg.side, 
                            qty=qty, 
                            error=str(e))
            from .twap_engine import OrderResult
            return OrderResult(
                success=False,
                price=None,
                order_id=None,
                error_message=str(e)
            )

    async def _rollback_order(self, leg: Leg, qty: float, original_order_id: str) -> bool:
        """回滾訂單（執行反向操作）"""
        try:
            # 反向操作
            reverse_side = "sell" if leg.side == "buy" else "buy"
            reverse_leg = Leg(
                exchange=leg.exchange,
                symbol=leg.symbol,
                type=leg.type,
                side=reverse_side
            )
            
            rollback_result = await self._place_order(reverse_leg, qty)
            if rollback_result.success:
                self.logger.info("arb_rollback_success", 
                               originalOrderId=original_order_id,
                               rollbackOrderId=rollback_result.order_id)
                return True
            else:
                self.logger.error("arb_rollback_failed", 
                                originalOrderId=original_order_id,
                                error=rollback_result.error_message)
                return False
                                
        except Exception as e:
            self.logger.error("arb_rollback_error", originalOrderId=original_order_id, error=str(e))
            return False

    async def _fetch_fill_price_async(self, leg: Leg, order_id: str, result, trade_type):
        """異步查詢成交價格並更新記錄（支持多次重試）"""
        try:
            self.logger.info("arb_fetch_fill_price_async_start", 
                           order_id=order_id,
                           symbol=leg.symbol,
                           exchange=leg.exchange)
            
            # 獲取交易所實例
            from ..exchanges import ExchangeFactory
            exchange = ExchangeFactory.create_from_config(leg.exchange)
            
            # 🔧 多次重試機制（最多3次，每次等待更久）
            max_retries = 3
            retry_delays = [2.0, 3.0, 5.0]  # 2秒、3秒、5秒
            
            for attempt in range(max_retries):
                # 等待訂單完全成交並更新
                await asyncio.sleep(retry_delays[attempt])
                
                # 查詢成交價格
                self.logger.info("arb_fetch_fill_price_async_querying", 
                               order_id=order_id,
                               symbol=leg.symbol,
                               exchange=leg.exchange,
                               attempt=attempt + 1,
                               max_retries=max_retries)
                
                fill_price = await exchange.get_fill_price(order_id, leg.symbol, trade_type)
                
                if fill_price and fill_price > 0:
                    result.price = fill_price
                    self.logger.info("arb_fill_price_retrieved", 
                                   order_id=order_id,
                                   symbol=leg.symbol,
                                   exchange=leg.exchange,
                                   price=fill_price,
                                   attempt=attempt + 1)
                    
                    # 更新內存中的執行記錄
                    self._update_execution_price(order_id, fill_price)
                    
                    # 通知前端價格已更新
                    self._notify_price_update(order_id, fill_price, leg)
                    
                    self.logger.info("arb_fill_price_async_completed", 
                                   order_id=order_id,
                                   symbol=leg.symbol,
                                   exchange=leg.exchange,
                                   price=fill_price)
                    return  # 成功獲取，退出重試循環
                else:
                    self.logger.warning("arb_fill_price_retry_attempt_failed", 
                                      order_id=order_id,
                                      symbol=leg.symbol,
                                      exchange=leg.exchange,
                                      fill_price=fill_price,
                                      attempt=attempt + 1,
                                      max_retries=max_retries)
            
            # 所有重試都失敗
            self.logger.warning("arb_fill_price_all_retries_failed", 
                              order_id=order_id,
                              symbol=leg.symbol,
                              exchange=leg.exchange,
                              max_retries=max_retries,
                              message="所有異步查詢嘗試都失敗，價格仍為0")
                
        except Exception as e:
            self.logger.error("arb_fetch_fill_price_async_failed", 
                             order_id=order_id,
                             symbol=leg.symbol,
                             exchange=leg.exchange,
                             error=str(e))
            import traceback
            self.logger.error("arb_fetch_fill_price_async_traceback", 
                             traceback=traceback.format_exc())

    def _update_execution_price(self, order_id: str, fill_price: float):
        """更新執行記錄中的成交價格"""
        try:
            # 更新內存中的最新記錄
            for pair_id, history in self._executions_history.items():
                if history:
                    latest_record = history[-1]
                    if (latest_record.get('leg1', {}).get('orderId') == order_id or
                        latest_record.get('leg2', {}).get('orderId') == order_id):
                        
                        # 更新價格
                        if latest_record.get('leg1', {}).get('orderId') == order_id:
                            latest_record['leg1']['price'] = fill_price
                            latest_record['leg1']['priceUpdated'] = True
                        if latest_record.get('leg2', {}).get('orderId') == order_id:
                            latest_record['leg2']['price'] = fill_price
                            latest_record['leg2']['priceUpdated'] = True
                        
                        # 重新計算價差，使用標準化計算方式
                        leg1_price = latest_record.get('leg1', {}).get('price')
                        leg2_price = latest_record.get('leg2', {}).get('price')
                        leg1_side = latest_record.get('leg1', {}).get('side')
                        leg2_side = latest_record.get('leg2', {}).get('side')
                        
                        if leg1_price and leg2_price and leg1_side and leg2_side:
                            if leg1_side == "sell" and leg2_side == "buy":
                                # -A+B：A腿賣出，B腿買入
                                spread = leg1_price - leg2_price
                                spread_pct = (spread / (leg1_price + leg2_price)) * 2 * 100.0
                            elif leg1_side == "buy" and leg2_side == "sell":
                                # +A-B：A腿買入，B腿賣出
                                spread = leg2_price - leg1_price
                                spread_pct = (spread / (leg2_price + leg1_price)) * 2 * 100.0
                            else:
                                # 其他情況，使用舊的計算方式作為備用
                                spread = leg1_price - leg2_price
                                spread_pct = (spread / leg2_price) * 100 if leg2_price > 0 else 0
                            
                            latest_record['spread'] = spread
                            latest_record['spreadPercent'] = spread_pct
                        
                        self.logger.info("arb_execution_price_updated", 
                                       pair_id=pair_id,
                                       order_id=order_id,
                                       price=fill_price)
                        
                        # 同時更新 JSONL 文件
                        self._update_jsonl_price(order_id, fill_price)
                        break
            
        except Exception as e:
            self.logger.error("arb_update_execution_price_failed", 
                             order_id=order_id, 
                             error=str(e))

    def _notify_price_update(self, order_id: str, fill_price: float, leg: Leg):
        """通知前端價格已更新"""
        try:
            if ws_manager is not None:
                payload = json.dumps({
                    "type": "priceUpdated",
                    "data": {
                        "orderId": order_id,
                        "price": fill_price,
                        "symbol": leg.symbol,
                        "exchange": leg.exchange,
                        "type": leg.type,
                        "side": leg.side,
                        "timestamp": int(time.time() * 1000)
                    }
                })
                import asyncio
                asyncio.create_task(ws_manager.broadcast(payload))
                
        except Exception as e:
            self.logger.error("arb_price_update_notify_failed", 
                             order_id=order_id, 
                             error=str(e))

    def _mark_execution_failed(self, pair_id: str, reason: str, error_message: str) -> None:
        """標記執行失敗並記錄錯誤"""
        # 記錄執行失敗
        self.logger.error("arb_execution_failed", 
                         pairId=pair_id, 
                         reason=reason, 
                         error=error_message)
        
        # 增加失敗次數（用於統計）
        if pair_id not in self._executions_history:
            self._executions_history[pair_id] = []
        
        # 獲取 pair 配置信息
        pair_config = self._pairs.get(pair_id)
        
        # 獲取 maxExecs、totalTriggers 和 threshold 資訊
        try:
            from ..api.routes_monitoring import monitoring_pairs
            pair_data = monitoring_pairs.get(pair_id, {})
            max_execs = pair_data.get('maxExecs', 1)
            total_triggers = pair_data.get('totalTriggers', 0)
            threshold = pair_data.get('threshold', 0)
        except:
            max_execs = 1
            total_triggers = 0
            threshold = 0
        
        # 構建 leg 信息（即使失敗也要保留配置信息）
        leg1_info = None
        leg2_info = None
        if pair_config:
            leg1_info = {
                "exchange": pair_config.leg1.exchange,
                "symbol": pair_config.leg1.symbol,
                "type": pair_config.leg1.type,
                "side": pair_config.leg1.side,
                "orderId": None,  # 失敗時沒有訂單ID
                "price": None,
                "priceUpdated": False,
                "originalOrderId": None
            }
            leg2_info = {
                "exchange": pair_config.leg2.exchange,
                "symbol": pair_config.leg2.symbol,
                "type": pair_config.leg2.type,
                "side": pair_config.leg2.side,
                "orderId": None,  # 失敗時沒有訂單ID
                "price": None,
                "priceUpdated": False,
                "originalOrderId": None
            }
        
        # 記錄失敗歷史（統一格式）
        failure = {
            "ts": int(time.time() * 1000),
            "mode": "pair",
            "strategyId": pair_id,
            "pairId": pair_id,
            "twapId": None,
            "totalTriggers": (total_triggers or 0) + 1,  # 統一：第幾次執行
            "status": "failed",
            "reason": reason,
            "error": error_message,
            "qty": pair_config.qty if pair_config else 0,
            "spread": None,
            "spreadPercent": None,
            # 統一數量/配置欄位
            "totalAmount": float(max_execs * (pair_config.qty if pair_config else 0)),
            "orderCount": max_execs,
            "threshold": threshold,
            "intervalMs": None,
            "isRollback": False,
            "leg1": leg1_info,
            "leg2": leg2_info
        }
        self._executions_history[pair_id].append(failure)
        # 持久化失敗記錄
        try:
            self._append_jsonl(failure)
        except Exception as e:
            self.logger.error("jsonl_write_failed_failed", error=str(e))
        
        # 更新監控對的觸發統計（失敗）
        try:
            from ..api.routes_monitoring import update_pair_trigger_stats
            update_pair_trigger_stats(pair_id, success=False)
        except Exception as e:
            self.logger.error("arb_update_trigger_stats_failed", pairId=pair_id, error=str(e))
        
        # 推播失敗事件到前端
        try:
            if ws_manager is not None:
                payload = json.dumps({
                    "type": "arbitrageFailed",
                    "data": {
                        "pairId": pair_id,
                        "reason": reason,
                        "error": error_message,
                        "ts": int(time.time() * 1000)
                    }
                })
                import asyncio
                asyncio.create_task(ws_manager.broadcast(payload))
        except Exception:
            pass

        # 發生錯誤後，停用該監控對（但保留記錄，不刪除）
        try:
            if pair_id in self._pairs:
                self._pairs[pair_id].enabled = False
            # 更新到 monitoring_pairs
            try:
                from ..api.routes_monitoring import monitoring_pairs, save_monitoring_pairs
                if pair_id in monitoring_pairs:
                    monitoring_pairs[pair_id]["enabled"] = False
                    save_monitoring_pairs()
            except Exception as update_err:
                self.logger.error("arb_disable_failed_pair_error", pairId=pair_id, error=str(update_err))
            
            if ws_manager is not None:
                payload = json.dumps({
                    "type": "pairDisabled",
                    "data": {"id": pair_id, "reason": "failed"}
                })
                import asyncio
                asyncio.create_task(ws_manager.broadcast(payload))
            self.logger.info("arb_pair_disabled_due_to_error", pairId=pair_id)
        except Exception as e:
            self.logger.error("arb_disable_pair_on_error_failed", pairId=pair_id, error=str(e))


# 全域引擎實例
arb_engine = ArbitrageEngine()


