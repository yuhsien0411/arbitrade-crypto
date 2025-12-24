# 創建安裝腳本
cat > /root/install_arbitrade.sh << 'EOF'
#!/bin/bash

# Arbitrade 一鍵安裝部署腳本
# 作者: XIAN
# 版本: 2.0.1

set -e  # 遇到錯誤立即停止

# 顏色定義
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 打印函數
print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# 檢查是否為 root 用戶
if [ "$EUID" -ne 0 ]; then 
    print_error "請使用 root 用戶運行此腳本"
    exit 1
fi

echo ""
echo "======================================"
echo "  Arbitrade 加密貨幣套利系統"
echo "  一鍵安裝部署腳本 v2.0.1"
echo "======================================"
echo ""

# 步驟 1: 更新系統
print_status "步驟 1/11: 更新系統套件..."
apt update -qq
DEBIAN_FRONTEND=noninteractive apt upgrade -y -qq
print_success "系統更新完成"

# 步驟 2: 安裝基礎工具
print_status "步驟 2/11: 安裝基礎工具..."
apt install -y -qq git curl wget vim ufw
print_success "基礎工具安裝完成"

# 步驟 3: 配置 Swap 交換空間（解決內存不足問題）
print_status "步驟 3/11: 檢查並配置 Swap 交換空間..."

# 檢查當前內存
TOTAL_MEM=$(free -m | awk '/^Mem:/{print $2}')
SWAP_SIZE=$(free -m | awk '/^Swap:/{print $2}')

print_status "當前系統內存: ${TOTAL_MEM}MB, Swap: ${SWAP_SIZE}MB"

# 如果內存小於 2GB 且 Swap 小於 1GB，則配置 Swap
if [ $TOTAL_MEM -lt 2048 ] && [ $SWAP_SIZE -lt 1024 ]; then
    print_warning "檢測到內存不足，正在配置 2GB Swap 空間..."
    
    # 檢查是否已存在 swapfile
    if [ -f /swapfile ]; then
        print_warning "Swap 文件已存在，跳過創建"
    else
        # 創建 2GB Swap 文件
        fallocate -l 2G /swapfile
        chmod 600 /swapfile
        mkswap /swapfile
        swapon /swapfile
        
        # 設置開機自動掛載
        if ! grep -q '/swapfile' /etc/fstab; then
            echo '/swapfile none swap sw 0 0' >> /etc/fstab
        fi
        
        # 調整 swappiness
        sysctl vm.swappiness=60
        if ! grep -q 'vm.swappiness' /etc/sysctl.conf; then
            echo 'vm.swappiness=60' >> /etc/sysctl.conf
        fi
        
        print_success "Swap 配置完成！"
        free -h
    fi
else
    print_success "系統內存充足或 Swap 已配置，跳過此步驟"
fi

# 步驟 4: 安裝 Python 環境
print_status "步驟 4/11: 安裝 Python 環境..."
apt install -y -qq python3 python3-pip python3-venv
python3 --version
print_success "Python 環境安裝完成"

# 步驟 5: 安裝 Node.js
print_status "步驟 5/11: 安裝 Node.js 20..."
if ! command -v node &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - > /dev/null 2>&1
    apt install -y -qq nodejs
fi
node --version
npm --version
print_success "Node.js 安裝完成"

# 步驟 6: 安裝 PM2
print_status "步驟 6/11: 安裝 PM2 和 serve..."
npm install -g pm2 serve --silent
pm2 --version
print_success "PM2 安裝完成"

# 步驟 7: 克隆代碼
print_status "步驟 7/11: 克隆 GitHub 倉庫..."
cd /root
if [ -d "arbitrade-crypto" ]; then
    print_warning "目錄已存在，跳過克隆"
    cd arbitrade-crypto
    git pull origin master
else
    git clone https://github.com/yuhsien0411/arbitrade-crypto.git
    cd arbitrade-crypto
fi
print_success "代碼克隆完成"

# 步驟 8: 配置環境變量

print_status "步驟 8/11: 配置環境變量..."

# 獲取服務器 IP
SERVER_IP=$(curl -s ifconfig.me)
print_status "檢測到服務器 IP: $SERVER_IP"

if [ ! -f ".env" ]; then
    # .env 不存在，創建新的
    cat > .env << 'ENVEOF'
# ========== 環境設定 ==========
ENVIRONMENT=production
DEBUG=false
LOG_LEVEL=ERROR

# ========== 交易所 API 設定 ==========
# ⚠️ 請手動編輯此文件，填入您的實際 API 密鑰！
BYBIT_API_KEY=your_bybit_api_key_here
BYBIT_SECRET=your_bybit_secret_here
BYBIT_TESTNET=false

BINANCE_API_KEY=your_binance_api_key_here
BINANCE_SECRET=your_binance_secret_here
BINANCE_USE_PORTFOLIO_MARGIN=true

