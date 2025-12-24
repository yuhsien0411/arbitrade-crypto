#!/usr/bin/env python3
"""
資料遷移腳本：將舊格式的 JSONL 檔案轉換為新的統一格式
"""

import os
import json
import time
from pathlib import Path
from typing import Dict, Any, List
import shutil
from datetime import datetime

# 添加專案根目錄到 Python 路徑
import sys
sys.path.append(str(Path(__file__).parent.parent))

from app.models.arbitrage import ExecutionRecord, ExecutionLeg


def backup_file(file_path: str) -> str:
    """備份原始檔案"""
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_path = f"{file_path}.backup_{timestamp}"
    shutil.copy2(file_path, backup_path)
    print(f"✅ 已備份原始檔案: {backup_path}")
    return backup_path


def migrate_execution_record(old_record: Dict[str, Any]) -> Dict[str, Any]:
    """將舊格式的執行記錄轉換為新格式"""
    try:
        # 建立新格式的執行記錄
        new_record = ExecutionRecord(
            ts=old_record.get("ts", int(time.time() * 1000)),
            pairId=old_record.get("pairId", "unknown"),
            qty=float(old_record.get("qty", 0.001)),
            status=old_record.get("status", "success"),
            maxExecs=int(old_record.get("maxExecs", 1)),
            totalTriggers=int(old_record.get("totalTriggers", 1)),
            leg1=ExecutionLeg(
                exchange=old_record.get("leg1", {}).get("exchange", "bybit"),
                symbol=old_record.get("leg1", {}).get("symbol", "BTCUSDT"),
                type=old_record.get("leg1", {}).get("type", "spot"),
                side=old_record.get("leg1", {}).get("side", "buy"),
                orderId=old_record.get("leg1", {}).get("orderId")
            ),
            leg2=ExecutionLeg(
                exchange=old_record.get("leg2", {}).get("exchange", "bybit"),
                symbol=old_record.get("leg2", {}).get("symbol", "BTCUSDT"),
                type=old_record.get("leg2", {}).get("type", "spot"),
                side=old_record.get("leg2", {}).get("side", "sell"),
                orderId=old_record.get("leg2", {}).get("orderId")
            ),
            # 向後兼容欄位
            success=old_record.get("success"),
            reason=old_record.get("reason"),
            error=old_record.get("error")
        )
        
        # 轉換為字典格式（使用 alias）
        return new_record.dict(by_alias=True)
        
    except Exception as e:
        print(f"❌ 轉換記錄失敗: {e}")
        print(f"   原始記錄: {old_record}")
        return old_record  # 保留原始記錄


def migrate_jsonl_file(file_path: str) -> bool:
    """遷移單個 JSONL 檔案"""
    if not os.path.exists(file_path):
        print(f"⚠️  檔案不存在: {file_path}")
        return False
    
    print(f"🔄 開始遷移檔案: {file_path}")
    
    # 備份原始檔案
    backup_path = backup_file(file_path)
    
    try:
        # 讀取原始資料
        original_records = []
        with open(file_path, 'r', encoding='utf-8') as f:
            for line_num, line in enumerate(f, 1):
                line = line.strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                    original_records.append(record)
                except json.JSONDecodeError as e:
                    print(f"⚠️  第 {line_num} 行 JSON 解析失敗: {e}")
                    continue
        
        print(f"📊 讀取到 {len(original_records)} 筆記錄")
        
        # 轉換資料
        migrated_records = []
        for i, record in enumerate(original_records):
            migrated_record = migrate_execution_record(record)
            migrated_records.append(migrated_record)
            
            if (i + 1) % 100 == 0:
                print(f"   已處理 {i + 1}/{len(original_records)} 筆記錄")
        
        # 寫入新格式檔案
        with open(file_path, 'w', encoding='utf-8') as f:
            for record in migrated_records:
                f.write(json.dumps(record, ensure_ascii=False) + '\n')
        
        print(f"✅ 遷移完成: {len(migrated_records)} 筆記錄")
        return True
        
    except Exception as e:
        print(f"❌ 遷移失敗: {e}")
        # 恢復備份
        shutil.copy2(backup_path, file_path)
        print(f"🔄 已恢復原始檔案")
        return False


def find_jsonl_files(data_dir: str) -> List[str]:
    """尋找所有 JSONL 檔案"""
    jsonl_files = []
    data_path = Path(data_dir)
    
    if not data_path.exists():
        print(f"⚠️  資料目錄不存在: {data_dir}")
        return jsonl_files
    
    # 尋找 arbitrage 目錄下的 JSONL 檔案
    arbitrage_dir = data_path / "arbitrage"
    if arbitrage_dir.exists():
        for file_path in arbitrage_dir.glob("*.jsonl"):
            jsonl_files.append(str(file_path))
    
    return jsonl_files


def validate_migrated_data(file_path: str) -> bool:
    """驗證遷移後的資料格式"""
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            for line_num, line in enumerate(f, 1):
                line = line.strip()
                if not line:
                    continue
                
                try:
                    record = json.loads(line)
                    # 嘗試用 Pydantic 模型驗證
                    ExecutionRecord(**record)
                except Exception as e:
                    print(f"❌ 第 {line_num} 行驗證失敗: {e}")
                    return False
        
        print(f"✅ 資料格式驗證通過: {file_path}")
        return True
        
    except Exception as e:
        print(f"❌ 驗證過程出錯: {e}")
        return False


def main():
    """主要遷移流程"""
    print("🚀 開始資料遷移...")
    print("=" * 50)
    
    # 確定資料目錄
    script_dir = Path(__file__).parent
    project_root = script_dir.parent.parent
    data_dir = project_root / "data"
    
    print(f"📁 專案根目錄: {project_root}")
    print(f"📁 資料目錄: {data_dir}")
    
    # 尋找 JSONL 檔案
    jsonl_files = find_jsonl_files(str(data_dir))
    
    if not jsonl_files:
        print("ℹ️  沒有找到需要遷移的 JSONL 檔案")
        return
    
    print(f"📋 找到 {len(jsonl_files)} 個 JSONL 檔案:")
    for file_path in jsonl_files:
        print(f"   - {file_path}")
    
    # 確認是否繼續
    response = input("\n是否繼續遷移？(y/N): ").strip().lower()
    if response != 'y':
        print("❌ 取消遷移")
        return
    
    # 執行遷移
    success_count = 0
    for file_path in jsonl_files:
        print(f"\n{'='*50}")
        if migrate_jsonl_file(file_path):
            # 驗證遷移結果
            if validate_migrated_data(file_path):
                success_count += 1
            else:
                print(f"⚠️  檔案遷移成功但驗證失敗: {file_path}")
        else:
            print(f"❌ 檔案遷移失敗: {file_path}")
    
    # 總結
    print(f"\n{'='*50}")
    print(f"📊 遷移總結:")
    print(f"   - 總檔案數: {len(jsonl_files)}")
    print(f"   - 成功遷移: {success_count}")
    print(f"   - 失敗數量: {len(jsonl_files) - success_count}")
    
    if success_count == len(jsonl_files):
        print("🎉 所有檔案遷移成功！")
    else:
        print("⚠️  部分檔案遷移失敗，請檢查錯誤訊息")


if __name__ == "__main__":
    main()
