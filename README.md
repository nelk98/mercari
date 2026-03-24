# Mercari Monitor（MVP 重构版）

> **声明**：本仓库中的代码主要由 **人工智能（AI）辅助生成**。使用前请自行审查安全性、合规性、许可与可维护性；作者不对因使用本仓库而产生的任何后果承担责任。

本仓库已重构为 `apps + packages` 的 monorepo，核心目标：

- 统一使用 Playwright 抓取 Mercari 数据
- 桌面端提供双窗口：主窗口 + 悬浮精简窗口

## 目录结构

- `apps/server`：API、调度、状态管理
- `apps/desktop`：Tauri 桌面端（`main` + `widget` 窗口）
- `packages/scraper-playwright`：抓取库
- `packages/shared`：跨端常量与通用工具

## 快速启动

```bash
pnpm install
cp apps/server/.env.example apps/server/.env
pnpm run run:app
```

启动后：

- Server: `http://localhost:2999`
- Desktop: Tauri 双窗口应用（默认显示悬浮 widget）

## 常用命令

```bash
# 一键启动后端 + 桌面端
pnpm run run:app

# 全量开发（server + desktop）
pnpm run dev

# 仅 server
pnpm run dev:server

# 仅 desktop（需要 server 已启动）
pnpm run desktop:dev

# 运行单元测试
pnpm run test
```

## MVP API

- `GET /api/status`
- `GET /api/sources`
- `POST /api/sources`
- `PATCH /api/sources/:id`
- `DELETE /api/sources/:id`
- `GET /api/items?limit=24`
- `POST /api/scrape/run`

## 环境变量（apps/server/.env）

- `PORT`：服务端端口（默认 `2999`）
- `INTERVAL_MIN_MS`：最小抓取间隔
- `INTERVAL_MAX_MS`：最大抓取间隔
