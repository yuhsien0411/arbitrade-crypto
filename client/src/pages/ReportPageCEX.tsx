/**
 * CEX 風格報表頁面
 * 顯示各交易所的淨值變化趨勢
 * 設計參考 Binance/Bybit 的專業報表風格
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Card, Row, Col, Button, Space, Typography, Empty, Spin } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { apiService } from '../services/api';
import dayjs from 'dayjs';

const { Text, Title } = Typography;

// 交易所顏色配置
const EXCHANGE_COLORS = {
  total: '#52c41a',     // 綠色 - 總計
  bybit: '#52c41a',     // 綠色 - Bybit
  binance: '#1890ff',   // 藍色 - Binance
  okx: '#faad14',       // 橙色 - OKX
  bitget: '#722ed1',    // 紫色 - Bitget
};

// 淨值記錄接口
interface NetValueRecord {
  timestamp: number;
  datetime: string;
  totalValue: number;
  exchanges: {
    bybit?: Record<string, number>;
    binance?: Record<string, number>;
    okx?: Record<string, number>;
    bitget?: Record<string, number>;
  };
}

// 圖表數據點接口
interface ChartDataPoint {
  time: string;
  timestamp: number;
  total?: number;
  bybit?: number;
  binance?: number;
  okx?: number;
  bitget?: number;
}

const ReportPageCEX: React.FC = () => {
  // 狀態管理
  const [loading, setLoading] = useState(false);
  const [netValueData, setNetValueData] = useState<NetValueRecord[]>([]);
  const [timeRange, setTimeRange] = useState<'day' | 'week' | 'month' | 'all'>('week');
  const [selectedExchanges, setSelectedExchanges] = useState<Record<string, boolean>>({
    total: true,
    bybit: true,
    binance: true,
    okx: true,
    bitget: true,
  });

  // 載入淨值歷史數據
  const loadNetValueData = useCallback(async () => {
    try {
      setLoading(true);
      
      // 根據時間範圍計算日期
      let fromDate: string | undefined;
      const toDate = dayjs().format('YYYY-MM-DD');
      
      switch (timeRange) {
        case 'day':
          fromDate = dayjs().subtract(1, 'day').format('YYYY-MM-DD');
          break;
        case 'week':
          fromDate = dayjs().subtract(7, 'day').format('YYYY-MM-DD');
          break;
        case 'month':
          fromDate = dayjs().subtract(30, 'day').format('YYYY-MM-DD');
          break;
        case 'all':
          fromDate = undefined; // 不限制開始日期
          break;
      }
      
      const params = fromDate ? { from_date: fromDate, to_date: toDate } : {};
      const response: any = await apiService.getNetValueHistory(params);
      
      if (response?.success && Array.isArray(response?.data)) {
        setNetValueData(response.data);
      } else {
        setNetValueData([]);
      }
    } catch (error) {
      console.error('載入淨值數據失敗:', error);
      setNetValueData([]);
    } finally {
      setLoading(false);
    }
  }, [timeRange]);

  // 初始載入和時間範圍變化時重新載入
  useEffect(() => {
    loadNetValueData();
  }, [loadNetValueData]);

  // 計算當前各交易所淨值
  const currentValues = useMemo(() => {
    if (netValueData.length === 0) {
      return {
        total: 0,
        bybit: 0,
        binance: 0,
        okx: 0,
        bitget: 0,
        totalChange: 0,
        totalChangePercent: 0,
      };
    }

    const latest = netValueData[netValueData.length - 1];
    const earliest = netValueData[0];
    
    // 計算各交易所淨值
    const calcExchangeValue = (balances?: Record<string, number>) => {
      if (!balances) return 0;
      return Object.values(balances).reduce((sum, val) => sum + val, 0);
    };

    const totalValue = latest.totalValue || 0;
    const bybitValue = calcExchangeValue(latest.exchanges?.bybit);
    const binanceValue = calcExchangeValue(latest.exchanges?.binance);
    const okxValue = calcExchangeValue(latest.exchanges?.okx);
    const bitgetValue = calcExchangeValue(latest.exchanges?.bitget);

    // 計算變化
    const earliestTotal = earliest.totalValue || 0;
    const totalChange = totalValue - earliestTotal;
    const totalChangePercent = earliestTotal > 0 ? (totalChange / earliestTotal) * 100 : 0;

    return {
      total: totalValue,
      bybit: bybitValue,
      binance: binanceValue,
      okx: okxValue,
      bitget: bitgetValue,
      totalChange,
      totalChangePercent,
    };
  }, [netValueData]);

  // 轉換為圖表數據
  const chartData = useMemo<ChartDataPoint[]>(() => {
    if (netValueData.length === 0) return [];

    return netValueData.map((record) => {
      const calcExchangeValue = (balances?: Record<string, number>) => {
        if (!balances) return undefined;
        const value = Object.values(balances).reduce((sum, val) => sum + val, 0);
        return value > 0 ? value : undefined;
      };

      const bybit = calcExchangeValue(record.exchanges?.bybit);
      const binance = calcExchangeValue(record.exchanges?.binance);
      const okx = calcExchangeValue(record.exchanges?.okx);
      const bitget = calcExchangeValue(record.exchanges?.bitget);

      return {
        time: dayjs(record.timestamp * 1000).format('MM-DD HH:mm'),
        timestamp: record.timestamp,
        total: record.totalValue > 0 ? record.totalValue : undefined,
        bybit,
        binance,
        okx,
        bitget,
      };
    });
  }, [netValueData]);

  // 切換交易所顯示
  const toggleExchange = (exchange: string) => {
    setSelectedExchanges((prev) => ({
      ...prev,
      [exchange]: !prev[exchange],
    }));
  };

  // 自定義 Tooltip
  const CustomTooltip = ({ active, payload, label }: any) => {
    if (!active || !payload || payload.length === 0) return null;

    return (
      <div
        style={{
          background: 'rgba(0, 0, 0, 0.8)',
          border: '1px solid #333',
          borderRadius: '4px',
          padding: '12px',
          color: '#fff',
        }}
      >
        <Text style={{ color: '#999', fontSize: '12px', display: 'block', marginBottom: '8px' }}>
          {label}
        </Text>
        {payload.map((item: any) => (
          <div key={item.dataKey} style={{ marginBottom: '4px' }}>
            <Text style={{ color: item.color, fontSize: '13px' }}>
              {item.name}: <strong>{item.value?.toFixed(2)} USDT</strong>
            </Text>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div style={{ background: '#0b0e11', minHeight: '100vh', padding: '0' }}>
      {/* 頂部淨值卡片 */}
      <Row gutter={[12, 12]} style={{ marginBottom: 24 }}>
        {/* 總淨值 */}
        <Col xs={24} sm={12} md={8} lg={24 / 5} xl={24 / 5} xxl={24 / 5}>
          <Card
            style={{
              background: '#1e2329',
              border: '1px solid #2b3139',
              borderRadius: '8px',
              height: '100%',
            }}
            bodyStyle={{ padding: '16px' }}
          >
            <Text style={{ color: '#848e9c', fontSize: '13px', display: 'block', marginBottom: '8px' }}>
              總淨值 (USDT)
            </Text>
            <Text style={{ color: '#ffffff', fontSize: '24px', fontWeight: 'bold', display: 'block', lineHeight: '1.2' }}>
              {currentValues.total.toFixed(2)}
            </Text>
            <Text
              style={{
                color: currentValues.totalChange >= 0 ? '#0ecb81' : '#f6465d',
                fontSize: '13px',
                display: 'block',
                marginTop: '8px',
              }}
            >
              {currentValues.totalChange >= 0 ? '+' : ''}
              {currentValues.totalChange.toFixed(2)} ({currentValues.totalChangePercent >= 0 ? '+' : ''}{currentValues.totalChangePercent.toFixed(2)}%)
            </Text>
          </Card>
        </Col>

        {/* Bybit */}
        <Col xs={24} sm={12} md={8} lg={24 / 5} xl={24 / 5} xxl={24 / 5}>
          <Card
            style={{
              background: '#1e2329',
              border: '1px solid #2b3139',
              borderRadius: '8px',
              height: '100%',
            }}
            bodyStyle={{ padding: '16px' }}
          >
            <Text style={{ color: '#848e9c', fontSize: '13px', display: 'block', marginBottom: '8px' }}>
              Bybit (USDT)
            </Text>
            <Text style={{ color: '#ffffff', fontSize: '24px', fontWeight: 'bold', display: 'block', lineHeight: '1.2' }}>
              {currentValues.bybit.toFixed(2)}
            </Text>
          </Card>
        </Col>

        {/* Binance */}
        <Col xs={24} sm={12} md={8} lg={24 / 5} xl={24 / 5} xxl={24 / 5}>
          <Card
            style={{
              background: '#1e2329',
              border: '1px solid #2b3139',
              borderRadius: '8px',
              height: '100%',
            }}
            bodyStyle={{ padding: '16px' }}
          >
            <Text style={{ color: '#848e9c', fontSize: '13px', display: 'block', marginBottom: '8px' }}>
              Binance (USDT)
            </Text>
            <Text style={{ color: '#ffffff', fontSize: '24px', fontWeight: 'bold', display: 'block', lineHeight: '1.2' }}>
              {currentValues.binance.toFixed(2)}
            </Text>
          </Card>
        </Col>

        {/* OKX */}
        <Col xs={24} sm={12} md={8} lg={24 / 5} xl={24 / 5} xxl={24 / 5}>
          <Card
            style={{
              background: '#1e2329',
              border: '1px solid #2b3139',
              borderRadius: '8px',
              height: '100%',
            }}
            bodyStyle={{ padding: '16px' }}
          >
            <Text style={{ color: '#848e9c', fontSize: '13px', display: 'block', marginBottom: '8px' }}>
              OKX (USDT)
            </Text>
            <Text style={{ color: '#ffffff', fontSize: '24px', fontWeight: 'bold', display: 'block', lineHeight: '1.2' }}>
              {currentValues.okx.toFixed(2)}
            </Text>
          </Card>
        </Col>

        {/* Bitget */}
        <Col xs={24} sm={12} md={8} lg={24 / 5} xl={24 / 5} xxl={24 / 5}>
          <Card
            style={{
              background: '#1e2329',
              border: '1px solid #2b3139',
              borderRadius: '8px',
              height: '100%',
            }}
            bodyStyle={{ padding: '16px' }}
          >
            <Text style={{ color: '#848e9c', fontSize: '13px', display: 'block', marginBottom: '8px' }}>
              Bitget (USDT)
            </Text>
            <Text style={{ color: '#ffffff', fontSize: '24px', fontWeight: 'bold', display: 'block', lineHeight: '1.2' }}>
              {currentValues.bitget.toFixed(2)}
            </Text>
          </Card>
        </Col>
      </Row>

      {/* 控制面板 */}
      <Card
        style={{
          background: '#1e2329',
          border: '1px solid #2b3139',
          borderRadius: '8px',
          marginBottom: 24,
        }}
        bodyStyle={{ padding: '16px 24px' }}
      >
        <Row align="middle" justify="space-between">
          {/* 左側：時間範圍 */}
          <Col>
            <Space size="middle">
              <Text style={{ color: '#848e9c', fontSize: '14px' }}>時間範圍：</Text>
              <Space size="small">
                <Button
                  type={timeRange === 'day' ? 'primary' : 'default'}
                  size="small"
                  onClick={() => setTimeRange('day')}
                  style={{
                    background: timeRange === 'day' ? '#f0b90b' : 'transparent',
                    borderColor: timeRange === 'day' ? '#f0b90b' : '#2b3139',
                    color: timeRange === 'day' ? '#000' : '#848e9c',
                  }}
                >
                  日
                </Button>
                <Button
                  type={timeRange === 'week' ? 'primary' : 'default'}
                  size="small"
                  onClick={() => setTimeRange('week')}
                  style={{
                    background: timeRange === 'week' ? '#f0b90b' : 'transparent',
                    borderColor: timeRange === 'week' ? '#f0b90b' : '#2b3139',
                    color: timeRange === 'week' ? '#000' : '#848e9c',
                  }}
                >
                  周
                </Button>
                <Button
                  type={timeRange === 'month' ? 'primary' : 'default'}
                  size="small"
                  onClick={() => setTimeRange('month')}
                  style={{
                    background: timeRange === 'month' ? '#f0b90b' : 'transparent',
                    borderColor: timeRange === 'month' ? '#f0b90b' : '#2b3139',
                    color: timeRange === 'month' ? '#000' : '#848e9c',
                  }}
                >
                  月
                </Button>
                <Button
                  type={timeRange === 'all' ? 'primary' : 'default'}
                  size="small"
                  onClick={() => setTimeRange('all')}
                  style={{
                    background: timeRange === 'all' ? '#f0b90b' : 'transparent',
                    borderColor: timeRange === 'all' ? '#f0b90b' : '#2b3139',
                    color: timeRange === 'all' ? '#000' : '#848e9c',
                  }}
                >
                  全部
                </Button>
              </Space>
            </Space>
          </Col>

          {/* 右側：交易所篩選 */}
          <Col>
            <Space size="middle">
              <Text style={{ color: '#848e9c', fontSize: '14px' }}>顯示：</Text>
              <Space size="small">
                <Button
                  type={selectedExchanges.total ? 'primary' : 'default'}
                  size="small"
                  onClick={() => toggleExchange('total')}
                  style={{
                    background: selectedExchanges.total ? '#eaaa08' : 'transparent',
                    borderColor: selectedExchanges.total ? '#eaaa08' : '#2b3139',
                    color: selectedExchanges.total ? '#000' : '#848e9c',
                    fontWeight: selectedExchanges.total ? 600 : 400,
                    transition: 'all 0.3s ease',
                  }}
                >
                  總計
                </Button>
                <Button
                  type={selectedExchanges.bybit ? 'primary' : 'default'}
                  size="small"
                  onClick={() => toggleExchange('bybit')}
                  style={{
                    background: selectedExchanges.bybit ? '#0ecb81' : 'transparent',
                    borderColor: selectedExchanges.bybit ? '#0ecb81' : '#2b3139',
                    color: selectedExchanges.bybit ? '#000' : '#848e9c',
                    fontWeight: selectedExchanges.bybit ? 600 : 400,
                    transition: 'all 0.3s ease',
                  }}
                >
                  Bybit
                </Button>
                <Button
                  type={selectedExchanges.binance ? 'primary' : 'default'}
                  size="small"
                  onClick={() => toggleExchange('binance')}
                  style={{
                    background: selectedExchanges.binance ? '#1890ff' : 'transparent',
                    borderColor: selectedExchanges.binance ? '#1890ff' : '#2b3139',
                    color: selectedExchanges.binance ? '#fff' : '#848e9c',
                    fontWeight: selectedExchanges.binance ? 600 : 400,
                    transition: 'all 0.3s ease',
                  }}
                >
                  Binance
                </Button>
                <Button
                  type={selectedExchanges.okx ? 'primary' : 'default'}
                  size="small"
                  onClick={() => toggleExchange('okx')}
                  style={{
                    background: selectedExchanges.okx ? '#faad14' : 'transparent',
                    borderColor: selectedExchanges.okx ? '#faad14' : '#2b3139',
                    color: selectedExchanges.okx ? '#000' : '#848e9c',
                    fontWeight: selectedExchanges.okx ? 600 : 400,
                    transition: 'all 0.3s ease',
                  }}
                >
                  OKX
                </Button>
                <Button
                  type={selectedExchanges.bitget ? 'primary' : 'default'}
                  size="small"
                  onClick={() => toggleExchange('bitget')}
                  style={{
                    background: selectedExchanges.bitget ? '#722ed1' : 'transparent',
                    borderColor: selectedExchanges.bitget ? '#722ed1' : '#2b3139',
                    color: selectedExchanges.bitget ? '#fff' : '#848e9c',
                    fontWeight: selectedExchanges.bitget ? 600 : 400,
                    transition: 'all 0.3s ease',
                  }}
                >
                  Bitget
                </Button>
              </Space>
              <Button
                icon={<ReloadOutlined />}
                size="small"
                onClick={loadNetValueData}
                loading={loading}
                style={{
                  background: 'transparent',
                  borderColor: '#2b3139',
                  color: '#848e9c',
                  transition: 'all 0.3s ease',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)';
                  e.currentTarget.style.borderColor = '#474d57';
                  e.currentTarget.style.color = '#fff';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent';
                  e.currentTarget.style.borderColor = '#2b3139';
                  e.currentTarget.style.color = '#848e9c';
                }}
              >
                刷新
              </Button>
            </Space>
          </Col>
        </Row>
      </Card>

      {/* 圖表區域 */}
      <Card
        style={{
          background: '#1e2329',
          border: '1px solid #2b3139',
          borderRadius: '8px',
        }}
        bodyStyle={{ padding: '24px' }}
      >
        <Title level={4} style={{ color: '#ffffff', marginBottom: 24 }}>
          帳戶淨值曲線
        </Title>

        {loading ? (
          <div style={{ textAlign: 'center', padding: '100px 0' }}>
            <Spin size="large" />
          </div>
        ) : chartData.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <Text style={{ color: '#848e9c' }}>暫無淨值數據</Text>
            }
            style={{ padding: '100px 0' }}
          />
        ) : (
          <ResponsiveContainer width="100%" height={500}>
            <LineChart data={chartData} margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#2b3139" />
              <XAxis
                dataKey="time"
                stroke="#848e9c"
                tick={{ fill: '#848e9c', fontSize: 12 }}
                interval="preserveStartEnd"
              />
              <YAxis
                stroke="#848e9c"
                tick={{ fill: '#848e9c', fontSize: 12 }}
                tickFormatter={(value) => `${value.toFixed(0)}`}
              />
              <Tooltip content={<CustomTooltip />} />
              <Legend
                wrapperStyle={{ color: '#848e9c' }}
                iconType="line"
                formatter={(value) => (
                  <span style={{ color: '#848e9c' }}>{value}</span>
                )}
              />
              
              {selectedExchanges.total && (
                <Line
                  type="monotone"
                  dataKey="total"
                  name="總計"
                  stroke={EXCHANGE_COLORS.total}
                  strokeWidth={3}
                  dot={false}
                  activeDot={{ r: 6 }}
                />
              )}
              {selectedExchanges.bybit && (
                <Line
                  type="monotone"
                  dataKey="bybit"
                  name="Bybit"
                  stroke={EXCHANGE_COLORS.bybit}
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 5 }}
                />
              )}
              {selectedExchanges.binance && (
                <Line
                  type="monotone"
                  dataKey="binance"
                  name="Binance"
                  stroke={EXCHANGE_COLORS.binance}
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 5 }}
                />
              )}
              {selectedExchanges.okx && (
                <Line
                  type="monotone"
                  dataKey="okx"
                  name="OKX"
                  stroke={EXCHANGE_COLORS.okx}
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 5 }}
                />
              )}
              {selectedExchanges.bitget && (
                <Line
                  type="monotone"
                  dataKey="bitget"
                  name="Bitget"
                  stroke={EXCHANGE_COLORS.bitget}
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 5 }}
                />
              )}
            </LineChart>
          </ResponsiveContainer>
        )}
      </Card>
    </div>
  );
};

export default ReportPageCEX;

