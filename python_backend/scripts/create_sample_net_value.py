"""
創建示例淨值數據
生成最近30天的淨值記錄，模擬真實的資產變化
"""
import json
from datetime import datetime, timedelta
from pathlib import Path
import random

# 創建數據目錄
data_dir = Path("../data/net_value")
data_dir.mkdir(parents=True, exist_ok=True)

# 起始參數
start_date = datetime.now() - timedelta(days=30)
initial_balance = 10000.0  # 初始淨值 10000 USDT
current_balance = initial_balance

# 生成30天的數據，每小時一條記錄
records_by_date = {}

for day_offset in range(31):  # 包含今天
    current_date = start_date + timedelta(days=day_offset)
    date_key = current_date.strftime('%Y%m%d')
    records_by_date[date_key] = []
    
    for hour in range(24):
        timestamp = current_date.replace(hour=hour, minute=0, second=0, microsecond=0)
        
        # 模擬資產變化（隨機波動 + 輕微上升趨勢）
        # 每小時變化 -0.5% 到 +1.5%，整體呈現上升趨勢
        change_percent = random.uniform(-0.5, 1.5)
        current_balance = current_balance * (1 + change_percent / 100)
        
        # 添加一些事件性波動
        if random.random() < 0.05:  # 5% 概率大波動
            event_change = random.uniform(-2, 3)
            current_balance = current_balance * (1 + event_change / 100)
        
        # 確保不會降到太低
        current_balance = max(current_balance, initial_balance * 0.85)
        
        record = {
            "ts": int(timestamp.timestamp() * 1000),
            "datetime": timestamp.strftime("%Y-%m-%d %H:%M:%S"),
            "totalUSDT": round(current_balance, 2),
            "balances": {
                "bybit": {
                    "USDT": round(current_balance * 0.7, 2),
                    "BTC": round(current_balance * 0.2 / 68000, 6),  # 假設 BTC 價格
                    "ETH": round(current_balance * 0.1 / 3800, 6)    # 假設 ETH 價格
                }
            }
        }
        
        records_by_date[date_key].append(record)

# 寫入文件
total_records = 0
for date_key, records in records_by_date.items():
    filename = f"net_value_{date_key}.jsonl"
    filepath = data_dir / filename
    
    with open(filepath, 'w', encoding='utf-8') as f:
        for record in records:
            f.write(json.dumps(record, ensure_ascii=False) + '\n')
    
    total_records += len(records)
    print(f"✅ 已創建 {filename}，包含 {len(records)} 條記錄")

print(f"\n🎉 完成！共創建 {total_records} 條淨值記錄")
print(f"📊 初始淨值: {initial_balance:.2f} USDT")
print(f"📊 最終淨值: {current_balance:.2f} USDT")
print(f"📈 總收益: {current_balance - initial_balance:.2f} USDT ({(current_balance/initial_balance - 1) * 100:.2f}%)")

