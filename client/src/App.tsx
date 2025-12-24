/**
 * 主應用組件 - CEX風格
 */

import React, { useEffect, useState } from 'react';
import { Routes, Route, useNavigate, useLocation } from 'react-router-dom';
import { Layout, Space, Tag, App as AntdApp, Drawer, Button } from 'antd';
import { useDispatch } from 'react-redux';
import {
  HomeOutlined,
  SwapOutlined,
  ThunderboltOutlined,
  ClockCircleOutlined,
  SettingOutlined,
  FundOutlined,
  FileTextOutlined,
  MenuOutlined
} from '@ant-design/icons';
import { useIsMobile } from './utils/responsive';

import Dashboard from './pages/Dashboard';
import ArbitragePage from './pages/ArbitragePage';
import TwapPage from './pages/TwapPage';
import SettingsPage from './pages/SettingsPage';
import PositionMonitoringPage from './pages/PositionMonitoringPage';
import ReportPage from './pages/ReportPage';
import ReportPageCEX from './pages/ReportPageCEX';
import Trading from './v2/pages/Trading';
import { connectWebSocket } from './services/websocket';
import logger from './utils/logger';
import { apiService } from './services/api';
import { AppDispatch } from './store';
import { updateExchanges } from './store/slices/systemSlice';

const { Header, Content } = Layout;

