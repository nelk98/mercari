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

export const createApp = ({ store, scheduler, eventHub }) => {
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
    res.json(state.status)
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

  return app
}
