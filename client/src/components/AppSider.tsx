/**
 * 應用側邊欄組件
 */

import React from 'react';
import { Layout, Menu } from 'antd';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  DashboardOutlined,
  SwapOutlined,
  ThunderboltOutlined,
  ClockCircleOutlined,
  SettingOutlined,
  FundOutlined,
  FileTextOutlined
} from '@ant-design/icons';

const { Sider } = Layout;

const AppSider: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();

  const menuItems = [
    {
      key: '/',
      icon: <DashboardOutlined />,
      label: '監控儀表板',
    },
    {
      key: '/trading',
      icon: <ThunderboltOutlined />,
      label: '交易台',
    },
    {
      key: '/positions',
      icon: <FundOutlined />,
      label: '倉位監控',
    },
    {
      key: '/arbitrage',
      icon: <SwapOutlined />,
      label: '雙腿套利',
    },
    {
      key: '/twap',
      icon: <ClockCircleOutlined />,
      label: 'TWAP策略',
    },
    {
      key: '/reports',
      icon: <FileTextOutlined />,
      label: '績效報告',
    },
    {
      key: '/settings',
      icon: <SettingOutlined />,
      label: '系統設置',
    },
  ];

  const handleMenuClick = ({ key }: { key: string }) => {
    navigate(key);
  };

  return (
    <Sider
      width={200}
      style={{
        background: '#fff',
        borderRight: '1px solid #f0f0f0'
      }}
      breakpoint="lg"
      collapsedWidth="0"
    >
      
      <Menu
        mode="inline"
        selectedKeys={[location.pathname]}
        style={{ 
          height: '100%', 
          borderRight: 0,
          fontSize: '14px'
        }}
        items={menuItems}
        onClick={handleMenuClick}
      />
    </Sider>
  );
};

export default AppSider;
