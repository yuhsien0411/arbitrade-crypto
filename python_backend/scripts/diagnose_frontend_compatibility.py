"""
前后端兼容性诊断工具
用于检查旧版前端与新后端的兼容性问题
"""

import asyncio
import sys
import os

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.services.arbitrage_engine import arb_engine
from app.services.twap_engine import twap_engine
from app.utils.logger import get_logger, configure_logging

configure_logging()
logger = get_logger()


async def diagnose_arbitrage_pairs():
    """诊断套利监控对配置"""
    print("\n" + "="*60)
    print("📊 诊断套利监控对配置")
    print("="*60)
    
    pairs = arb_engine._pairs
    
    if not pairs:
        print("⚠️  没有找到任何监控对")
        print("   建议：使用前端创建一个测试监控对")
        return False
    
    print(f"\n✅ 找到 {len(pairs)} 个监控对\n")
    
    has_issues = False
    
    for pair_id, config in pairs.items():
        print(f"\n监控对ID: {pair_id}")
        print(f"  Leg1: {config.leg1.exchange} {config.leg1.symbol} {config.leg1.type} {config.leg1.side}")
        print(f"  Leg2: {config.leg2.exchange} {config.leg2.symbol} {config.leg2.type} {config.leg2.side}")
        print(f"  Threshold: {config.threshold}%")
        print(f"  Qty: {config.qty}")
        print(f"  MaxExecs: {config.maxExecs}")
        print(f"  Enabled: {config.enabled}")
        print(f"  Executions: {arb_engine._executions_count.get(pair_id, 0)}/{config.maxExecs}")
        
        # 检查问题
        issues = []
        
        # 问题1: Threshold为0
        if abs(config.threshold) < 0.001:
            issues.append("⚠️  Threshold接近0，可能永远不会触发")
            has_issues = True
        
        # 问题2: 未启用
        if not config.enabled:
            issues.append("⚠️  监控对未启用 (enabled=False)")
            has_issues = True
        
        # 问题3: 已达到最大执行次数
        exec_count = arb_engine._executions_count.get(pair_id, 0)
        if exec_count >= config.maxExecs:
            issues.append(f"⚠️  已达到最大执行次数 ({exec_count}/{config.maxExecs})")
            has_issues = True
        
        # 问题4: 相同exchange和symbol但不同type
        if (config.leg1.exchange == config.leg2.exchange and 
            config.leg1.symbol == config.leg2.symbol and
            config.leg1.type == config.leg2.type):
            issues.append("⚠️  两腿完全相同，可能配置错误")
            has_issues = True
        
        if issues:
            print("\n  🔍 发现的问题:")
            for issue in issues:
                print(f"     {issue}")
        else:
            print("\n  ✅ 配置看起来正常")
    
    return not has_issues


async def diagnose_twap_plans():
    """诊断TWAP计划配置"""
    print("\n" + "="*60)
    print("📊 诊断TWAP计划配置")
    print("="*60)
    
    plans = twap_engine.plans
    
    if not plans:
        print("⚠️  没有找到任何TWAP计划")
        print("   建议：使用前端创建一个测试TWAP计划")
        return False
    
    print(f"\n✅ 找到 {len(plans)} 个TWAP计划\n")
    
    has_issues = False
    
    for plan_id, plan in plans.items():
        progress = await twap_engine.get_progress(plan_id)
        
        print(f"\n计划ID: {plan_id}")
        print(f"  名称: {plan.name}")
        print(f"  总数量: {plan.totalQty}")
        print(f"  单次数量: {plan.sliceQty}")
        print(f"  间隔: {plan.intervalMs}ms")
        print(f"  腿数: {len(plan.legs)}")
        
        for i, leg in enumerate(plan.legs):
            print(f"  Leg{i+1}: {leg.exchange} {leg.symbol} {leg.category} {leg.side} {leg.type}")
        
        if progress:
            print(f"  状态: {progress.state.value}")
            print(f"  进度: {progress.slicesDone}/{progress.slicesTotal} 片")
            print(f"  已执行: {progress.executed}/{plan.totalQty}")
            print(f"  剩余: {progress.remaining}")
        
        # 检查问题
        issues = []
        
        # 问题1: 数量配置不合理
        if plan.sliceQty > plan.totalQty:
            issues.append("⚠️  单次数量大于总数量")
            has_issues = True
        
        # 问题2: 间隔太短
        if plan.intervalMs < 1000:
            issues.append("⚠️  执行间隔小于1秒，可能触发限流")
            has_issues = True
        
        # 问题3: 没有腿
        if not plan.legs:
            issues.append("⚠️  没有配置交易腿")
            has_issues = True
        
        # 问题4: 卡在某个状态
        if progress and progress.state.value == "running" and progress.slicesDone == 0:
            issues.append("⚠️  状态为running但没有执行记录，可能卡住了")
            has_issues = True
        
        if issues:
            print("\n  🔍 发现的问题:")
            for issue in issues:
                print(f"     {issue}")
        else:
            print("\n  ✅ 配置看起来正常")
    
    return not has_issues


