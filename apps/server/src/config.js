import 'dotenv/config'
import {
  DEFAULT_INTERVAL_MAX_MS,
  DEFAULT_INTERVAL_MIN_MS,
  DEFAULT_PORT,
  clamp,
} from '@mercari/shared'

const number = (value, fallback) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

const minInterval = clamp(number(process.env.INTERVAL_MIN_MS, DEFAULT_INTERVAL_MIN_MS), 5000, 120000)
const maxInterval = clamp(number(process.env.INTERVAL_MAX_MS, DEFAULT_INTERVAL_MAX_MS), minInterval, 180000)
const scrapeTimeoutMs = clamp(number(process.env.SCRAPE_TIMEOUT_MS, 30000), 5000, 120000)
const scrapeRetries = clamp(number(process.env.SCRAPE_RETRIES, 0), 0, 3)
const scrapeConcurrency = clamp(number(process.env.SCRAPE_CONCURRENCY, 5), 1, 8)

const truthyEnv = (value) => {
  if (value == null || value === '') return false
  const v = String(value).trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes' || v === 'on'
}

const scrapeFreshContext = truthyEnv(process.env.SCRAPE_FRESH_CONTEXT)
/** 为 true 时 Playwright 默认有界面（也可用托盘「显示抓取浏览器」临时开启） */
const scrapePlaywrightHeaded = truthyEnv(process.env.SCRAPE_HEADED)
const scrapeProxyServer = (process.env.SCRAPE_PROXY_SERVER || '').trim() || null
/** 使用本机 Chrome/Chromium 通道，无头与有头行为更接近，可缓解部分站点仅无头被拦（如 chrome、msedge） */
const scrapePlaywrightChannel = (process.env.PLAYWRIGHT_CHANNEL || '').trim() || null

/** 未设置或非 0/false/off/no 时启用：Mercari /search 同 URL 时用顶栏按钮刷新，失败再 reload */
const scrapeSoftMercariRefresh = () => {
  const v = process.env.SCRAPE_SOFT_REFRESH
  if (v == null || String(v).trim() === '') return true
  const s = String(v).trim().toLowerCase()
  return !(s === '0' || s === 'false' || s === 'off' || s === 'no')
}

/** 默认顺序抓取；设 SCRAPE_CONCURRENT=1 恢复多源并发 */
const scrapeConcurrent = truthyEnv(process.env.SCRAPE_CONCURRENT)
const scrapeRoundBudgetMs = clamp(number(process.env.SCRAPE_ROUND_BUDGET_MS, 30000), 15000, 120000)
const scrapeStaggerGapMs = clamp(number(process.env.SCRAPE_STAGGER_GAP_MS, 180), 0, 2000)
/** 全部窗口完成搜索/刷新后，等待列表异步落稳再统一读 DOM（毫秒） */
const scrapePostRefreshWaitMs = clamp(number(process.env.SCRAPE_POST_REFRESH_WAIT_MS, 2500), 0, 20000)

export const config = {
  port: number(process.env.PORT, DEFAULT_PORT),
  intervalMinMs: minInterval,
  intervalMaxMs: maxInterval,
  scrapeTimeoutMs,
  scrapeRetries,
  scrapeConcurrency,
  scrapeFreshContext,
  scrapePlaywrightHeaded,
  scrapeSoftMercariRefresh: scrapeSoftMercariRefresh(),
  scrapeProxyServer,
  scrapePlaywrightChannel,
  scrapeConcurrent,
  scrapeRoundBudgetMs,
  scrapeStaggerGapMs,
  scrapePostRefreshWaitMs,
}
