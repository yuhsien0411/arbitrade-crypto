"""
Binance UM 損益流水同步器
"""

import asyncio
from typing import Optional, Sequence, Set, Tuple

from ..exchanges.binance import BinanceExchange
from ..utils.logger import get_logger
from .income_repository import IncomeRepository


class BinanceIncomeSynchronizer:
    """
    從 /papi/v1/um/income 取得 Binance Portfolio Margin 收益紀錄並持久化。
    """

    DEFAULT_TYPES = ["REALIZED_PNL", "COMMISSION", "FUNDING_FEE"]

    def __init__(
        self,
        exchange: BinanceExchange,
        repository: Optional[IncomeRepository] = None,
        income_types: Optional[Sequence[str]] = None,
    ):
        self.exchange = exchange
        self.repository = repository or IncomeRepository()
        self.logger = get_logger()
        self.income_types = list(income_types) if income_types else self.DEFAULT_TYPES

    async def sync(
        self,
        *,
        start_time: Optional[int] = None,
        limit: int = 1000,
        sleep_interval: float = 0.2,
    ) -> int:
        """
        從 Binance 拉取流水，返回新增筆數。
        """
        exchange_key = "binance"
        metadata = self.repository.load_metadata(exchange_key)

        cursor_time = int(metadata.get("lastTime") or 0)
        cursor_tran = str(metadata.get("lastTranId") or "")

        if start_time is not None:
            cursor_time = max(cursor_time, int(start_time))

        total_new = 0
        fetch_start = cursor_time if cursor_time > 0 else start_time
        seen_keys: Set[Tuple[int, str, str]] = set()

        while True:
            response = await self.exchange.get_um_income(
                start_time=fetch_start,
                limit=limit,
            )
            if not response:
                break

            records = sorted(
                response,
                key=lambda item: (
                    int(item.get("time", 0)),
                    str(item.get("tranId") or ""),
                ),
            )

            batch_progress = False

            for item in records:
                income_type = item.get("incomeType")
                if self.income_types and income_type not in self.income_types:
                    continue

                time_ms = int(item.get("time", 0))
                tran_id = str(item.get("tranId") or "")

                if time_ms < cursor_time:
                    continue
                if (
                    time_ms == cursor_time
                    and cursor_tran
                    and tran_id <= cursor_tran
                ):
                    continue

                key = (time_ms, tran_id, income_type)
                if key in seen_keys:
                    continue
                seen_keys.add(key)

                amount = self._safe_float(item.get("income"))

                record = {
                    "exchange": exchange_key,
                    "symbol": (item.get("symbol") or "").upper(),
                    "incomeType": income_type,
                    "amount": amount,
                    "asset": item.get("asset"),
                    "info": item.get("info"),
                    "timestamp": time_ms,
                    "tranId": tran_id,
                    "tradeId": item.get("tradeId"),
                }

                await asyncio.to_thread(
                    self.repository.append_record,
                    exchange_key,
                    record,
                )
                cursor_time = time_ms
                cursor_tran = tran_id
                batch_progress = True
                total_new += 1

            if cursor_time:
                fetch_start = cursor_time

            if len(response) < limit:
                break
            if not batch_progress:
                break

            if sleep_interval:
                await asyncio.sleep(sleep_interval)

        if total_new > 0 and cursor_time:
            metadata["lastTime"] = cursor_time
            metadata["lastTranId"] = cursor_tran
            self.repository.save_metadata(exchange_key, metadata)

        return total_new

    @staticmethod
    def _safe_float(value) -> float:
        try:
            return float(value)
        except (TypeError, ValueError):
            return 0.0
