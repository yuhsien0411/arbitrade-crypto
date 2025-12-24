"""
對沖分析服務
負責分析持倉的對沖情況並提供建議
"""

from typing import List, Dict, Any, Tuple, Optional
from dataclasses import dataclass, field
from ..exchanges.base import AccountSummary, Position, Balance
from ..utils.logger import get_logger


@dataclass
class PositionExposure:
    """持倉敞口"""
    exchange: str
    position_type: str  # "spot_cash" | "spot_margin" | "perp_linear" | etc.
    side: str  # "long" | "short"
    size_base: float
    notional_usdt: float
    carry_8h: float
    funding_rate_8h: Optional[float] = None
    interest_rate_daily: Optional[float] = None


@dataclass
class ExposureSummary:
    """敞口匯總"""
    base_asset: str
    positions: List[PositionExposure] = field(default_factory=list)
    long_base: float = 0.0
    short_base: float = 0.0
    net_base: float = 0.0
    long_notional_usdt: float = 0.0
    short_notional_usdt: float = 0.0
    net_notional_usdt: float = 0.0
    hedge_ratio: float = 0.0
    hedge_status: str = "unhedged"  # "fully_hedged" | "partially_hedged" | "unhedged" | "over_hedged"
    net_carry_8h: float = 0.0
    net_carry_daily: float = 0.0
    risk_level: str = "low"  # "low" | "medium" | "high"
    suggestions: List[str] = field(default_factory=list)


