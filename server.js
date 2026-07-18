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
const createNetworkRouter = require('./public/network');
const dotenv = require('dotenv');

const envPath = path.join(__dirname, '.env');
const sampleEnvPath = path.join(__dirname, '示例.env');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
} else if (fs.existsSync(sampleEnvPath)) {
  dotenv.config({ path: sampleEnvPath });
} else {
  dotenv.config();
}

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

// ========== 数据库连接配置 ==========
const DB_HOST = process.env.DB_HOST || 'localhost';
const DB_PORT = parseInt(process.env.DB_PORT, 10) || 3306;
const DB_USER = process.env.DB_USER;
const DB_PASSWORD = process.env.DB_PASSWORD;
const DB_NAME = process.env.DB_NAME || 'mc_servers';

if (!DB_USER || !DB_PASSWORD) {
  console.error('请设置 DB_USER 和 DB_PASSWORD 环境变量');
  process.exit(1);
}

const dbConfig = {
  host: DB_HOST,
  port: DB_PORT,
  user: DB_USER,
  password: DB_PASSWORD,
  waitForConnections: true,
  connectionLimit: 10,
  charset: 'utf8mb4',
};

let pool;

async function ensureDatabaseExists() {
  const connection = await mysql.createConnection({
    host: DB_HOST,
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASSWORD,
    charset: 'utf8mb4',
  });
  await connection.query(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await connection.end();
}

async function ensureDatabaseTables(dbPool) {
  await dbPool.execute(`
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

  await dbPool.execute(`
    CREATE TABLE IF NOT EXISTS network_ips (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      ip VARCHAR(45) NOT NULL UNIQUE,
      tags JSON NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await dbPool.execute(`
    CREATE TABLE IF NOT EXISTS network_ip_requests (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      ip VARCHAR(45) NOT NULL UNIQUE,
      first_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      request_count INT UNSIGNED NOT NULL DEFAULT 1
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await dbPool.execute(`
    CREATE TABLE IF NOT EXISTS mc_stats_history (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      server_id INT UNSIGNED NOT NULL,
      cpu DECIMAL(8,2) NULL,
      memory_used BIGINT UNSIGNED NULL,
      memory_total BIGINT UNSIGNED NULL,
      tps DECIMAL(8,2) NULL,
      recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_mc_stats_history_server_time (server_id, recorded_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
}

async function connectDatabaseWithRetry() {
  const maxAttempts = Number(process.env.DB_RETRY_ATTEMPTS || 8);
  const retryDelayMs = Number(process.env.DB_RETRY_DELAY_MS || 3000);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await ensureDatabaseExists();
      pool = mysql.createPool({
        ...dbConfig,
        database: DB_NAME,
      });
      await pool.query('SELECT 1');
      return pool;
    } catch (err) {
      logger.error(`数据库连接失败 (第 ${attempt}/${maxAttempts} 次):`, err);
      if (attempt >= maxAttempts) throw err;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }

  throw new Error('数据库连接失败');
}

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

// 登录限流
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  skipSuccessfulRequests: true,
  message: { error: '登录尝试过多，请稍后再试' },
});

// ========== 认证中间件（静态资源放行） ==========
function authMiddleware(req, res, next) {
  // 公开路径：登录页面、登录API
  if (req.path === '/login.html' || req.path === '/api/login' || req.path === '/api/logout') {
    return next();
  }
  // 静态资源扩展名直接放行（不要求认证）
  const ext = path.extname(req.path);
  if (['.css', '.js', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.json', '.map'].includes(ext)) {
    return next();
  }
  // 检查认证
  const cookies = parseCookies(req.headers.cookie || '');
  if (verifyAuthToken(cookies[AUTH_CONFIG.cookieName])) {
    return next();
  }
  // 未认证：API 返回 401，页面重定向到登录
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: '未授权' });
  }
  res.redirect('/login.html');
}
app.use(authMiddleware);

// ========== 静态文件服务（在认证之后，但认证中间件已放行静态资源） ==========
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', createNetworkRouter(() => pool, logger));

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
function handleStartupError(err) {
  if (!err) return;
  if (err.code === 'EADDRINUSE') {
    logger.error(`端口 ${PORT} 被占用，请停止占用该端口或修改 .env 中的 PORT`, err);
  } else {
    logger.error('HTTP Server error:', err);
  }
  process.exit(1);
}
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Rejection:', { reason });
});
process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception:', err);
  process.exit(1);
});

const mcManager = new McServerManager(null, __dirname, (event, serverId, payload) => {
  if (!wss) return;
  const message = JSON.stringify({ type: event, serverId, ...payload });
  wss.clients.forEach((ws) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    const hasWildcard = ws.mcSubscriptions && ws.mcSubscriptions.has('*');
    const subscribedToServer = ws.mcSubscriptions && ws.mcSubscriptions.has(String(serverId));
    const serverMatch = hasWildcard || subscribedToServer;

    if (event === 'mc_log' && !serverMatch) return;
    if (event === 'mc_players' && !ws.subscribedMcPlayers) return;
    if (event === 'mc_stats' && !ws.subscribedMcStats) return;
    if ((event === 'mc_players' || event === 'mc_stats') && !serverMatch) return;

    if (event === 'mc_players') {
      const key = `${payload.count || 0}:${payload.max || 0}:${(payload.players || []).join('|')}`;
      if (ws.lastMcPlayersPayload === key) return;
      ws.lastMcPlayersPayload = key;
    }
    if (event === 'mc_stats') {
      const key = `${payload.cpu ?? ''}:${payload.memory?.used ?? ''}:${payload.memory?.total ?? ''}:${payload.tps ?? ''}`;
      if (ws.lastMcStatsPayload === key) return;
      ws.lastMcStatsPayload = key;
    }

    try {
      ws.send(message);
    } catch (err) {
      // ignore send failures for disconnected clients
    }
  });
});

// ========== 【重要】先定义具体的 /api/mc/servers 路由，再挂载通配路由器 ==========
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

// ========== MC 通配路由（必须放在最后） ==========
const mcRouter = createMcControlRouter(mcManager, logger, {
  asyncHandler: (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next),
  fs,
  path,
});
app.use('/api/mc/:id', mcRouter);

// ========== WebSocket 服务（仅 MC 订阅） ==========
const server = http.createServer(app);
wss = new WebSocket.Server({ server });
// 处理 WebSocket 服务器层面的错误，避免未捕获异常
wss.on('error', (err) => {
  logger.error('WebSocket Server error:', err);
  process.exit(1);
});
wss.on('connection', (ws) => {
  ws.mcSubscriptions = new Set();
  ws.subscribedMcPlayers = false;
  ws.subscribedMcStats = false;
  ws.lastMcPlayersPayload = null;
  ws.lastMcStatsPayload = null;

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
    } catch (e) {
      // ignore malformed websocket payloads
    }
  });
});

// ========== 启动服务 ==========
async function start() {
  try {
    pool = await connectDatabaseWithRetry();
    mcManager.dbPool = pool;

    await ensureDatabaseTables(pool);
    await mcManager.loadFromDatabase();
    server.on('error', handleStartupError);
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