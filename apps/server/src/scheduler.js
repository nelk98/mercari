import { nowIso } from '@mercari/shared'
import { createScraperEngine } from '@mercari/scraper-playwright'

const pickNextDelay = (minMs, maxMs) => Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs

export class ScrapeScheduler {
  constructor({ store, intervalMinMs, intervalMaxMs, scrapeTimeoutMs = 12000, scrapeRetries = 0, scrapeConcurrency = 3 }) {
    this.store = store
    this.intervalMinMs = intervalMinMs
    this.intervalMaxMs = intervalMaxMs
    this.scrapeTimeoutMs = scrapeTimeoutMs
    this.scrapeRetries = scrapeRetries
    this.scrapeConcurrency = Math.max(1, scrapeConcurrency)
    this.timer = null
    this.running = false
  }

  async runInPool(items, worker, concurrency) {
    const all = Array.isArray(items) ? items : []
    const poolSize = Math.max(1, Math.min(concurrency, all.length || 1))
    const result = []
    let index = 0

    const runners = Array.from({ length: poolSize }, async () => {
      while (index < all.length) {
        const current = all[index]
        index += 1
        const value = await worker(current)
        if (value) result.push(value)
      }
    })

    await Promise.all(runners)
    return result
  }

  async runOnce() {
    if (this.running) return { skipped: true }
    this.running = true
    await this.store.setStatus({ state: 'running', message: '抓取中...' })
    try {
      const sources = (await this.store.listSources()).filter((item) => item.enabled === 1)
      const engine = await createScraperEngine({
        timeoutMs: this.scrapeTimeoutMs,
        retries: this.scrapeRetries,
      })
      const collected = []
      try {
        const chunks = await this.runInPool(
          sources,
          async (source) => engine.scrapeOne(source, { timeoutMs: this.scrapeTimeoutMs, retries: this.scrapeRetries }),
          this.scrapeConcurrency,
        )
        for (const items of chunks) collected.push(...items)
      } finally {
        await engine.close()
      }
      const sorted = collected
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        .slice(0, 120)
      const ingest = await this.store.upsertScrapedItems(sorted)
      await this.store.setStatus({
        state: 'online',
        last_run_at: nowIso(),
        consecutive_failures: 0,
        message: `抓取完成，新增 ${ingest.inserted} 条`,
      })
      return { items: sorted.length, inserted: ingest.inserted }
    } catch (error) {
      const state = await this.store.getState()
      await this.store.setStatus({
        state: 'degraded',
        consecutive_failures: (state.status?.consecutive_failures || 0) + 1,
        last_run_at: nowIso(),
        message: error?.message || '抓取失败',
      })
      return { error: error?.message || 'scrape failed' }
    } finally {
      this.running = false
    }
  }

  scheduleNext() {
    const delay = pickNextDelay(this.intervalMinMs, this.intervalMaxMs)
    const nextRunAt = new Date(Date.now() + delay).toISOString()
    this.store.setStatus({ next_run_at: nextRunAt }).catch(() => {})
    this.timer = setTimeout(async () => {
      await this.runOnce()
      this.scheduleNext()
    }, delay)
  }

  start() {
    if (this.timer) return
    this.scheduleNext()
  }

  stop() {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }
}
