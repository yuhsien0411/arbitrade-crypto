/**
 * CEX 風格頂部導航
 */

import React from 'react';

interface CEXHeaderProps {
  selectedPair: {
    leg1: { exchange: string; symbol: string; type: string };
    leg2: { exchange: string; symbol: string; type: string };
  };
  onPairChange: (pair: any) => void;
}

const CEXHeader: React.FC<CEXHeaderProps> = ({ selectedPair, onPairChange }) => {
  return (
    <header className="h-[60px] bg-bg-secondary border-b border-border flex items-center px-4">
      {/* Logo */}
      <div className="flex items-center space-x-3">
        <div className="text-primary text-2xl font-bold">⚡</div>
        <div className="text-text-primary font-bold text-lg">ArbiTrade</div>
      </div>


      {/* 右側工具 */}
      <div className="ml-auto flex items-center space-x-4">
        {/* 總資產 */}
        <div className="flex items-center space-x-2">
          <span className="text-text-secondary text-xs">總資產:</span>
          <span className="text-text-primary font-mono font-bold">0.00 USDT</span>
        </div>

        {/* 連接狀態 */}
        <div className="flex items-center space-x-1">
          <div className="w-2 h-2 bg-trade-buy rounded-full animate-pulse"></div>
          <span className="text-text-secondary text-xs">已連接</span>
        </div>
      </div>
    </header>
  );
};

export default CEXHeader;

