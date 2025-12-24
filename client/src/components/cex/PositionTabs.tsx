/**
 * 倉位/訂單 Tab 組件
 * 顯示在圖表下方
 */

import React, { useState } from 'react';
import { useSelector } from 'react-redux';
import { RootState } from '../../store';

type TabType = 'positions' | 'orders' | 'history';

const PositionTabs: React.FC = () => {
  const [activeTab, setActiveTab] = useState<TabType>('positions');
  
  // 從 Redux store 獲取數據
  const arbitrageExecutions = useSelector((state: RootState) => state.arbitrage.recentExecutions);
  const twapExecutions = useSelector((state: RootState) => state.twap.executions);
  const twapStrategies = useSelector((state: RootState) => state.twap.strategies);
  
  // 計算執行中的訂單數量
  const executingOrders = twapStrategies.filter(strategy => 
    strategy.status === 'active' || strategy.status === 'paused'
  );
  
  // 計算歷史記錄數量
  const totalHistory = arbitrageExecutions.length + twapExecutions.length;

  return (
    <div className="h-full bg-bg-secondary flex flex-col">
      {/* Tab 標籤 */}
      <div className="h-12 border-b border-border flex items-center px-4 space-x-1">
        <button
          onClick={() => setActiveTab('positions')}
          className={`tab-cex ${activeTab === 'positions' ? 'active' : ''}`}
        >
          倉位 (0)
        </button>
        <button
          onClick={() => setActiveTab('orders')}
          className={`tab-cex ${activeTab === 'orders' ? 'active' : ''}`}
        >
          執行中訂單 ({executingOrders.length})
        </button>
        <button
          onClick={() => setActiveTab('history')}
          className={`tab-cex ${activeTab === 'history' ? 'active' : ''}`}
        >
          歷史記錄 ({totalHistory})
        </button>
      </div>

      {/* Tab 內容 */}
      <div className="flex-1 overflow-y-auto">
        {activeTab === 'positions' && <PositionsContent />}
        {activeTab === 'orders' && <OrdersContent executingOrders={executingOrders} />}
        {activeTab === 'history' && <HistoryContent 
          arbitrageExecutions={arbitrageExecutions}
          twapExecutions={twapExecutions}
        />}
      </div>
    </div>
  );
};

// 倉位內容
const PositionsContent: React.FC = () => {
  return (
    <div className="h-full flex items-center justify-center">
      <div className="text-center">
        <div className="text-4xl text-text-tertiary mb-2">📊</div>
        <div className="text-text-secondary">暫無倉位</div>
        <div className="text-text-tertiary text-sm mt-1">執行交易後將顯示倉位信息</div>
      </div>
    </div>
  );
};

// 執行中訂單內容
interface OrdersContentProps {
  executingOrders: any[];
}

const OrdersContent: React.FC<OrdersContentProps> = ({ executingOrders }) => {
  if (executingOrders.length === 0) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center">
          <div className="text-4xl text-text-tertiary mb-2">⏳</div>
          <div className="text-text-secondary">暫無執行中訂單</div>
          <div className="text-text-tertiary text-sm mt-1">添加監控對後將顯示訂單狀態</div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full p-4">
      <div className="space-y-3">
        {executingOrders.map((order) => (
          <div key={order.id} className="bg-bg-tertiary rounded-lg p-4 border border-border">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center space-x-2">
                <span className="text-accent-primary text-sm font-medium">
                  {order.status === 'active' ? '執行中' : '已暫停'}
                </span>
                <span className="text-text-tertiary text-xs">
                  ID: {order.id.slice(0, 8)}...
                </span>
              </div>
              <div className="text-text-secondary text-sm">
                {new Date(order.createdAt).toLocaleString()}
              </div>
            </div>
            
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <div className="text-text-tertiary text-xs mb-1">Leg 1</div>
                <div className="text-text-primary">
                  {order.leg1?.exchange?.toUpperCase()} {order.leg1?.symbol}
                </div>
                <div className="text-text-secondary text-xs">
                  {order.leg1?.type} • {order.leg1?.side}
                </div>
              </div>
              <div>
                <div className="text-text-tertiary text-xs mb-1">Leg 2</div>
                <div className="text-text-primary">
                  {order.leg2?.exchange?.toUpperCase()} {order.leg2?.symbol}
                </div>
                <div className="text-text-secondary text-xs">
                  {order.leg2?.type} • {order.leg2?.side}
                </div>
              </div>
            </div>
            
            <div className="mt-3 pt-3 border-t border-border">
              <div className="flex justify-between text-sm">
                <span className="text-text-tertiary">總數量:</span>
                <span className="text-text-primary">{order.totalQty}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-text-tertiary">已執行:</span>
                <span className="text-text-primary">
                  {order.executedQty || 0} / {order.totalQty}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-text-tertiary">進度:</span>
                <span className="text-accent-primary">
                  {Math.round(((order.executedQty || 0) / order.totalQty) * 100)}%
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

// 歷史記錄內容
interface HistoryContentProps {
  arbitrageExecutions: any[];
  twapExecutions: any[];
}

const HistoryContent: React.FC<HistoryContentProps> = ({ 
  arbitrageExecutions, 
  twapExecutions 
}) => {
  const allExecutions = [...arbitrageExecutions, ...twapExecutions]
    .sort((a, b) => (b.timestamp || b.createdAt || 0) - (a.timestamp || a.createdAt || 0))
    .slice(0, 20); // 只顯示最近 20 條記錄

  if (allExecutions.length === 0) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center">
          <div className="text-4xl text-text-tertiary mb-2">📝</div>
          <div className="text-text-secondary">暫無歷史記錄</div>
          <div className="text-text-tertiary text-sm mt-1">執行交易後將記錄歷史</div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full p-4">
      <div className="space-y-2">
        {allExecutions.map((execution, index) => (
          <div key={index} className="bg-bg-tertiary rounded p-3 border border-border">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center space-x-2">
                <span className={`text-xs px-2 py-1 rounded ${
                  execution.success 
                    ? 'bg-green-900 text-green-300' 
                    : 'bg-red-900 text-red-300'
                }`}>
                  {execution.success ? '成功' : '失敗'}
                </span>
                <span className="text-text-tertiary text-xs">
                  {execution.orderId ? `訂單: ${execution.orderId.slice(0, 8)}...` : '套利執行'}
                </span>
              </div>
              <div className="text-text-secondary text-xs">
                {new Date(execution.timestamp || execution.createdAt || Date.now()).toLocaleString()}
              </div>
            </div>
            
            <div className="text-sm">
              <div className="text-text-primary">
                {execution.symbol || '套利交易'} • {execution.exchange || '多交易所'}
              </div>
              <div className="text-text-secondary text-xs mt-1">
                數量: {execution.qty || execution.amount || 'N/A'} • 
                價格: {execution.price ? `$${execution.price}` : 'N/A'}
                {execution.error && (
                  <span className="text-red-400 ml-2">錯誤: {execution.error}</span>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default PositionTabs;

