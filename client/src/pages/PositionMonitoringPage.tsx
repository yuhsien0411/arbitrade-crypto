/**
 * 倉位監控頁面
 */

import React, { useEffect, useState, useCallback } from 'react';
import { Row, Col, Card, Statistic, Table, Tag, Button, Space, Typography, Alert, Spin, Tooltip } from 'antd';
import {
  DollarOutlined,
  WarningOutlined,
  SafetyOutlined,
  ReloadOutlined,
  RiseOutlined,
  FallOutlined,
  InfoCircleOutlined,
} from '@ant-design/icons';
import { getApiBaseUrl } from '../utils/env';
import { useSelector, useDispatch } from 'react-redux';
import { RootState, AppDispatch } from '../store';
import { setSummary, setFundingRates, setLoading, setError } from '../store/slices/positionsSlice';
import type { ExposureSummary } from '../types/positions';

const { Title, Text } = Typography;

const PositionMonitoringPage: React.FC = () => {
  const dispatch = useDispatch<AppDispatch>();
  const { summary, loading, error } = useSelector((state: RootState) => state.positions);
  const [autoRefresh, setAutoRefresh] = useState(true);

  // 併發載入（縮短等待時間，添加超時機制）
  const loadAll = useCallback(async (showLoading: boolean = true) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, 30000); // 🔥 增加超時時間到 30 秒（因為需要查詢多個交易所）

    try {
      if (showLoading) dispatch(setLoading(true));
      
      const apiBase = getApiBaseUrl();
      const [summaryRes, fundingRes] = await Promise.all([
        fetch(`${apiBase}/api/positions/summary`, { 
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json' }
        }).catch(e => {
          // 🔥 如果是 AbortError（超时或取消），不记录错误
          if (e.name === 'AbortError' || e.message?.includes('aborted')) {
            return null;
          }
          console.error('載入倉位摘要失敗:', e);
          return null;
        }),
        fetch(`${apiBase}/api/funding-rates`, { 
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json' }
        }).catch(e => {
          // 🔥 如果是 AbortError（超时或取消），不记录错误
          if (e.name === 'AbortError' || e.message?.includes('aborted')) {
            return null;
          }
          console.error('載入資金費率失敗:', e);
          return null;
        }),
      ]);

      // 即使某個請求失敗，也繼續處理其他請求
      const [summaryData, fundingData] = await Promise.all([
        summaryRes ? summaryRes.json().catch(() => null) : Promise.resolve(null),
        fundingRes ? fundingRes.json().catch(() => null) : Promise.resolve(null),
      ]);

      if (summaryData?.success) {
        dispatch(setSummary(summaryData.data));
      } else if (summaryRes && !summaryData?.success) {
        console.warn('倉位摘要請求失敗:', summaryData);
      }

      if (fundingData?.success) {
        dispatch(setFundingRates(fundingData.data));
      } else if (fundingRes && !fundingData?.success) {
        console.warn('資金費率請求失敗:', fundingData);
      }
    } catch (err: any) {
      // 如果請求被取消（abort），不顯示錯誤
      if (err.name === 'AbortError') {
        console.log('請求已取消（超時）');
      } else {
        const errorMsg = err?.message || '載入失敗';
        console.error('載入數據錯誤:', errorMsg);
        dispatch(setError(errorMsg));
      }
    } finally {
      clearTimeout(timeoutId);
      if (showLoading) dispatch(setLoading(false));
    }
  }, [dispatch]);

  // 初始載入（並行，確保立即執行）
  useEffect(() => {
    let mounted = true;
    const loadData = async () => {
      if (mounted) {
        await loadAll(true);
      }
    };
    loadData();
    return () => {
      mounted = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // 只在組件掛載時執行一次，loadAll 是穩定的 useCallback

  // 自動刷新（並行，避免整頁 Loading）
  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(() => {
      loadAll(false);
    }, 30000); // 30秒刷新一次
    return () => clearInterval(interval);
  }, [autoRefresh, loadAll]);

  // 計算統計數據
  const stats = React.useMemo(() => {
    if (!summary) {
      return {
        totalEquity: 0,
        totalPnl: 0,
        overallRisk: 'low' as const,
        hedgeRatio: 0,
        fullyHedged: 0,
        partiallyHedged: 0,
        unhedged: 0,
        maintenanceMarginRate: 0,
        overallLeverage: 0,
      };
    }

    const totalEquity = summary.accounts.reduce((sum, acc) => sum + acc.totalEquityUSDT, 0);
    const totalPnl = summary.accounts.reduce((sum, acc) => 
      sum + acc.positions.reduce((pnlSum, pos) => pnlSum + pos.unrealizedPnlUSDT, 0), 0
    );

    const fullyHedged = summary.exposures.filter(e => e.hedgeStatus === 'fully_hedged').length;
    const partiallyHedged = summary.exposures.filter(e => e.hedgeStatus === 'partially_hedged').length;
    const unhedged = summary.exposures.filter(e => e.hedgeStatus === 'unhedged').length;

    // 計算平均對沖比例（忽略小於 $10 的敞口）
    const MIN_NOTIONAL_FOR_HEDGE_RATIO = 10.0;
    const significantExposures = summary.exposures.filter(
      e => Math.abs(e.longNotionalUSDT) > MIN_NOTIONAL_FOR_HEDGE_RATIO || 
           Math.abs(e.shortNotionalUSDT) > MIN_NOTIONAL_FOR_HEDGE_RATIO
    );
    
    const avgHedgeRatio = significantExposures.length > 0
      ? significantExposures.reduce((sum, e) => sum + e.hedgeRatio, 0) / significantExposures.length
      : 0;

    const overallRisk = unhedged > 0 ? 'high' : partiallyHedged > fullyHedged ? 'medium' : 'low';
    
    // 計算平均維持保證金率和整體槓桿率
    const avgMaintenanceMarginRate = summary.accounts.length > 0
      ? summary.accounts.reduce((sum, acc) => sum + acc.maintenanceMarginRate, 0) / summary.accounts.length
      : 0;
    
    // 整體槓桿率 = 總保證金 / 總權益
    const overallLeverage = totalEquity > 0
      ? summary.accounts.reduce((sum, acc) => sum + acc.totalMarginUSDT, 0) / totalEquity
      : 0;

    return {
      totalEquity,
      totalPnl,
      overallRisk,
      hedgeRatio: avgHedgeRatio,
      fullyHedged,
      partiallyHedged,
      unhedged,
      maintenanceMarginRate: avgMaintenanceMarginRate,
      overallLeverage,
    };
  }, [summary]);

  const riskColor: Record<string, string> = {
    low: '#52c41a',
    medium: '#faad14',
    high: '#ff4d4f',
  };

  const riskText: Record<string, string> = {
    low: '低風險',
    medium: '中風險',
    high: '高風險',
  };

  const hedgeStatusColor: Record<string, any> = {
    fully_hedged: 'success',
    partially_hedged: 'warning',
    unhedged: 'error',
    over_hedged: 'processing',
  };

  const hedgeStatusText: Record<string, string> = {
    fully_hedged: '完全對沖',
    partially_hedged: '部分對沖',
    unhedged: '未對沖',
    over_hedged: '過度對沖',
  };

  return (
    <div style={{ background: '#0b0e11', minHeight: '100vh' }}>
      {/* 頁面標題 */}
      <div style={{ marginBottom: 24 }}>
        <Space align="center" style={{ width: '100%', justifyContent: 'space-between' }}>
          <Title level={2} style={{ margin: 0, color: '#fff' }}>
            📊 倉位監控
          </Title>
          <Space>
            <Button
              type={autoRefresh ? 'primary' : 'default'}
              onClick={() => setAutoRefresh(!autoRefresh)}
            >
              {autoRefresh ? '自動刷新' : '手動模式'}
            </Button>
            <Button
              icon={<ReloadOutlined />}
              onClick={() => { loadAll(false); }}
              loading={loading}
            >
              刷新數據
            </Button>
          </Space>
        </Space>
      </div>

      {/* 錯誤提示 */}
      {error && (
        <Alert
          message="載入錯誤"
          description={error}
          type="error"
          showIcon
          closable
          style={{ marginBottom: 24 }}
        />
      )}

      {/* 不支援的交易所提示 */}
      {summary?.unsupportedExchanges && summary.unsupportedExchanges.length > 0 && (
        <Alert
          message="部分交易所不支援"
          description={
            <div>
              {summary.unsupportedExchanges.map((ex: any) => (
                <div key={ex.exchange}>
                  <strong>{ex.exchange}</strong>: {ex.reason}
                </div>
              ))}
            </div>
          }
          type="warning"
          showIcon
          style={{ marginBottom: 24 }}
        />
      )}

      {loading && !summary ? (
        <div style={{ textAlign: 'center', padding: '100px 0' }}>
          <Spin size="large" />
          <div style={{ marginTop: 16, color: '#848e9c' }}>載入倉位數據中...</div>
          <div style={{ marginTop: 8, fontSize: 12, color: '#5e6673' }}>
            如果超過 10 秒仍未載入，請檢查後端服務是否正常運行
          </div>
        </div>
      ) : (
        <>
          {/* 統計卡片 */}
          <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
            <Col xs={24} sm={12} md={6}>
              <Card className="stat-card">
                <Statistic
                  title="總資產價值"
                  value={stats.totalEquity}
                  precision={2}
                  prefix={<DollarOutlined />}
                  suffix="USDT"
                  valueStyle={{ color: '#1890ff' }}
                />
              </Card>
            </Col>

            <Col xs={24} sm={12} md={6}>
              <Card className="stat-card">
                <Statistic
                  title="未實現盈虧"
                  value={stats.totalPnl}
                  precision={2}
                  prefix={stats.totalPnl >= 0 ? <RiseOutlined /> : <FallOutlined />}
                  suffix="USDT"
                  valueStyle={{ color: stats.totalPnl >= 0 ? '#52c41a' : '#ff4d4f' }}
                />
              </Card>
            </Col>

            <Col xs={24} sm={12} md={6}>
              <Card className="stat-card">
                <Statistic
                  title="風險等級"
                  value={riskText[stats.overallRisk]}
                  prefix={<WarningOutlined />}
                  valueStyle={{ color: riskColor[stats.overallRisk], fontSize: 24 }}
                />
              </Card>
            </Col>

            <Col xs={24} sm={12} md={6}>
              <Card className="stat-card">
                <Statistic
                  title={
                    <Space>
                      <span>平均對沖比例</span>
                      <Tooltip title="計算方式：多空較小方 ÷ 較大方。自動忽略小於 $10 的敞口，只統計有實際意義的對沖倉位。">
                        <InfoCircleOutlined style={{ color: '#8c8c8c', fontSize: 12 }} />
                      </Tooltip>
                    </Space>
                  }
                  value={stats.hedgeRatio * 100}
                  precision={1}
                  prefix={<SafetyOutlined />}
                  suffix="%"
                  valueStyle={{ color: stats.hedgeRatio >= 0.95 ? '#52c41a' : '#faad14' }}
                />
              </Card>
            </Col>
          </Row>

          {/* 交易所帳戶統計 */}
          <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
            {summary?.accounts.map((account) => {
              // 計算真實槓桿率：考慮合約和借幣
              // 1. 合約名義價值
              const contractNotional = account.positions.reduce(
                (sum, pos) => sum + Math.abs(pos.notionalUSDT), 0
              );
              
              // 2. 借幣名義價值
              const borrowedNotional = account.balances.reduce(
                (sum, bal) => sum + (bal.borrowed > 0 ? Math.abs(bal.usdtValue) : 0), 0
              );
              
              // 3. 總名義價值
              const totalNotional = contractNotional + borrowedNotional;
              
              // 4. 真實槓桿率
              const realLeverage = account.totalEquityUSDT > 0
                ? totalNotional / account.totalEquityUSDT
                : 0;
              
              
              return (
                <Col xs={24} sm={12} md={6} key={account.exchange}>
                  <Card 
                    className="stat-card"
                    title={
                      <Space>
                        <span style={{ fontWeight: 600, textTransform: 'uppercase' }}>
                          {account.exchange}
                        </span>
                        {(account.accountMode === 'unified' || account.accountMode === 'portfolio') && (
                          <Tag color="blue" style={{ fontSize: 10 }}>統一帳戶</Tag>
                        )}
                        {account.accountMode === 'classic' && (
                          <Tag color="default" style={{ fontSize: 10 }}>經典帳戶</Tag>
                        )}
                      </Space>
                    }
                    size="small"
                  >
                    <Space direction="vertical" style={{ width: '100%' }} size="small">
                      {/* 淨值 */}
                      <div>
                        <Text type="secondary" style={{ fontSize: 12 }}>淨值</Text>
                        <div style={{ fontSize: 20, fontWeight: 600, color: '#1890ff' }}>
                          ${account.totalEquityUSDT.toFixed(2)}
                        </div>
                      </div>
                      
                      {/* MMR */}
                      <div>
                        <Space>
                          <Text type="secondary" style={{ fontSize: 12 }}>MMR</Text>
                          <Tooltip
                            title={
                              account.exchange?.toLowerCase() === 'binance'
                                ? '已轉換為 Bybit 風格：MMR = 100 / uniMMR；≥ 100% 風險最高'
                                : '維持保證金率。超過 100% 會觸發強平。'
                            }
                          >
                            <InfoCircleOutlined style={{ color: '#8c8c8c', fontSize: 10 }} />
                          </Tooltip>
                        </Space>
                        {(() => {
                          const isBinance = account.exchange?.toLowerCase() === 'binance';
                          const raw = Number(account.maintenanceMarginRate) || 0; // Bybit: 比例；Binance: uniMMR
                          // Bybit 顯示：raw * 100；Binance 顯示：100 / uniMMR
                          const mmrPercent = isBinance
                            ? (raw > 0 ? (100 / raw) : 0)
                            : (raw * 100);
                          const color = mmrPercent >= 100
                            ? '#ff4d4f'
                            : (mmrPercent >= 50 ? '#faad14' : '#52c41a');
                          return (
                            <div style={{ fontSize: 16, fontWeight: 500, color }}>
                              {mmrPercent.toFixed(2)}%
                            </div>
                          );
                        })()}
                      </div>
                      
                      {/* 槓桿率（真實） */}
                      <div>
                        <Space>
                          <Text type="secondary" style={{ fontSize: 12 }}>槓桿率</Text>
                          <Tooltip title={
                            <div>
                              <div>真實槓桿率 = (合約名義價值 + 借幣價值) / 總權益</div>
                              <div style={{ marginTop: 4, fontSize: 11, opacity: 0.8 }}>
                                合約: ${contractNotional.toFixed(2)} | 
                                借幣: ${borrowedNotional.toFixed(2)}
                              </div>
                            </div>
                          }>
                            <InfoCircleOutlined style={{ color: '#8c8c8c', fontSize: 10 }} />
                          </Tooltip>
                        </Space>
                        <div style={{ 
                          fontSize: 16, 
                          fontWeight: 500,
                          color: realLeverage > 10 ? '#ff4d4f' : 
                                 realLeverage > 5 ? '#faad14' : '#1890ff'
                        }}>
                          {realLeverage.toFixed(2)}x
                        </div>
                      </div>
                    </Space>
                  </Card>
                </Col>
              );
            })}
          </Row>

          {/* 對沖雷達 */}
          <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
            <Col span={24}>
              <Card
                title="🔄 對沖雷達"
                extra={
                  <Space>
                    <Tag color="success">完全對沖: {stats.fullyHedged}</Tag>
                    <Tag color="warning">部分對沖: {stats.partiallyHedged}</Tag>
                    <Tag color="error">未對沖: {stats.unhedged}</Tag>
                  </Space>
                }
              >
                <Table
                  dataSource={(summary?.exposures || []).filter(
                    (exposure) => Math.abs(exposure.netNotionalUSDT) >= 5
                  )}
                  rowKey="baseAsset"
                  pagination={false}
                  columns={[
                    {
                      title: '資產',
                      dataIndex: 'baseAsset',
                      key: 'baseAsset',
                      render: (asset: string) => <Text strong>{asset}</Text>,
                    },
                    {
                      title: '多頭敞口',
                      key: 'long',
                      render: (record: ExposureSummary) => (
                        <div>
                          <div>{record.longBase.toFixed(4)}</div>
                          <Text type="secondary" style={{ fontSize: 12 }}>
                            ${record.longNotionalUSDT.toFixed(2)}
                          </Text>
                        </div>
                      ),
                    },
                    {
                      title: '空頭敞口',
                      key: 'short',
                      render: (record: ExposureSummary) => (
                        <div>
                          <div>{record.shortBase.toFixed(4)}</div>
                          <Text type="secondary" style={{ fontSize: 12 }}>
                            ${record.shortNotionalUSDT.toFixed(2)}
                          </Text>
                        </div>
                      ),
                    },
                    {
                      title: '淨敞口',
                      key: 'net',
                      render: (record: ExposureSummary) => (
                        <div>
                          <div style={{ color: record.netBase >= 0 ? '#52c41a' : '#ff4d4f' }}>
                            {record.netBase >= 0 ? '+' : ''}{record.netBase.toFixed(4)}
                          </div>
                          <Text type="secondary" style={{ fontSize: 12 }}>
                            ${record.netNotionalUSDT.toFixed(2)}
                          </Text>
                        </div>
                      ),
                    },
                    {
                      title: '對沖狀態',
                      key: 'hedgeStatus',
                      render: (record: ExposureSummary) => (
                        <div>
                          <Tag color={hedgeStatusColor[record.hedgeStatus]}>
                            {hedgeStatusText[record.hedgeStatus]}
                          </Tag>
                          <div style={{ marginTop: 4 }}>
                            <Text type="secondary" style={{ fontSize: 12 }}>
                              {(record.hedgeRatio * 100).toFixed(1)}%
                            </Text>
                          </div>
                        </div>
                      ),
                    },
                    {
                      title: '風險',
                      dataIndex: 'riskLevel',
                      key: 'riskLevel',
                      render: (level: string) => (
                        <Tag color={riskColor[level as keyof typeof riskColor]}>
                          {riskText[level as keyof typeof riskText]}
                        </Tag>
                      ),
                    },
                    {
                      title: '建議',
                      dataIndex: 'suggestions',
                      key: 'suggestions',
                      render: (suggestions: string[]) => (
                        <div>
                          {suggestions.slice(0, 2).map((s, i) => (
                            <div key={i} style={{ fontSize: 12, marginBottom: 4 }}>
                              • {s}
                            </div>
                          ))}
                        </div>
                      ),
                    },
                  ]}
                />
              </Card>
            </Col>
          </Row>

          {/* 餘額與持倉 */}
          <Row gutter={[16, 16]}>
            <Col xs={24} lg={12}>
              <Card title="💰 現貨資產" style={{ height: '100%' }}>
                {summary?.accounts.map((account) => (
                  <div key={account.exchange} style={{ marginBottom: 24 }}>
                    <Title level={5}>{account.exchange.toUpperCase()}</Title>
                    <Table
                      dataSource={account.balances}
                      rowKey="asset"
                      size="small"
                      pagination={false}
                      columns={[
                        {
                          title: '資產',
                          dataIndex: 'asset',
                          key: 'asset',
                        },
                        {
                          title: '總額',
                          dataIndex: 'total',
                          key: 'total',
                          render: (val: number) => (
                            <Text style={{ color: val < 0 ? '#ff4d4f' : undefined }}>
                              {val.toFixed(6)}
                            </Text>
                          ),
                        },
                        {
                          title: '借幣',
                          dataIndex: 'borrowed',
                          key: 'borrowed',
                          render: (val: number) => val > 0 ? (
                            <Text type="danger">{val.toFixed(6)}</Text>
                          ) : '-',
                        },
                        {
                          title: '餘額',
                          dataIndex: 'netBalance',
                          key: 'netBalance',
                          render: (val: number) => (
                            <Text style={{ color: val < 0 ? '#ff4d4f' : undefined }}>
                              {val.toFixed(6)}
                            </Text>
                          ),
                        },
                        {
                          title: 'USDT 價值',
                          dataIndex: 'usdtValue',
                          key: 'usdtValue',
                          render: (val: number) => (
                            <Text style={{ color: val < 0 ? '#ff4d4f' : undefined }}>
                              ${val.toFixed(2)}
                            </Text>
                          ),
                        },
                      ]}
                    />
                  </div>
                ))}
              </Card>
            </Col>

            <Col xs={24} lg={12}>
              <Card title="📈 合約倉位" style={{ height: '100%' }}>
                {summary?.accounts.map((account) => {
                  // 🔥 过滤：只显示合约仓位，且 sizeBase 不为 0
                  const contractPositions = account.positions.filter(pos => {
                    const isContract = pos.type?.includes('perp') || pos.type?.includes('futures');
                    const hasSize = Math.abs(pos.sizeBase || 0) > 0;
                    return isContract && hasSize;
                  });
                  
                  return (
                    <div key={account.exchange} style={{ marginBottom: 24 }}>
                      <Title level={5}>{account.exchange.toUpperCase()}</Title>
                      <Table
                        dataSource={contractPositions}
                        rowKey={(record) => `${account.exchange}_${record.symbol}_${record.side}_${record.type || 'unknown'}`}
                        size="small"
                        pagination={false}
                        columns={[
                        {
                          title: '交易對',
                          dataIndex: 'symbol',
                          key: 'symbol',
                        },
                        {
                          title: '方向',
                          dataIndex: 'side',
                          key: 'side',
                          render: (side: string) => (
                            <Tag color={side === 'long' ? 'green' : 'red'}>
                              {side === 'long' ? '多' : '空'}
                            </Tag>
                          ),
                        },
                        {
                          title: '數量',
                          dataIndex: 'sizeBase',
                          key: 'sizeBase',
                          render: (val: number) => Math.abs(val).toFixed(4),
                        },
                        {
                          title: '標記價',
                          dataIndex: 'markPrice',
                          key: 'markPrice',
                          render: (val: number) => `$${val.toFixed(2)}`,
                        },
                        {
                          title: '價值',
                          dataIndex: 'notionalUSDT',
                          key: 'notionalUSDT',
                          render: (val: number) => `$${val.toFixed(2)}`,
                        },
                        {
                          title: '已實現盈虧',
                          dataIndex: 'realizedPnlUSDT',
                          key: 'realizedPnlUSDT',
                          render: (val: number) => (
                            <Text style={{ color: val >= 0 ? '#52c41a' : '#ff4d4f' }}>
                              {val >= 0 ? '+' : ''}${val.toFixed(2)}
                            </Text>
                          ),
                        },
                        {
                          title: '資金費率',
                          dataIndex: 'fundingRate8h',
                          key: 'fundingRate8h',
                          render: (val: number | undefined) =>
                            val !== undefined ? `${(val * 100).toFixed(4)}%` : '-',
                        },
                      ]}
                    />
                  </div>
                );
              })}
              </Card>
            </Col>
          </Row>
        </>
      )}
    </div>
  );
};

export default PositionMonitoringPage;

