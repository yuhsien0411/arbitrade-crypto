/**
 * 倉位卡片組件
 * 顯示雙腿套利倉位的詳細信息，包括成交價、當前價、盈虧等
 */

import React, { useMemo, useState, useEffect } from 'react';
import { Card, Row, Col, Space, Tag, Button, Divider, Typography, Modal } from 'antd';
import { ClockCircleOutlined, DollarOutlined } from '@ant-design/icons';
import { getApiBaseUrl } from '../../utils/env';

const { Text } = Typography;

interface PositionCardProps {
  pair: any;
  prices: { leg1: any; leg2: any };
  onClick: () => void;
  onClose: () => void;
  executions: any[];
  realData?: {
    leg1?: any;
    leg2?: any;
    leg1Matched?: boolean;
    leg2Matched?: boolean;
    fullyMatched?: boolean;
    isClosed?: boolean;
  };
}

const PositionCard: React.FC<PositionCardProps> = ({ 
  pair, 
  prices, 
  onClick, 
  onClose,
  executions,
  realData
}) => {
  const [fundingCountdown, setFundingCountdown] = useState('');
  const [showCloseModal, setShowCloseModal] = useState(false);
  const [fundingRates, setFundingRates] = useState<Record<string, any>>({});
  const [showDetails, setShowDetails] = useState<{ leg1: boolean; leg2: boolean }>({ leg1: false, leg2: false });

  // 獲取最近一次執行記錄（成交價格）
  const lastExecution = useMemo(() => {
    // 優先匹配 pairId 或 strategyId
    let matched = executions
      .filter(e => {
        const matchId = e.pairId === pair.id || e.strategyId === pair.id;
        const isSuccess = e.success || e.status === 'success';
        return matchId && isSuccess;
      })
      .sort((a, b) => (b.ts || b.timestamp || 0) - (a.ts || a.timestamp || 0))[0];
    
    // 如果沒有匹配到，嘗試通過交易所和交易對匹配（用於持久化數據恢復）
    if (!matched) {
      matched = executions
        .filter(e => {
          const exec = e as any;
          // 匹配 leg1 和 leg2 的交易所和交易對
          const leg1Match = exec?.leg1?.exchange === pair.leg1?.exchange && 
                           exec?.leg1?.symbol === pair.leg1?.symbol;
          const leg2Match = exec?.leg2?.exchange === pair.leg2?.exchange && 
                           exec?.leg2?.symbol === pair.leg2?.symbol;
          const isSuccess = exec?.success || exec?.status === 'success';
          return (leg1Match && leg2Match) && isSuccess;
        })
        .sort((a, b) => (b.ts || b.timestamp || 0) - (a.ts || a.timestamp || 0))[0];
    }
    
    return matched;
  }, [executions, pair.id, pair.leg1, pair.leg2]);

  // 獲取資金費率數據
  useEffect(() => {
    const fetchFundingRates = async () => {
      try {
        const base = getApiBaseUrl();
        const symbols = [pair.leg1.symbol, pair.leg2.symbol].filter((s, i, arr) => arr.indexOf(s) === i).join(',');
        const res = await fetch(`${base}/api/funding-rates?symbols=${symbols}`);
        const data = await res.json();
        
        if (data.success && data.data) {
          const ratesMap: Record<string, any> = {};
          data.data.forEach((rate: any) => {
            const key = `${rate.exchange}_${rate.symbol}`;
            ratesMap[key] = rate;
          });
          setFundingRates(ratesMap);
        }
      } catch (e) {
        // 靜默失敗，使用默認值
      }
    };

    fetchFundingRates();
    const interval = setInterval(fetchFundingRates, 60000); // 每分鐘更新一次
    return () => clearInterval(interval);
  }, [pair.leg1.symbol, pair.leg2.symbol]);

  // 計算資金費率倒計時（每 8 小時）
  useEffect(() => {
    const updateCountdown = () => {
      const now = new Date();
      const hour = now.getUTCHours();
      const nextHours = [0, 8, 16];
      const next = nextHours.find(h => h > hour) || nextHours[0];
      
      const nextTime = new Date(now);
      nextTime.setUTCHours(next, 0, 0, 0);
      if (next <= hour) nextTime.setDate(nextTime.getDate() + 1);
      
      const diff = nextTime.getTime() - now.getTime();
      const hours = Math.floor(diff / 3600000);
      const minutes = Math.floor((diff % 3600000) / 60000);
      const seconds = Math.floor((diff % 60000) / 1000);
      
      setFundingCountdown(`${hours}H ${minutes}m ${seconds}s`);
    };

    updateCountdown();
    const timer = setInterval(updateCountdown, 1000);
    return () => clearInterval(timer);
  }, []);

  // 計算盈虧（優先使用實際持倉數據）
  const calculatePnL = useMemo(() => {
    // 優先使用實際持倉的開倉均價（如果匹配到）
    // 然後從執行記錄中提取（支持多種格式）
    const exec = lastExecution as any;
    const leg1Entry = realData?.leg1?.entryPrice || 
                     exec?.leg1?.price || 
                     exec?.leg1Price || 
                     exec?.opportunity?.leg1Price?.price || 
                     0;
    const leg2Entry = realData?.leg2?.entryPrice || 
                     exec?.leg2?.price || 
                     exec?.leg2Price || 
                     exec?.opportunity?.leg2Price?.price || 
                     0;
    
    // 優先使用實際持倉數量
    const qty = realData?.leg1?.size || realData?.leg2?.size || pair.qty || 0;

    // 優先使用實際持倉的標記價格和未實現盈虧（如果匹配到）
    if (realData?.leg1?.unrealizedPnl !== undefined && realData?.leg2?.unrealizedPnl !== undefined) {
      return {
        leg1PnL: realData.leg1.unrealizedPnl || 0,
        leg2PnL: realData.leg2.unrealizedPnl || 0,
        totalPnL: (realData.leg1.unrealizedPnl || 0) + (realData.leg2.unrealizedPnl || 0),
        leg1Entry,
        leg2Entry,
        leg1Current: realData.leg1?.markPrice || 0,
        leg2Current: realData.leg2?.markPrice || 0,
        // 實際持倉數據
        realSize: qty,
        isRealData: true,
      };
    }

    // 如果沒有實時價格，盈虧為 0，但仍然返回成交價
    if (!prices.leg1.bid || !prices.leg2.ask) {
      return { 
        leg1PnL: 0, 
        leg2PnL: 0, 
        totalPnL: 0,
        leg1Entry,  // ✅ 保留成交價
        leg2Entry,  // ✅ 保留成交價
        leg1Current: 0,
        leg2Current: 0,
        realSize: qty,
        isRealData: false,
      };
    }

    // Leg1 盈虧（買入 -> 當前賣價，賣出 -> 當前買價）
    const leg1Current = pair.leg1.side === 'buy' ? prices.leg1.bid : prices.leg1.ask;
    const leg1PnL = pair.leg1.side === 'buy' 
      ? (leg1Current - leg1Entry) * qty 
      : (leg1Entry - leg1Current) * qty;

    // Leg2 盈虧
    const leg2Current = pair.leg2.side === 'buy' ? prices.leg2.bid : prices.leg2.ask;
    const leg2PnL = pair.leg2.side === 'buy'
      ? (leg2Current - leg2Entry) * qty
      : (leg2Entry - leg2Current) * qty;

    return {
      leg1PnL,
      leg2PnL,
      totalPnL: leg1PnL + leg2PnL,
      leg1Entry,
      leg2Entry,
      leg1Current,
      leg2Current,
      realSize: qty,
      isRealData: false,
    };
  }, [lastExecution, prices, pair, realData]);

  // 獲取資金費率或借幣利率
  const getFeeInfo = (leg: any) => {
    if (leg.type === 'linear') {
      // 合約：顯示資金費率週期
      const key = `${leg.exchange}_${leg.symbol}`;
      const rate = fundingRates[key];
      const fundingRate8h = rate?.fundingRate8h || 0;
      const displayRate = (fundingRate8h * 100).toFixed(4);
      const color = fundingRate8h >= 0 ? '#0ecb81' : '#f6465d';
      
      return (
        <Space size={4}>
          <ClockCircleOutlined style={{ color: '#f0b90b', fontSize: 11 }} />
          <Text style={{ fontSize: 11, color: '#848e9c' }}>
            資費週期: {fundingCountdown}
          </Text>
          <Text style={{ fontSize: 11, color, fontWeight: 500 }}>
            {fundingRate8h >= 0 ? '+' : ''}{displayRate}%
          </Text>
        </Space>
      );
    } else {
      // 現貨：顯示借幣利率
      return (
        <Space size={4}>
          <DollarOutlined style={{ color: '#f0b90b', fontSize: 11 }} />
          <Text style={{ fontSize: 11, color: '#848e9c' }}>
            借幣利率:
          </Text>
          <Text style={{ fontSize: 11, color: '#f0b90b' }}>
            0.02% / 日
          </Text>
        </Space>
      );
    }
  };

  const handleClose = () => {
    setShowCloseModal(true);
  };

  const confirmClose = () => {
    setShowCloseModal(false);
    onClose();
  };

  return (
    <>
      <Card 
        style={{ 
          marginBottom: 12, 
          background: '#1e2329',
          cursor: 'pointer',
          border: `2px solid ${calculatePnL.totalPnL >= 0 ? '#0ecb81' : calculatePnL.totalPnL < 0 ? '#f6465d' : '#2b3139'}`,
          transition: 'all 0.3s',
          borderRadius: 8,
        }}
        onClick={onClick}
        bodyStyle={{ padding: 16 }}
        hoverable
      >
        {/* Position A - Leg1 */}
        <Row align="middle">
          <Col span={1}>
            <Text style={{ color: '#f0b90b', fontWeight: 700, fontSize: 14 }}>A:</Text>
          </Col>
          <Col span={11}>
            <Space direction="vertical" size={2}>
              <Space size={6}>
                <Text style={{ color: '#fff', fontSize: 13, fontWeight: 600 }}>
                  {pair.leg1.exchange.toUpperCase()} {pair.leg1.symbol}
                  {pair.leg1.type === 'linear' ? '.P' : ''}
                </Text>
                <Tag color={pair.leg1.side === 'buy' ? 'green' : 'red'} style={{ fontSize: 10, margin: 0 }}>
                  {pair.leg1.side === 'buy' ? '+1 多頭' : '-1 空頭'}
                </Tag>
              </Space>
              {getFeeInfo(pair.leg1)}
            </Space>
          </Col>
          <Col span={12}>
            <Row gutter={[8, 4]}>
              <Col span={12}>
                <Space direction="vertical" size={0} style={{ width: '100%' }}>
                  <Text style={{ fontSize: 10, color: '#848e9c' }}>成交</Text>
                  <Text style={{ fontSize: 12, color: '#fff', fontWeight: 600 }}>
                    {calculatePnL.realSize || pair.qty} @ {
                      (pair.leg1.type === 'spot' || pair.leg1.type === 'margin') 
                        ? '-' 
                        : `$${calculatePnL.leg1Entry?.toFixed(2) || '-'}`
                    }
                  </Text>
                  {realData?.leg1Matched && (
                    <Text style={{ fontSize: 9, color: '#52c41a' }}>✓ 已確認</Text>
                  )}
                </Space>
              </Col>
              <Col span={12}>
                <Space direction="vertical" size={0} style={{ width: '100%' }}>
                  <Text style={{ fontSize: 10, color: '#848e9c' }}>當前</Text>
                  <Text style={{ 
                    fontSize: 12, 
                    color: calculatePnL.leg1PnL >= 0 ? '#0ecb81' : '#f6465d',
                    fontWeight: 600 
                  }}>
                    ${calculatePnL.leg1Current?.toFixed(2) || '-'}
                  </Text>
                  {realData?.leg1?.liquidationPrice && (
                    <Text style={{ fontSize: 9, color: '#ff4d4f' }}>
                      強平: ${realData.leg1.liquidationPrice.toFixed(2)}
                    </Text>
                  )}
                </Space>
              </Col>
            </Row>
          </Col>
        </Row>

        {/* Leg1 詳細信息（僅合約顯示） */}
        {pair.leg1.type === 'linear' && realData?.leg1 && (
          <>
            <div 
              style={{ 
                marginTop: 8, 
                padding: '8px 12px', 
                background: '#161a1e', 
                borderRadius: 4,
                cursor: 'pointer',
                border: '1px solid #2b3139'
              }}
              onClick={(e) => {
                e.stopPropagation();
                setShowDetails(prev => ({ ...prev, leg1: !prev.leg1 }));
              }}
            >
              <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                <Text style={{ fontSize: 11, color: '#848e9c' }}>
                  {showDetails.leg1 ? '▼' : '▶'} 詳細信息
                </Text>
                {/* 未實現盈虧標籤 - spot 和 margin 不顯示 */}
                {realData.leg1.unrealizedPnl !== undefined && 
                 pair.leg1.type !== 'spot' && 
                 pair.leg1.type !== 'margin' && (
                  <Tag color={realData.leg1.unrealizedPnl >= 0 ? 'success' : 'error'} style={{ margin: 0, fontSize: 10 }}>
                    UnPnl: {realData.leg1.unrealizedPnl >= 0 ? '+' : ''}${realData.leg1.unrealizedPnl.toFixed(2)}
                  </Tag>
                )}
              </Space>
            </div>
            {showDetails.leg1 && (
              <div style={{ marginTop: 8, padding: '12px', background: '#161a1e', borderRadius: 4, border: '1px solid #2b3139' }}>
                <Row gutter={[8, 8]}>
                  <Col span={12}>
                    <Space direction="vertical" size={4} style={{ width: '100%' }}>
                      <Text style={{ fontSize: 10, color: '#848e9c' }}>未實現盈虧</Text>
                      <Text style={{ 
                        fontSize: 13, 
                        color: (pair.leg1.type === 'spot' || pair.leg1.type === 'margin') ? '#848e9c' : ((realData.leg1.unrealizedPnl || 0) >= 0 ? '#0ecb81' : '#f6465d'),
                        fontWeight: 600 
                      }}>
                        {(pair.leg1.type === 'spot' || pair.leg1.type === 'margin') ? '-' : `$${(realData.leg1.unrealizedPnl || 0).toFixed(2)}`}
                      </Text>
                    </Space>
                  </Col>
                  <Col span={12}>
                    <Space direction="vertical" size={4} style={{ width: '100%' }}>
                      <Text style={{ fontSize: 10, color: '#848e9c' }}>已實現盈虧</Text>
                      <Text style={{ 
                        fontSize: 13, 
                        color: (realData.leg1.realizedPnlUSDT || 0) >= 0 ? '#0ecb81' : '#f6465d',
                        fontWeight: 600 
                      }}>
                        ${(realData.leg1.realizedPnlUSDT || 0).toFixed(2)}
                      </Text>
                    </Space>
                  </Col>
                  <Col span={12}>
                    <Space direction="vertical" size={4} style={{ width: '100%' }}>
                      <Text style={{ fontSize: 10, color: '#848e9c' }}>佔用保證金</Text>
                      <Text style={{ fontSize: 13, color: '#fff', fontWeight: 600 }}>
                        ${(realData.leg1.margin || 0).toFixed(2)}
                      </Text>
                    </Space>
                  </Col>
                  <Col span={12}>
                    <Space direction="vertical" size={4} style={{ width: '100%' }}>
                      <Text style={{ fontSize: 10, color: '#848e9c' }}>名義價值</Text>
                      <Text style={{ fontSize: 13, color: '#fff', fontWeight: 600 }}>
                        ${(realData.leg1.notionalUSDT || ((realData.leg1.size || 0) * (realData.leg1.markPrice || 0))).toFixed(2)}
                      </Text>
                    </Space>
                  </Col>
                  <Col span={12}>
                    <Space direction="vertical" size={4} style={{ width: '100%' }}>
                      <Text style={{ fontSize: 10, color: '#848e9c' }}>槓桿倍數</Text>
                      <Text style={{ fontSize: 13, color: '#f0b90b', fontWeight: 600 }}>
                        {realData.leg1.leverage ? `${realData.leg1.leverage}x` : '-'}
                      </Text>
                    </Space>
                  </Col>
                  <Col span={12}>
                    <Space direction="vertical" size={4} style={{ width: '100%' }}>
                      <Text style={{ fontSize: 10, color: '#848e9c' }}>標記價格</Text>
                      <Text style={{ fontSize: 13, color: '#fff', fontWeight: 600 }}>
                        ${(realData.leg1.markPrice || 0).toFixed(2)}
                      </Text>
                    </Space>
                  </Col>
                  {realData.leg1.marginMode && (
                    <Col span={12}>
                      <Space direction="vertical" size={4} style={{ width: '100%' }}>
                        <Text style={{ fontSize: 10, color: '#848e9c' }}>保證金模式</Text>
                        <Text style={{ fontSize: 13, color: '#fff', fontWeight: 600 }}>
                          {(realData.leg1.marginMode === 'cross' || realData.leg1.marginMode === 'crossed') ? '全倉' : '逐倉'}
                        </Text>
                      </Space>
                    </Col>
                  )}
                </Row>
              </div>
            )}
          </>
        )}

        <Divider style={{ margin: '8px 0', borderColor: '#2b3139' }} />

        {/* Position B - Leg2 */}
        <Row align="middle">
          <Col span={1}>
            <Text style={{ color: '#f0b90b', fontWeight: 700, fontSize: 14 }}>B:</Text>
          </Col>
          <Col span={11}>
            <Space direction="vertical" size={2}>
              <Space size={6}>
                <Text style={{ color: '#fff', fontSize: 13, fontWeight: 600 }}>
                  {pair.leg2.exchange.toUpperCase()} {pair.leg2.symbol}
                  {pair.leg2.type === 'linear' ? '.P' : ''}
                </Text>
                <Tag color={pair.leg2.side === 'buy' ? 'green' : 'red'} style={{ fontSize: 10, margin: 0 }}>
                  {pair.leg2.side === 'buy' ? '+1 多頭' : '-1 空頭'}
                </Tag>
              </Space>
              {getFeeInfo(pair.leg2)}
            </Space>
          </Col>
          <Col span={12}>
            <Row gutter={[8, 4]}>
              <Col span={12}>
                <Space direction="vertical" size={0} style={{ width: '100%' }}>
                  <Text style={{ fontSize: 10, color: '#848e9c' }}>成交</Text>
                  <Text style={{ fontSize: 12, color: '#fff', fontWeight: 600 }}>
                    {calculatePnL.realSize || pair.qty} @ {
                      (pair.leg2.type === 'spot' || pair.leg2.type === 'margin') 
                        ? '-' 
                        : `$${calculatePnL.leg2Entry?.toFixed(2) || '-'}`
                    }
                  </Text>
                  {realData?.leg2Matched && (
                    <Text style={{ fontSize: 9, color: '#52c41a' }}>✓ 已確認</Text>
                  )}
                </Space>
              </Col>
              <Col span={12}>
                <Space direction="vertical" size={0} style={{ width: '100%' }}>
                  <Text style={{ fontSize: 10, color: '#848e9c' }}>當前</Text>
                  <Text style={{ 
                    fontSize: 12, 
                    color: calculatePnL.leg2PnL >= 0 ? '#0ecb81' : '#f6465d',
                    fontWeight: 600 
                  }}>
                    ${calculatePnL.leg2Current?.toFixed(2) || '-'}
                  </Text>
                  {realData?.leg2?.liquidationPrice && (
                    <Text style={{ fontSize: 9, color: '#ff4d4f' }}>
                      強平: ${realData.leg2.liquidationPrice.toFixed(2)}
                    </Text>
                  )}
                </Space>
              </Col>
            </Row>
          </Col>
        </Row>

        {/* Leg2 詳細信息（僅合約顯示） */}
        {pair.leg2.type === 'linear' && realData?.leg2 && (
          <>
            <div 
              style={{ 
                marginTop: 8, 
                padding: '8px 12px', 
                background: '#161a1e', 
                borderRadius: 4,
                cursor: 'pointer',
                border: '1px solid #2b3139'
              }}
              onClick={(e) => {
                e.stopPropagation();
                setShowDetails(prev => ({ ...prev, leg2: !prev.leg2 }));
              }}
            >
              <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                <Text style={{ fontSize: 11, color: '#848e9c' }}>
                  {showDetails.leg2 ? '▼' : '▶'} 詳細信息
                </Text>
                {/* 未實現盈虧標籤 - spot 和 margin 不顯示 */}
                {realData.leg2.unrealizedPnl !== undefined && 
                 pair.leg2.type !== 'spot' && 
                 pair.leg2.type !== 'margin' && (
                  <Tag color={realData.leg2.unrealizedPnl >= 0 ? 'success' : 'error'} style={{ margin: 0, fontSize: 10 }}>
                    UnPnl: {realData.leg2.unrealizedPnl >= 0 ? '+' : ''}${realData.leg2.unrealizedPnl.toFixed(2)}
                  </Tag>
                )}
              </Space>
            </div>
            {showDetails.leg2 && (
              <div style={{ marginTop: 8, padding: '12px', background: '#161a1e', borderRadius: 4, border: '1px solid #2b3139' }}>
                <Row gutter={[8, 8]}>
                  <Col span={12}>
                    <Space direction="vertical" size={4} style={{ width: '100%' }}>
                      <Text style={{ fontSize: 10, color: '#848e9c' }}>未實現盈虧</Text>
                      <Text style={{ 
                        fontSize: 13, 
                        color: (pair.leg2.type === 'spot' || pair.leg2.type === 'margin') ? '#848e9c' : ((realData.leg2.unrealizedPnl || 0) >= 0 ? '#0ecb81' : '#f6465d'),
                        fontWeight: 600 
                      }}>
                        {(pair.leg2.type === 'spot' || pair.leg2.type === 'margin') ? '-' : `$${(realData.leg2.unrealizedPnl || 0).toFixed(2)}`}
                      </Text>
                    </Space>
                  </Col>
                  <Col span={12}>
                    <Space direction="vertical" size={4} style={{ width: '100%' }}>
                      <Text style={{ fontSize: 10, color: '#848e9c' }}>已實現盈虧</Text>
                      <Text style={{ 
                        fontSize: 13, 
                        color: (realData.leg2.realizedPnlUSDT || 0) >= 0 ? '#0ecb81' : '#f6465d',
                        fontWeight: 600 
                      }}>
                        ${(realData.leg2.realizedPnlUSDT || 0).toFixed(2)}
                      </Text>
                    </Space>
                  </Col>
                  <Col span={12}>
                    <Space direction="vertical" size={4} style={{ width: '100%' }}>
                      <Text style={{ fontSize: 10, color: '#848e9c' }}>佔用保證金</Text>
                      <Text style={{ fontSize: 13, color: '#fff', fontWeight: 600 }}>
                        ${(realData.leg2.margin || 0).toFixed(2)}
                      </Text>
                    </Space>
                  </Col>
                  <Col span={12}>
                    <Space direction="vertical" size={4} style={{ width: '100%' }}>
                      <Text style={{ fontSize: 10, color: '#848e9c' }}>名義價值</Text>
                      <Text style={{ fontSize: 13, color: '#fff', fontWeight: 600 }}>
                        ${(realData.leg2.notionalUSDT || ((realData.leg2.size || 0) * (realData.leg2.markPrice || 0))).toFixed(2)}
                      </Text>
                    </Space>
                  </Col>
                  <Col span={12}>
                    <Space direction="vertical" size={4} style={{ width: '100%' }}>
                      <Text style={{ fontSize: 10, color: '#848e9c' }}>槓桿倍數</Text>
                      <Text style={{ fontSize: 13, color: '#f0b90b', fontWeight: 600 }}>
                        {realData.leg2.leverage ? `${realData.leg2.leverage}x` : '-'}
                      </Text>
                    </Space>
                  </Col>
                  <Col span={12}>
                    <Space direction="vertical" size={4} style={{ width: '100%' }}>
                      <Text style={{ fontSize: 10, color: '#848e9c' }}>標記價格</Text>
                      <Text style={{ fontSize: 13, color: '#fff', fontWeight: 600 }}>
                        ${(realData.leg2.markPrice || 0).toFixed(2)}
                      </Text>
                    </Space>
                  </Col>
                  {realData.leg2.marginMode && (
                    <Col span={12}>
                      <Space direction="vertical" size={4} style={{ width: '100%' }}>
                        <Text style={{ fontSize: 10, color: '#848e9c' }}>保證金模式</Text>
                        <Text style={{ fontSize: 13, color: '#fff', fontWeight: 600 }}>
                          {(realData.leg2.marginMode === 'cross' || realData.leg2.marginMode === 'crossed') ? '全倉' : '逐倉'}
                        </Text>
                      </Space>
                    </Col>
                  )}
                </Row>
              </div>
            )}
          </>
        )}

        <Divider style={{ margin: '12px 0', borderColor: '#2b3139' }} />

        {/* 統計信息 */}
        <Row justify="space-between" align="middle">
          <Col>
            <Space size={16}>
              <div>
                <Text style={{ color: '#848e9c', fontSize: 11 }}>開倉價差: </Text>
                <Text style={{ color: '#fff', fontSize: 11, fontWeight: 600 }}>
                  {(pair.leg1.type === 'spot' || pair.leg1.type === 'margin' || 
                    pair.leg2.type === 'spot' || pair.leg2.type === 'margin') ? (
                    '-'
                  ) : (
                    (() => {
                      const l1 = calculatePnL.leg1Entry;
                      const l2 = calculatePnL.leg2Entry;
                      if (!l1 || !l2) return '-';
                      const spread = pair.leg1.side === 'buy' 
                        ? (l2 - l1) 
                        : (l1 - l2);
                      return `$${spread.toFixed(2)}`;
                    })()
                  )}
                </Text>
              </div>
              <div>
                <Text style={{ color: '#848e9c', fontSize: 11 }}>當前價差: </Text>
                <Text style={{ 
                  color: '#fff',
                  fontSize: 12, 
                  fontWeight: 600 
                }}>
                  {(() => {
                    if (!prices.leg1.bid || !prices.leg2.ask) return '-';
                    const leg1Price = pair.leg1.side === 'buy' ? prices.leg1.ask : prices.leg1.bid;
                    const leg2Price = pair.leg2.side === 'buy' ? prices.leg2.ask : prices.leg2.bid;
                    const spread = ((leg1Price - leg2Price) / leg2Price * 100).toFixed(3);
                    return `${spread}%`;
                  })()}
                </Text>
              </div>
              <div>
                <Text style={{ color: '#848e9c', fontSize: 11 }}>觸發: </Text>
                <Text style={{ color: '#f0b90b', fontSize: 12, fontWeight: 600 }}>
                  {pair.totalTriggers || 0}次
                </Text>
              </div>
            </Space>
          </Col>
          <Col>
            <Space size={12}>
              <div style={{ textAlign: 'right' }}>
                <Text style={{ color: '#848e9c', fontSize: 11, display: 'block' }}>
                  總盈虧
                </Text>
                <Text style={{ 
                  color: calculatePnL.totalPnL >= 0 ? '#0ecb81' : '#f6465d', 
                  fontSize: 16, 
                  fontWeight: 700 
                }}>
                  {calculatePnL.totalPnL >= 0 ? '+' : ''}
                  ${calculatePnL.totalPnL.toFixed(2)}
                </Text>
              </div>
              <Button 
                size="small" 
                danger 
                onClick={(e) => { 
                  e.stopPropagation(); 
                  handleClose(); 
                }}
                style={{ height: 32 }}
              >
                移除監控
              </Button>
            </Space>
          </Col>
        </Row>
      </Card>

      {/* 移除監控確認對話框 */}
      <Modal
        title="確認移除監控"
        open={showCloseModal}
        onOk={confirmClose}
        onCancel={() => setShowCloseModal(false)}
        okText="確認移除"
        cancelText="取消"
        okButtonProps={{ danger: true }}
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <div>
            <Text style={{ color: '#848e9c' }}>交易對:</Text>
            <Text style={{ color: '#fff', marginLeft: 8, fontWeight: 600 }}>
              {pair.leg1.exchange.toUpperCase()} {pair.leg1.symbol} ⇄ {pair.leg2.exchange.toUpperCase()} {pair.leg2.symbol}
            </Text>
          </div>
          <div>
            <Text style={{ color: '#848e9c' }}>當前盈虧:</Text>
            <Text style={{ 
              color: calculatePnL.totalPnL >= 0 ? '#0ecb81' : '#f6465d', 
              marginLeft: 8,
              fontSize: 16,
              fontWeight: 700 
            }}>
              {calculatePnL.totalPnL >= 0 ? '+' : ''}${calculatePnL.totalPnL.toFixed(2)}
            </Text>
          </div>
          <div>
            <Text style={{ color: '#848e9c' }}>觸發次數:</Text>
            <Text style={{ color: '#f0b90b', marginLeft: 8 }}>
              {pair.totalTriggers || 0}次
            </Text>
          </div>
          <div style={{ marginTop: 8, padding: 12, background: 'rgba(246, 70, 93, 0.1)', borderRadius: 4 }}>
            <Text style={{ color: '#f6465d', fontSize: 12 }}>
              ⚠️ 注意：此操作只會從監控列表中移除，不會實際平倉交易。如需平倉，請至交易所手動操作。
            </Text>
          </div>
        </Space>
      </Modal>
    </>
  );
};

export default PositionCard;

