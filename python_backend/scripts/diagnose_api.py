#!/usr/bin/env python3
"""
Bybit API 診斷工具
幫助診斷 ErrCode: 10003 權限問題
"""

import sys
import os
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pybit.unified_trading import HTTP
from app.config.env import config
import json

def diagnose_bybit_api():
    """診斷 Bybit API 權限問題"""
    
    print("🔍 Bybit API 診斷工具")
    print("=" * 50)
    
    # 檢查 API 密鑰配置
    api_key = config.BYBIT_API_KEY
    api_secret = config.BYBIT_SECRET
    
    if not api_key or not api_secret:
        print("❌ API 密鑰未配置")
        print("請在 .env 文件中配置 BYBIT_API_KEY 和 BYBIT_SECRET")
        return
    
    print(f"✅ API Key: {api_key[:8]}...{api_key[-4:]}")
    print(f"✅ Secret: {'*' * len(api_secret)}")
    
    # 初始化客戶端
    try:
        client = HTTP(
            testnet=False,  # 使用主網
            api_key=api_key,
            api_secret=api_secret
        )
        print("✅ 客戶端初始化成功")
    except Exception as e:
        print(f"❌ 客戶端初始化失敗: {e}")
        return
    
    # 測試 1: 基本連接
    print("\n📡 測試 1: 基本連接")
    try:
        server_time = client.get_server_time()
        if server_time.get("retCode") == 0:
            print("✅ 服務器連接正常")
        else:
            print(f"❌ 服務器連接失敗: {server_time}")
    except Exception as e:
        print(f"❌ 服務器連接異常: {e}")
    
    # 測試 2: API 密鑰權限
    print("\n🔑 測試 2: API 密鑰權限")
    try:
        account_info = client.get_account_info()
        if account_info.get("retCode") == 0:
            print("✅ API 密鑰有效，帳戶信息獲取成功")
            result = account_info.get("result", {})
            print(f"   帳戶類型: {result.get('unifiedMarginStatus', 'Unknown')}")
            print(f"   保證金模式: {result.get('marginMode', 'Unknown')}")
        else:
            print(f"❌ API 密鑰權限問題: {account_info}")
            print("   可能原因:")
            print("   - API 密鑰權限不足")
            print("   - IP 不在白名單中")
            print("   - 帳戶被限制")
    except Exception as e:
        print(f"❌ API 密鑰測試異常: {e}")
    
    # 測試 3: 現貨餘額查詢
    print("\n💰 測試 3: 現貨餘額查詢")
    try:
        wallet_balance = client.get_wallet_balance(accountType="UNIFIED")
        if wallet_balance.get("retCode") == 0:
            print("✅ 餘額查詢成功")
            balances = wallet_balance.get("result", {}).get("list", [])
            if balances:
                coins = balances[0].get("coin", [])
                usdt_balance = None
                for coin in coins:
                    if coin.get("coin") == "USDT":
                        usdt_balance = float(coin.get("walletBalance", 0))
                        break
                
                if usdt_balance and usdt_balance > 0:
                    print(f"   USDT 餘額: {usdt_balance}")
                else:
                    print("   ⚠️  USDT 餘額不足或為 0")
            else:
                print("   ⚠️  無餘額信息")
        else:
            print(f"❌ 餘額查詢失敗: {wallet_balance}")
    except Exception as e:
        print(f"❌ 餘額查詢異常: {e}")
    
    # 測試 4: 現貨交易權限
    print("\n🛒 測試 4: 現貨交易權限")
    try:
        # 嘗試獲取現貨交易規則
        instruments = client.get_instruments_info(category="spot", symbol="BTCUSDT")
        if instruments.get("retCode") == 0:
            print("✅ 現貨市場數據訪問正常")
            
            # 嘗試模擬下單（不會實際執行）
            print("   測試下單權限...")
            
            # 這裡我們不實際下單，而是檢查帳戶是否有交易權限
            # 通過查詢訂單歷史來判斷
            try:
                order_history = client.get_order_history(category="spot", limit=1)
                if order_history.get("retCode") == 0:
                    print("✅ 現貨交易權限正常")
                elif order_history.get("retCode") == 10003:
                    print("❌ 現貨交易權限不足 (ErrCode: 10003)")
                    print("   解決方案:")
                    print("   1. 登入 Bybit 官網")
                    print("   2. 進入 API 管理 > 編輯 API")
                    print("   3. 確認勾選「現貨交易」權限")
                    print("   4. 檢查 IP 白名單設置")
                else:
                    print(f"❌ 現貨交易權限檢查失敗: {order_history}")
            except Exception as e:
                print(f"❌ 現貨交易權限檢查異常: {e}")
                
        else:
            print(f"❌ 現貨市場數據訪問失敗: {instruments}")
    except Exception as e:
        print(f"❌ 現貨交易權限測試異常: {e}")
    
    # 測試 5: 合約交易權限
    print("\n📈 測試 5: 合約交易權限")
    try:
        # 嘗試獲取合約交易規則
        instruments = client.get_instruments_info(category="linear", symbol="BTCUSDT")
        if instruments.get("retCode") == 0:
            print("✅ 合約市場數據訪問正常")
            
            # 檢查合約交易權限
            try:
                order_history = client.get_order_history(category="linear", limit=1)
                if order_history.get("retCode") == 0:
                    print("✅ 合約交易權限正常")
                elif order_history.get("retCode") == 10003:
                    print("❌ 合約交易權限不足 (ErrCode: 10003)")
                    print("   解決方案:")
                    print("   1. 登入 Bybit 官網")
                    print("   2. 進入 API 管理 > 編輯 API")
                    print("   3. 確認勾選「合約交易」權限")
                else:
                    print(f"❌ 合約交易權限檢查失敗: {order_history}")
            except Exception as e:
                print(f"❌ 合約交易權限檢查異常: {e}")
                
        else:
            print(f"❌ 合約市場數據訪問失敗: {instruments}")
    except Exception as e:
        print(f"❌ 合約交易權限測試異常: {e}")
    
    print("\n" + "=" * 50)
    print("🎯 診斷完成")
    print("\n如果看到 ErrCode: 10003，請按照上述解決方案操作：")
    print("1. 檢查 API 權限設置")
    print("2. 確認 IP 白名單")
    print("3. 驗證帳戶狀態")
    print("4. 確保有足夠餘額")

if __name__ == "__main__":
    diagnose_bybit_api()
