/**
 * TradingView 價格圖表組件
 * 使用 Lightweight Charts 顯示兩個交易所的實時價格與價差
 * 分為兩個獨立圖表：上方顯示價格走勢，下方顯示價差率
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { createChart, LineData, Time } from 'lightweight-charts';
import { Card, Button, Space } from 'antd';
import { getApiBaseUrl } from '../utils/env';
import { formatUnixTime, formatUnixTimeFull } from '../utils/formatters';

interface TradingViewPriceChartProps {
  leg1Exchange: string;
  leg1Symbol: string;
  leg1Type?: 'spot' | 'linear';
  leg1Side?: 'buy' | 'sell';
  leg2Exchange: string;
  leg2Symbol: string;
  leg2Type?: 'spot' | 'linear';
  leg2Side?: 'buy' | 'sell';
  height?: number;
}

const TradingViewPriceChart: React.FC<TradingViewPriceChartProps> = ({
  leg1Exchange,
  leg1Symbol,
  leg1Type = 'spot',
  leg1Side = 'buy',
  leg2Exchange,
  leg2Symbol,
  leg2Type = 'linear',
  leg2Side = 'sell',
  height = 450,
}) => {
  // 上方圖表容器（價格）
  const priceChartContainerRef = useRef<HTMLDivElement>(null);
  const priceChartRef = useRef<ReturnType<typeof createChart> | null>(null);
  const leg1SeriesRef = useRef<any>(null);
  const leg2SeriesRef = useRef<any>(null);

  // 下方圖表容器（價差率）
  const spreadChartContainerRef = useRef<HTMLDivElement>(null);
  const spreadChartRef = useRef<ReturnType<typeof createChart> | null>(null);
  const spreadSeriesPositiveRef = useRef<any>(null); // 正值（綠色）
  const spreadSeriesNegativeRef = useRef<any>(null); // 負值（紅色）

  const [timeframe, setTimeframe] = useState<string>('1m');

  // 時間周期選項
  const timeframeOptions = [
    { label: '1m', value: '1m' },
    { label: '5m', value: '5m' },
    { label: '15m', value: '15m' },
    { label: '30m', value: '30m' },
    { label: '1H', value: '1h' },
    { label: '4H', value: '4h' },
    { label: '1D', value: '1d' },
  ];

  // 數據存儲
  const leg1DataRef = useRef<LineData[]>([]);
  const leg2DataRef = useRef<LineData[]>([]);
  const spreadDataRef = useRef<LineData[]>([]);

  // 計算圖表高度（上方70%價格，下方30%價差）
  const priceChartHeight = Math.floor(height * 0.7);
  const spreadChartHeight = height - priceChartHeight - 8; // 8px 間距

  // 統一的價格格式化函數：智能格式化，最多8個數字+1個小數點，預留固定寬度空間
  const formatPriceFixedWidth = useCallback((price: number): string => {
    if (typeof price !== 'number' || Number.isNaN(price)) {
      return '0';
    }
    
    // 智能決定小數位數：確保總共不超過8個數字（不包括小數點）
    const absPrice = Math.abs(price);
    const integerPart = Math.floor(absPrice);
    const integerDigits = integerPart.toString().length;
    
    let precision = 2;
    
    // 根據整數部分位數動態調整小數位數，確保總數字數不超過8個
    if (integerDigits >= 6) {
      precision = 1; // 6位整數：1位小數（總共7個數字）
    } else if (integerDigits >= 5) {
      precision = 2; // 5位整數：2位小數（總共7個數字）
    } else if (integerDigits >= 4) {
      precision = 3; // 4位整數：3位小數（總共7個數字）
    } else if (integerDigits >= 3) {
      precision = 4; // 3位整數：4位小數（總共7個數字）
    } else if (integerDigits >= 2) {
      precision = 5; // 2位整數：5位小數（總共7個數字）
    } else if (integerDigits >= 1) {
      precision = 6; // 1位整數：6位小數（總共7個數字）
    } else {
      precision = 7; // 0位整數（小數）：7位小數（總共7個數字）
    }
    
    // 格式化並移除尾部零
    const formatted = price.toFixed(precision);
    return formatted.replace(/\.?0+$/, ''); // 移除尾部零和小數點（如果沒有小數部分）
  }, []);

  // 價差格式化函數：固定顯示小數後3位
  const formatSpreadFixedWidth = useCallback((spread: number): string => {
    if (typeof spread !== 'number' || Number.isNaN(spread)) {
      return '0.000';
    }
    
    // 固定顯示3位小數
    return spread.toFixed(3);
  }, []);

  const calculateSpreadRatio = useCallback(
    (price1: number, price2: number): { ratio: number; percent: number } => {
      if (price1 <= 0 || price2 <= 0) {
        return { ratio: 100, percent: 0 };
      }

      let ratio = 100;

      if (leg1Side === 'sell' && leg2Side === 'buy') {
        ratio = (price1 / price2) * 100;
      } else if (leg1Side === 'buy' && leg2Side === 'sell') {
        ratio = (price2 / price1) * 100;
      }

      const percent = ratio - 100;
      return { ratio, percent };
    },
    [leg1Side, leg2Side],
  );

  // 同步時間軸的函數
  const syncTimeScales = useCallback((sourceChart: any, targetChart: any) => {
    if (!sourceChart || !targetChart) return;
    
    try {
      const sourceTimeScale = sourceChart.timeScale();
      const targetTimeScale = targetChart.timeScale();

      if (!sourceTimeScale || !targetTimeScale) return;

      const visibleRange = sourceTimeScale.getVisibleRange();
      if (visibleRange && visibleRange.from !== null && visibleRange.to !== null) {
        // 檢查目標圖表是否有數據
        const targetRange = targetTimeScale.getVisibleRange();
        if (targetRange) {
          targetTimeScale.setVisibleRange(visibleRange);
        }
      }
    } catch (error) {
      // 忽略同步錯誤，避免在圖表初始化期間的錯誤
      console.debug('時間軸同步錯誤（可忽略）:', error);
    }
  }, []);

  // 初始化價格圖表（上方）
  useEffect(() => {
    if (!priceChartContainerRef.current) return;

    const chart = createChart(priceChartContainerRef.current, {
      width: priceChartContainerRef.current.clientWidth,
      height: priceChartHeight,
      layout: {
        background: { color: '#0b0e11' },
        textColor: '#848e9c',
      },
      grid: {
        vertLines: { color: '#1e2329', visible: false },
        horzLines: {
          color: '#2b3139',
          visible: true,
          style: 0,
        },
      },
      localization: {
        timeFormatter: (time: Time) => formatUnixTimeFull(Number(time)),
        priceFormatter: (price: number) => formatPriceFixedWidth(price),
      },
      crosshair: {
        mode: 1,
        vertLine: {
          width: 1,
          color: '#758696',
          style: 3,
          labelBackgroundColor: '#f0b90b',
        },
        horzLine: {
          width: 1,
          color: '#758696',
          style: 3,
          labelBackgroundColor: '#f0b90b',
        },
      } as any,
      rightPriceScale: {
        visible: true,
        borderColor: '#2b3139',
        scaleMargins: {
          top: 0.05,
          bottom: 0.1,
        },
        entireTextOnly: false,
        autoScale: true,
        minimumWidth: 85,
        allowBoldLabels: false,
        mode: 0,
      },
      leftPriceScale: {
        visible: false,
      },
      timeScale: {
        borderColor: '#2b3139',
        timeVisible: false,
        secondsVisible: false,
        visible: false,
        fixLeftEdge: true,
        fixRightEdge: true,
        tickMarkFormatter: (time: Time) => formatUnixTime(Number(time), 'HH:mm'),
        minBarSpacing: 0.5,
        rightOffset: 5,
      },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
      },
      handleScale: {
        axisPressedMouseMove: true,
        mouseWheel: true,
        pinch: true,
        axisDoubleClickReset: true,
      },
    } as any);

    priceChartRef.current = chart;

    // Leg1 價格線
    const leg1Series = chart.addLineSeries({
      color: '#f59e42',
      lineWidth: 2,
      priceScaleId: 'right',
      crosshairMarkerVisible: true,
      crosshairMarkerRadius: 4,
      lastValueVisible: true,
      priceLineVisible: true,
      title: `${leg1Exchange.toUpperCase()} ${leg1Symbol}`,
    });
    leg1SeriesRef.current = leg1Series;

    // Leg2 價格線
    const leg2Series = chart.addLineSeries({
      color: '#4a9eff',
      lineWidth: 2,
      priceScaleId: 'right',
      crosshairMarkerVisible: true,
      crosshairMarkerRadius: 4,
      lastValueVisible: true,
      priceLineVisible: true,
      title: `${leg2Exchange.toUpperCase()} ${leg2Symbol}`,
    });
    leg2SeriesRef.current = leg2Series;

    // 時間軸同步：當上方圖表滾動時，同步下方圖表
    let syncTimer: NodeJS.Timeout | null = null;
    chart.timeScale().subscribeVisibleTimeRangeChange(() => {
      if (priceChartRef.current && spreadChartRef.current) {
        if (syncTimer) {
          clearTimeout(syncTimer);
        }
        syncTimer = setTimeout(() => {
          syncTimeScales(priceChartRef.current, spreadChartRef.current);
        }, 50);
      }
    });

    const handleResize = () => {
      if (priceChartContainerRef.current && priceChartRef.current) {
        priceChartRef.current.applyOptions({
          width: priceChartContainerRef.current.clientWidth,
        });
      }
    };

    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      if (syncTimer) {
        clearTimeout(syncTimer);
      }
      chart.remove();
    };
  }, [priceChartHeight, leg1Exchange, leg1Symbol, leg2Exchange, leg2Symbol, syncTimeScales, formatPriceFixedWidth]);

  // 初始化價差率圖表（下方）
  useEffect(() => {
    if (!spreadChartContainerRef.current) return;

    const chart = createChart(spreadChartContainerRef.current, {
      width: spreadChartContainerRef.current.clientWidth,
      height: spreadChartHeight,
      layout: {
        background: { color: '#0b0e11' },
        textColor: '#848e9c',
      },
      grid: {
        vertLines: { color: '#1e2329', visible: false },
        horzLines: {
          color: '#2b3139',
          visible: true,
          style: 0,
        },
      },
      localization: {
        timeFormatter: (time: Time) => formatUnixTimeFull(Number(time)),
        priceFormatter: (price: number) => formatSpreadFixedWidth(price),
      },
      crosshair: {
        mode: 1,
        vertLine: {
          width: 1,
          color: '#758696',
          style: 3,
          labelBackgroundColor: '#f0b90b',
        },
        horzLine: {
          width: 1,
          color: '#758696',
          style: 3,
          labelBackgroundColor: '#f0b90b',
        },
      } as any,
      rightPriceScale: {
        visible: true,
        borderColor: '#2b3139',
        scaleMargins: {
          top: 0.05,
          bottom: 0.1,
        },
        entireTextOnly: false,
        autoScale: true,
        minimumWidth: 85,
        mode: 0,
      },
      leftPriceScale: {
        visible: false,
      },
      timeScale: {
        borderColor: '#2b3139',
        timeVisible: true,
        secondsVisible: true,
        fixLeftEdge: true,
        fixRightEdge: true,
        tickMarkFormatter: (time: Time) => formatUnixTime(Number(time), 'HH:mm'),
        minBarSpacing: 0.5,
        rightOffset: 5,
      },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
      },
      handleScale: {
        axisPressedMouseMove: true,
        mouseWheel: true,
        pinch: true,
        axisDoubleClickReset: true,
      },
    } as any);

    spreadChartRef.current = chart;

    // 價差率摺線圖 - 正值（綠色）
    const spreadSeriesPositive = chart.addLineSeries({
      color: '#0ecb81',
      lineWidth: 2,
      priceScaleId: 'right',
      crosshairMarkerVisible: true,
      crosshairMarkerRadius: 4,
      lastValueVisible: false,
      priceLineVisible: false,
      title: '價差率 (%)',
    });
    spreadSeriesPositiveRef.current = spreadSeriesPositive;

    // 價差率摺線圖 - 負值（紅色）
    const spreadSeriesNegative = chart.addLineSeries({
      color: '#f6465d',
      lineWidth: 2,
      priceScaleId: 'right',
      crosshairMarkerVisible: true,
      crosshairMarkerRadius: 4,
      lastValueVisible: false,
      priceLineVisible: false,
      title: '價差率 (%)',
    });
    spreadSeriesNegativeRef.current = spreadSeriesNegative;

    // 添加 0% 基準線（使用正值 series）
    spreadSeriesPositive.createPriceLine({
      price: 0,
      color: '#848e9c',
      lineWidth: 1,
      lineStyle: 2,
      axisLabelVisible: true,
      title: '0%',
    });

    // 時間軸同步：當下方圖表滾動時，同步上方圖表
    let syncTimer2: NodeJS.Timeout | null = null;
    chart.timeScale().subscribeVisibleTimeRangeChange(() => {
      if (spreadChartRef.current && priceChartRef.current) {
        if (syncTimer2) {
          clearTimeout(syncTimer2);
        }
        syncTimer2 = setTimeout(() => {
          syncTimeScales(spreadChartRef.current, priceChartRef.current);
        }, 50);
      }
    });

    const handleResize = () => {
      if (spreadChartContainerRef.current && spreadChartRef.current) {
        spreadChartRef.current.applyOptions({
          width: spreadChartContainerRef.current.clientWidth,
        });
      }
    };

    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      if (syncTimer2) {
        clearTimeout(syncTimer2);
      }
      chart.remove();
    };
  }, [spreadChartHeight, leg1Exchange, leg1Symbol, leg2Exchange, leg2Symbol, syncTimeScales, formatSpreadFixedWidth]);

  // 載入歷史 K 線數據（使用舊版的防抖邏輯）
  useEffect(() => {
    // 🔥 立即清除舊數據，避免顯示舊交易所/標的的數據
    if (leg1SeriesRef.current) leg1SeriesRef.current.setData([]);
    if (leg2SeriesRef.current) leg2SeriesRef.current.setData([]);
    if (spreadSeriesPositiveRef.current) spreadSeriesPositiveRef.current.setData([]);
    if (spreadSeriesNegativeRef.current) spreadSeriesNegativeRef.current.setData([]);
    leg1DataRef.current = [];
    leg2DataRef.current = [];
    spreadDataRef.current = [];

    const loadHistoricalData = async () => {
      if (!leg1SeriesRef.current || !leg2SeriesRef.current || !spreadSeriesPositiveRef.current || !spreadSeriesNegativeRef.current) return;

      try {
        const apiBase = getApiBaseUrl();
        // 根據時間框架調整數據量，較長時間框架減少數據量以提升速度
        const limit = ['1m', '5m'].includes(timeframe) ? 500 : 300;
        
        const [leg1Response, leg2Response] = await Promise.all([
          fetch(`${apiBase}/api/klines/${leg1Exchange}/${leg1Symbol}?category=${leg1Type}&interval=${timeframe}&limit=${limit}`),
          fetch(`${apiBase}/api/klines/${leg2Exchange}/${leg2Symbol}?category=${leg2Type}&interval=${timeframe}&limit=${limit}`),
        ]);

        if (!leg1Response.ok) throw new Error(`Leg1 API error (${leg1Response.status})`);
        if (!leg2Response.ok) throw new Error(`Leg2 API error (${leg2Response.status})`);

        const leg1Result = await leg1Response.json();
        const leg2Result = await leg2Response.json();

        // 🔥 先重置數據，確保即使其中一個失敗也能清除舊數據
        leg1DataRef.current = [];
        leg2DataRef.current = [];

        if (leg1Result.success && leg1Result.data?.length) {
          const leg1LineData: LineData[] = leg1Result.data.map((k: any) => ({
            time: k.time as Time,
            value: k.close,
          }));
          leg1SeriesRef.current.setData(leg1LineData);
          leg1DataRef.current = leg1LineData;
        } else {
          // 🔥 如果 leg1 數據載入失敗，清除圖表數據
          leg1SeriesRef.current.setData([]);
        }

        if (leg2Result.success && leg2Result.data?.length) {
          const leg2LineData: LineData[] = leg2Result.data.map((k: any) => ({
            time: k.time as Time,
            value: k.close,
          }));
          leg2SeriesRef.current.setData(leg2LineData);
          leg2DataRef.current = leg2LineData;
        } else {
          // 🔥 如果 leg2 數據載入失敗，清除圖表數據
          leg2SeriesRef.current.setData([]);
        }

        // 🔥 計算價差率數據，根據正負值分配到不同的 series
        // 只有當兩個 leg 都有數據時才計算價差
        if (leg1DataRef.current.length > 0 && leg2DataRef.current.length > 0) {
          const spreadLineData: LineData[] = [];
          const positiveData: LineData[] = [];
          const negativeData: LineData[] = [];
          const minLength = Math.min(leg1DataRef.current.length, leg2DataRef.current.length);

          for (let i = 0; i < minLength; i++) {
            const price1 = leg1DataRef.current[i].value;
            const price2 = leg2DataRef.current[i].value;
            const { percent } = calculateSpreadRatio(price1, price2);
            const time = leg1DataRef.current[i].time;
            const point: LineData = { time, value: percent };

            spreadLineData.push(point);

            // 處理跨越 0 的情況：如果前一個點和當前點符號不同，需要在 0 處添加連接點
            if (i > 0) {
              const prevValue = spreadLineData[i - 1].value;
              const prevTime = leg1DataRef.current[i - 1].time;
              if ((prevValue >= 0 && percent < 0) || (prevValue < 0 && percent >= 0)) {
                // 跨越 0，在前一個時間點添加 0 點到兩個 series 以連接線條
                const zeroPointPrev: LineData = { time: prevTime, value: 0 };
                const zeroPointCurr: LineData = { time, value: 0 };
                positiveData.push(zeroPointPrev);
                positiveData.push(zeroPointCurr);
                negativeData.push(zeroPointPrev);
                negativeData.push(zeroPointCurr);
              }
            }

            // 根據值的正負分配到對應的 series
            if (percent >= 0) {
              positiveData.push(point);
            } else {
              negativeData.push(point);
            }
          }

          // 設置數據到對應的 series
          spreadSeriesPositiveRef.current.setData(positiveData);
          spreadSeriesNegativeRef.current.setData(negativeData);
          spreadDataRef.current = spreadLineData;
        } else {
          // 🔥 如果其中一個 leg 沒有數據，清除價差數據
          spreadSeriesPositiveRef.current.setData([]);
          spreadSeriesNegativeRef.current.setData([]);
          spreadDataRef.current = [];
        }

      } catch (error) {
        console.error('歷史數據載入失敗:', error);
        // 🔥 錯誤時也要清除數據，避免顯示舊數據
        if (leg1SeriesRef.current) leg1SeriesRef.current.setData([]);
        if (leg2SeriesRef.current) leg2SeriesRef.current.setData([]);
        if (spreadSeriesPositiveRef.current) spreadSeriesPositiveRef.current.setData([]);
        if (spreadSeriesNegativeRef.current) spreadSeriesNegativeRef.current.setData([]);
        leg1DataRef.current = [];
        leg2DataRef.current = [];
        spreadDataRef.current = [];
      }
    };

    // 🔥 使用舊版的防抖邏輯：500ms 延遲
    const timer = setTimeout(loadHistoricalData, 500);
    return () => clearTimeout(timer);
  }, [leg1Exchange, leg1Symbol, leg1Type, leg2Exchange, leg2Symbol, leg2Type, timeframe, leg1Side, leg2Side, calculateSpreadRatio]);

  // 訂閱實時價格
  useEffect(() => {
    const handlePriceUpdate = (event: any) => {
      const { data: wsData } = event.detail;
      if (!wsData) return;

      const leg1 = wsData.leg1Price;
      const leg2 = wsData.leg2Price;

      const matchLeg1 = leg1?.exchange === leg1Exchange && leg1?.symbol === leg1Symbol;
      const matchLeg2 = leg2?.exchange === leg2Exchange && leg2?.symbol === leg2Symbol;

      if (!matchLeg1 || !matchLeg2) return;

      const timestamp = wsData.timestamp || Date.now();
      const time = Math.floor(timestamp / 1000) as Time;

      const price1 = leg1.lastPrice || leg1.bid1?.price || leg1.ask1?.price || 0;
      const price2 = leg2.lastPrice || leg2.bid1?.price || leg2.ask1?.price || 0;

      if (price1 === 0 || price2 === 0) return;

      const { percent } = calculateSpreadRatio(price1, price2);

      const leg1Point: LineData = { time, value: price1 };
      const leg2Point: LineData = { time, value: price2 };
      const spreadPoint: LineData = { time, value: percent };

      leg1DataRef.current.push(leg1Point);
      leg2DataRef.current.push(leg2Point);
      spreadDataRef.current.push(spreadPoint);

      if (leg1DataRef.current.length > 1000) leg1DataRef.current.shift();
      if (leg2DataRef.current.length > 1000) leg2DataRef.current.shift();
      if (spreadDataRef.current.length > 1000) spreadDataRef.current.shift();

      if (leg1SeriesRef.current) leg1SeriesRef.current.update(leg1Point);
      if (leg2SeriesRef.current) leg2SeriesRef.current.update(leg2Point);
      
      // 處理跨越 0 的情況：如果前一個點和當前點符號不同，需要在 0 處添加連接點
      if (spreadDataRef.current.length > 1) {
        const prevValue = spreadDataRef.current[spreadDataRef.current.length - 2].value;
        const prevTime = spreadDataRef.current[spreadDataRef.current.length - 2].time;
        if ((prevValue >= 0 && percent < 0) || (prevValue < 0 && percent >= 0)) {
          // 跨越 0，在前一個時間點添加 0 點到兩個 series，然後在當前時間點也添加 0 點
          const zeroPointPrev: LineData = { time: prevTime, value: 0 };
          const zeroPointCurr: LineData = { time, value: 0 };
          if (spreadSeriesPositiveRef.current) {
            spreadSeriesPositiveRef.current.update(zeroPointPrev);
            spreadSeriesPositiveRef.current.update(zeroPointCurr);
          }
          if (spreadSeriesNegativeRef.current) {
            spreadSeriesNegativeRef.current.update(zeroPointPrev);
            spreadSeriesNegativeRef.current.update(zeroPointCurr);
          }
        }
      }

      // 根據值的正負更新對應的 series
      if (percent >= 0) {
        if (spreadSeriesPositiveRef.current) spreadSeriesPositiveRef.current.update(spreadPoint);
      } else {
        if (spreadSeriesNegativeRef.current) spreadSeriesNegativeRef.current.update(spreadPoint);
      }
    };

    window.addEventListener('priceUpdate', handlePriceUpdate);
    return () => {
      window.removeEventListener('priceUpdate', handlePriceUpdate);
    };
  }, [leg1Exchange, leg1Symbol, leg2Exchange, leg2Symbol, leg1Side, leg2Side, calculateSpreadRatio]);

  return (
    <Card
      bodyStyle={{
        padding: 0,
        background: '#0b0e11',
        overflow: 'visible',
      }}
      style={{
        background: '#0b0e11',
        border: '1px solid #2b3139',
        borderRadius: 8,
        overflow: 'hidden',
      }}
    >
      {/* 時間周期選擇按鈕 */}
      <div
        style={{
          padding: '12px 16px',
          borderBottom: '1px solid #2b3139',
          background: '#0b0e11',
        }}
      >
        <Space size="small">
          {timeframeOptions.map((option) => (
            <Button
              key={option.value}
              type={timeframe === option.value ? 'primary' : 'default'}
              size="small"
              onClick={() => setTimeframe(option.value)}
              style={{
                background: timeframe === option.value ? '#f0b90b' : 'transparent',
                borderColor: timeframe === option.value ? '#f0b90b' : '#2b3139',
                color: timeframe === option.value ? '#0b0e11' : '#848e9c',
                minWidth: '50px',
              }}
            >
              {option.label}
            </Button>
          ))}
        </Space>
      </div>

      {/* 上方圖表：價格走勢 */}
      <div
        ref={priceChartContainerRef}
        style={{
          position: 'relative',
          width: '100%',
          height: priceChartHeight,
          overflow: 'visible',
          boxSizing: 'border-box',
        }}
      />
      
      {/* 間距 */}
      <div style={{ height: '8px' }} />
      
      {/* 下方圖表：價差率 */}
      <div
        ref={spreadChartContainerRef}
        style={{
          position: 'relative',
          width: '100%',
          height: spreadChartHeight,
          overflow: 'visible',
          boxSizing: 'border-box',
        }}
      />
    </Card>
  );
};

export default TradingViewPriceChart;