class HedgeAnalyzer:
    """對沖分析器"""
    
    def __init__(self):
        self.logger = get_logger()
    
    def analyze_exposures(self, accounts: List[AccountSummary]) -> List[ExposureSummary]:
        """分析所有帳戶的敞口並生成匯總"""
        try:
            # 步驟 1: 收集所有持倉和餘額
            all_exposures: Dict[str, List[PositionExposure]] = {}
            # 🔥 建立 Balance 映射（用於查找 spot_margin 持倉的借幣利率）
            balance_map: Dict[Tuple[str, str], Balance] = {}  # (exchange, asset) -> Balance
            
            for account in accounts:
                self.logger.info("hedge_analyzer_processing_account", 
                               exchange=account.exchange, 
                               account_mode=account.account_mode,
                               balances_count=len(account.balances),
                               positions_count=len(account.positions))
                
                # 支援所有帳戶模式（unified, portfolio, classic）
                # classic 模式也可以有合約持倉，需要納入對沖分析
                if account.account_mode == "unsupported":
                    self.logger.info("hedge_analyzer_skipping_account", 
                                   exchange=account.exchange, 
                                   account_mode=account.account_mode,
                                   reason="account mode unsupported")
                    continue  # 只跳過不支援的帳戶
                
                # 🔥 建立 Balance 映射（包括有借幣的餘額，用於查找 spot_margin 持倉的借幣利率）
                for balance in account.balances:
                    if balance.borrowed > 0:
                        # 保存有借幣的餘額，用於查找 spot_margin 持倉的借幣利率
                        balance_map[(account.exchange, balance.asset)] = balance
                
                # 處理現貨餘額（不包括槓桿現貨，因為它們已經被轉換為 spot_margin 持倉）
                # 🔥 跳過有借幣的餘額，因為它們已經被轉換為 spot_margin 持倉，會在 positions 中處理
                for balance in account.balances:
                    self.logger.info("hedge_analyzer_processing_balance", 
                                   exchange=account.exchange,
                                   asset=balance.asset,
                                   net_balance=balance.net_balance,
                                   borrowed=balance.borrowed,
                                   usdt_value=balance.usdt_value)
                    # 🔥 跳過有借幣的餘額（它們已經被轉換為 spot_margin 持倉）
                    if balance.borrowed > 0:
                        self.logger.info("hedge_analyzer_skipping_borrowed_balance",
                                       exchange=account.exchange,
                                       asset=balance.asset,
                                       borrowed=balance.borrowed,
                                       note="有借幣的餘額已轉換為 spot_margin 持倉，跳過餘額處理")
                        continue
                    if balance.net_balance != 0:
                        self._process_balance(balance, account.exchange, all_exposures)
                
                # 處理合約持倉
                for position in account.positions:
                    self.logger.info("hedge_analyzer_processing_position", 
                                   exchange=account.exchange,
                                   symbol=position.symbol,
                                   size=position.size)
                    self._process_position(position, account.exchange, all_exposures, balance_map)
            
            # 步驟 2: 計算每個基礎資產的對沖情況
            summaries = []
            for base_asset, exposures in all_exposures.items():
                summary = self._calculate_exposure_summary(base_asset, exposures)
                summaries.append(summary)
            
            return summaries
            
        except Exception as e:
            self.logger.error("hedge_analyze_exposures_failed", error=str(e))
            return []
    
    def _process_balance(
        self, 
        balance: Balance, 
        exchange: str, 
        all_exposures: Dict[str, List[PositionExposure]]
    ):
        """處理現貨餘額"""
        base_asset = balance.asset
        
        net_balance = balance.net_balance
        if net_balance == 0:
            return
        
        # 調試日誌：記錄處理的餘額
        self.logger.info("hedge_analyzer_processing_balance", 
                        exchange=exchange, 
                        asset=base_asset, 
                        net_balance=net_balance,
                        usdt_value=balance.usdt_value)
        
        # 跳過穩定幣（USDT、USDC 等不應顯示在對沖分析中）
        if base_asset in ["USDT", "USDC", "USD", "BUSD", "DAI", "TUSD"]:
            return
        
        # 判斷持倉類型
        position_type = "spot_margin" if balance.borrowed > 0 else "spot_cash"
        side = "long" if net_balance > 0 else "short"
        size_base = abs(net_balance)
        
        # 🔥 修复：统一使用 size_base * 单价来计算名义价值，与合约持仓保持一致
        # balance.usdt_value 是基于 net_balance 的总价值
        # 单价 = balance.usdt_value / net_balance（如果 net_balance != 0）
        # 名义价值 = size_base * |单价|
        if net_balance != 0:
            price_per_unit = balance.usdt_value / net_balance
            notional_usdt = size_base * abs(price_per_unit)
            
            # 🔥 添加调试日志
            self.logger.info("hedge_analyzer_balance_notional_calc",
                           exchange=exchange,
                           asset=base_asset,
                           net_balance=net_balance,
                           size_base=size_base,
                           usdt_value=balance.usdt_value,
                           price_per_unit=price_per_unit,
                           notional_usdt=notional_usdt,
                           note="现货余额名义价值计算")
        else:
            notional_usdt = abs(balance.usdt_value)
            price_per_unit = 0
        
        # 持有成本已移除，設為 0
        carry_8h = 0.0
        
        exposure = PositionExposure(
            exchange=exchange,
            position_type=position_type,
            side=side,
            size_base=size_base,
            notional_usdt=notional_usdt,  # 🔥 使用计算出的名义价值
            carry_8h=carry_8h,
            interest_rate_daily=balance.interest_rate_daily
        )
        
        if base_asset not in all_exposures:
            all_exposures[base_asset] = []
        all_exposures[base_asset].append(exposure)
    
    def _process_position(
        self, 
        position: Position, 
        exchange: str, 
        all_exposures: Dict[str, List[PositionExposure]],
        balance_map: Optional[Dict[Tuple[str, str], Balance]] = None
    ):
        """處理合約持倉"""
        base_asset = position.base_asset
        
        # 🔥 确保 notional_usdt 是正数
        notional_usdt = abs(position.notional_value)
        
        # 🔥 添加调试日志
        self.logger.info("hedge_analyzer_position_notional_calc",
                        exchange=exchange,
                        symbol=position.symbol,
                        base_asset=base_asset,
                        side=position.side,
                        size=position.size,
                        size_base=abs(position.size),
                        mark_price=position.mark_price,
                        notional_value_raw=position.notional_value,
                        notional_usdt=notional_usdt,
                        calculated=abs(position.size) * position.mark_price,
                        note="合约持仓名义价值计算")
        
        # 持有成本已移除，設為 0
        carry_8h = 0.0
        
        exposure = PositionExposure(
            exchange=exchange,
            position_type=position.position_type,
            side=position.side,
            size_base=abs(position.size),
            notional_usdt=notional_usdt,
            carry_8h=carry_8h,
            funding_rate_8h=position.funding_rate_8h
        )
        
        if base_asset not in all_exposures:
            all_exposures[base_asset] = []
        all_exposures[base_asset].append(exposure)
    
    def _calculate_exposure_summary(
        self, 
        base_asset: str, 
        exposures: List[PositionExposure]
    ) -> ExposureSummary:
        """計算敞口匯總"""
        summary = ExposureSummary(base_asset=base_asset, positions=exposures)
        
        # 匯總多空敞口
        for exp in exposures:
            # 🔥 确保 notional_usdt 是正数
            notional_value = abs(exp.notional_usdt)
            
            # 🔥 添加调试日志
            self.logger.info("hedge_analyzer_accumulating_exposure",
                           base_asset=base_asset,
                           side=exp.side,
                           exchange=exp.exchange,
                           position_type=exp.position_type,
                           size_base=exp.size_base,
                           notional_usdt_raw=exp.notional_usdt,
                           notional_usdt_used=notional_value,
                           note="累加敞口价值")
            
            if exp.side == "long":
                summary.long_base += exp.size_base
                summary.long_notional_usdt += notional_value
            else:  # short
                summary.short_base += exp.size_base
                summary.short_notional_usdt += notional_value
            
            summary.net_carry_8h += exp.carry_8h
        
        # 🔥 添加总结日志
        self.logger.info("hedge_analyzer_summary_calculated",
                        base_asset=base_asset,
                        long_base=summary.long_base,
                        long_notional_usdt=summary.long_notional_usdt,
                        short_base=summary.short_base,
                        short_notional_usdt=summary.short_notional_usdt,
                        exposures_count=len(exposures),
                        note="敞口汇总结果")
        
        # 計算淨敞口
        summary.net_base = summary.long_base - summary.short_base
        
        # 🔥 优化：使用加权平均价格计算净敞口价值
        # 如果有多头和空头，使用加权平均价格；否则使用单一方向的价格
        if summary.long_base > 0 and summary.short_base > 0:
            # 加权平均价格 = (多头总价值 + 空头总价值) / (多头数量 + 空头数量)
            avg_price = (summary.long_notional_usdt + summary.short_notional_usdt) / (
                summary.long_base + summary.short_base
            )
            summary.net_notional_usdt = abs(summary.net_base * avg_price)
        elif summary.long_base > 0:
            # 只有多头，使用多头平均价格
            avg_price = summary.long_notional_usdt / max(summary.long_base, 0.0001)
            summary.net_notional_usdt = abs(summary.net_base * avg_price)
        elif summary.short_base > 0:
            # 只有空头，使用空头平均价格
            avg_price = summary.short_notional_usdt / max(summary.short_base, 0.0001)
            summary.net_notional_usdt = abs(summary.net_base * avg_price)
        else:
            summary.net_notional_usdt = 0.0
        summary.net_carry_daily = summary.net_carry_8h * 3
        
        # 計算對沖比率
        if summary.long_base == 0 and summary.short_base == 0:
            summary.hedge_ratio = 0.0
        elif summary.long_base == 0 or summary.short_base == 0:
            summary.hedge_ratio = 0.0
        else:
            summary.hedge_ratio = min(summary.long_base, summary.short_base) / max(summary.long_base, summary.short_base)
        
        # 判定對沖狀態
        total_notional = summary.long_notional_usdt + summary.short_notional_usdt
        net_exposure_pct = summary.net_notional_usdt / max(total_notional, 0.0001)
        
        if summary.hedge_ratio >= 0.95 and net_exposure_pct <= 0.05:
            summary.hedge_status = "fully_hedged"
        elif 0.6 <= summary.hedge_ratio < 0.95:
            summary.hedge_status = "partially_hedged"
        elif summary.hedge_ratio < 0.6:
            summary.hedge_status = "unhedged"
        elif abs(summary.short_base) > summary.long_base * 1.05:
            summary.hedge_status = "over_hedged"
        
        # 判定風險等級
        # 只有當淨敞口 > $10 時才判斷為未對沖/高風險
        MIN_NOTIONAL_THRESHOLD = 10.0  # 最小敞口閾值 $10
        
        if summary.net_notional_usdt <= MIN_NOTIONAL_THRESHOLD:
            # 淨敞口 ≤ $10：視為可忽略，標記為低風險
            summary.risk_level = "low"
            # 如果原本判定為未對沖，改為完全對沖
            if summary.hedge_status == "unhedged":
                summary.hedge_status = "fully_hedged"
        elif summary.hedge_status == "fully_hedged":
            summary.risk_level = "low"
        elif summary.hedge_status in ["partially_hedged"] or net_exposure_pct < 0.1:
            summary.risk_level = "medium"
        else:
            summary.risk_level = "high"
        
        # 生成建議
        summary.suggestions = self._generate_suggestions(summary)
        
        return summary
    
    def _generate_suggestions(self, summary: ExposureSummary) -> List[str]:
        """生成對沖建議"""
        suggestions = []
        
        # 最小敞口閾值 $10，小於此值不給建議
        MIN_NOTIONAL_THRESHOLD = 10.0
        
        if summary.hedge_status == "unhedged" and summary.net_notional_usdt > MIN_NOTIONAL_THRESHOLD:
            if summary.long_base > summary.short_base:
                deficit = summary.long_base - summary.short_base
                suggestions.append(f"建議增加 {deficit:.4f} {summary.base_asset} 空頭倉位以達完全對沖")
            else:
                deficit = summary.short_base - summary.long_base
                suggestions.append(f"建議增加 {deficit:.4f} {summary.base_asset} 多頭倉位以達完全對沖")
        
        elif summary.hedge_status == "partially_hedged" and summary.net_notional_usdt > MIN_NOTIONAL_THRESHOLD:
            if summary.long_base > summary.short_base:
                deficit = summary.long_base - summary.short_base
                suggestions.append(f"建議增加 {deficit:.4f} {summary.base_asset} 空頭倉位以達完全對沖")
            else:
                deficit = summary.short_base - summary.long_base
                suggestions.append(f"建議增加 {deficit:.4f} {summary.base_asset} 多頭倉位以達完全對沖")
        
        elif summary.hedge_status == "over_hedged":
            suggestions.append("警告：空頭倉位過多，存在過度對沖風險")
        
        # 持有成本相關建議已移除
        
        # 檢查跨所對沖
        exchanges = set(exp.exchange for exp in summary.positions)
        if len(exchanges) > 1:
            suggestions.append(f"檢測到跨交易所對沖（{', '.join(exchanges)}），請注意基差風險")
        
        return suggestions

