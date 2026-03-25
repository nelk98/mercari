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
const scrapeProxyServer = (process.env.SCRAPE_PROXY_SERVER || '').trim() || null

/** 默认顺序抓取；设 SCRAPE_CONCURRENT=1 恢复多源并发 */
const scrapeConcurrent = truthyEnv(process.env.SCRAPE_CONCURRENT)
const scrapeRoundBudgetMs = clamp(number(process.env.SCRAPE_ROUND_BUDGET_MS, 30000), 15000, 120000)
const scrapeStaggerGapMs = clamp(number(process.env.SCRAPE_STAGGER_GAP_MS, 180), 0, 2000)

export const config = {
  port: number(process.env.PORT, DEFAULT_PORT),
  intervalMinMs: minInterval,
  intervalMaxMs: maxInterval,
  scrapeTimeoutMs,
  scrapeRetries,
  scrapeConcurrency,
  scrapeFreshContext,
  scrapeProxyServer,
  scrapeConcurrent,
  scrapeRoundBudgetMs,
  scrapeStaggerGapMs,
}
