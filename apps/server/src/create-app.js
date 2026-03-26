import express from 'express'
import cors from 'cors'
import { ApiErrorCode, DEFAULT_FETCH_LIMIT, DEFAULT_WIDGET_FETCH_LIMIT } from '@mercari/shared'

const isMercariUrl = (value) => {
  try {
    const url = new URL(value)
    return url.hostname.includes('mercari.com')
  } catch (_) {
    return false
  }
}

const badRequest = (res, message) =>
  res.status(400).json({ error: message, code: ApiErrorCode.INVALID_INPUT })

export const createApp = ({ store, scheduler, eventHub, scrapeLog = null }) => {
  const app = express()
  app.use(cors())
  app.use(express.json({ limit: '1mb' }))

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true })
  })

  app.get('/api/events', (req, res) => {
    req.socket.setTimeout(0)
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    if (typeof res.flushHeaders === 'function') res.flushHeaders()
    const unsubscribe = eventHub.subscribe(res)
    res.write(': connected\n\n')
    req.on('close', unsubscribe)
  })

  app.get('/api/status', async (_req, res) => {
    const state = await store.getState()
    res.json({
      ...state.status,
      schedule_active: scheduler.isScheduleActive(),
    })
  })

  app.get('/api/sources', async (_req, res) => {
    const list = await store.listSources()
    res.json(list)
  })

  app.post('/api/sources', async (req, res) => {
    const url = String(req.body?.url || '').trim()
    const name = String(req.body?.name || '').trim()
    if (!url) return badRequest(res, 'url is required')
    if (!isMercariUrl(url)) return badRequest(res, 'only mercari url is allowed')
    await store.addSource({ name, url })
    const list = await store.listSources()
    res.status(201).json(list[0])
  })

  app.patch('/api/sources/:id', async (req, res) => {
    const id = Number(req.params.id)
    if (!Number.isFinite(id)) return badRequest(res, 'invalid source id')
    await store.updateSource(id, req.body || {})
    const list = await store.listSources()
    const updated = list.find((item) => item.id === id)
    if (!updated) return res.status(404).json({ error: 'source not found', code: ApiErrorCode.NOT_FOUND })
    return res.json(updated)
  })

  app.delete('/api/sources/:id', async (req, res) => {
    const id = Number(req.params.id)
    if (!Number.isFinite(id)) return badRequest(res, 'invalid source id')
    await store.removeSource(id)
    res.status(204).send()
  })

  app.get('/api/items', async (req, res) => {
    const rawLimit = Number(req.query.limit)
    const defaultLimit = req.query.widget === '1' ? DEFAULT_WIDGET_FETCH_LIMIT : DEFAULT_FETCH_LIMIT
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(rawLimit, 200)) : defaultLimit
    const unreadOnly = req.query.unread === '1'
    const recentWithinMinutes = Number(req.query.recent_minutes)
    const recentMinutes = Number.isFinite(recentWithinMinutes) ? Math.max(1, Math.min(1440, recentWithinMinutes)) : null
    const items = await store.listItems({ limit, unreadOnly, recentWithinMinutes: recentMinutes })
    const withFlags = items.map((item) => {
      const firstSeen = Date.parse(item.first_seen_at || '')
      const isRecent = Number.isFinite(firstSeen) ? (Date.now() - firstSeen <= 30 * 60 * 1000) : false
      return { ...item, is_recent: isRecent, is_read: Boolean(item.read_at) }
    })
    res.json(withFlags)
  })

  app.post('/api/items/mark-read', async (req, res) => {
    const all = req.body?.all === true
    const keys = Array.isArray(req.body?.keys) ? req.body.keys : []
    if (!all && keys.length === 0) return badRequest(res, 'all=true or keys[] required')
    const result = await store.markItemsRead({ all, keys })
    return res.json({ ok: true, ...result })
  })

  app.post('/api/scrape/run', (_req, res) => {
    res.status(202).json({ ok: true, accepted: true })
    scheduler.runOnce().catch((err) => {
      eventHub.broadcast('scrape_error', { message: String(err?.message || err) })
    })
  })

  /**
   * 启用/关闭 Playwright 有头模式，关闭当前引擎以便下轮生效。
   * body.headed === false 时仅关有头；否则开启有头并异步触发一轮抓取（便于托盘「显示抓取浏览器」）。
   */
  app.post('/api/scrape/playwright-visual', async (req, res) => {
    const headed = req.body?.headed !== false
    scheduler.setPlaywrightHeaded(headed)
    await scheduler.disposeScraperEngine()
    if (headed) {
      res.status(202).json({ ok: true, headed: true, scrapeStarted: true })
      scheduler.runOnce().catch((err) => {
        eventHub.broadcast('scrape_error', { message: String(err?.message || err) })
      })
    } else {
      res.json({ ok: true, headed: false, scrapeStarted: false })
    }
  })

  /** 桌面快捷键：切换定时抓取排期（启动 ↔ 暂停）；单轮 runOnce 可能仍在进行 */
  app.post('/api/scrape/schedule/toggle', async (_req, res) => {
    const { scheduled } = scheduler.toggleSchedule()
    if (scheduled) {
      await store.setStatus({ message: '定时抓取已启动' })
      eventHub.broadcast('schedule_state', { scheduled: true })
    } else {
      await store.setStatus({ next_run_at: null, message: '定时抓取已暂停' })
      eventHub.broadcast('schedule_state', { scheduled: false })
    }
    res.json({ ok: true, scheduled })
  })

  /** 托盘单项切换：有头 ↔ 无头；切到有头时释放引擎并立即跑一轮抓取 */
  app.post('/api/scrape/playwright-visual/toggle', async (_req, res) => {
    const next = !scheduler.playwrightHeaded
    scheduler.setPlaywrightHeaded(next)
    await scheduler.disposeScraperEngine()
    if (next) {
      res.status(202).json({ ok: true, headed: true, scrapeStarted: true })
      scheduler.runOnce().catch((err) => {
        eventHub.broadcast('scrape_error', { message: String(err?.message || err) })
      })
    } else {
      res.json({ ok: true, headed: false, scrapeStarted: false })
    }
  })

  app.get('/api/scrape/logs', async (req, res) => {
    if (!scrapeLog) return res.status(503).json({ error: 'scrape log disabled' })
    const day = typeof req.query.day === 'string' ? req.query.day : undefined
    const rawLimit = Number(req.query.limit)
    const limit = Number.isFinite(rawLimit) ? rawLimit : 200
    const { day: resolvedDay, logs } = await scrapeLog.readRecent({ day, limit })
    res.json({ day: resolvedDay, logs })
  })

  return app
}
