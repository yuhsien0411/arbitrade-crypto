/**
 * PAIRS下單票組件（CEX 風格）
 * 提供專業的PAIRS下單介面
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  Card,
  Form,
  Select,
  InputNumber,
  Radio,
  Button,
  Space,
  Divider,
  Typography,
  Row,
  Col,
  Alert,
  Tooltip,
  Tag,
  App as AntdApp,
} from 'antd';
import {
  ThunderboltOutlined,
  EyeOutlined,
  InfoCircleOutlined,
  SwapOutlined,
} from '@ant-design/icons';
import axios from 'axios';
import { getApiBaseUrl } from '../utils/env';

const { Text, Title } = Typography;
const { Option } = Select;

// 交易所能力接口
interface ExchangeCapabilities {
  name: string;
  supportsSpot: boolean;
  supportsLinear: boolean;
  supportsInverse: boolean;
  supportsUnifiedAccount: boolean;
  accountProfile: string;
  supportedTradeTypes: string[];
  isUnifiedLike: boolean;
  notes: string;
}

interface PriceData {
  bid: number;
  ask: number;
  timestamp: number;
}

interface DualLegOrderTicketProps {
  onExecute?: (orderData: any) => void;
  onAddToMonitor?: (orderData: any) => void;
  initialLeg1Exchange?: string;
  initialLeg2Exchange?: string;
}

const DualLegOrderTicket: React.FC<DualLegOrderTicketProps> = ({
  onExecute,
  onAddToMonitor,
  initialLeg1Exchange = 'bybit',
  initialLeg2Exchange = 'binance',
}) => {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm();

  // 狀態
  const [loading, setLoading] = useState(false);
  const [capabilitiesMap, setCapabilitiesMap] = useState<Record<string, ExchangeCapabilities>>({});
  const [leg1Capabilities, setLeg1Capabilities] = useState<ExchangeCapabilities | null>(null);
  const [leg2Capabilities, setLeg2Capabilities] = useState<ExchangeCapabilities | null>(null);
  const [leg1Price, setLeg1Price] = useState<PriceData | null>(null);
  const [leg2Price, setLeg2Price] = useState<PriceData | null>(null);

  // 可用交易所列表
  const availableExchanges = [
    { key: 'bybit', name: 'Bybit' },
    { key: 'binance', name: 'Binance' },
    { key: 'okx', name: 'OKX' },
    { key: 'bitget', name: 'Bitget' },
  ];

  // 初始化：加載所有交易所能力
  useEffect(() => {
    const loadCapabilities = async () => {
      try {
        const apiBase = getApiBaseUrl();
        const response = await axios.get<Record<string, ExchangeCapabilities>>(
          `${apiBase}/api/exchanges/capabilities`
        );
        setCapabilitiesMap(response.data);
        
        // 初始化 leg1 和 leg2 的能力
        if (response.data[initialLeg1Exchange]) {
          setLeg1Capabilities(response.data[initialLeg1Exchange]);
        }
        if (response.data[initialLeg2Exchange]) {
          setLeg2Capabilities(response.data[initialLeg2Exchange]);
        }
      } catch (error) {
        console.error('Failed to load exchange capabilities:', error);
        message.error('無法加載交易所能力信息');
      }
    };

    loadCapabilities();
  }, [initialLeg1Exchange, initialLeg2Exchange, message]);

  // 訂閱 WebSocket 價格更新
  useEffect(() => {
    const handlePriceUpdate = (event: any) => {
      const { data } = event.detail;
      if (!data) return;

      const { leg1Price: wsLeg1, leg2Price: wsLeg2 } = data;

      // 檢查是否匹配當前配置
      const leg1Exchange = form.getFieldValue('leg1_exchange');
      const leg1Symbol = form.getFieldValue('leg1_symbol');
      const leg2Exchange = form.getFieldValue('leg2_exchange');
      const leg2Symbol = form.getFieldValue('leg2_symbol');

      // 更新 Leg1 價格
      if (
        wsLeg1 &&
        wsLeg1.exchange === leg1Exchange &&
        wsLeg1.symbol === leg1Symbol
      ) {
        setLeg1Price({
          bid: wsLeg1.bid1?.price || 0,
          ask: wsLeg1.ask1?.price || 0,
          timestamp: data.timestamp || Date.now(),
        });
      }

      // 更新 Leg2 價格
      if (
        wsLeg2 &&
        wsLeg2.exchange === leg2Exchange &&
        wsLeg2.symbol === leg2Symbol
      ) {
        setLeg2Price({
          bid: wsLeg2.bid1?.price || 0,
          ask: wsLeg2.ask1?.price || 0,
          timestamp: data.timestamp || Date.now(),
        });
      }
    };

    // 監聽自定義事件
    window.addEventListener('priceUpdate', handlePriceUpdate);

    return () => {
      window.removeEventListener('priceUpdate', handlePriceUpdate);
    };
  }, [form]);

  // 監聽 Leg1 交易所變化
  const handleLeg1ExchangeChange = useCallback(
    (exchange: string) => {
      const caps = capabilitiesMap[exchange];
      setLeg1Capabilities(caps);

      // 自動調整交易類型（如果當前類型不支援）
      const currentType = form.getFieldValue('leg1_type');
      if (currentType === 'spot' && !caps?.supportsSpot) {
        form.setFieldsValue({ leg1_type: 'linear' });
        message.warning(`${caps?.name} 不支援現貨，已自動切換至合約`);
      }
    },
    [capabilitiesMap, form, message]
  );

  // 監聽 Leg2 交易所變化
  const handleLeg2ExchangeChange = useCallback(
    (exchange: string) => {
      const caps = capabilitiesMap[exchange];
      setLeg2Capabilities(caps);

      // 自動調整交易類型
      const currentType = form.getFieldValue('leg2_type');
      if (currentType === 'spot' && !caps?.supportsSpot) {
        form.setFieldsValue({ leg2_type: 'linear' });
        message.warning(`${caps?.name} 不支援現貨，已自動切換至合約`);
      }
    },
    [capabilitiesMap, form, message]
  );

  // 計算預估結果
  const calculateEstimate = useCallback(() => {
    const leg1Side = form.getFieldValue('leg1_side') || 'buy';
    const leg2Side = form.getFieldValue('leg2_side') || 'sell';
    const quantity = form.getFieldValue('quantity') || 0;

    if (!leg1Price || !leg2Price || quantity <= 0) {
      return null;
    }

    // 根據方向選擇價格
    const leg1ExecPrice = leg1Side === 'buy' ? leg1Price.ask : leg1Price.bid;
    const leg2ExecPrice = leg2Side === 'buy' ? leg2Price.ask : leg2Price.bid;

    // 計算價差（賣出 - 買入）
    let spread = 0;
    let spreadPercent = 0;

    if (leg1Side === 'buy' && leg2Side === 'sell') {
      // Leg1 買入，Leg2 賣出
      spread = leg2ExecPrice - leg1ExecPrice;
      spreadPercent = leg1ExecPrice > 0 ? (spread / leg1ExecPrice) * 100 : 0;
    } else if (leg1Side === 'sell' && leg2Side === 'buy') {
      // Leg1 賣出，Leg2 買入
      spread = leg1ExecPrice - leg2ExecPrice;
      spreadPercent = leg2ExecPrice > 0 ? (spread / leg2ExecPrice) * 100 : 0;
    } else {
      // 默認：Leg2 - Leg1
      spread = leg2ExecPrice - leg1ExecPrice;
      spreadPercent = leg1ExecPrice > 0 ? (spread / leg1ExecPrice) * 100 : 0;
    }

    // 預估盈虧（簡化版，未扣除手續費）
    const estimatedPnL = spread * quantity;

    return {
      leg1ExecPrice,
      leg2ExecPrice,
      spread,
      spreadPercent,
      estimatedPnL,
    };
  }, [form, leg1Price, leg2Price]);

  const estimate = calculateEstimate();

  // 立即執行
  const handleExecute = async () => {
    try {
      const values = await form.validateFields();
      setLoading(true);

      const orderData = {
        leg1: {
          exchange: values.leg1_exchange,
          symbol: values.leg1_symbol,
          side: values.leg1_side,
          type: values.leg1_type,
        },
        leg2: {
          exchange: values.leg2_exchange,
          symbol: values.leg2_symbol,
          side: values.leg2_side,
          type: values.leg2_type,
        },
        qty: values.quantity,
        threshold: 0, // 立即執行不需要閾值
        enabled: true,
      };

      if (onExecute) {
        await onExecute(orderData);
        message.success('訂單已提交執行');
      }
    } catch (error: any) {
      console.error('Execute error:', error);
      message.error(error.message || '執行失敗');
    } finally {
      setLoading(false);
    }
  };

  // 添加到監控
  const handleAddToMonitor = async () => {
    try {
      const values = await form.validateFields();

      const orderData = {
        leg1: {
          exchange: values.leg1_exchange,
          symbol: values.leg1_symbol,
          side: values.leg1_side,
          type: values.leg1_type,
        },
        leg2: {
          exchange: values.leg2_exchange,
          symbol: values.leg2_symbol,
          side: values.leg2_side,
          type: values.leg2_type,
        },
        qty: values.quantity,
        threshold: values.threshold || 0.1,
        enabled: true,
      };

      if (onAddToMonitor) {
        await onAddToMonitor(orderData);
        message.success('已添加到監控列表');
      }
    } catch (error: any) {
      console.error('Add to monitor error:', error);
      message.error(error.message || '添加失敗');
    }
  };

  return (
    <Card
      title={
        <Space>
          <SwapOutlined style={{ fontSize: 20, color: '#1890ff' }} />
          <span style={{ fontSize: 16, fontWeight: 600 }}>PAIRS下單</span>
        </Space>
      }
      style={{ height: '100%' }}
      bodyStyle={{ padding: '16px 24px' }}
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={{
          leg1_exchange: initialLeg1Exchange,
          leg1_type: 'linear',
          leg1_side: 'buy',
          leg1_symbol: 'ETHUSDT',
          leg2_exchange: initialLeg2Exchange,
          leg2_type: 'spot',
          leg2_side: 'sell',
          leg2_symbol: 'ETHUSDT',
          quantity: 0.1,
          order_type: 'market',
          slippage: 0.1,
          threshold: 0.1,
        }}
      >
        {/* Leg 1 */}
        <Title level={5} style={{ marginBottom: 16 }}>
          Leg 1（第一腿）
          {leg1Capabilities?.isUnifiedLike && (
            <Tag color="blue" style={{ marginLeft: 8, fontSize: 11 }}>
              統一帳戶
            </Tag>
          )}
        </Title>

        <Row gutter={12}>
          <Col span={12}>
            <Form.Item label="交易所" name="leg1_exchange" rules={[{ required: true }]}>
              <Select onChange={handleLeg1ExchangeChange}>
                {availableExchanges.map((ex) => (
                  <Option key={ex.key} value={ex.key}>
                    {ex.name}
                  </Option>
                ))}
              </Select>
            </Form.Item>
          </Col>

          <Col span={12}>
            <Form.Item label="類型" name="leg1_type" rules={[{ required: true }]}>
              <Select>
                <Option value="spot" disabled={!leg1Capabilities?.supportsSpot}>
                  現貨
                  {!leg1Capabilities?.supportsSpot && (
                    <Tooltip title="該交易所不支援現貨">
                      <InfoCircleOutlined style={{ marginLeft: 4, color: '#999' }} />
                    </Tooltip>
                  )}
                </Option>
                <Option value="linear" disabled={!leg1Capabilities?.supportsLinear}>
                  合約
                </Option>
              </Select>
            </Form.Item>
          </Col>
        </Row>

        <Row gutter={12}>
          <Col span={12}>
            <Form.Item label="幣對" name="leg1_symbol" rules={[{ required: true }]}>
              <Select
                showSearch
                placeholder="輸入交易對"
                filterOption={(input, option) =>
                  (option?.value as string)?.toLowerCase().includes(input.toLowerCase())
                }
              >
                <Option value="BTCUSDT">BTCUSDT</Option>
                <Option value="ETHUSDT">ETHUSDT</Option>
                <Option value="SOLUSDT">SOLUSDT</Option>
                <Option value="BNBUSDT">BNBUSDT</Option>
              </Select>
            </Form.Item>
          </Col>

          <Col span={12}>
            <Form.Item label="方向" name="leg1_side" rules={[{ required: true }]}>
              <Radio.Group buttonStyle="solid">
                <Radio.Button value="buy" style={{ width: '50%', textAlign: 'center' }}>
                  買入
                </Radio.Button>
                <Radio.Button value="sell" style={{ width: '50%', textAlign: 'center' }}>
                  賣出
                </Radio.Button>
              </Radio.Group>
            </Form.Item>
          </Col>
        </Row>

        {leg1Capabilities && !leg1Capabilities.supportsSpot && (
          <Alert
            message="僅支援合約交易"
            description={leg1Capabilities.notes}
            type="info"
            showIcon
            closable
            style={{ marginBottom: 16, fontSize: 12 }}
          />
        )}

        <Divider style={{ margin: '16px 0' }} />

        {/* Leg 2 */}
        <Title level={5} style={{ marginBottom: 16 }}>
          Leg 2（第二腿）
          {leg2Capabilities?.isUnifiedLike && (
            <Tag color="blue" style={{ marginLeft: 8, fontSize: 11 }}>
              統一帳戶
            </Tag>
          )}
        </Title>

        <Row gutter={12}>
          <Col span={12}>
            <Form.Item label="交易所" name="leg2_exchange" rules={[{ required: true }]}>
              <Select onChange={handleLeg2ExchangeChange}>
                {availableExchanges.map((ex) => (
                  <Option key={ex.key} value={ex.key}>
                    {ex.name}
                  </Option>
                ))}
              </Select>
            </Form.Item>
          </Col>

          <Col span={12}>
            <Form.Item label="類型" name="leg2_type" rules={[{ required: true }]}>
              <Select>
                <Option value="spot" disabled={!leg2Capabilities?.supportsSpot}>
                  現貨
                  {!leg2Capabilities?.supportsSpot && (
                    <Tooltip title="該交易所不支援現貨">
                      <InfoCircleOutlined style={{ marginLeft: 4, color: '#999' }} />
                    </Tooltip>
                  )}
                </Option>
                <Option value="linear" disabled={!leg2Capabilities?.supportsLinear}>
                  合約
                </Option>
              </Select>
            </Form.Item>
          </Col>
        </Row>

        <Row gutter={12}>
          <Col span={12}>
            <Form.Item label="幣對" name="leg2_symbol" rules={[{ required: true }]}>
              <Select
                showSearch
                placeholder="輸入交易對"
                filterOption={(input, option) =>
                  (option?.value as string)?.toLowerCase().includes(input.toLowerCase())
                }
              >
                <Option value="BTCUSDT">BTCUSDT</Option>
                <Option value="ETHUSDT">ETHUSDT</Option>
                <Option value="SOLUSDT">SOLUSDT</Option>
                <Option value="BNBUSDT">BNBUSDT</Option>
              </Select>
            </Form.Item>
          </Col>

          <Col span={12}>
            <Form.Item label="方向" name="leg2_side" rules={[{ required: true }]}>
              <Radio.Group buttonStyle="solid">
                <Radio.Button value="buy" style={{ width: '50%', textAlign: 'center' }}>
                  買入
                </Radio.Button>
                <Radio.Button value="sell" style={{ width: '50%', textAlign: 'center' }}>
                  賣出
                </Radio.Button>
              </Radio.Group>
            </Form.Item>
          </Col>
        </Row>

        {leg2Capabilities && !leg2Capabilities.supportsSpot && (
          <Alert
            message="僅支援合約交易"
            description={leg2Capabilities.notes}
            type="info"
            showIcon
            closable
            style={{ marginBottom: 16, fontSize: 12 }}
          />
        )}

        <Divider style={{ margin: '16px 0' }} />

        {/* 下單參數 */}
        <Title level={5} style={{ marginBottom: 16 }}>
          下單參數
        </Title>

        <Row gutter={12}>
          <Col span={12}>
            <Form.Item label="數量" name="quantity" rules={[{ required: true, type: 'number', min: 0.001 }]}>
              <InputNumber
                style={{ width: '100%' }}
                step={0.01}
                precision={3}
                placeholder="輸入數量"
              />
            </Form.Item>
          </Col>

          <Col span={12}>
            <Form.Item label="閾值 (%)" name="threshold" tooltip="用於監控模式">
              <InputNumber
                style={{ width: '100%' }}
                step={0.01}
                precision={2}
                placeholder="0.1"
              />
            </Form.Item>
          </Col>
        </Row>

        <Row gutter={12}>
          <Col span={12}>
            <Form.Item label="類型" name="order_type">
              <Radio.Group buttonStyle="solid">
                <Radio.Button value="market">市價</Radio.Button>
                <Radio.Button value="limit" disabled>
                  限價
                </Radio.Button>
              </Radio.Group>
            </Form.Item>
          </Col>

          <Col span={12}>
            <Form.Item label="滑點 (%)" name="slippage">
              <InputNumber style={{ width: '100%' }} step={0.01} precision={2} />
            </Form.Item>
          </Col>
        </Row>

        <Divider style={{ margin: '16px 0' }} />

        {/* 預估結果 */}
        <Title level={5} style={{ marginBottom: 16 }}>
          預估結果
        </Title>

        {estimate ? (
          <Card size="small" style={{ background: '#fafafa', marginBottom: 16 }}>
            <Row gutter={[8, 8]}>
              <Col span={12}>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  Leg1 預估價:
                </Text>
              </Col>
              <Col span={12} style={{ textAlign: 'right' }}>
                <Text strong>{estimate.leg1ExecPrice.toFixed(2)} USDT</Text>
              </Col>

              <Col span={12}>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  Leg2 預估價:
                </Text>
              </Col>
              <Col span={12} style={{ textAlign: 'right' }}>
                <Text strong>{estimate.leg2ExecPrice.toFixed(2)} USDT</Text>
              </Col>

              <Col span={12}>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  價差:
                </Text>
              </Col>
              <Col span={12} style={{ textAlign: 'right' }}>
                <Text strong style={{ color: estimate.spread >= 0 ? '#52c41a' : '#ff4d4f' }}>
                  {estimate.spread >= 0 ? '+' : ''}
                  {estimate.spread.toFixed(2)} USDT
                </Text>
              </Col>

              <Col span={12}>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  價差百分比:
                </Text>
              </Col>
              <Col span={12} style={{ textAlign: 'right' }}>
                <Text strong style={{ color: estimate.spreadPercent >= 0 ? '#52c41a' : '#ff4d4f' }}>
                  {estimate.spreadPercent >= 0 ? '+' : ''}
                  {estimate.spreadPercent.toFixed(2)}%
                </Text>
              </Col>

              <Col span={12}>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  預估盈虧:
                </Text>
              </Col>
              <Col span={12} style={{ textAlign: 'right' }}>
                <Text
                  strong
                  style={{
                    color: estimate.estimatedPnL >= 0 ? '#52c41a' : '#ff4d4f',
                    fontSize: 16,
                  }}
                >
                  {estimate.estimatedPnL >= 0 ? '+' : ''}
                  {estimate.estimatedPnL.toFixed(2)} USDT{' '}
                  {estimate.estimatedPnL >= 0 ? '✅' : '⚠️'}
                </Text>
              </Col>
            </Row>
          </Card>
        ) : (
          <Alert
            message="等待價格數據..."
            type="info"
            showIcon
            style={{ marginBottom: 16, fontSize: 12 }}
          />
        )}

        {/* 執行按鈕 */}
        <Row gutter={12}>
          <Col span={12}>
            <Button
              type="primary"
              size="large"
              block
              icon={<ThunderboltOutlined />}
              onClick={handleExecute}
              loading={loading}
              disabled={!estimate}
            >
              立即執行
            </Button>
          </Col>
          <Col span={12}>
            <Button
              size="large"
              block
              icon={<EyeOutlined />}
              onClick={handleAddToMonitor}
              disabled={!estimate}
            >
              添加到監控
            </Button>
          </Col>
        </Row>
      </Form>
    </Card>
  );
};

export default DualLegOrderTicket;

