import fs from 'node:fs/promises'
import path from 'node:path'
import { nowIso } from '@mercari/shared'

const DATA_DIR = path.resolve(process.cwd(), 'data')
const STATE_FILE = path.resolve(DATA_DIR, 'state.json')
const KEY_DELIMITER = '::'

const defaultStatus = () => ({
  state: 'idle',
  last_run_at: null,
  next_run_at: null,
  consecutive_failures: 0,
  message: '',
})

const defaultPersistedState = () => ({
  sources: [],
})

const ensureDir = async () => {
  await fs.mkdir(DATA_DIR, { recursive: true })
}

const dayFromIso = (iso) => {
  const date = new Date(iso || Date.now())
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10)
  return date.toISOString().slice(0, 10)
}

const dayFile = (day) => path.resolve(DATA_DIR, `items-${day}.json`)

const makeItemKey = (item) => `${item?.source_id || ''}${KEY_DELIMITER}${item?.item_id || item?.url || ''}`

const readJson = async (file, fallback) => {
  try {
    const raw = await fs.readFile(file, 'utf8')
    return JSON.parse(raw)
  } catch (_) {
    return fallback
  }
}

const writeJson = async (file, value) => {
  await fs.writeFile(file, JSON.stringify(value, null, 2), 'utf8')
}

const readState = async () => {
  await ensureDir()
  const parsed = await readJson(STATE_FILE, defaultPersistedState())
  return {
    ...defaultPersistedState(),
    sources: Array.isArray(parsed.sources) ? parsed.sources : [],
  }
}

const sanitizePersistedState = (state) => ({
  ...defaultPersistedState(),
  sources: Array.isArray(state?.sources) ? state.sources : [],
})

const writeState = async (state) => {
  await ensureDir()
  await writeJson(STATE_FILE, sanitizePersistedState(state))
}

export class Store {
  constructor() {
    this.status = defaultStatus()
    this.statePromise = readState().then(async (state) => {
      const cleaned = sanitizePersistedState(state)
      await writeState(cleaned)
      return cleaned
    })
  }

  async getState() {
    const persisted = await this.statePromise
    return {
      ...persisted,
      status: { ...this.status },
    }
  }

  async mutate(mutator) {
    const current = await this.statePromise
    const nextRaw = mutator(structuredClone(current)) || current
    const next = sanitizePersistedState(nextRaw)
    this.statePromise = Promise.resolve(next)
    await writeState(next)
    return next
  }

  async readDayItems(day) {
    return readJson(dayFile(day), [])
  }

  async writeDayItems(day, items) {
    await writeJson(dayFile(day), Array.isArray(items) ? items : [])
  }

  async listRecentDayKeys(limitDays = 7) {
    await ensureDir()
    const names = await fs.readdir(DATA_DIR).catch(() => [])
    const matched = names
      .map((name) => {
        const m = name.match(/^items-(\d{4}-\d{2}-\d{2})\.json$/)
        return m ? m[1] : null
      })
      .filter(Boolean)
      .sort((a, b) => b.localeCompare(a))
    return matched.slice(0, Math.max(1, limitDays))
  }

  async listItems({ limit = 18, unreadOnly = false, recentWithinMinutes = null } = {}) {
    const days = await this.listRecentDayKeys(14)
    const all = []
    for (const day of days) {
      const items = await this.readDayItems(day)
      for (const item of items) {
        if (unreadOnly && item.read_at) continue
        if (typeof recentWithinMinutes === 'number' && Number.isFinite(recentWithinMinutes)) {
          const firstSeen = Date.parse(item.first_seen_at || '')
          if (Number.isNaN(firstSeen)) continue
          if (Date.now() - firstSeen > recentWithinMinutes * 60 * 1000) continue
        }
        all.push(item)
      }
    }
    all.sort((a, b) => {
      const at = Date.parse(a.first_seen_at || a.created_at || 0) || 0
      const bt = Date.parse(b.first_seen_at || b.created_at || 0) || 0
      return bt - at
    })
    return all.slice(0, Math.max(1, Math.min(limit, 500)))
  }

  async listSources() {
    const state = await this.getState()
    return state.sources.slice().sort((a, b) => b.id - a.id)
  }

  async addSource({ name, url }) {
    return this.mutate((state) => {
      const id = state.sources.reduce((max, src) => Math.max(max, src.id || 0), 0) + 1
      state.sources.push({
        id,
        name: String(name || '').trim() || `源 #${id}`,
        url: String(url || '').trim(),
        enabled: 1,
        created_at: nowIso(),
      })
      return state
    })
  }

  async updateSource(id, payload) {
    return this.mutate((state) => {
      const source = state.sources.find((item) => item.id === id)
      if (!source) return state
      if (typeof payload.name === 'string') source.name = payload.name.trim() || source.name
      if (typeof payload.enabled === 'boolean') source.enabled = payload.enabled ? 1 : 0
      return state
    })
  }

  async removeSource(id) {
    return this.mutate((state) => {
      state.sources = state.sources.filter((source) => source.id !== id)
      return state
    })
  }

  async setStatus(patch) {
    this.status = { ...this.status, ...(patch || {}) }
    return this.status
  }

  async upsertScrapedItems(items) {
    const incoming = Array.isArray(items) ? items : []
    const now = nowIso()
    const dayCache = new Map()
    const keyDayMap = new Map()

    const getDayItems = async (day) => {
      if (!dayCache.has(day)) {
        dayCache.set(day, await this.readDayItems(day))
      }
      return dayCache.get(day)
    }

    const recentDays = await this.listRecentDayKeys(30)
    for (const day of recentDays) {
      const rows = await this.readDayItems(day)
      for (const row of rows) {
        if (row?.key) keyDayMap.set(row.key, day)
      }
    }

    let inserted = 0
    for (const item of incoming) {
      const key = makeItemKey(item)
      if (!key || !item.url) continue
      const mapped = keyDayMap.get(key)
      if (!mapped) {
        const day = dayFromIso(now)
        const dayItems = await getDayItems(day)
        dayItems.push({
          ...item,
          key,
          first_seen_at: now,
          last_seen_at: now,
          read_at: null,
        })
        keyDayMap.set(key, day)
        inserted += 1
        continue
      }

      const dayItems = await getDayItems(mapped)
      const target = dayItems.find((row) => row.key === key)
      if (!target) continue
      target.title = item.title || target.title
      target.price = item.price || target.price
      target.image = item.image || target.image
      target.url = item.url || target.url
      target.published_at = item.published_at || target.published_at || null
      target.last_seen_at = now
    }

    for (const [day, rows] of dayCache.entries()) {
      await this.writeDayItems(day, rows)
    }

    return { inserted, total: incoming.length }
  }

  async markItemsRead({ all = false, keys = [] } = {}) {
    const now = nowIso()
    const targetKeys = all ? null : new Set(Array.isArray(keys) ? keys : [])
    const days = await this.listRecentDayKeys(60)

    let marked = 0
    for (const day of days) {
      const rows = await this.readDayItems(day)
      let changed = false
      for (const row of rows) {
        if (!all && !targetKeys?.has(row.key)) continue
        if (!row.read_at) marked += 1
        row.read_at = now
        changed = true
      }
      if (changed) await this.writeDayItems(day, rows)
    }
    return { marked }
  }
}
