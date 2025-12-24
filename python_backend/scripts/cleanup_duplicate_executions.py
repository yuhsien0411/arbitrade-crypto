"""
清理 JSONL 執行記錄中的重複記錄

用途：移除因為舊版本 bug 產生的重複記錄
規則：對於每個 pairId，如果有多筆記錄，只保留成功記錄；如果沒有成功記錄，保留最後一筆
"""

import os
import json
import time
from typing import Dict, List
from collections import defaultdict


def cleanup_jsonl_file(file_path: str, dry_run: bool = True) -> None:
    """
    清理指定的 JSONL 文件
    
    Args:
        file_path: JSONL 文件路徑
        dry_run: 如果為 True，只顯示會做什麼，不實際修改文件
    """
    if not os.path.exists(file_path):
        print(f"❌ 文件不存在: {file_path}")
        return
    
    print(f"📂 處理文件: {file_path}")
    print(f"🔧 模式: {'模擬運行（不會修改文件）' if dry_run else '實際清理'}")
    
    # 讀取所有記錄
    records: List[dict] = []
    with open(file_path, 'r', encoding='utf-8') as f:
        for line_num, line in enumerate(f, 1):
            try:
                record = json.loads(line.strip())
                records.append(record)
            except json.JSONDecodeError as e:
                print(f"⚠️ 第 {line_num} 行 JSON 解析失敗: {e}")
    
    print(f"📊 讀取記錄總數: {len(records)}")
    
    # 按 pairId 分組
    grouped: Dict[str, List[dict]] = defaultdict(list)
    for record in records:
        pair_id = record.get('pairId', 'unknown')
        grouped[pair_id].append(record)
    
    print(f"📦 不同的 pairId 數量: {len(grouped)}")
    
    # 過濾重複記錄
    filtered_records: List[dict] = []
    duplicate_count = 0
    
    for pair_id, pair_records in grouped.items():
        if len(pair_records) == 1:
            # 只有一筆記錄，直接保留
            filtered_records.append(pair_records[0])
        else:
            # 有多筆記錄，需要過濾
            print(f"\n🔍 pairId: {pair_id} 有 {len(pair_records)} 筆記錄")
            
            # 優先找成功記錄
            success_records = [r for r in pair_records if r.get('status') == 'success']
            
            if success_records:
                # 如果有成功記錄，選擇第一筆成功記錄
                selected = success_records[0]
                print(f"  ✅ 選擇成功記錄 (ts={selected.get('ts')})")
                filtered_records.append(selected)
                duplicate_count += len(pair_records) - 1
                
                # 顯示被移除的記錄
                for r in pair_records:
                    if r != selected:
                        print(f"  🗑️ 移除記錄: status={r.get('status')}, ts={r.get('ts')}")
            else:
                # 沒有成功記錄，選擇最後一筆（按時間戳）
                sorted_records = sorted(pair_records, key=lambda r: r.get('ts', 0), reverse=True)
                selected = sorted_records[0]
                print(f"  📝 選擇最後記錄: status={selected.get('status')}, ts={selected.get('ts')}")
                filtered_records.append(selected)
                duplicate_count += len(pair_records) - 1
                
                # 顯示被移除的記錄
                for r in sorted_records[1:]:
                    print(f"  🗑️ 移除記錄: status={r.get('status')}, ts={r.get('ts')}")
    
    print(f"\n📊 清理結果:")
    print(f"  原始記錄數: {len(records)}")
    print(f"  清理後記錄數: {len(filtered_records)}")
    print(f"  移除重複記錄: {duplicate_count}")
    
    if not dry_run:
        # 備份原文件
        backup_path = f"{file_path}.backup.{int(time.time())}"
        print(f"\n💾 備份原文件到: {backup_path}")
        with open(backup_path, 'w', encoding='utf-8') as f:
            with open(file_path, 'r', encoding='utf-8') as original:
                f.write(original.read())
        
        # 寫入清理後的記錄
        print(f"✍️ 寫入清理後的記錄...")
        with open(file_path, 'w', encoding='utf-8') as f:
            for record in filtered_records:
                f.write(json.dumps(record, ensure_ascii=False) + '\n')
        
        print(f"✅ 清理完成！")
    else:
        print(f"\n💡 提示: 使用 --execute 參數執行實際清理")


def main():
    import argparse
    
    parser = argparse.ArgumentParser(description='清理 JSONL 執行記錄中的重複記錄')
    parser.add_argument('--file', '-f', type=str, help='指定要清理的 JSONL 文件')
    parser.add_argument('--all', '-a', action='store_true', help='清理所有執行記錄文件')
    parser.add_argument('--execute', '-e', action='store_true', help='實際執行清理（默認為模擬運行）')
    
    args = parser.parse_args()
    
    # 確定數據目錄
    script_dir = os.path.dirname(os.path.abspath(__file__))
    base_dir = os.path.abspath(os.path.join(script_dir, '../../..'))
    data_dir = os.path.join(base_dir, 'data', 'arbitrage')
    
    print("=" * 60)
    print("🧹 JSONL 執行記錄清理工具")
    print("=" * 60)
    print(f"📁 數據目錄: {data_dir}")
    print()
    
    if args.file:
        # 清理指定文件
        cleanup_jsonl_file(args.file, dry_run=not args.execute)
    elif args.all:
        # 清理所有執行記錄文件
        if not os.path.exists(data_dir):
            print(f"❌ 數據目錄不存在: {data_dir}")
            return
        
        jsonl_files = [f for f in os.listdir(data_dir) if f.startswith('executions_') and f.endswith('.jsonl')]
        
        if not jsonl_files:
            print("❌ 沒有找到執行記錄文件")
            return
        
        print(f"📂 找到 {len(jsonl_files)} 個執行記錄文件:")
        for f in jsonl_files:
            print(f"  - {f}")
        print()
        
        for filename in jsonl_files:
            file_path = os.path.join(data_dir, filename)
            cleanup_jsonl_file(file_path, dry_run=not args.execute)
            print()
    else:
        # 默認清理當日文件
        day_str = time.strftime('%Y%m%d')
        file_path = os.path.join(data_dir, f'executions_{day_str}.jsonl')
        
        if os.path.exists(file_path):
            cleanup_jsonl_file(file_path, dry_run=not args.execute)
        else:
            print(f"❌ 當日執行記錄文件不存在: {file_path}")
            print(f"💡 提示: 使用 --all 參數清理所有文件")


if __name__ == '__main__':
    main()

