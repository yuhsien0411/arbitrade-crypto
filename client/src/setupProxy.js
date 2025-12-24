/**
 * 前端代理配置
 * 只代理 API 请求到后端，避免热更新文件被代理
 */
const { createProxyMiddleware } = require('http-proxy-middleware');

module.exports = function(app) {
  // 只代理 /api 和 /status 开头的请求
  app.use(
    ['/api', '/status'],
    createProxyMiddleware({
      target: 'http://localhost:7001',
      changeOrigin: true,
      logLevel: 'silent', // 减少日志输出
    })
  );
};

