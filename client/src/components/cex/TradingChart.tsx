/**
 * 交易圖表組件
 * 顯示價差走勢圖
 */

import React, { useState, useEffect, useRef } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { formatTimeHMS } from '../../utils/formatters';

interface TradingChartProps {
  leg1Exchange: string;
  leg1Symbol: string;
  leg1Type: string;
  leg2Exchange: string;
  leg2Symbol: string;
  leg2Type: string;
}

interface DataPoint {
  time: string;
  spread: number;
  spreadPercent: number;
}

const TradingChart: React.FC<TradingChartProps> = ({
  leg1Exchange,
  leg1Symbol,
  leg1Type,
  leg2Exchange,
  leg2Symbol,
  leg2Type,
}) => {
  const [data, setData] = useState<DataPoint[]>([]);
  const [mode, setMode] = useState<'spread' | 'percent'>('spread');
  const dataRef = useRef<DataPoint[]>([]);

  // 訂閱 WebSocket 價格更新
  useEffect(() => {
    const handlePriceUpdate = (event: any) => {
      const { data: wsData } = event.detail;
      if (!wsData) return;

      const { spread, spreadPercent, timestamp } = wsData;

      // 統一使用 formatTimeHMS 確保時區一致
      const newPoint: DataPoint = {
        time: formatTimeHMS(timestamp || Date.now()),
        spread: spread || 0,
        spreadPercent: spreadPercent || 0,
      };

      const updatedData = [...dataRef.current, newPoint].slice(-100);
      dataRef.current = updatedData;
      setData(updatedData);
    };

    window.addEventListener('priceUpdate', handlePriceUpdate);
    return () => window.removeEventListener('priceUpdate', handlePriceUpdate);
  }, []);

  const displayData = data.map((d) => ({
    ...d,
    value: mode === 'spread' ? d.spread : d.spreadPercent,
  }));

  const currentValue = displayData[displayData.length - 1]?.value || 0;
  const isPositive = currentValue >= 0;

  return (
    <div className="h-full bg-bg-secondary flex flex-col">
      {/* 頂部工具欄 */}
      <div className="h-16 border-b border-border flex items-center justify-between px-4">
        <div className="flex items-center space-x-4">
          <h3 className="text-text-primary font-medium">價差圖表</h3>
          
          {/* Leg1/Leg2 信息 */}
          <div className="flex items-center space-x-2">
            <div className="flex items-center bg-bg-tertiary rounded px-2 py-1">
              <span className="text-text-secondary text-xs mr-1.5">Leg1:</span>
              <span className="text-text-primary font-medium text-xs">
                {leg1Exchange.toUpperCase()}
              </span>
              <span className="mx-1 text-text-tertiary text-xs">/</span>
              <span className="text-text-primary font-bold text-xs">{leg1Symbol}</span>
              <span className="ml-1.5 text-[10px] bg-trade-buy bg-opacity-20 text-trade-buy px-1 py-0.5 rounded">
                {leg1Type.toUpperCase()}
              </span>
            </div>

            <div className="text-text-tertiary text-sm">↔</div>

            <div className="flex items-center bg-bg-tertiary rounded px-2 py-1">
              <span className="text-text-secondary text-xs mr-1.5">Leg2:</span>
              <span className="text-text-primary font-medium text-xs">
                {leg2Exchange.toUpperCase()}
              </span>
              <span className="mx-1 text-text-tertiary text-xs">/</span>
              <span className="text-text-primary font-bold text-xs">{leg2Symbol}</span>
              <span className="ml-1.5 text-[10px] bg-trade-sell bg-opacity-20 text-trade-sell px-1 py-0.5 rounded">
                {leg2Type.toUpperCase()}
              </span>
            </div>
          </div>
          
          {/* 當前價差 */}
          {displayData.length > 0 && (
            <div className="flex items-center space-x-2">
              <span className={`text-lg font-mono font-bold ${isPositive ? 'text-trade-buy' : 'text-trade-sell'}`}>
                {isPositive ? '+' : ''}
                {currentValue.toFixed(mode === 'spread' ? 2 : 4)}
              </span>
              <span className="text-text-secondary text-sm">
                {mode === 'spread' ? 'USDT' : '%'}
              </span>
            </div>
          )}
        </div>

        {/* 模式切換 */}
        <div className="flex items-center space-x-2">
          <button
            onClick={() => setMode('spread')}
            className={`px-3 py-1 rounded text-sm transition-colors ${
              mode === 'spread'
                ? 'bg-primary text-bg-primary'
                : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'
            }`}
          >
            絕對值
          </button>
          <button
            onClick={() => setMode('percent')}
            className={`px-3 py-1 rounded text-sm transition-colors ${
              mode === 'percent'
                ? 'bg-primary text-bg-primary'
                : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'
            }`}
          >
            百分比
          </button>
        </div>
      </div>

      {/* 圖表區域 */}
      <div className="flex-1 p-4">
        {displayData.length === 0 ? (
          <div className="h-full flex items-center justify-center">
            <div className="text-center">
              <div className="text-4xl text-text-tertiary mb-2">📈</div>
              <div className="text-text-secondary">等待價格數據...</div>
              <div className="text-text-tertiary text-sm mt-1">
                {leg1Exchange?.toUpperCase()} {leg1Symbol} ↔ {leg2Exchange?.toUpperCase()} {leg2Symbol}
              </div>
            </div>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={displayData} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#2B3139" />
              <XAxis 
                dataKey="time" 
                stroke="#848E9C"
                tick={{ fill: '#848E9C', fontSize: 11 }}
                tickLine={{ stroke: '#2B3139' }}
              />
              <YAxis 
                stroke="#848E9C"
                tick={{ fill: '#848E9C', fontSize: 11 }}
                tickLine={{ stroke: '#2B3139' }}
                tickFormatter={(value) => 
                  `${value >= 0 ? '+' : ''}${value.toFixed(mode === 'spread' ? 1 : 2)}`
                }
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: '#1E2329',
                  border: '1px solid #2B3139',
                  borderRadius: '4px',
                  fontSize: '12px',
                }}
                labelStyle={{ color: '#848E9C' }}
                itemStyle={{ color: '#EAECEF' }}
                formatter={(value: any) => [
                  `${value >= 0 ? '+' : ''}${value.toFixed(mode === 'spread' ? 2 : 4)} ${mode === 'spread' ? 'USDT' : '%'}`,
                  '價差',
                ]}
              />
              <Line
                type="monotone"
                dataKey="value"
                stroke={currentValue >= 0 ? '#0ECB81' : '#F6465D'}
                strokeWidth={2}
                dot={false}
                animationDuration={300}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
};

export default TradingChart;