async def check_api_keys():
    """检查API Key配置"""
    print("\n" + "="*60)
    print("🔑 检查API Key配置")
    print("="*60 + "\n")
    
    from app.config.env import config
    
    validation = config.validate_api_keys()
    
    for exchange, result in validation.items():
        status = "✅" if result["configured"] else "❌"
        print(f"{status} {exchange.upper()}: ", end="")
        
        if result["configured"]:
            if result["valid"]:
                print("已配置且有效")
            else:
                print(f"已配置但验证失败 - {result.get('message', '未知错误')}")
        else:
            print("未配置")
    
    # 检查是否至少有一个交易所配置正确
    has_valid = any(v["configured"] and v["valid"] for v in validation.values())
    
    if not has_valid:
        print("\n⚠️  警告：没有任何交易所配置有效的API Key")
        print("   建议：访问 http://localhost:3000/settings 配置API Key")
        return False
    
    return True


def check_websocket():
    """检查WebSocket状态"""
    print("\n" + "="*60)
    print("🔌 检查WebSocket连接")
    print("="*60 + "\n")
    
    from app.utils.websocket_manager import manager
    
    connection_count = len(manager.active_connections)
    
    if connection_count == 0:
        print("⚠️  没有活跃的WebSocket连接")
        print("   这意味着前端无法接收实时更新")
        print("   建议：")
        print("     1. 刷新前端页面")
        print("     2. 检查浏览器控制台的WebSocket错误")
        print("     3. 确认前端连接到 ws://localhost:7001/ws")
        return False
    else:
        print(f"✅ 有 {connection_count} 个活跃的WebSocket连接")
        return True


def check_engine_status():
    """检查引擎状态"""
    print("\n" + "="*60)
    print("⚙️  检查套利引擎状态")
    print("="*60 + "\n")
    
    status = arb_engine.get_status()
    
    if status["running"]:
        print(f"✅ 套利引擎正在运行")
        print(f"   监控对数量: {len(status['pairs'])}")
        print(f"   扫描间隔: {status['intervalSec']}秒")
    else:
        print("⚠️  套利引擎未运行")
        print("   建议：POST /api/arbitrage/engine/control { action: 'start' }")
        return False
    
    return True


def print_recommendations():
    """打印修复建议"""
    print("\n" + "="*60)
    print("💡 修复建议")
    print("="*60 + "\n")
    
    print("如果发现问题，请按以下步骤修复：\n")
    
    print("1. Threshold配置问题")
    print("   - 正向套利：threshold应为正值 (例如 0.1)")
    print("   - 负向套利：threshold应为负值 (例如 -0.1)")
    print("   - 修改方法：PUT /api/arbitrage/pairs/{pair_id}")
    print("     { \"threshold\": 0.1 }\n")
    
    print("2. WebSocket未连接")
    print("   - 刷新前端页面")
    print("   - 检查浏览器控制台的Network标签")
    print("   - 确认连接到 ws://localhost:7001/ws\n")
    
    print("3. API Key未配置")
    print("   - 访问 http://localhost:3000/settings")
    print("   - 配置并测试API Key")
    print("   - 或者使用新版前端 http://localhost:3000\n")
    
    print("4. 引擎未运行")
    print("   - 引擎通常会自动启动")
    print("   - 如未启动，POST /api/arbitrage/engine/control")
    print("     { \"action\": \"start\" }\n")
    
    print("5. 使用新版前端（推荐）")
    print("   cd D:\\arbi\\client")
    print("   npm install")
    print("   npm start")
    print("   访问 http://localhost:3000\n")


async def main():
    """主函数"""
    print("\n" + "🔍"*30)
    print("\n🚀 开始诊断前后端兼容性\n")
    print("🔍"*30 + "\n")
    
    results = {}
    
    # 检查1: API Key
    results["api_keys"] = await check_api_keys()
    
    # 检查2: 引擎状态
    results["engine"] = check_engine_status()
    
    # 检查3: WebSocket
    results["websocket"] = check_websocket()
    
    # 检查4: 套利监控对
    results["pairs"] = await diagnose_arbitrage_pairs()
    
    # 检查5: TWAP计划
    results["twap"] = await diagnose_twap_plans()
    
    # 总结
    print("\n" + "="*60)
    print("📊 诊断总结")
    print("="*60 + "\n")
    
    total = len(results)
    passed = sum(1 for v in results.values() if v)
    
    print(f"总检查项: {total}")
    print(f"通过: {passed} ✅")
    print(f"失败: {total - passed} ❌\n")
    
    if passed == total:
        print("🎉 所有检查都通过！系统配置正常。")
        print("\n如果仍然无法下单，请检查：")
        print("  1. Threshold是否合理（能够触发）")
        print("  2. 当前市场价差是否满足触发条件")
        print("  3. 是否已达到maxExecs限制")
    else:
        print("⚠️  发现一些问题，请查看上面的详细信息。")
        print_recommendations()
    
    print("\n" + "="*60 + "\n")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n\n👋 诊断已取消")
    except Exception as e:
        print(f"\n\n❌ 诊断过程中出现错误: {e}")
        import traceback
        traceback.print_exc()