OKX_API_KEY=
OKX_SECRET=
OKX_PASSWORD=

BITGET_API_KEY=
BITGET_SECRET=
BITGET_PASSWORD=

# ========== 前後端網址設定 ==========
FRONTEND_URL=http://SERVER_IP:3000,http://localhost:3000
BACKEND_HOST=0.0.0.0
BACKEND_PORT=7001
FRONTEND_PORT=3000

REACT_APP_API_URL=http://SERVER_IP:7001
REACT_APP_SERVER_URL=http://SERVER_IP:7001
REACT_APP_WS_URL=ws://SERVER_IP:7001/ws
ENVEOF

    sed -i "s/SERVER_IP/$SERVER_IP/g" .env
    print_success "環境配置文件已創建：/root/arbitrade-crypto/.env"
    print_warning "⚠️  請編輯 .env 文件，填入您的實際 API 密鑰！"
else
    # .env 已存在，只更新 IP 地址
    print_warning ".env 文件已存在，更新 IP 地址..."
    
    # 備份原文件
    cp .env .env.backup
    
    # 更新所有包含舊 IP 的行
    sed -i "s|http://[0-9]\+\.[0-9]\+\.[0-9]\+\.[0-9]\+|http://$SERVER_IP|g" .env
    sed -i "s|ws://[0-9]\+\.[0-9]\+\.[0-9]\+\.[0-9]\+|ws://$SERVER_IP|g" .env
    
    print_success "IP 地址已更新為: $SERVER_IP"
    print_status "原配置已備份至: .env.backup"
fi

# 步驟 9: 安裝後端依賴
print_status "步驟 9/11: 安裝後端 Python 依賴..."
python3 -m venv venv
source venv/bin/activate
pip install --upgrade pip -q
pip install -r requirements.txt -q
python -c "import fastapi; import uvicorn; print('後端依賴驗證成功')"
deactivate
print_success "後端依賴安裝完成"

# 步驟 10: 構建前端
print_status "步驟 10/11: 安裝前端依賴並構建..."
cd /root/arbitrade-crypto/client
npm install --silent
npm run build
ls -lh build/ | head -5
print_success "前端構建完成"

# 步驟 11: 創建 PM2 配置
print_status "步驟 11/11: 創建 PM2 配置..."
cd /root/arbitrade-crypto
cat > ecosystem.config.js << 'PMEOF'
module.exports = {
  apps: [
    {
      name: 'arbitrade-backend',
      cwd: '/root/arbitrade-crypto/python_backend',
      script: 'venv/bin/uvicorn',
      args: 'app.main:app --host 0.0.0.0 --port 7001 --log-level error',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        ENVIRONMENT: 'production',
        PYTHONUNBUFFERED: '1'
      },
      error_file: '/root/logs/backend-error.log',
      out_file: '/root/logs/backend-out.log',
      log_file: '/root/logs/backend-combined.log',
      time: true
    },
    {
      name: 'arbitrade-frontend',
      cwd: '/root/arbitrade-crypto/client',
      script: 'serve',
      args: '-s build -l 3000',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      error_file: '/root/logs/frontend-error.log',
      out_file: '/root/logs/frontend-out.log',
      log_file: '/root/logs/frontend-combined.log',
      time: true
    }
  ]
};
PMEOF
print_success "PM2 配置創建完成"

# 創建日誌目錄
mkdir -p /root/logs

# 配置防火牆
print_status "配置防火牆..."
ufw --force enable
ufw allow 22/tcp
ufw allow 3000/tcp
ufw allow 7001/tcp
print_success "防火牆配置完成"

# 獲取服務器 IP
SERVER_IP=$(curl -s ifconfig.me)

echo ""
echo "======================================"
print_success "🎉 安裝完成！"
echo "======================================"
echo ""
echo "📝 接下來的步驟："
echo ""
echo "1. 編輯環境配置文件，填入 API 密鑰："
echo "   ${YELLOW}nano /root/arbitrade-crypto/.env${NC}"
echo ""
echo "2. 啟動服務："
echo "   ${YELLOW}cd /root/arbitrade-crypto${NC}"
echo "   ${YELLOW}pm2 start ecosystem.config.js${NC}"
echo "   ${YELLOW}pm2 save${NC}"
echo "   ${YELLOW}pm2 startup${NC}"
echo ""
echo "3. 查看服務狀態："
echo "   ${YELLOW}pm2 status${NC}"
echo "   ${YELLOW}pm2 logs${NC}"
echo ""
echo "4. 訪問您的應用："
echo "   前端: ${GREEN}http://$SERVER_IP:3000${NC}"
echo "   後端: ${GREEN}http://$SERVER_IP:7001/health${NC}"
echo ""
echo "======================================"
echo ""

EOF
