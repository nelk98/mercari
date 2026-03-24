# Mercari 抓取 + 企业微信推送（Monorepo）

## 一行启动

```bash
pnpm install
pnpm run dev
```

> 首次安装会自动下载 Playwright 浏览器，可能需要一点时间。

## 一键启动（仅后端 + 前端）

```bash
pnpm run dev:ws
```

## 一键启动（后端 + 前端 + 桌面小组件）

```bash
pnpm run dev:full
```

## 一键启动（含 ngrok）

```bash
pnpm run dev:all
```

这个命令会同时启动前后端，并打开 ngrok 代理 `http://localhost:2999`，
你可以把 ngrok 的 HTTPS 地址填到 QQ 机器人后台回调地址里。

## 桌面小组件（macOS）

桌面小组件在 `desktop/` 目录，基于 Tauri，支持：
- 屏幕悬浮小窗（Always-on-top）
- 菜单栏图标 + 弹出列表

首次需要安装 Rust 工具链：

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

运行桌面小组件：

```bash
pnpm run desktop:dev
```

> 小组件会从 `http://localhost:2999` 拉取数据，请先启动后端。

## 环境变量

复制一份并填写 QQ 机器人配置：

```bash
cp server/.env.example server/.env
```

然后在 `server/.env` 里设置：

- `QQ_APP_ID` 机器人 AppId
- `QQ_APP_SECRET` 机器人密钥
- `QQ_USER_OPENID` 你的 QQ OpenID（单聊所需）。不填也可，系统会在你发第一条消息给机器人后自动记录
- `INTERVAL_MIN_MS` 抓取间隔下限，默认 20000
- `INTERVAL_MAX_MS` 抓取间隔上限，默认 30000
- `PORT` 服务端口，默认 2999

## 使用方式

1. 访问前端：`http://localhost:5173`
2. 添加 Mercari 搜索链接
3. 系统每 20-30 秒抓取一次，有新商品自动推送到 QQ 单聊

## 数据存储

数据会保存到：`/Users/nelk/Desktop/mercari/server/data/`

## QQ 单聊 OpenID 获取（方式 2）

1. 将回调地址配置为 `https://你的域名/api/qq/webhook`
2. 在 QQ 机器人后台开启事件订阅（`C2C_MESSAGE_CREATE`）
3. 给机器人发一条消息
4. 访问 `http://localhost:2999/api/qq/openid` 查看捕获到的 OpenID

> 注意：回调地址需要可公网访问的 HTTPS，并确保消息 URL 白名单包含 `jp.mercari.com`（否则带链接的消息会被拦截）。

## 备注

- 仅对 Mercari 链接进行抓取（`mercari.com` 域名）
- 新商品通过 `source + item_id` 去重
