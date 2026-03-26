import { randomUUID } from 'node:crypto'
import { nowIso } from '@mercari/shared'
import { createScraperEngine } from '@mercari/scraper-playwright'
import { toDisplayUrl } from './scrape-log.js'

const pickNextDelay = (minMs, maxMs) => Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export class ScrapeScheduler {
  constructor({
    store,
    intervalMinMs,
    intervalMaxMs,
    scrapeTimeoutMs = 12000,
    scrapeRetries = 0,
    scrapeConcurrency = 3,
    scrapeSequential = true,
    scrapeRoundBudgetMs = 30000,
    scrapeStaggerGapMs = 180,
    scrapeFreshContext = false,
    scrapePlaywrightHeaded = false,
    scrapeSoftMercariRefresh = true,
    scrapeProxyServer = null,
    scrapePlaywrightChannel = null,
    scrapePostRefreshWaitMs = 2500,
    broadcast = null,
    scrapeLog = null,
  }) {
    this.store = store
    this.intervalMinMs = intervalMinMs
    this.intervalMaxMs = intervalMaxMs
    this.scrapeTimeoutMs = scrapeTimeoutMs
    this.scrapeRetries = scrapeRetries
    this.scrapeConcurrency = Math.max(1, scrapeConcurrency)
    this.scrapeSequential = Boolean(scrapeSequential)
    this.scrapeRoundBudgetMs = scrapeRoundBudgetMs
    this.scrapeStaggerGapMs = scrapeStaggerGapMs
    this.scrapeFreshContext = scrapeFreshContext
    /** @type {boolean} 为 true 时 chromium.launch({ headless: false }) */
    this.playwrightHeaded = Boolean(scrapePlaywrightHeaded)
    this.scrapeSoftMercariRefresh = scrapeSoftMercariRefresh
    this.scrapeProxyServer = scrapeProxyServer
    this.scrapePlaywrightChannel = scrapePlaywrightChannel
    this.scrapePostRefreshWaitMs = Math.max(0, scrapePostRefreshWaitMs)
    /** @type {((event: string, data: unknown) => void) | null} */
    this.broadcast = typeof broadcast === 'function' ? broadcast : null
    this.scrapeLog = scrapeLog || null
    this.timer = null
    this.running = false
    /** @type {Awaited<ReturnType<typeof createScraperEngine>> | null} */
    this.scraperEngine = null
  }

  async disposeScraperEngine() {
    if (!this.scraperEngine) return
    const engine = this.scraperEngine
    this.scraperEngine = null
    await engine.close().catch(() => {})
  }

  /** 下次创建的引擎是否使用有头浏览器 */
  setPlaywrightHeaded(headed) {
    this.playwrightHeaded = Boolean(headed)
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
    const runId = randomUUID()
    const runStartedAt = Date.now()
    await this.store.setStatus({ state: 'running', message: '抓取中...' })
    let totalInserted = 0
    try {
      const sources = (await this.store.listSources()).filter((item) => item.enabled === 1)
      if (sources.length === 0) {
        await this.scrapeLog?.append({
          at: nowIso(),
          run_id: runId,
          url: '(无启用监控源)',
          url_raw: '',
          source_id: null,
          source_name: '',
          inserted: 0,
          item_count: 0,
          status: 'skipped',
          duration_ms: Date.now() - runStartedAt,
          error: null,
        })
        await this.store.setStatus({
          state: 'online',
          last_run_at: nowIso(),
          message: '无启用监控源',
        })
        this.broadcast?.('scrape_complete', { inserted: 0, sources: 0 })
        return { items: 0, inserted: 0 }
      }

      if (!this.scraperEngine) {
        this.scraperEngine = await createScraperEngine({
          headless: !this.playwrightHeaded,
          timeoutMs: this.scrapeTimeoutMs,
          retries: this.scrapeRetries,
          freshContextPerScrape: this.scrapeFreshContext,
          softMercariRefresh: this.scrapeSoftMercariRefresh,
          ...(this.scrapeProxyServer ? { proxyServer: this.scrapeProxyServer } : {}),
          ...(this.scrapePlaywrightChannel ? { channel: this.scrapePlaywrightChannel } : {}),
          onBrowserDisconnected: () => {
            this.scraperEngine = null
            this.broadcast?.('playwright_browser_closed', { reason: 'disconnected' })
          },
        })
      }
      const engine = this.scraperEngine

      try {
        const processSource = async (source, timeoutMs) => {
          const label = source.name || `源 #${source.id}`
          const urlRaw = String(source.url || '')
          const urlDisplay = toDisplayUrl(urlRaw)
          const t0 = Date.now()
          try {
            const items = await engine.scrapeOne(source, {
              timeoutMs,
              retries: this.scrapeRetries,
              softMercariRefresh: this.scrapeSoftMercariRefresh,
            })
            const ingest = await this.store.upsertScrapedItems(items)
            totalInserted += ingest.inserted
            const durationMs = Date.now() - t0
            await this.scrapeLog?.append({
              at: nowIso(),
              run_id: runId,
              url: urlDisplay,
              url_raw: urlRaw,
              source_id: source.id,
              source_name: source.name || '',
              inserted: ingest.inserted,
              item_count: items.length,
              status: 'ok',
              duration_ms: durationMs,
              error: null,
            })
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
          } catch (err) {
            const msg = err?.message || String(err)
            const durationMs = Date.now() - t0
            // eslint-disable-next-line no-console
            console.error(`[scheduler] source ${source.id} ${label}`, err)
            await this.scrapeLog?.append({
              at: nowIso(),
              run_id: runId,
              url: urlDisplay,
              url_raw: urlRaw,
              source_id: source.id,
              source_name: source.name || '',
              inserted: 0,
              item_count: 0,
              status: 'error',
              duration_ms: durationMs,
              error: msg,
            })
            await this.store.setStatus({
              state: 'running',
              message: `抓取中… ${label} 失败（已跳过，继续其他源）：${msg}`,
            })
            this.broadcast?.('scrape_progress', {
              phase: 'source_error',
              sourceId: source.id,
              sourceName: source.name || '',
              error: msg,
              itemCount: 0,
              inserted: 0,
            })
            return []
          }
        }

        const processSourceReadList = async (source, timeoutMs) => {
          const label = source.name || `源 #${source.id}`
          const urlRaw = String(source.url || '')
          const urlDisplay = toDisplayUrl(urlRaw)
          const t0 = Date.now()
          try {
            const items = await engine.readSourceList(source, { timeoutMs })
            const ingest = await this.store.upsertScrapedItems(items)
            totalInserted += ingest.inserted
            const durationMs = Date.now() - t0
            await this.scrapeLog?.append({
              at: nowIso(),
              run_id: runId,
              url: urlDisplay,
              url_raw: urlRaw,
              source_id: source.id,
              source_name: source.name || '',
              inserted: ingest.inserted,
              item_count: items.length,
              status: 'ok',
              duration_ms: durationMs,
              error: null,
            })
            await this.store.setStatus({
              state: 'running',
              message: `读取列表… ${label}（本批 +${ingest.inserted}）`,
            })
            this.broadcast?.('scrape_progress', {
              phase: 'read_done',
              sourceId: source.id,
              sourceName: source.name || '',
              inserted: ingest.inserted,
              itemCount: items.length,
            })
            return items
          } catch (err) {
            const msg = err?.message || String(err)
            const durationMs = Date.now() - t0
            // eslint-disable-next-line no-console
            console.error(`[scheduler] read ${source.id} ${label}`, err)
            await this.scrapeLog?.append({
              at: nowIso(),
              run_id: runId,
              url: urlDisplay,
              url_raw: urlRaw,
              source_id: source.id,
              source_name: source.name || '',
              inserted: 0,
              item_count: 0,
              status: 'error',
              duration_ms: durationMs,
              error: msg,
            })
            await this.store.setStatus({
              state: 'running',
              message: `读取列表… ${label} 失败：${msg}`,
            })
            this.broadcast?.('scrape_progress', {
              phase: 'read_error',
              sourceId: source.id,
              sourceName: source.name || '',
              error: msg,
              itemCount: 0,
              inserted: 0,
            })
            return []
          }
        }

        const useTwoPhaseRefreshThenRead =
          this.scrapeSequential &&
          !this.scrapeFreshContext &&
          typeof engine.refreshSource === 'function' &&
          typeof engine.readSourceList === 'function'

        if (useTwoPhaseRefreshThenRead) {
          const gap = Math.max(0, this.scrapeStaggerGapMs)
          const perSourceTimeout = this.scrapeTimeoutMs
          await this.store.setStatus({
            state: 'running',
            message: '阶段一：逐个切换页签并刷新搜索…',
          })
          for (let i = 0; i < sources.length; i += 1) {
            if (i > 0 && gap > 0) await sleep(gap)
            const source = sources[i]
            const label = source.name || `源 #${source.id}`
            try {
              await engine.refreshSource(source, {
                timeoutMs: perSourceTimeout,
                softMercariRefresh: this.scrapeSoftMercariRefresh,
              })
              this.broadcast?.('scrape_progress', {
                phase: 'refresh_done',
                sourceId: source.id,
                sourceName: source.name || '',
              })
              await this.store.setStatus({
                state: 'running',
                message: `刷新页签… ${label} 完成`,
              })
            } catch (err) {
              const msg = err?.message || String(err)
              // eslint-disable-next-line no-console
              console.error(`[scheduler] refresh ${source.id} ${label}`, err)
              this.broadcast?.('scrape_progress', {
                phase: 'refresh_error',
                sourceId: source.id,
                sourceName: source.name || '',
                error: msg,
              })
              await this.store.setStatus({
                state: 'running',
                message: `刷新页签… ${label} 失败：${msg}`,
              })
            }
          }
          await this.store.setStatus({
            state: 'running',
            message: `阶段二：等待列表更新（${this.scrapePostRefreshWaitMs}ms）…`,
          })
          if (this.scrapePostRefreshWaitMs > 0) {
            await sleep(this.scrapePostRefreshWaitMs)
          }
          await this.store.setStatus({
            state: 'running',
            message: '阶段二：逐个读取各页商品…',
          })
          for (let i = 0; i < sources.length; i += 1) {
            if (i > 0 && gap > 0) await sleep(gap)
            await processSourceReadList(sources[i], perSourceTimeout)
          }
        } else if (this.scrapeSequential) {
          const gap = Math.max(0, this.scrapeStaggerGapMs)
          const perSourceTimeout = this.scrapeTimeoutMs
          for (let i = 0; i < sources.length; i += 1) {
            if (i > 0 && gap > 0) await sleep(gap)
            await processSource(sources[i], perSourceTimeout)
          }
        } else {
          await this.runInPool(
            sources,
            (source) => processSource(source, this.scrapeTimeoutMs),
            this.scrapeConcurrency,
          )
        }
      } finally {
        await engine.pruneSourcePages?.(new Set(sources.map((s) => String(s.id))))
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
      await this.disposeScraperEngine()
      const msg = error?.message || String(error)
      await this.scrapeLog?.append({
        at: nowIso(),
        run_id: runId,
        url: '(整轮异常)',
        url_raw: '',
        source_id: null,
        source_name: '',
        inserted: 0,
        item_count: 0,
        status: 'error',
        duration_ms: Date.now() - runStartedAt,
        error: msg,
      })
      const state = await this.store.getState()
      await this.store.setStatus({
        state: 'degraded',
        consecutive_failures: (state.status?.consecutive_failures || 0) + 1,
        last_run_at: nowIso(),
        message: msg || '抓取失败',
      })
      this.broadcast?.('scrape_error', { message: msg || 'scrape failed' })
      return { error: msg || 'scrape failed' }
    } finally {
      this.running = false
    }
  }

  scheduleNext() {
    const delay = pickNextDelay(this.intervalMinMs, this.intervalMaxMs)
    const nextRunAt = new Date(Date.now() + delay).toISOString()
    this.store.setStatus({ next_run_at: nextRunAt }).catch(() => {})
    this.timer = setTimeout(() => {
      void (async () => {
        try {
          await this.runOnce()
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('[scheduler] runOnce threw', err)
        } finally {
          this.scheduleNext()
        }
      })()
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

  /** 定时链是否在运行（下一轮 setTimeout 已排期） */
  isScheduleActive() {
    return this.timer != null
  }

  /** 在「排期抓取」与「暂停排期」之间切换；不影响正在执行的 runOnce */
  toggleSchedule() {
    if (this.timer) {
      this.stop()
      return { scheduled: false }
    }
    this.start()
    return { scheduled: true }
  }
}
