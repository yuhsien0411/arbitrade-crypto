/**
 * 系統介紹頁面
 */

import React from 'react';
import { Row, Col, Card, Space, Typography, Tag, Divider } from 'antd';
import {
  ThunderboltOutlined,
  SwapOutlined,
  ClockCircleOutlined,
  FundOutlined,
  SafetyOutlined,
  RocketOutlined,
  GlobalOutlined,
  BarChartOutlined,
  ApiOutlined,
} from '@ant-design/icons';

const { Title, Text, Paragraph } = Typography;

const Dashboard: React.FC = () => {
  const features = [
    {
      icon: <SwapOutlined style={{ fontSize: 32, color: '#f0b90b' }} />,
      title: '雙腿套利交易',
      description: '智能監控多個交易所的價格差異，自動執行套利策略，捕捉瞬間價差機會。',
      color: '#f0b90b',
    },
    {
      icon: <ClockCircleOutlined style={{ fontSize: 32, color: '#722ed1' }} />,
      title: 'TWAP 策略執行',
      description: '時間加權平均價格策略，將大單拆分為多個小單，減少市場衝擊，實現更優的執行價格。',
      color: '#722ed1',
    },
    {
      icon: <FundOutlined style={{ fontSize: 32, color: '#1890ff' }} />,
      title: '倉位監控',
      description: '實時監控所有交易所的持倉情況，包括合約、現貨、槓桿等多種資產類型，統一管理風險。',
      color: '#1890ff',
    },
    {
      icon: <BarChartOutlined style={{ fontSize: 32, color: '#52c41a' }} />,
      title: '績效分析',
      description: '詳細的歷史交易記錄分析，包括盈虧統計、成功率、回報率等關鍵指標，幫助優化策略。',
      color: '#52c41a',
    },
    {
      icon: <SafetyOutlined style={{ fontSize: 32, color: '#faad14' }} />,
      title: '風險控制',
      description: '內建多層風險控制機制，包括倉位限制、止損止盈、資金管理等功能，保障交易安全。',
      color: '#faad14',
    },
    {
      icon: <GlobalOutlined style={{ fontSize: 32, color: '#eb2f96' }} />,
      title: '多交易所支持',
      description: '支持 Binance、Bybit、Bitget、OKX 等主流交易所，統一接口管理，操作便捷。',
      color: '#eb2f96',
    },
  ];

  const exchanges = [
    { name: 'Binance', color: '#f0b90b' },
    { name: 'Bybit', color: '#fcd535' },
    { name: 'Bitget', color: '#52c41a' },
    { name: 'OKX', color: '#1890ff' },
  ];

  const techStack = [
    { name: 'React + TypeScript', desc: '現代化前端框架' },
    { name: 'Python FastAPI', desc: '高性能後端 API' },
    { name: 'Redux Toolkit', desc: '狀態管理' },
    { name: 'TradingView Charts', desc: '專業圖表展示' },
    { name: 'WebSocket', desc: '實時數據推送' },
  ];

  return (
    <div style={{ background: '#0b0e11', minHeight: '100vh', padding: '24px' }}>
      {/* 主標題區 */}
      <div style={{ textAlign: 'center', marginBottom: 48, padding: '40px 0' }}>
        <Space direction="vertical" size="large" style={{ width: '100%' }}>
          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 16 }}>
            <ThunderboltOutlined style={{ fontSize: 64, color: '#f0b90b' }} />
            <Title level={1} style={{ margin: 0, color: '#fff', fontSize: 48 }}>
              ArbiTrade
            </Title>
          </div>
          <Title level={2} style={{ margin: 0, color: '#848e9c', fontWeight: 400 }}>
            專業的量化套利交易系統
          </Title>
          <Paragraph style={{ color: '#848e9c', fontSize: 18, maxWidth: 800, margin: '0 auto' }}>
            自動化監控多個交易所的價格差異，執行套利和 TWAP 策略，
            幫助您在加密貨幣市場中捕捉交易機會，實現穩定收益。
          </Paragraph>
        </Space>
      </div>

      {/* 核心功能 */}
      <div style={{ marginBottom: 64 }}>
        <Title level={2} style={{ color: '#fff', marginBottom: 32, textAlign: 'center' }}>
          <RocketOutlined style={{ marginRight: 8, color: '#f0b90b' }} />
          核心功能
        </Title>
        <Row gutter={[24, 24]}>
          {features.map((feature, index) => (
            <Col xs={24} sm={12} lg={8} key={index}>
              <Card
                hoverable
                style={{
                  background: '#1e2329',
                  border: `1px solid ${feature.color}33`,
                  borderRadius: 12,
                  height: '100%',
                }}
                bodyStyle={{ padding: 24 }}
              >
                <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                  <div>{feature.icon}</div>
                  <Title level={4} style={{ margin: 0, color: '#fff' }}>
                    {feature.title}
                  </Title>
                  <Paragraph style={{ color: '#848e9c', margin: 0, fontSize: 14 }}>
                    {feature.description}
                  </Paragraph>
                </Space>
              </Card>
            </Col>
          ))}
        </Row>
      </div>

      <Divider style={{ borderColor: '#2b3139', margin: '48px 0' }} />

      {/* 支持的交易所 */}
      <div style={{ marginBottom: 64 }}>
        <Title level={2} style={{ color: '#fff', marginBottom: 32, textAlign: 'center' }}>
          <GlobalOutlined style={{ marginRight: 8, color: '#f0b90b' }} />
          支持的交易所
        </Title>
        <Row gutter={[16, 16]} justify="center">
          {exchanges.map((exchange, index) => (
            <Col key={index}>
              <Card
                style={{
                  background: '#1e2329',
                  border: `1px solid ${exchange.color}33`,
                  borderRadius: 8,
                  minWidth: 150,
                  textAlign: 'center',
                }}
                bodyStyle={{ padding: '20px 32px' }}
              >
                <Text style={{ color: '#fff', fontSize: 18, fontWeight: 600 }}>
                  {exchange.name}
                </Text>
              </Card>
            </Col>
          ))}
        </Row>
      </div>

      <Divider style={{ borderColor: '#2b3139', margin: '48px 0' }} />

      {/* 技術架構 */}
      <div style={{ marginBottom: 64 }}>
        <Title level={2} style={{ color: '#fff', marginBottom: 32, textAlign: 'center' }}>
          <ApiOutlined style={{ marginRight: 8, color: '#f0b90b' }} />
          技術架構
        </Title>
        <Row gutter={[16, 16]} justify="center">
          {techStack.map((tech, index) => (
            <Col xs={24} sm={12} md={8} lg={6} key={index}>
              <Card
                style={{
                  background: '#1e2329',
                  border: '1px solid #2b3139',
                  borderRadius: 8,
                  textAlign: 'center',
                }}
                bodyStyle={{ padding: '20px' }}
              >
                <Text style={{ color: '#fff', fontSize: 16, fontWeight: 600, display: 'block', marginBottom: 8 }}>
                  {tech.name}
                </Text>
                <Text style={{ color: '#848e9c', fontSize: 12, display: 'block' }}>
                  {tech.desc}
                </Text>
              </Card>
            </Col>
          ))}
        </Row>
      </div>

      {/* 開始使用 */}
      <div style={{ textAlign: 'center', padding: '40px 0' }}>
        <Card
          style={{
            background: 'linear-gradient(135deg, rgba(240, 185, 11, 0.1) 0%, rgba(240, 185, 11, 0.05) 100%)',
            border: '1px solid #f0b90b33',
            borderRadius: 12,
            maxWidth: 600,
            margin: '0 auto',
          }}
          bodyStyle={{ padding: 32 }}
        >
          <Space direction="vertical" size="large" style={{ width: '100%' }}>
            <ThunderboltOutlined style={{ fontSize: 48, color: '#f0b90b' }} />
            <Title level={3} style={{ margin: 0, color: '#fff' }}>
              準備開始交易？
            </Title>
            <Paragraph style={{ color: '#848e9c', fontSize: 16, margin: 0 }}>
              前往 <Tag color="gold" style={{ fontSize: 14, padding: '4px 12px' }}>交易台</Tag> 開始創建您的第一個套利策略
            </Paragraph>
          </Space>
        </Card>
      </div>
    </div>
  );
};

export default Dashboard;
