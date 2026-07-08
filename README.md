# MC Control

MC Control 是一个面向 Minecraft 服务器的轻量化 Web 管理面板，支持在线启动、停止、发送命令、查看日志、监控状态、备份还原以及多实例管理。

## 功能特点

- Web 管理界面，可直接浏览和控制 Minecraft 服务
- 支持启动 / 停止 / 强制终止服务器
- 支持发送游戏内命令
- 支持实时查看服务器日志与玩家列表
- 支持 CPU / 内存 / TPS 监控
- 支持备份与恢复世界数据
- 支持多实例管理与自动重启配置
- 支持基于 MySQL 的实例持久化存储

## 项目结构

- server.js：主服务端入口，负责认证、WebSocket、路由与服务启动
- mc_server.js：Minecraft 服务器管理、进程控制、日志处理、备份恢复逻辑
- public/：前端页面与静态资源
- logs/：运行日志目录

## 环境要求

- Node.js 18+
- MySQL / MariaDB
- 可运行 Java 的环境（Minecraft 服务端依赖）

## 安装步骤

1. 克隆项目

```bash
git clone <your-repo-url>
cd MC_control
```

2. 安装依赖

```bash
npm install
```

3. 配置环境变量

复制示例文件：

```bash
copy 示例.env .env
```

修改 .env 中的内容，至少需要配置：

```env
WEB_PASSWORD=your_secure_password_here
WEB_AUTH_SECRET=your_random_secret_key_32chars
DB_HOST=localhost
DB_PORT=3306
DB_USER=your_db_user
DB_PASSWORD=your_db_password
DB_NAME=your_database_name
PORT=3233
```

4. 启动服务

```bash
npm start
```

启动后访问：

- http://localhost:3233/login.html

## 默认登录

使用你在 .env 中配置的 WEB_PASSWORD 登录。

## 主要使用场景

- 个人 Minecraft 服务器管理
- 小型服主的 Web 控制台
- 内网部署的轻量运维面板

## 注意事项

- 需要确保 Java 可执行环境可用
- 备份恢复操作会影响游戏世界数据，请谨慎使用
- 生产环境建议使用 HTTPS 与更强的密码策略

## 开发说明

可运行如下检查：

```bash
npm run lint
```

