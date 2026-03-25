import fs from 'node:fs/promises'
import path from 'node:path'

/** 便于阅读的 URL（解码 % 编码，失败则回退原文） */
export const toDisplayUrl = (raw) => {
  const s = String(raw || '').trim()
  if (!s) return ''
  try {
    return decodeURI(s)
  } catch {
    return s
  }
}

const dayFromIso = (iso) => {
  const d = new Date(iso || Date.now())
  if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 10)
  return d.toISOString().slice(0, 10)
}

const logFilePath = (dataDir, day) =>
  path.resolve(dataDir, `scrape-logs-${day}.ndjson`)

export class ScrapeLogger {
  /**
   * @param {string} dataDir 与 Store 一致，默认 process.cwd()/data
   */
  constructor(dataDir = path.resolve(process.cwd(), 'data')) {
    this.dataDir = dataDir
    /** @type {Promise<void>} */
    this._chain = Promise.resolve()
  }

  /**
   * @param {object} entry
   */
  append(entry) {
    this._chain = this._chain.then(() => this._append(entry))
    return this._chain
  }

  async _append(entry) {
    await fs.mkdir(this.dataDir, { recursive: true })
    const at = entry.at || new Date().toISOString()
    const day = dayFromIso(at)
    const file = logFilePath(this.dataDir, day)
    const line = `${JSON.stringify({ ...entry, at })}\n`
    await fs.appendFile(file, line, 'utf8')
  }

  /**
   * 读取某日日志，从新到旧最多 limit 条
   * @param {{ day?: string, limit?: number }} opts
   */
  async readRecent({ day, limit = 200 } = {}) {
    const d =
      typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day)
        ? day
        : new Date().toISOString().slice(0, 10)
    const max = Math.max(1, Math.min(Number(limit) || 200, 2000))
    const file = logFilePath(this.dataDir, d)
    let raw = ''
    try {
      raw = await fs.readFile(file, 'utf8')
    } catch {
      return { day: d, logs: [] }
    }
    const lines = raw.split('\n').filter((l) => l.trim())
    const parsed = []
    for (const line of lines) {
      try {
        parsed.push(JSON.parse(line))
      } catch {
        /* skip bad line */
      }
    }
    return { day: d, logs: parsed.slice(-max).reverse() }
  }
}
