"""
遷移舊格式執行記錄到統一格式 V2

此腳本將舊格式的 TWAP 和 Pairs 執行記錄轉換為新的統一格式。

統一格式變更：
- 移除 executionIndex，統一使用 totalTriggers（從1開始）
- 移除 sliceQty，統一使用 qty
- 移除 originalSliceIndex，只保留 isRollback 標記
- 移除 planId，改用 pairId/twapId
- 添加 mode, strategyId, reason, error 等欄位

使用方法：
    python -m python_backend.scripts.migrate_to_unified_format_v2
"""

import os
import json
import sys
from pathlib import Path
from typing import Dict, List, Any
from datetime import datetime


class UnifiedFormatMigrator:
    """統一格式遷移器"""
    
    def __init__(self, base_dir: str = None):
        if base_dir is None:
            # 預設為專案根目錄
            current_file = Path(__file__).resolve()
            self.base_dir = current_file.parent.parent.parent
        else:
            self.base_dir = Path(base_dir)
        
        self.arbitrage_dir = self.base_dir / "data" / "arbitrage"
        self.twap_dir = self.base_dir / "data" / "twap"
        
        print(f"基礎目錄: {self.base_dir}")
        print(f"Pairs 資料目錄: {self.arbitrage_dir}")
        print(f"TWAP 資料目錄: {self.twap_dir}")
    
    def migrate_pair_record(self, record: Dict[str, Any]) -> Dict[str, Any]:
        """遷移單筆 Pairs 記錄到統一格式
        
        Args:
            record: 舊格式的 Pairs 記錄
            
        Returns:
            統一格式的 Pairs 記錄
        """
        # 如果已經是新格式，直接返回
        if "mode" in record and "strategyId" in record and "twapId" in record:
            return record
        
        pair_id = record.get("pairId")
        
        # 構建統一格式
        unified = {
            "ts": record.get("ts", 0),
            "mode": "pair",
            "strategyId": pair_id,
            "pairId": pair_id,
            "twapId": None,
            
            # 統一使用 totalTriggers（從1開始）
            "totalTriggers": record.get("totalTriggers") or record.get("executionIndex") or 1,
            
            "status": record.get("status", "success"),
            "reason": record.get("reason"),
            "error": record.get("error"),
            
            # 統一使用 qty
            "qty": record.get("qty") or record.get("sliceQty") or 0,
            "spread": record.get("spread"),
            "spreadPercent": record.get("spreadPercent"),
            
            "totalAmount": record.get("totalAmount") or (
                record.get("maxExecs", 1) * record.get("qty", 0)
            ),
            "orderCount": record.get("orderCount") or record.get("maxExecs") or 1,
            "threshold": record.get("threshold"),
            "intervalMs": None,
            
            "isRollback": record.get("isRollback", False),
            
            "leg1": record.get("leg1"),
            "leg2": record.get("leg2"),
        }
        
        # 確保 leg1/leg2 包含所有必要欄位
        for leg_key in ["leg1", "leg2"]:
            if unified[leg_key]:
                leg = unified[leg_key]
                if "originalOrderId" not in leg:
                    leg["originalOrderId"] = None
                if "priceUpdated" not in leg:
                    leg["priceUpdated"] = bool(leg.get("price") and float(leg.get("price", 0)) > 0)
        
        return unified
    
    def migrate_twap_record(self, record: Dict[str, Any]) -> Dict[str, Any]:
        """遷移單筆 TWAP 記錄到統一格式
        
        Args:
            record: 舊格式的 TWAP 記錄
            
        Returns:
            統一格式的 TWAP 記錄
        """
        # 如果已經是新格式，直接返回
        if "mode" in record and "strategyId" in record and "pairId" in record:
            return record
        
        plan_id = record.get("planId") or record.get("twapId")
        slice_index = record.get("sliceIndex", 0)
        
        # 構建統一格式
        unified = {
            "ts": record.get("ts", 0),
            "mode": "twap",
            "strategyId": plan_id,
            "pairId": None,
            "twapId": plan_id,
            
            # 統一使用 totalTriggers（從1開始）
            "totalTriggers": record.get("executionIndex") or (slice_index + 1),
            
            "status": record.get("status", "success"),
            "reason": record.get("reason"),
            "error": record.get("error"),
            
            # 統一使用 qty
            "qty": record.get("qty") or record.get("sliceQty") or 0,
            "spread": record.get("spread"),
            "spreadPercent": record.get("spreadPercent"),
            
            "totalAmount": record.get("totalAmount", 0),
            "orderCount": record.get("orderCount", 0),
            "threshold": None,
            "intervalMs": record.get("intervalMs"),
            
            "isRollback": record.get("isRollback", False),
            
            "leg1": record.get("leg1"),
            "leg2": record.get("leg2"),
        }
        
        # 確保 leg1/leg2 包含所有必要欄位
        for leg_key in ["leg1", "leg2"]:
            if unified[leg_key]:
                leg = unified[leg_key]
                if "originalOrderId" not in leg:
                    leg["originalOrderId"] = leg.get("originalOrderId") or None
                if "priceUpdated" not in leg:
                    leg["priceUpdated"] = bool(leg.get("price") and float(leg.get("price", 0)) > 0)
        
        return unified
    
    def migrate_file(self, file_path: Path, is_twap: bool = False) -> tuple[int, int]:
        """遷移單個 JSONL 文件
        
        Args:
            file_path: 文件路徑
            is_twap: 是否為 TWAP 文件
            
        Returns:
            (成功遷移數量, 總記錄數量)
        """
        if not file_path.exists():
            print(f"⚠️  文件不存在: {file_path}")
            return 0, 0
        
        print(f"\n處理文件: {file_path.name}")
        
        # 讀取所有記錄
        records = []
        with open(file_path, 'r', encoding='utf-8') as f:
            for line_num, line in enumerate(f, 1):
                line = line.strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                    records.append(record)
                except json.JSONDecodeError as e:
                    print(f"  ⚠️  第 {line_num} 行 JSON 解析失敗: {e}")
                    continue
        
        total_count = len(records)
        if total_count == 0:
            print(f"  ℹ️  文件為空")
            return 0, 0
        
        # 遷移記錄
        migrated_records = []
        migrate_func = self.migrate_twap_record if is_twap else self.migrate_pair_record
        
        for record in records:
            try:
                unified = migrate_func(record)
                migrated_records.append(unified)
            except Exception as e:
                print(f"  ⚠️  記錄遷移失敗: {e}")
                # 保留原始記錄
                migrated_records.append(record)
        
        # 備份原始文件
        backup_path = file_path.with_suffix(f".jsonl.backup_{datetime.now().strftime('%Y%m%d_%H%M%S')}")
        file_path.rename(backup_path)
        print(f"  ✅ 備份原始文件: {backup_path.name}")
        
        # 寫入遷移後的記錄
        with open(file_path, 'w', encoding='utf-8') as f:
            for record in migrated_records:
                f.write(json.dumps(record, ensure_ascii=False) + '\n')
        
        success_count = len(migrated_records)
        print(f"  ✅ 遷移完成: {success_count}/{total_count} 筆記錄")
        
        return success_count, total_count
    
    def migrate_all(self, dry_run: bool = False):
        """遷移所有文件
        
        Args:
            dry_run: 是否為測試模式（不實際寫入文件）
        """
        if dry_run:
            print("\n🔍 測試模式：只分析，不修改文件\n")
        else:
            print("\n🚀 開始遷移...\n")
        
        total_success = 0
        total_records = 0
        
        # 遷移 Pairs 文件
        print("=" * 60)
        print("遷移 Pairs 執行記錄")
        print("=" * 60)
        
        if self.arbitrage_dir.exists():
            for file_path in sorted(self.arbitrage_dir.glob("executions_*.jsonl")):
                if dry_run:
                    # 只讀取並分析
                    with open(file_path, 'r', encoding='utf-8') as f:
                        count = sum(1 for line in f if line.strip())
                    print(f"  📄 {file_path.name}: {count} 筆記錄")
                    total_records += count
                else:
                    success, count = self.migrate_file(file_path, is_twap=False)
                    total_success += success
                    total_records += count
        else:
            print(f"⚠️  目錄不存在: {self.arbitrage_dir}")
        
        # 遷移 TWAP 文件
        print("\n" + "=" * 60)
        print("遷移 TWAP 執行記錄")
        print("=" * 60)
        
        if self.twap_dir.exists():
            for file_path in sorted(self.twap_dir.glob("executions_*.jsonl")):
                if dry_run:
                    # 只讀取並分析
                    with open(file_path, 'r', encoding='utf-8') as f:
                        count = sum(1 for line in f if line.strip())
                    print(f"  📄 {file_path.name}: {count} 筆記錄")
                    total_records += count
                else:
                    success, count = self.migrate_file(file_path, is_twap=True)
                    total_success += success
                    total_records += count
        else:
            print(f"⚠️  目錄不存在: {self.twap_dir}")
        
        # 總結
        print("\n" + "=" * 60)
        if dry_run:
            print(f"📊 分析完成: 共 {total_records} 筆記錄")
        else:
            print(f"✅ 遷移完成: {total_success}/{total_records} 筆記錄")
            print(f"📁 備份文件已保存在原始目錄中")
        print("=" * 60)


def main():
    """主函數"""
    import argparse
    
    parser = argparse.ArgumentParser(description="遷移執行記錄到統一格式 V2")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="測試模式：只分析，不修改文件"
    )
    parser.add_argument(
        "--base-dir",
        type=str,
        default=None,
        help="專案根目錄（預設為自動偵測）"
    )
    
    args = parser.parse_args()
    
    try:
        migrator = UnifiedFormatMigrator(base_dir=args.base_dir)
        migrator.migrate_all(dry_run=args.dry_run)
    except KeyboardInterrupt:
        print("\n\n⚠️  使用者中斷")
        sys.exit(1)
    except Exception as e:
        print(f"\n❌ 錯誤: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()

