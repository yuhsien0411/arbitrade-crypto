/**
 * 下單面板組件（CEX 風格）
 * 支援 TWAP 和PAIRS模式切換
 * Leg1/Leg2 左右並排顯示
 */

import React, { useState, useEffect } from 'react';
import { App as AntdApp } from 'antd';
import { apiService } from '../../services/api';
import { getApiBaseUrl } from '../../utils/env';

interface OrderPanelProps {
  leg1Exchange: string;
  leg1Symbol: string;
  leg1Type: string;
  leg2Exchange: string;
  leg2Symbol: string;
  leg2Type: string;
  onPairChange: (config: {
    leg1Exchange: string;
    leg1Symbol: string;
    leg1Type: string;
    leg2Exchange: string;
    leg2Symbol: string;
    leg2Type: string;
  }) => void;
}

interface ExchangeCaps {
  supportsSpot: boolean;
  supportsLinear: boolean;
  notes?: string;
}

type OrderMode = 'dual-leg' | 'twap';

const OrderPanel: React.FC<OrderPanelProps> = ({ 
  leg1Exchange: propLeg1Exchange,
  leg1Symbol: propLeg1Symbol,
  leg1Type: propLeg1Type,
  leg2Exchange: propLeg2Exchange,
  leg2Symbol: propLeg2Symbol,
  leg2Type: propLeg2Type,
  onPairChange,
}) => {
  const { message } = AntdApp.useApp();
  
  const [mode, setMode] = useState<OrderMode>('dual-leg');
  
  // PAIRS模式狀態 - 使用 props 初始化
  const [leg1Exchange, setLeg1Exchange] = useState(propLeg1Exchange);
  const [leg1Type, setLeg1Type] = useState(propLeg1Type);
  const [leg2Exchange, setLeg2Exchange] = useState(propLeg2Exchange);
  const [leg2Type, setLeg2Type] = useState(propLeg2Type);
  
  const [leg1Side, setLeg1Side] = useState<'buy' | 'sell'>('buy');
  const [leg2Side, setLeg2Side] = useState<'buy' | 'sell'>('sell');
  const [qty1, setQty1] = useState('0.1');
  const [qty2, setQty2] = useState('0.1');
  const [threshold, setThreshold] = useState('0.1');
  const [symbol1, setSymbol1] = useState(propLeg1Symbol);
  const [symbol2, setSymbol2] = useState(propLeg2Symbol);
  
  // TWAP 模式狀態（暫時未使用，保留供未來 TWAP API 使用）
  // const [twapExchange, setTwapExchange] = useState('bybit');
  // const [twapSymbol, setTwapSymbol] = useState('ETHUSDT');
  // const [twapType, setTwapType] = useState('linear');
  // const [twapSide, setTwapSide] = useState<'buy' | 'sell'>('buy');
  // const [twapQty, setTwapQty] = useState('1.0');
  // const [twapDuration, setTwapDuration] = useState('60');
  const [twapInterval, setTwapInterval] = useState('5');
  const [twapCount, setTwapCount] = useState('12');
  
  const [loading, setLoading] = useState(false);
  const [capabilities, setCapabilities] = useState<Record<string, ExchangeCaps>>({});
  const [leg1Price, setLeg1Price] = useState<{ bid: number; ask: number } | null>(null);
  const [leg2Price, setLeg2Price] = useState<{ bid: number; ask: number } | null>(null);

  // 加載能力
  useEffect(() => {
    const apiBase = getApiBaseUrl();
    fetch(`${apiBase}/api/exchanges/capabilities`)
      .then(res => res.json())
      .then(data => setCapabilities(data))
      .catch(err => console.error('Failed to load capabilities:', err));
  }, []);

  // Symbol1 改變時自動更新 Symbol2
  useEffect(() => {
    setSymbol2(symbol1);
  }, [symbol1]);

  // 配置改變時通知父組件
  useEffect(() => {
    onPairChange({
      leg1Exchange,
      leg1Symbol: symbol1,
      leg1Type,
      leg2Exchange,
      leg2Symbol: symbol2,
      leg2Type,
    });
  }, [leg1Exchange, symbol1, leg1Type, leg2Exchange, symbol2, leg2Type, onPairChange]);

  // 訂閱價格
  useEffect(() => {
    const handlePriceUpdate = (event: any) => {
      const { data } = event.detail;
      if (!data) return;

      const { leg1Price: wsLeg1, leg2Price: wsLeg2 } = data;

      if (wsLeg1 && wsLeg1.exchange === leg1Exchange && wsLeg1.symbol === symbol1) {
        setLeg1Price({ bid: wsLeg1.bid1?.price || 0, ask: wsLeg1.ask1?.price || 0 });
      }
      if (wsLeg2 && wsLeg2.exchange === leg2Exchange && wsLeg2.symbol === symbol2) {
        setLeg2Price({ bid: wsLeg2.bid1?.price || 0, ask: wsLeg2.ask1?.price || 0 });
      }
    };

    window.addEventListener('priceUpdate', handlePriceUpdate);
    return () => window.removeEventListener('priceUpdate', handlePriceUpdate);
  }, [leg1Exchange, leg2Exchange, symbol1, symbol2]);

  // PAIRS模式計算預估
  const dualEstimate = React.useMemo(() => {
    if (mode !== 'dual-leg' || !leg1Price || !leg2Price || !qty1) return null;

    const q1 = parseFloat(qty1);
    if (isNaN(q1) || q1 <= 0) return null;

    const leg1ExecPrice = leg1Side === 'buy' ? leg1Price.ask : leg1Price.bid;
    const leg2ExecPrice = leg2Side === 'buy' ? leg2Price.ask : leg2Price.bid;

    let spread = 0;
    if (leg1Side === 'buy' && leg2Side === 'sell') {
      spread = leg2ExecPrice - leg1ExecPrice;
    } else if (leg1Side === 'sell' && leg2Side === 'buy') {
      spread = leg1ExecPrice - leg2ExecPrice;
    }

    const spreadPercent = leg1ExecPrice > 0 ? (spread / leg1ExecPrice) * 100 : 0;
    const estimatedPnL = spread * q1;

    return { leg1ExecPrice, leg2ExecPrice, spread, spreadPercent, estimatedPnL };
  }, [mode, leg1Price, leg2Price, leg1Side, leg2Side, qty1]);

  // 執行下單
  const handleExecute = async () => {
    console.log('[OrderPanel] handleExecute called, mode:', mode);
    setLoading(true);
    try {
      if (mode === 'dual-leg') {
        const orderData = {
          leg1: { 
            exchange: leg1Exchange as any, 
            symbol: symbol1, 
            type: leg1Type as any, 
            side: leg1Side 
          },
          leg2: { 
            exchange: leg2Exchange as any, 
            symbol: symbol2, 
            type: leg2Type as any, 
            side: leg2Side 
          },
          qty: parseFloat(qty1),
          threshold: parseFloat(threshold),
          maxExecs: 1, // 添加必需的 maxExecs 字段
          enabled: true,
        };
        console.log('[OrderPanel] Submitting PAIRS order:', orderData);
        console.log('[OrderPanel] Calling apiService.addMonitoringPair...');
        const result = await apiService.addMonitoringPair(orderData);
        console.log('[OrderPanel] API response:', result);
        message.success('PAIRS訂單已提交');
      } else {
        // TWAP 模式 - 使用正確的格式
        const twapData = {
          name: `TWAP策略_${Date.now()}`,
          totalQty: parseFloat(qty1) * parseInt(twapCount), // 總數量
          sliceQty: parseFloat(qty1), // 單次數量
          intervalMs: parseInt(twapInterval) * 1000, // 轉換為毫秒
          legs: [
            {
              exchange: leg1Exchange,
              symbol: symbol1,
              side: leg1Side,
              type: "market" as const,
              category: leg1Type === 'linear' ? 'linear' : 'spot' as const
            },
            {
              exchange: leg2Exchange,
              symbol: symbol2,
              side: leg2Side,
              type: "market" as const,
              category: leg2Type === 'linear' ? 'linear' : 'spot' as const
            }
          ]
        };
        console.log('[OrderPanel] Submitting TWAP order:', twapData);
        await apiService.addTwapStrategy(twapData);
        message.success('TWAP 策略已提交');
      }
    } catch (error: any) {
      message.error(error.message || '執行失敗');
    } finally {
      setLoading(false);
    }
  };

  const exchanges = ['bybit', 'binance', 'okx', 'bitget'];

  return (
    <div className="h-full bg-bg-secondary flex flex-col">
      {/* 標題 + 模式切換 */}
      <div className="h-12 border-b border-border flex items-center justify-between px-4">
        <h3 className="text-text-primary font-medium">
          {mode === 'dual-leg' ? 'PAIRS' : 'TWAP 策略'}
        </h3>
        <button
          onClick={() => setMode(mode === 'dual-leg' ? 'twap' : 'dual-leg')}
          className="px-3 py-1 bg-bg-tertiary hover:bg-bg-hover text-text-primary rounded text-sm transition-colors"
        >
          切換至 {mode === 'dual-leg' ? 'TWAP' : 'PAIRS'}
        </button>
      </div>

      {/* 滾動內容 */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {mode === 'dual-leg' ? (
          /* PAIRS模式 - 表格式佈局 */
          <>
            {/* 表頭 */}
            <div className="grid grid-cols-2 gap-3 text-xs text-text-secondary font-medium">
              <div className="text-center">Leg 1</div>
              <div className="text-center">Leg 2</div>
            </div>

            {/* Exchange */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-text-secondary text-xs mb-1 block">Exchange1</label>
                <select
                  value={leg1Exchange}
                  onChange={(e) => setLeg1Exchange(e.target.value)}
                  className="select-cex w-full text-sm"
                >
                  {exchanges.map((ex) => (
                    <option key={ex} value={ex}>{ex.toUpperCase()}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-text-secondary text-xs mb-1 block">Exchange2</label>
                <select
                  value={leg2Exchange}
                  onChange={(e) => setLeg2Exchange(e.target.value)}
                  className="select-cex w-full text-sm"
                >
                  {exchanges.map((ex) => (
                    <option key={ex} value={ex}>{ex.toUpperCase()}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Category */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-text-secondary text-xs mb-1 block">Category1</label>
                <select
                  value={leg1Type}
                  onChange={(e) => setLeg1Type(e.target.value)}
                  className="select-cex w-full text-sm"
                >
                  <option value="spot" disabled={!capabilities[leg1Exchange]?.supportsSpot}>現貨</option>
                  <option value="linear">合約</option>
                </select>
              </div>
              <div>
                <label className="text-text-secondary text-xs mb-1 block">Category2</label>
                <select
                  value={leg2Type}
                  onChange={(e) => setLeg2Type(e.target.value)}
                  className="select-cex w-full text-sm"
                >
                  <option value="spot" disabled={!capabilities[leg2Exchange]?.supportsSpot}>現貨</option>
                  <option value="linear">合約</option>
                </select>
              </div>
            </div>

            {/* Symbol */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-text-secondary text-xs mb-1 block">Symbol1</label>
                <input
                  type="text"
                  value={symbol1}
                  onChange={(e) => setSymbol1(e.target.value.toUpperCase())}
                  className="input-cex w-full text-sm uppercase font-mono"
                  placeholder="BTCUSDT"
                />
              </div>
              <div>
                <label className="text-text-secondary text-xs mb-1 block">Symbol2 (自動跟隨)</label>
                <input
                  type="text"
                  value={symbol2}
                  onChange={(e) => setSymbol2(e.target.value.toUpperCase())}
                  className="input-cex w-full text-sm uppercase font-mono"
                  placeholder="BTCUSDT"
                />
              </div>
            </div>

            {/* Side 買入/賣出 */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-text-secondary text-xs mb-1 block">方向</label>
                <div className="flex space-x-1">
                  <button
                    onClick={() => setLeg1Side('buy')}
                    className={`flex-1 py-1.5 rounded text-xs font-medium transition-colors ${
                      leg1Side === 'buy' ? 'btn-buy' : 'bg-bg-tertiary text-text-secondary'
                    }`}
                  >
                    買
                  </button>
                  <button
                    onClick={() => setLeg1Side('sell')}
                    className={`flex-1 py-1.5 rounded text-xs font-medium transition-colors ${
                      leg1Side === 'sell' ? 'btn-sell' : 'bg-bg-tertiary text-text-secondary'
                    }`}
                  >
                    賣
                  </button>
                </div>
              </div>
              <div>
                <label className="text-text-secondary text-xs mb-1 block">方向</label>
                <div className="flex space-x-1">
                  <button
                    onClick={() => setLeg2Side('buy')}
                    className={`flex-1 py-1.5 rounded text-xs font-medium transition-colors ${
                      leg2Side === 'buy' ? 'btn-buy' : 'bg-bg-tertiary text-text-secondary'
                    }`}
                  >
                    買
                  </button>
                  <button
                    onClick={() => setLeg2Side('sell')}
                    className={`flex-1 py-1.5 rounded text-xs font-medium transition-colors ${
                      leg2Side === 'sell' ? 'btn-sell' : 'bg-bg-tertiary text-text-secondary'
                    }`}
                  >
                    賣
                  </button>
                </div>
              </div>
            </div>

            {/* Qty */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-text-secondary text-xs mb-1 block">Qty1</label>
                <input
                  type="number"
                  value={qty1}
                  onChange={(e) => setQty1(e.target.value)}
                  className="input-cex w-full text-sm"
                  step="0.01"
                />
              </div>
              <div>
                <label className="text-text-secondary text-xs mb-1 block">Qty2</label>
                <input
                  type="number"
                  value={qty2}
                  onChange={(e) => setQty2(e.target.value)}
                  className="input-cex w-full text-sm"
                  step="0.01"
                />
              </div>
            </div>

            {/* 價格顯示 */}
            <div className="grid grid-cols-2 gap-3 text-xs">
              <div className="card-cex p-2">
                {leg1Price ? (
                  <div className="space-y-0.5">
                    <div className="flex justify-between">
                      <span className="text-text-secondary">買:</span>
                      <span className="font-mono price-buy">{leg1Price.bid.toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-text-secondary">賣:</span>
                      <span className="font-mono price-sell">{leg1Price.ask.toFixed(2)}</span>
                    </div>
                  </div>
                ) : (
                  <div className="text-text-secondary text-center">等待價格...</div>
                )}
              </div>
              <div className="card-cex p-2">
                {leg2Price ? (
                  <div className="space-y-0.5">
                    <div className="flex justify-between">
                      <span className="text-text-secondary">買:</span>
                      <span className="font-mono price-buy">{leg2Price.bid.toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-text-secondary">賣:</span>
                      <span className="font-mono price-sell">{leg2Price.ask.toFixed(2)}</span>
                    </div>
                  </div>
                ) : (
                  <div className="text-text-secondary text-center">等待價格...</div>
                )}
              </div>
            </div>

            {/* 分隔線 */}
            <div className="border-t border-border pt-3">
              <label className="text-text-secondary text-xs mb-1 block">價差閾值 (%)</label>
              <input
                type="number"
                value={threshold}
                onChange={(e) => setThreshold(e.target.value)}
                className="input-cex w-full text-sm"
                step="0.01"
              />
            </div>

            {/* 預估結果 */}
            {dualEstimate && (
              <div className="card-cex p-3 space-y-2">
                <div className="text-text-secondary text-xs font-medium mb-2">預估結果</div>
                <div className="space-y-1.5 text-sm">
                  <div className="flex justify-between">
                    <span className="text-text-secondary">價差:</span>
                    <span className={`font-mono font-bold ${dualEstimate.spread >= 0 ? 'text-trade-buy' : 'text-trade-sell'}`}>
                      {dualEstimate.spread >= 0 ? '+' : ''}{dualEstimate.spread.toFixed(2)} USDT
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-text-secondary">價差%:</span>
                    <span className={`font-mono font-bold ${dualEstimate.spreadPercent >= 0 ? 'text-trade-buy' : 'text-trade-sell'}`}>
                      {dualEstimate.spreadPercent >= 0 ? '+' : ''}{dualEstimate.spreadPercent.toFixed(4)}%
                    </span>
                  </div>
                  <div className="flex justify-between pt-2 border-t border-border">
                    <span className="text-text-secondary">預估盈虧:</span>
                    <span className={`font-mono font-bold text-base ${dualEstimate.estimatedPnL >= 0 ? 'text-trade-buy' : 'text-trade-sell'}`}>
                      {dualEstimate.estimatedPnL >= 0 ? '+' : ''}{dualEstimate.estimatedPnL.toFixed(2)} USDT
                    </span>
                  </div>
                </div>
              </div>
            )}
          </>
        ) : (
          /* TWAP 模式 - 使用相同的左右並排佈局 */
          <>
            {/* 表頭 */}
            <div className="grid grid-cols-2 gap-3 text-xs text-text-secondary font-medium">
              <div className="text-center">Leg 1</div>
              <div className="text-center">Leg 2</div>
            </div>

            {/* Exchange */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-text-secondary text-xs mb-1 block">Exchange1</label>
                <select
                  value={leg1Exchange}
                  onChange={(e) => setLeg1Exchange(e.target.value)}
                  className="select-cex w-full text-sm"
                >
                  {exchanges.map((ex) => (
                    <option key={ex} value={ex}>{ex.toUpperCase()}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-text-secondary text-xs mb-1 block">Exchange2</label>
                <select
                  value={leg2Exchange}
                  onChange={(e) => setLeg2Exchange(e.target.value)}
                  className="select-cex w-full text-sm"
                >
                  {exchanges.map((ex) => (
                    <option key={ex} value={ex}>{ex.toUpperCase()}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Category */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-text-secondary text-xs mb-1 block">Category1</label>
                <select
                  value={leg1Type}
                  onChange={(e) => setLeg1Type(e.target.value)}
                  className="select-cex w-full text-sm"
                >
                  <option value="spot" disabled={!capabilities[leg1Exchange]?.supportsSpot}>現貨</option>
                  <option value="linear">合約</option>
                </select>
              </div>
              <div>
                <label className="text-text-secondary text-xs mb-1 block">Category2</label>
                <select
                  value={leg2Type}
                  onChange={(e) => setLeg2Type(e.target.value)}
                  className="select-cex w-full text-sm"
                >
                  <option value="spot" disabled={!capabilities[leg2Exchange]?.supportsSpot}>現貨</option>
                  <option value="linear">合約</option>
                </select>
              </div>
            </div>

            {/* Symbol */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-text-secondary text-xs mb-1 block">Symbol1</label>
                <input
                  type="text"
                  value={symbol1}
                  onChange={(e) => setSymbol1(e.target.value.toUpperCase())}
                  className="input-cex w-full text-sm uppercase font-mono"
                  placeholder="BTCUSDT"
                />
              </div>
              <div>
                <label className="text-text-secondary text-xs mb-1 block">Symbol2 (自動跟隨)</label>
                <input
                  type="text"
                  value={symbol2}
                  onChange={(e) => setSymbol2(e.target.value.toUpperCase())}
                  className="input-cex w-full text-sm uppercase font-mono"
                  placeholder="BTCUSDT"
                />
              </div>
            </div>

            {/* Side 買入/賣出 */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-text-secondary text-xs mb-1 block">方向</label>
                <div className="flex space-x-1">
                  <button
                    onClick={() => setLeg1Side('buy')}
                    className={`flex-1 py-1.5 rounded text-xs font-medium transition-colors ${
                      leg1Side === 'buy' ? 'btn-buy' : 'bg-bg-tertiary text-text-secondary'
                    }`}
                  >
                    買
                  </button>
                  <button
                    onClick={() => setLeg1Side('sell')}
                    className={`flex-1 py-1.5 rounded text-xs font-medium transition-colors ${
                      leg1Side === 'sell' ? 'btn-sell' : 'bg-bg-tertiary text-text-secondary'
                    }`}
                  >
                    賣
                  </button>
                </div>
              </div>
              <div>
                <label className="text-text-secondary text-xs mb-1 block">方向</label>
                <div className="flex space-x-1">
                  <button
                    onClick={() => setLeg2Side('buy')}
                    className={`flex-1 py-1.5 rounded text-xs font-medium transition-colors ${
                      leg2Side === 'buy' ? 'btn-buy' : 'bg-bg-tertiary text-text-secondary'
                    }`}
                  >
                    買
                  </button>
                  <button
                    onClick={() => setLeg2Side('sell')}
                    className={`flex-1 py-1.5 rounded text-xs font-medium transition-colors ${
                      leg2Side === 'sell' ? 'btn-sell' : 'bg-bg-tertiary text-text-secondary'
                    }`}
                  >
                    賣
                  </button>
                </div>
              </div>
            </div>

            {/* Qty */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-text-secondary text-xs mb-1 block">Qty1</label>
                <input
                  type="number"
                  value={qty1}
                  onChange={(e) => setQty1(e.target.value)}
                  className="input-cex w-full text-sm"
                  step="0.01"
                />
              </div>
              <div>
                <label className="text-text-secondary text-xs mb-1 block">Qty2</label>
                <input
                  type="number"
                  value={qty2}
                  onChange={(e) => setQty2(e.target.value)}
                  className="input-cex w-full text-sm"
                  step="0.01"
                />
              </div>
            </div>

            {/* TWAP 參數 */}
            <div className="border-t border-border pt-3 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-text-secondary text-xs mb-1 block">時間間隔 (秒)</label>
                  <input
                    type="number"
                    value={twapInterval}
                    onChange={(e) => setTwapInterval(e.target.value)}
                    className="input-cex w-full text-sm"
                    step="1"
                    min="1"
                  />
                </div>
                <div>
                  <label className="text-text-secondary text-xs mb-1 block">交易次數</label>
                  <input
                    type="number"
                    value={twapCount}
                    onChange={(e) => setTwapCount(e.target.value)}
                    className="input-cex w-full text-sm"
                    step="1"
                    min="1"
                  />
                </div>
              </div>
            </div>

            {/* TWAP 執行計劃 */}
            <div className="card-cex p-3 space-y-2">
              <div className="text-text-secondary text-xs font-medium mb-2">執行計劃</div>
              <div className="space-y-1.5 text-sm">
                <div className="flex justify-between">
                  <span className="text-text-secondary">Leg1 總量:</span>
                  <span className="font-mono text-text-primary">
                    {(parseFloat(qty1) * parseInt(twapCount || '1')).toFixed(4)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-text-secondary">Leg2 總量:</span>
                  <span className="font-mono text-text-primary">
                    {(parseFloat(qty2) * parseInt(twapCount || '1')).toFixed(4)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-text-secondary">每次數量:</span>
                  <span className="font-mono text-text-primary">
                    {parseFloat(qty1).toFixed(4)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-text-secondary">交易次數:</span>
                  <span className="font-mono text-text-primary">{twapCount} 次</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-text-secondary">時間間隔:</span>
                  <span className="font-mono text-text-primary">
                    {parseInt(twapCount || '1') <= 1 ? '無間隔' : `${twapInterval} 秒`}
                  </span>
                </div>
                <div className="flex justify-between pt-2 border-t border-border">
                  <span className="text-text-secondary">預計耗時:</span>
                  <span className="font-mono text-text-primary">
                    {(() => {
                      const count = parseInt(twapCount || '1');
                      const interval = parseInt(twapInterval || '1');
                      if (count <= 1) {
                        return '立即完成';
                      }
                      const totalSeconds = (count - 1) * interval;
                      if (totalSeconds < 60) {
                        return `${totalSeconds} 秒`;
                      } else {
                        return `${Math.ceil(totalSeconds / 60)} 分鐘`;
                      }
                    })()}
                  </span>
                </div>
              </div>
            </div>
          </>
        )}
      </div>

      {/* 底部按鈕 */}
      <div className="p-4 border-t border-border">
        <button
          onClick={handleExecute}
          disabled={loading}
          className="btn-primary w-full py-3 text-base font-bold disabled:opacity-50"
        >
          {loading ? '提交中...' : mode === 'dual-leg' ? '立即執行' : '啟動 TWAP'}
        </button>
      </div>
    </div>
  );
};

export default OrderPanel;
