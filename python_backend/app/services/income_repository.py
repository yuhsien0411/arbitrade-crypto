"""
收入紀錄倉儲：負責將交易所收益/資金費流水持久化至 JSONL，並提供查詢與元資料管理能力。
"""

import json
import os
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from threading import Lock
from typing import Any, Dict, Iterable, List, Optional

from ..utils.logger import get_logger


class IncomeRepository:
    """
    交易所資金流水儲存與查詢
    
    - 每筆紀錄以 JSONL 形式保存在 data/income/{exchange}/income_YYYYMMDD.jsonl
    - metadata.json 紀錄最後同步的時間戳與交易ID，便於增量抓取
    """

    def __init__(self, data_dir: Optional[str] = None):
        self.logger = get_logger()
        base_candidate = Path(data_dir) if data_dir else Path("data")

        try:
            base_candidate.mkdir(parents=True, exist_ok=True)
        except Exception:
            # 若指定目錄建立失敗，退回當前工作目錄
            base_candidate = Path(os.getcwd()) / "data"
            base_candidate.mkdir(parents=True, exist_ok=True)

        self.base_dir = base_candidate / "income"
        self.base_dir.mkdir(parents=True, exist_ok=True)

        self._lock = Lock()

    # Path helpers ---------------------------------------------------------

    def _exchange_dir(self, exchange: str) -> Path:
        exchange_dir = self.base_dir / exchange.lower()
        exchange_dir.mkdir(parents=True, exist_ok=True)
        return exchange_dir

    def list_exchanges(self) -> List[str]:
        if not self.base_dir.exists():
            return []
        return sorted(
            [
                path.name
                for path in self.base_dir.iterdir()
                if path.is_dir()
            ]
        )

    def _file_path(self, exchange: str, timestamp_ms: int) -> Path:
        date = datetime.utcfromtimestamp(timestamp_ms / 1000)
        filename = f"income_{date.strftime('%Y%m%d')}.jsonl"
        return self._exchange_dir(exchange) / filename

    def _metadata_path(self, exchange: str) -> Path:
        return self._exchange_dir(exchange) / "metadata.json"

    # Metadata -------------------------------------------------------------

    def load_metadata(self, exchange: str) -> Dict[str, Any]:
        path = self._metadata_path(exchange)
        if not path.exists():
            return {}
        try:
            with path.open("r", encoding="utf-8") as fh:
                return json.load(fh)
        except Exception as exc:
            self.logger.warning(
                "income_metadata_load_failed",
                exchange=exchange,
                error=str(exc),
            )
            return {}

    def save_metadata(self, exchange: str, metadata: Dict[str, Any]) -> None:
        path = self._metadata_path(exchange)
        with self._lock:
            try:
                with path.open("w", encoding="utf-8") as fh:
                    json.dump(metadata, fh, ensure_ascii=False, indent=2)
            except Exception as exc:
                self.logger.error(
                    "income_metadata_save_failed",
                    exchange=exchange,
                    error=str(exc),
                )

    def update_cursor(self, exchange: str, *, last_time: int, last_tran_id: Optional[str] = None) -> None:
        metadata = self.load_metadata(exchange)
        metadata["lastTime"] = last_time
        if last_tran_id is not None:
            metadata["lastTranId"] = last_tran_id
        self.save_metadata(exchange, metadata)

    # Persist --------------------------------------------------------------

    def append_record(self, exchange: str, record: Dict[str, Any]) -> None:
        """
        將單筆流水寫入 JSONL。
        record 必須包含 timestamp (毫秒) 欄位。
        """
        if "timestamp" not in record:
            raise ValueError("record must contain 'timestamp' (ms)")

        path = self._file_path(exchange, int(record["timestamp"]))
        line = json.dumps(record, ensure_ascii=False)

        with self._lock:
            try:
                with path.open("a", encoding="utf-8") as fh:
                    fh.write(line + "\n")
            except Exception as exc:
                self.logger.error(
                    "income_append_failed",
                    exchange=exchange,
                    path=str(path),
                    error=str(exc),
                )
                raise

    # Query ----------------------------------------------------------------

    def _iter_files(
        self,
        exchange: str,
        start_ts: Optional[int] = None,
        end_ts: Optional[int] = None,
    ) -> Iterable[Path]:
        exchange_dir = self._exchange_dir(exchange)
        files = sorted(exchange_dir.glob("income_*.jsonl"))
        if not files:
            return []

        if start_ts is None and end_ts is None:
            return files

        start_date = (
            datetime.utcfromtimestamp(start_ts / 1000).date()
            if start_ts is not None
            else None
        )
        end_date = (
            datetime.utcfromtimestamp(end_ts / 1000).date()
            if end_ts is not None
            else None
        )

        selected = []
        for path in files:
            try:
                date_part = path.stem.split("_")[1]
                file_date = datetime.strptime(date_part, "%Y%m%d").date()
            except Exception:
                continue

            if start_date and file_date < start_date:
                continue
            if end_date and file_date > end_date:
                continue
            selected.append(path)
        return selected

    def sum_by_type(
        self,
        exchange: str,
        *,
        symbol: Optional[str] = None,
        income_types: Optional[List[str]] = None,
        start_ts: Optional[int] = None,
        end_ts: Optional[int] = None,
    ) -> Dict[str, float]:
        """
        聚合指定條件的流水，回傳 incomeType -> 金額 的字典。
        """
        totals: Dict[str, float] = defaultdict(float)
        files = self._iter_files(exchange, start_ts, end_ts)

        for path in files:
            try:
                with path.open("r", encoding="utf-8") as fh:
                    for line in fh:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            record = json.loads(line)
                        except json.JSONDecodeError:
                            continue

                        record_time = int(record.get("timestamp") or record.get("time", 0))
                        if start_ts is not None and record_time < start_ts:
                            continue
                        if end_ts is not None and record_time > end_ts:
                            continue

                        if symbol:
                            rec_symbol = record.get("symbol") or ""
                            if rec_symbol.upper() != symbol.upper():
                                continue

                        income_type = record.get("incomeType")
                        if income_type is None:
                            continue

                        if income_types and income_type not in income_types:
                            continue

                        try:
                            amount = float(record.get("amount") or record.get("income", 0))
                        except (TypeError, ValueError):
                            continue

                        totals[income_type] += amount
            except Exception as exc:
                self.logger.error(
                    "income_sum_file_failed",
                    exchange=exchange,
                    file=str(path),
                    error=str(exc),
                )

        return dict(totals)

    def aggregate_daily(
        self,
        exchange: str,
        *,
        symbol: Optional[str] = None,
        income_types: Optional[List[str]] = None,
        start_ts: Optional[int] = None,
        end_ts: Optional[int] = None,
    ) -> Dict[str, float]:
        """按日聚合收益資料"""
        daily_totals: Dict[str, float] = defaultdict(float)
        files = self._iter_files(exchange, start_ts, end_ts)

        for path in files:
            try:
                with path.open("r", encoding="utf-8") as fh:
                    for line in fh:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            record = json.loads(line)
                        except json.JSONDecodeError:
                            continue

                        record_time = int(record.get("timestamp") or record.get("time", 0))
                        if start_ts is not None and record_time < start_ts:
                            continue
                        if end_ts is not None and record_time > end_ts:
                            continue

                        if symbol:
                            rec_symbol = record.get("symbol") or ""
                            if rec_symbol.upper() != symbol.upper():
                                continue

                        income_type = record.get("incomeType")
                        if income_type is None:
                            continue

                        if income_types and income_type not in income_types:
                            continue

                        try:
                            amount = float(record.get("amount") or record.get("income", 0))
                        except (TypeError, ValueError):
                            continue

                        day_key = datetime.utcfromtimestamp(record_time / 1000).strftime("%Y-%m-%d")
                        daily_totals[day_key] += amount
            except Exception as exc:
                self.logger.error(
                    "income_daily_aggregate_failed",
                    exchange=exchange,
                    file=str(path),
                    error=str(exc),
                )

        return dict(daily_totals)