const App: React.FC = () => {
  const dispatch = useDispatch<AppDispatch>();
  const { message } = AntdApp.useApp();
  const navigate = useNavigate();
  const location = useLocation();
  const isMobile = useIsMobile();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // 在組件加載前清空所有資料（在 useEffect 之外執行）
  React.useLayoutEffect(() => {
    // 清空 localStorage 中的所有資料
    const { clearAll } = require('./utils/storage').default;
    clearAll();
    
    // 設置初始化標記
    sessionStorage.setItem('app_just_started', 'true');
    
    logger.info('應用程式啟動時清空本地存儲', {}, 'App');
  }, []);
  
  useEffect(() => {
    // 應用程式初始化 - 不清空任何數據，直接載入現有數據
    const initializeApp = async () => {
      try {
        logger.info('應用程式初始化完成，載入現有數據', {}, 'App');
      } catch (error) {
        logger.error('應用程式初始化失敗', error, 'App');
      }
    };

    // 載入交易所信息（延遲載入，避免初始請求）
    const loadExchanges = async () => {
      try {
        const response = await apiService.getExchanges();
        if (response.data) {
          // 後端返回為列表，轉換為以交易所名稱為鍵的物件
          const list = Array.isArray(response.data) ? response.data : [];
          const mapped: Record<string, any> = {};
          list.forEach((item: any) => {
            if (!item || !item.name) return;
            const key = String(item.name).toLowerCase();
            mapped[key] = {
              name: key,
              connected: !!item.connected,
              status: item.status || 'unknown',
              implemented: !!item.implemented,
              symbols: item.symbols || { spot: [], linear: [], inverse: [] },
              publicOnly: !!item.publicOnly,
            };
          });
          dispatch(updateExchanges(mapped));
        }
      } catch (error) {
        logger.error('載入交易所信息失敗', error, 'App');
      }
    };

    // 初始化應用程式，載入現有數據
    initializeApp();
    
    // 延遲 2 秒載入，避免初始頁面載入時的請求
    const timer = setTimeout(loadExchanges, 2000);

    // 連接WebSocket
    connectWebSocket(dispatch);

    // 顯示歡迎消息
    message.success('歡迎使用雙腿下單交易系統！');

    // 清理函數
    return () => {
      clearTimeout(timer);
      // WebSocket 連接會在組件卸載時自動清理
    };
  }, [dispatch, message]);

  // 所有菜單項（包括隱藏的）
  const allMenuItems = [
    {
      key: '/',
      icon: <HomeOutlined />,
      label: '首頁',
      visible: true,
    },
    {
      key: '/positions',
      icon: <FundOutlined />,
      label: '倉位監控',
      visible: true,
    },
    {
      key: '/trading',
      icon: <ThunderboltOutlined />,
      label: '交易',
      visible: true,
    },
    {
      key: '/arbitrage',
      icon: <SwapOutlined />,
      label: '交易台(舊)',
      visible: false, // 隱藏但保留路由
    },
    {
      key: '/twap',
      icon: <ClockCircleOutlined />,
      label: 'TWAP策略',
      visible: false, // 隱藏但保留路由
    },
    {
      key: '/reports',
      icon: <FileTextOutlined />,
      label: '績效報告',
      visible: true,
    },
    {
      key: '/settings',
      icon: <SettingOutlined />,
      label: '系統設置',
      visible: true,
    },
  ];

  // 只顯示可見的菜單項
  const menuItems = allMenuItems.filter(item => item.visible);

  // 渲染菜单项
  const renderMenuItem = (item: typeof menuItems[0], isDrawer = false) => (
    <div
      key={item.key}
      onClick={() => {
        navigate(item.key);
        if (isDrawer) setMobileMenuOpen(false);
      }}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: isDrawer ? '12px 16px' : '0 12px',
        height: isDrawer ? 48 : 40,
        cursor: 'pointer',
        color: location.pathname === item.key ? '#f0b90b' : '#848e9c',
        background: location.pathname === item.key ? 'rgba(240, 185, 11, 0.1)' : 'transparent',
        borderRadius: 6,
        fontSize: isDrawer ? 16 : 14,
        fontWeight: location.pathname === item.key ? 600 : 400,
        transition: 'all 0.2s',
        flexShrink: 0,
        whiteSpace: 'nowrap',
        marginBottom: isDrawer ? 4 : 0,
      }}
      onMouseEnter={(e) => {
        if (!isDrawer && location.pathname !== item.key) {
          e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)';
          e.currentTarget.style.color = '#fff';
        }
      }}
      onMouseLeave={(e) => {
        if (!isDrawer && location.pathname !== item.key) {
          e.currentTarget.style.background = 'transparent';
          e.currentTarget.style.color = '#848e9c';
        }
      }}
    >
      {item.icon}
      <span>{item.label}</span>
    </div>
  );

  return (
    <Layout style={{ minHeight: '100vh', background: '#0b0e11' }}>
      {/* CEX 風格頂部導航欄 */}
      <Header 
        className="app-header"
        style={{ 
          background: '#1e2329',
          padding: isMobile ? '0 12px' : '0 24px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderBottom: '1px solid #2b3139',
          height: isMobile ? 56 : 64,
        }}
      >
        <div style={{ 
          display: 'flex', 
          alignItems: 'center', 
          gap: isMobile ? 12 : 24, 
          flex: 1,
          minWidth: 0,
        }}>
          {/* Logo */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            <div style={{
              width: isMobile ? 28 : 32,
              height: isMobile ? 28 : 32,
              background: 'linear-gradient(135deg, #f0b90b 0%, #f8d12f 100%)',
              borderRadius: 6,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: isMobile ? 16 : 18,
              fontWeight: 700,
              color: '#0b0e11',
            }}>
              ⚡
            </div>
            <div>
              <div style={{ 
                color: '#fff', 
                fontSize: isMobile ? 16 : 18, 
                fontWeight: 700,
                lineHeight: 1.2,
              }}>
              ArbiTrade
              </div>
              {!isMobile && (
                <div style={{ 
                  color: '#848e9c', 
                  fontSize: 10,
                  lineHeight: 1,
                }}>
                  v1.0.0
                </div>
              )}
            </div>
          </div>

          {/* 桌面端導航選單 */}
          {!isMobile && (
            <div style={{ 
              display: 'flex', 
              alignItems: 'center', 
              gap: 4,
              flex: 1,
              minWidth: 0,
              overflowX: 'auto',
            }}>
              {menuItems.map((item) => renderMenuItem(item))}
            </div>
          )}

          {/* 移動端菜單按鈕 */}
          {isMobile && (
            <Button
              type="text"
              icon={<MenuOutlined style={{ color: '#fff', fontSize: 18 }} />}
              onClick={() => setMobileMenuOpen(true)}
              style={{
                marginLeft: 'auto',
                padding: '4px 8px',
              }}
            />
          )}
        </div>

        {/* 右側狀態 */}
        <Space style={{ flexShrink: 0, marginLeft: isMobile ? 8 : 0 }}>
          <Tag color="success" style={{ margin: 0, fontSize: isMobile ? 11 : 12 }}>
            🟢 {isMobile ? '' : '已連線'}
          </Tag>
        </Space>
      </Header>

      {/* 移動端抽屜菜單 */}
      <Drawer
        title={
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{
              width: 32,
              height: 32,
              background: 'linear-gradient(135deg, #f0b90b 0%, #f8d12f 100%)',
              borderRadius: 6,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 18,
              fontWeight: 700,
              color: '#0b0e11',
            }}>
              ⚡
            </div>
            <span style={{ color: '#fff', fontSize: 18, fontWeight: 700 }}>ArbiTrade</span>
          </div>
        }
        placement="left"
        onClose={() => setMobileMenuOpen(false)}
        open={mobileMenuOpen}
        styles={{
          body: {
            background: '#1e2329',
            padding: '16px 0',
          },
          header: {
            background: '#1e2329',
            borderBottom: '1px solid #2b3139',
          }
        }}
        width={280}
      >
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {menuItems.map((item) => renderMenuItem(item, true))}
        </div>
      </Drawer>

      {/* 主內容區 */}
      <Content style={{ 
        background: '#0b0e11',
        minHeight: `calc(100vh - ${isMobile ? 56 : 64}px)`,
      }}>
        <div className="app-content" style={{ 
          padding: location.pathname === '/trading' ? 0 : (isMobile ? 12 : 24),
          minHeight: '100%',
        }}>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/trading" element={<Trading />} />
            <Route path="/positions" element={<PositionMonitoringPage />} />
            <Route path="/arbitrage" element={<ArbitragePage />} />
            <Route path="/twap" element={<TwapPage />} />
            <Route path="/reports" element={<ReportPageCEX />} />
            <Route path="/reports-old" element={<ReportPage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Routes>
        </div>
      </Content>
    </Layout>
  );
};

export default App;
