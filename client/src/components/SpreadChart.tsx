/**
 * 價差圖表組件
 * 顯示PAIRS的實時價差走勢
 */

import React, { useState, useEffect, useRef } from 'react';
import { Line } from '@ant-design/plots';
import { Card, Space, Typography, Statistic, Row, Col, Radio, Empty, Tag } from 'antd';
import {
  RiseOutlined,
  FallOutlined,
  LineChartOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { formatTimeHMS } from '../utils/formatters';

const { Text } = Typography;

interface SpreadDataPoint {
  time: string;
  timestamp: number;
  spread: number;
  spreadPercent: number;
  leg1Price: number;
  leg2Price: number;
}

interface SpreadChartProps {
  leg1Exchange?: string;
  leg1Symbol?: string;
  leg2Exchange?: string;
  leg2Symbol?: string;
  height?: number;
  maxDataPoints?: number;
}

const SpreadChart: React.FC<SpreadChartProps> = ({
  leg1Exchange,
  leg1Symbol,
  leg2Exchange,
  leg2Symbol,
  height = 400,
  maxDataPoints = 100,
}) => {
  const [data, setData] = useState<SpreadDataPoint[]>([]);
  const [mode, setMode] = useState<'spread' | 'percent'>('percent');
  const dataRef = useRef<SpreadDataPoint[]>([]);

  // 訂閱 WebSocket 價格更新
  useEffect(() => {
    const handlePriceUpdate = (event: any) => {
      const { data: wsData } = event.detail;
      if (!wsData) return;

      const { leg1Price: wsLeg1, leg2Price: wsLeg2, spread, spreadPercent, timestamp } = wsData;

      // 檢查是否匹配當前配置
      const matchLeg1 =
        !leg1Exchange ||
        !leg1Symbol ||
        (wsLeg1 && wsLeg1.exchange === leg1Exchange && wsLeg1.symbol === leg1Symbol);

      const matchLeg2 =
        !leg2Exchange ||
        !leg2Symbol ||
        (wsLeg2 && wsLeg2.exchange === leg2Exchange && wsLeg2.symbol === leg2Symbol);

      if (!matchLeg1 || !matchLeg2) {
        return;
      }

      // 創建新數據點（統一使用 formatTimeHMS 確保時區一致）
      const newPoint: SpreadDataPoint = {
        time: formatTimeHMS(timestamp || Date.now()),
        timestamp: timestamp || Date.now(),
        spread: spread || 0,
        spreadPercent: spreadPercent || 0,
        leg1Price: wsLeg1?.bid1?.price || wsLeg1?.ask1?.price || 0,
        leg2Price: wsLeg2?.bid1?.price || wsLeg2?.ask1?.price || 0,
      };

      // 更新數據（保持最多 maxDataPoints 個點）
      const updatedData = [...dataRef.current, newPoint].slice(-maxDataPoints);
      dataRef.current = updatedData;
      setData(updatedData);
    };

    // 監聽自定義事件
    window.addEventListener('priceUpdate', handlePriceUpdate);

    return () => {
      window.removeEventListener('priceUpdate', handlePriceUpdate);
    };
  }, [leg1Exchange, leg1Symbol, leg2Exchange, leg2Symbol, maxDataPoints]);

  // 計算統計數據
  const stats = React.useMemo(() => {
    if (data.length === 0) {
      return {
        current: 0,
        change: 0,
        changePercent: 0,
        highest: 0,
        lowest: 0,
        average: 0,
      };
    }

    const values = mode === 'spread' ? data.map((d) => d.spread) : data.map((d) => d.spreadPercent);
    const current = values[values.length - 1];
    const first = values[0];
    const change = current - first;
    const changePercent = first !== 0 ? (change / Math.abs(first)) * 100 : 0;
    const highest = Math.max(...values);
    const lowest = Math.min(...values);
    const average = values.reduce((a, b) => a + b, 0) / values.length;

    return {
      current,
      change,
      changePercent,
      highest,
      lowest,
      average,
    };
  }, [data, mode]);

  // 圖表配置
  const config = {
    data: data.map((d) => ({
      time: d.time,
      value: mode === 'spread' ? d.spread : d.spreadPercent,
      timestamp: d.timestamp,
    })),
    xField: 'time',
    yField: 'value',
    height,
    smooth: true,
    animation: {
      appear: {
        animation: 'path-in',
        duration: 500,
      },
    },
    lineStyle: {
      lineWidth: 2,
      stroke: stats.current >= 0 ? '#0ecb81' : '#f6465d',
    },
    point: {
      size: 0,
      style: {
        fill: stats.current >= 0 ? '#0ecb81' : '#f6465d',
      },
    },
    areaStyle: {
      fill: stats.current >= 0 ? 'l(90) 0:#0ecb8120 1:#0ecb8105' : 'l(90) 0:#f6465d20 1:#f6465d05',
    },
    color: stats.current >= 0 ? '#0ecb81' : '#f6465d',
    tooltip: {
      showTitle: true,
      title: (datum: any) => datum.time || '',
      formatter: (datum: any) => {
        const suffix = mode === 'spread' ? ' USDT' : '%';
        return {
          name: '價差',
          value: `${datum.value >= 0 ? '+' : ''}${datum.value.toFixed(mode === 'spread' ? 2 : 4)}${suffix}`,
        };
      },
      showCrosshairs: true,
      crosshairs: {
        type: 'xy',
        line: {
          style: {
            stroke: '#1890ff',
            lineWidth: 1,
            lineDash: [4, 4],
          },
        },
      },
    },
    xAxis: {
      label: {
        autoRotate: false,
        autoHide: true,
        autoEllipsis: true,
        rotate: -30,
        offset: 10,
        style: {
          fontSize: 10,
          fill: '#848e9c',
        },
        formatter: (text: string, item: any, index: number) => {
          // 只顯示部分標籤
          if (data.length > 50 && index % 10 !== 0) {
            return '';
          }
          if (data.length > 20 && index % 5 !== 0) {
            return '';
          }
          return text;
        },
      },
      line: {
        style: {
          stroke: '#2b3139',
        },
      },
    },
    yAxis: {
      title: {
        text: mode === 'spread' ? '價差 (USDT)' : '價差百分比 (%)',
        style: {
          fontSize: 12,
          fill: '#848e9c',
        },
      },
      label: {
        formatter: (v: string) => {
          const num = Number(v);
          const suffix = mode === 'spread' ? '' : '%';
          return `${num >= 0 ? '+' : ''}${num.toFixed(mode === 'spread' ? 2 : 2)}${suffix}`;
        },
        style: {
          fontSize: 11,
          fill: '#848e9c',
        },
      },
      grid: {
        line: {
          style: {
            stroke: '#2b3139',
            lineWidth: 1,
            lineDash: [4, 4],
          },
        },
      },
    },
    legend: false,
    theme: {
      background: '#161a1e',
    },
  };

  // 無數據狀態
  if (data.length === 0) {
    return (
      <Card 
        style={{ 
          height: '100%',
          background: '#161a1e',
          border: '1px solid #2b3139',
        }}
        bodyStyle={{ background: '#161a1e' }}
      >
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            <Space direction="vertical">
              <Text style={{ color: '#848e9c' }}>等待價格數據...</Text>
              {leg1Exchange && leg1Symbol && (
                <Text style={{ fontSize: 12, color: '#5e6673' }}>
                  {leg1Exchange?.toUpperCase()} {leg1Symbol} ↔ {leg2Exchange?.toUpperCase()} {leg2Symbol}
                </Text>
              )}
            </Space>
          }
          style={{ padding: '60px 0' }}
        />
      </Card>
    );
  }

  return (
    <Card
      title={
        <Space>
          <LineChartOutlined style={{ fontSize: 18, color: '#f0b90b' }} />
          <span style={{ fontSize: 14, fontWeight: 600, color: '#eaecef' }}>實時價差走勢</span>
          {leg1Exchange && leg1Symbol && (
            <Tag style={{ 
              marginLeft: 8, 
              fontSize: 11, 
              background: 'rgba(240, 185, 11, 0.1)',
              border: '1px solid rgba(240, 185, 11, 0.3)',
              color: '#f0b90b',
            }}>
              {leg1Exchange?.toUpperCase()} {leg1Symbol} ↔ {leg2Exchange?.toUpperCase()} {leg2Symbol}
            </Tag>
          )}
        </Space>
      }
      extra={
        <Radio.Group value={mode} onChange={(e) => setMode(e.target.value)} size="small">
          <Radio.Button value="percent">百分比</Radio.Button>
          <Radio.Button value="spread">絕對值</Radio.Button>
        </Radio.Group>
      }
      bodyStyle={{ padding: '16px', background: '#161a1e' }}
      style={{ 
        height: '100%',
        background: '#161a1e',
        border: '1px solid #2b3139',
      }}
      headStyle={{
        background: '#1e2329',
        borderBottom: '1px solid #2b3139',
      }}
    >
      {/* 統計卡片 */}
      <Row gutter={[8, 8]} style={{ marginBottom: 16 }}>
        <Col xs={12} sm={6}>
          <Card size="small" style={{ background: '#1e2329', border: '1px solid #2b3139', textAlign: 'center' }}>
            <Statistic
              title={<Text style={{ fontSize: 11, color: '#848e9c' }}>當前</Text>}
              value={stats.current}
              precision={mode === 'spread' ? 2 : 4}
              suffix={mode === 'spread' ? 'USDT' : '%'}
              valueStyle={{ color: stats.current >= 0 ? '#0ecb81' : '#f6465d', fontSize: 16, fontWeight: 600 }}
              prefix={stats.current >= 0 ? <RiseOutlined /> : <FallOutlined />}
            />
          </Card>
        </Col>

        <Col xs={12} sm={6}>
          <Card size="small" style={{ background: '#1e2329', border: '1px solid #2b3139', textAlign: 'center' }}>
            <Statistic
              title={<Text style={{ fontSize: 11, color: '#848e9c' }}>變化</Text>}
              value={stats.change}
              precision={mode === 'spread' ? 2 : 4}
              suffix={mode === 'spread' ? 'USDT' : '%'}
              valueStyle={{ color: stats.change >= 0 ? '#0ecb81' : '#f6465d', fontSize: 14 }}
              prefix={stats.change >= 0 ? '+' : ''}
            />
          </Card>
        </Col>

        <Col xs={12} sm={6}>
          <Card size="small" style={{ background: '#1e2329', border: '1px solid #2b3139', textAlign: 'center' }}>
            <Statistic
              title={<Text style={{ fontSize: 11, color: '#848e9c' }}>最高</Text>}
              value={stats.highest}
              precision={mode === 'spread' ? 2 : 4}
              suffix={mode === 'spread' ? 'USDT' : '%'}
              valueStyle={{ fontSize: 14, color: '#eaecef' }}
            />
          </Card>
        </Col>

        <Col xs={12} sm={6}>
          <Card size="small" style={{ background: '#1e2329', border: '1px solid #2b3139', textAlign: 'center' }}>
            <Statistic
              title={<Text style={{ fontSize: 11, color: '#848e9c' }}>最低</Text>}
              value={stats.lowest}
              precision={mode === 'spread' ? 2 : 4}
              suffix={mode === 'spread' ? 'USDT' : '%'}
              valueStyle={{ fontSize: 14, color: '#eaecef' }}
            />
          </Card>
        </Col>
      </Row>

      {/* 圖表 */}
      <div style={{ marginTop: 8 }}>
        <Line {...config} />
      </div>

      {/* 說明文字 */}
      <div style={{ marginTop: 12, textAlign: 'center' }}>
        <Text style={{ fontSize: 11, color: '#5e6673' }}>
          💡 提示：圖表展示最近 {maxDataPoints} 個價格更新點，實時刷新
        </Text>
      </div>
    </Card>
  );
};

export default SpreadChart;

