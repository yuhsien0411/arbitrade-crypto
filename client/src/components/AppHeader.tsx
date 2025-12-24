/**
 * 應用標題欄組件
 */

import React from 'react';
import { Layout, Typography, Space, Badge, Dropdown, Button } from 'antd';
import { BellOutlined, SettingOutlined, WifiOutlined, DisconnectOutlined } from '@ant-design/icons';
import { useSelector } from 'react-redux';
import { RootState } from '../store';

const { Header } = Layout;
const { Title } = Typography;

const AppHeader: React.FC = () => {
  const { isConnected, connectionStatus, notifications } = useSelector((state: RootState) => state.system);
  
  const unreadNotifications = notifications.filter(n => 
    Date.now() - n.timestamp < 300000 // 5分鐘內的通知
  ).length;

  const notificationItems = notifications.slice(0, 10).map(notification => ({
    key: notification.id,
    label: (
      <div style={{ maxWidth: 300 }}>
        <div style={{ fontSize: 12, color: '#8c8c8c' }}>
          {new Date(notification.timestamp).toLocaleTimeString()}
        </div>
        <div>{notification.message}</div>
      </div>
    ),
  }));

  const connectionIcon = isConnected ? (
    <WifiOutlined style={{ color: '#52c41a' }} />
  ) : (
    <DisconnectOutlined style={{ color: '#ff4d4f' }} />
  );

  const connectionText = connectionStatus === 'connected' ? '已連接' : 
                        connectionStatus === 'connecting' ? '連接中' : 
                        connectionStatus === 'error' ? '連接錯誤' : '未連接';

  return (
    <Header 
      style={{ 
        background: '#001529',
        padding: '0 24px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <Title 
          level={3} 
          style={{ 
            color: 'white', 
            margin: 0,
            fontSize: '18px'
          }}
        >
          📈 Arbitrade
        </Title>
        <span style={{ 
          fontSize: '12px', 
          marginLeft: '12px',
          backgroundColor: '#1890ff',
          padding: '2px 8px',
          borderRadius: '4px',
          color: 'white'
        }}>
          v1.0.0
        </span>
      </div>

      <Space size="large">
        {/* 連接狀態 */}
        <Space size="small" className="connection-status">
          {connectionIcon}
          <span style={{ color: 'white', fontSize: '12px' }}>
            {connectionText}
          </span>
        </Space>

        {/* 通知 */}
        <Dropdown
          menu={{ items: notificationItems }}
          placement="bottomRight"
          trigger={['click']}
        >
          <Badge count={unreadNotifications} size="small">
            <Button
              type="text"
              icon={<BellOutlined />}
              style={{ color: 'white' }}
            />
          </Badge>
        </Dropdown>

        {/* 設置 */}
        <Button
          type="text"
          icon={<SettingOutlined />}
          style={{ color: 'white' }}
          onClick={() => {
            // 導航到設置頁面
            window.location.hash = '#/settings';
          }}
        />
      </Space>
    </Header>
  );
};

export default AppHeader;
