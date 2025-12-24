#!/usr/bin/env python3
"""
修復缺失 threshold 字段的執行記錄
為舊的執行記錄添加 threshold 字段，從監控對配置中獲取
"""

import json
import os
import sys
from pathlib import Path

# 添加項目根目錄到 Python 路徑
project_root = Path(__file__).parent.parent.parent
sys.path.insert(0, str(project_root))

from python_backend.app.api.routes_monitoring import monitoring_pairs

def fix_missing_threshold():
    """修復缺失 threshold 字段的執行記錄"""
    
    # 數據目錄
    data_dir = project_root / "data" / "arbitrage"
    
    if not data_dir.exists():
        print(f"數據目錄不存在: {data_dir}")
        return
    
    # 查找所有 JSONL 文件
    jsonl_files = list(data_dir.glob("executions_*.jsonl"))
    
    if not jsonl_files:
        print("未找到執行記錄文件")
        return
    
    for jsonl_file in jsonl_files:
        print(f"處理文件: {jsonl_file}")
        
        # 讀取文件
        records = []
        with open(jsonl_file, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if line:
                    try:
                        record = json.loads(line)
                        records.append(record)
                    except json.JSONDecodeError as e:
                        print(f"跳過無效的 JSON 行: {line[:100]}...")
                        continue
        
        # 統計需要修復的記錄
        fixed_count = 0
        for record in records:
            pair_id = record.get('pairId')
            if not pair_id:
                continue
                
            # 如果記錄中沒有 threshold 字段
            if 'threshold' not in record:
                # 從監控對配置中獲取 threshold
                pair_config = monitoring_pairs.get(pair_id, {})
                threshold = pair_config.get('threshold', 0.0)  # 默認值為 0.0
                
                # 添加 threshold 字段
                record['threshold'] = threshold
                fixed_count += 1
                print(f"  修復記錄 {pair_id}: 添加 threshold = {threshold}")
        
        if fixed_count > 0:
            # 備份原文件
            backup_file = jsonl_file.with_suffix('.jsonl.backup')
            if not backup_file.exists():
                import shutil
                shutil.copy2(jsonl_file, backup_file)
                print(f"  已創建備份文件: {backup_file}")
            
            # 寫入修復後的記錄
            with open(jsonl_file, 'w', encoding='utf-8') as f:
                for record in records:
                    f.write(json.dumps(record, ensure_ascii=False) + '\n')
            
            print(f"  修復完成: {fixed_count} 條記錄")
        else:
            print(f"  無需修復")
    
    print("所有文件處理完成")

if __name__ == "__main__":
    fix_missing_threshold()
