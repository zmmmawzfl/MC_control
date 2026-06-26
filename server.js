const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const mysql = require('mysql2/promise');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const { McServerManager, createMcControlRouter } = require('./mc_server');
require('dotenv').config();

// ========== 配置 ==========
const PORT = process.env.PORT || 3233;

// ========== 认证配置 ==========
const AUTH_CONFIG = {
  password: process.env.WEB_PASSWORD,
  secret: process.env.WEB_AUTH_SECRET,
  cookieName: 'mc_auth',
  maxAge: 24 * 60 * 60 * 1000,
};
if (!AUTH_CONFIG.password || !AUTH_CONFIG.secret) {
  console.error('请设置 WEB_PASSWORD 和 WEB_AUTH_SECRET 环境变量');
  process.exit(1);
}

// ========== 数据库连接池（仅 mc_servers 表） ==========
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  charset: 'utf8mb4',
});

// ========== 日志系统（轻量） ==========
const logDir = './logs';
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new DailyRotateFile({
      filename: path.join(logDir, 'error-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      level: 'error',
      maxSize: '20m',
      maxFiles: '14d',
    }),
    new DailyRotateFile({
      filename: path.join(logDir, 'combined-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      maxSize: '20m',
      maxFiles: '14d',
    }),
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      ),
    }),
  ],
});

// ========== 认证辅助函数 ==========
function parseCookies(cookieHeader = '') {
  return cookieHeader.split(';').reduce((cookies, cookie) => {
    const [name, ...rest] = cookie.split('=');
    if (name) cookies[name.trim()] = rest.join('=').trim();
    return cookies;
  }, {});
}

function createAuthToken() {
  const expires = Date.now() + AUTH_CONFIG.maxAge;
  const payload = `${expires}`;
  const signature = crypto.createHmac('sha256', AUTH_CONFIG.secret).update(payload).digest('hex');
  return `${payload}.${signature}`;
}

function verifyAuthToken(token) {
  if (!token) return false;
  const [expires, signature] = token.split('.');
  if (!expires || !signature) return false;
  const expected = crypto.createHmac('sha256', AUTH_CONFIG.secret).update(expires).digest('hex');
  try {
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return false;
  } catch (e) { return false; }
  return Date.now() <= Number(expires);
}

// ========== Express 应用 ==========
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); // 静态文件

// 登录限流
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  skipSuccessfulRequests: true,
  message: { error: '登录尝试过多，请稍后再试' },
});

// 认证中间件（除登录页面外都需要）
function authMiddleware(req, res, next) {
  if (req.path === '/login.html' || req.path === '/') return next();
  if (req.path === '/api/login') return next();
  const cookies = parseCookies(req.headers.cookie || '');
  if (verifyAuthToken(cookies[AUTH_CONFIG.cookieName])) return next();
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: '未授权' });
  }
  res.redirect('/login.html');
}
app.use(authMiddleware);

// ========== 登录路由 ==========
app.get('/login.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/api/login', loginLimiter, async (req, res) => {
  const { password } = req.body;
  if (password === AUTH_CONFIG.password) {
    const token = createAuthToken();
    res.cookie(AUTH_CONFIG.cookieName, token, {
      httpOnly: true,
      secure: false, // 如需 HTTPS，改为 true
      sameSite: 'Lax',
      maxAge: AUTH_CONFIG.maxAge,
    });
    return res.json({ success: true });
  }
  res.status(401).json({ success: false, error: '密码错误' });
});

app.get('/logout', (req, res) => {
  res.clearCookie(AUTH_CONFIG.cookieName);
  res.redirect('/login.html');
});

// ========== MC 管理器 ==========
let wss;
const mcManager = new McServerManager(pool, __dirname, (event, serverId, payload) => {
  if (!wss) return;
  const message = JSON.stringify({ type: event, serverId, ...payload });
  wss.clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  });
});

// ========== MC 路由 ==========
const mcRouter = createMcControlRouter(mcManager, logger, {
  asyncHandler: (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next),
  fs,
  path,
});
app.use('/api/mc/:id', mcRouter);

// 服务器列表管理
app.get('/api/mc/servers', async (req, res) => {
  try {
    const list = mcManager.getAllServersInfo();
    res.json({ success: true, servers: list });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});
app.post('/api/mc/servers', async (req, res) => {
  const { name, config } = req.body;
  if (!name) return res.status(400).json({ success: false, error: 'name required' });
  try {
    const srv = await mcManager.createServer(name, config || {});
    res.json({ success: true, id: srv.id });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});
app.put('/api/mc/servers/:id', async (req, res) => {
  try {
    const server = await mcManager.updateServer(req.params.id, req.body);
    res.json({ success: true, server: { id: server.id, config: server.config } });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});
app.delete('/api/mc/servers/:id', async (req, res) => {
  try {
    await mcManager.deleteServer(req.params.id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ========== WebSocket 服务（仅 MC 订阅） ==========
const server = http.createServer(app);
wss = new WebSocket.Server({ server });
wss.on('connection', (ws) => {
  ws.mcSubscriptions = new Set();
  ws.subscribedMcPlayers = false;
  ws.subscribedMcStats = false;

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      switch (data.type) {
        case 'subscribe_mc':
          if (!data.serverId || data.serverId === '*') {
            ws.mcSubscriptions.clear();
            ws.mcSubscriptions.add('*');
          } else {
            if (ws.mcSubscriptions.has('*')) ws.mcSubscriptions.delete('*');
            ws.mcSubscriptions.add(String(data.serverId));
          }
          break;
        case 'unsubscribe_mc':
          if (!data.serverId || data.serverId === '*') ws.mcSubscriptions.clear();
          else ws.mcSubscriptions.delete(String(data.serverId));
          break;
        case 'subscribe_mc_players':
          ws.subscribedMcPlayers = true;
          break;
        case 'subscribe_mc_stats':
          ws.subscribedMcStats = true;
          break;
        default:
          break;
      }
    } catch (e) {}
  });
});

// ========== 启动服务 ==========
async function start() {
  try {
    // 确保 mc_servers 表存在
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS mc_servers (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL UNIQUE,
        display_name VARCHAR(100),
        config JSON NOT NULL,
        auto_start TINYINT(1) DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    await mcManager.loadFromDatabase();
    server.listen(PORT, () => {
      logger.info(`MC Service running on http://localhost:${PORT}`);
      logger.info(`Login: http://localhost:${PORT}/login.html`);
    });
  } catch (e) {
    logger.error('Startup error:', e);
    process.exit(1);
  }
}
start();