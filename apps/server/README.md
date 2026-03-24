# Server

`apps/server` 提供 Mercari 监控的核心 API 与调度器。

## 运行

```bash
pnpm --filter @mercari/server dev
```

## 数据文件

默认存储在 `apps/server/data/state.json`。

## 依赖

- `@mercari/scraper-playwright`
- `@mercari/shared`
