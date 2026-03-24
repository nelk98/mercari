import { nowIso } from '@mercari/shared'
import { createScraperEngine } from '@mercari/scraper-playwright'

const pickNextDelay = (minMs, maxMs) => Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs

export class ScrapeScheduler {
  constructor({
    store,
    intervalMinMs,
    intervalMaxMs,
    scrapeTimeoutMs = 12000,
    scrapeRetries = 0,
    scrapeConcurrency = 3,
    scrapeFreshContext = false,
    scrapeProxyServer = null,
    broadcast = null,
  }) {
    this.store = store
    this.intervalMinMs = intervalMinMs
    this.intervalMaxMs = intervalMaxMs
    this.scrapeTimeoutMs = scrapeTimeoutMs
    this.scrapeRetries = scrapeRetries
    this.scrapeConcurrency = Math.max(1, scrapeConcurrency)
    this.scrapeFreshContext = scrapeFreshContext
    this.scrapeProxyServer = scrapeProxyServer
    /** @type {((event: string, data: unknown) => void) | null} */
    this.broadcast = typeof broadcast === 'function' ? broadcast : null
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
    if (this.running) {
      this.broadcast?.('scrape_skipped', { reason: 'already_running' })
      return { skipped: true }
    }
    this.running = true
    await this.store.setStatus({ state: 'running', message: '抓取中...' })
    let totalInserted = 0
    try {
      const sources = (await this.store.listSources()).filter((item) => item.enabled === 1)
      if (sources.length === 0) {
        await this.store.setStatus({
          state: 'online',
          last_run_at: nowIso(),
          message: '无启用监控源',
        })
        this.broadcast?.('scrape_complete', { inserted: 0, sources: 0 })
        return { items: 0, inserted: 0 }
      }

      const engine = await createScraperEngine({
        timeoutMs: this.scrapeTimeoutMs,
        retries: this.scrapeRetries,
        freshContextPerScrape: this.scrapeFreshContext,
        ...(this.scrapeProxyServer ? { proxyServer: this.scrapeProxyServer } : {}),
      })
      try {
        await this.runInPool(
          sources,
          async (source) => {
            const items = await engine.scrapeOne(source, {
              timeoutMs: this.scrapeTimeoutMs,
              retries: this.scrapeRetries,
            })
            const ingest = await this.store.upsertScrapedItems(items)
            totalInserted += ingest.inserted
            const label = source.name || `源 #${source.id}`
            await this.store.setStatus({
              state: 'running',
              message: `抓取中… ${label} 完成（本批 +${ingest.inserted}）`,
            })
            this.broadcast?.('scrape_progress', {
              phase: 'source_done',
              sourceId: source.id,
              sourceName: source.name || '',
              inserted: ingest.inserted,
              itemCount: items.length,
            })
            return items
          },
          this.scrapeConcurrency,
        )
      } finally {
        await engine.close()
      }

      await this.store.setStatus({
        state: 'online',
        last_run_at: nowIso(),
        consecutive_failures: 0,
        message: `抓取完成，新增 ${totalInserted} 条`,
      })
      this.broadcast?.('scrape_complete', { inserted: totalInserted, sources: sources.length })
      return { inserted: totalInserted }
    } catch (error) {
      const state = await this.store.getState()
      await this.store.setStatus({
        state: 'degraded',
        consecutive_failures: (state.status?.consecutive_failures || 0) + 1,
        last_run_at: nowIso(),
        message: error?.message || '抓取失败',
      })
      this.broadcast?.('scrape_error', { message: error?.message || 'scrape failed' })
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
