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
const scrapeTimeoutMs = clamp(number(process.env.SCRAPE_TIMEOUT_MS, 12000), 3000, 60000)
const scrapeRetries = clamp(number(process.env.SCRAPE_RETRIES, 0), 0, 3)
const scrapeConcurrency = clamp(number(process.env.SCRAPE_CONCURRENCY, 3), 1, 8)

export const config = {
  port: number(process.env.PORT, DEFAULT_PORT),
  intervalMinMs: minInterval,
  intervalMaxMs: maxInterval,
  scrapeTimeoutMs,
  scrapeRetries,
  scrapeConcurrency,
}
