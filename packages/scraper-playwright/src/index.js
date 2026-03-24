import { chromium } from 'playwright'

const CARD_SELECTOR = 'li[data-testid="item-cell"], div[data-testid="item-cell"], a[href*="/item/"]'
const READY_SELECTOR = '[data-testid="item-cell"], a[href*="/item/"]'

export class ScrapeError extends Error {
  constructor(code, message, cause) {
    super(message)
    this.name = 'ScrapeError'
    this.code = code
    this.cause = cause
  }
}

const safeText = (value = '') => String(value || '').replace(/\s+/g, ' ').trim()

const parsePriceText = (text) => {
  const normalized = safeText(text)
  if (!normalized) return ''
  const match = normalized.match(/([¥￥]\s?[\d,]+|[\d,]+\s?円)/)
  return match ? match[1].replace(/\s+/g, '') : normalized
}

const absoluteUrl = (raw, base) => {
  if (!raw) return ''
  try {
    return new URL(raw, base).toString()
  } catch (_) {
    return ''
  }
}

export const normalizeItem = (item, sourceId) => {
  const url = absoluteUrl(item.url, 'https://jp.mercari.com')
  const itemId = item.itemId || (url.match(/\/item\/([^/?#]+)/)?.[1] ?? '')
  return {
    source_id: sourceId,
    item_id: itemId,
    title: safeText(item.title) || '无标题',
    price: parsePriceText(item.price),
    image: absoluteUrl(item.image, 'https://jp.mercari.com'),
    url,
    published_at: item.publishedAt || null,
    created_at: new Date().toISOString(),
  }
}

export const dedupeItems = (items) => {
  const seen = new Set()
  const result = []
  for (const item of items) {
    const key = `${item.source_id || ''}:${item.item_id || item.url || ''}`
    if (!key || seen.has(key)) continue
    seen.add(key)
    result.push(item)
  }
  return result
}

const scrapeCards = async (page, sourceUrl) =>
  page.$$eval(CARD_SELECTOR, (cards) =>
    cards.slice(0, 30).map((node) => {
      const container = node
      const anchor = container.matches('a') ? container : container.querySelector('a[href*="/item/"]')
      const titleEl =
        container.querySelector('[data-testid="thumbnail-item-name"]') ||
        container.querySelector('[data-testid="item-name"]') ||
        container.querySelector('img')
      const priceEl =
        container.querySelector('[data-testid="thumbnail-item-price"]') ||
        container.querySelector('[data-testid="price"]') ||
        container.querySelector('span')
      const imgEl = container.querySelector('img')
      const timeEl = container.querySelector('time')
      return {
        url: anchor?.getAttribute('href') || '',
        title: titleEl?.getAttribute('alt') || titleEl?.textContent || '',
        price: priceEl?.textContent || '',
        image: imgEl?.getAttribute('src') || '',
        publishedAt: timeEl?.getAttribute('datetime') || '',
        itemId:
          anchor?.getAttribute('href')?.match(/\/item\/([^/?#]+)/)?.[1] ||
          container.getAttribute('data-item-id') ||
          '',
      }
    }),
  )

const defaultUserAgent =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'

export const createScraperEngine = async (options = {}) => {
  const browser = await chromium.launch({ headless: options.headless ?? true })
  const context = await browser.newContext({
    locale: 'ja-JP',
    userAgent: options.userAgent || defaultUserAgent,
  })

  const scrapeOne = async (source, sourceOptions = {}) => {
    const sourceUrl = source?.url
    if (!sourceUrl) {
      throw new ScrapeError('INVALID_INPUT', 'source.url is required')
    }

    const timeoutMs = sourceOptions.timeoutMs ?? options.timeoutMs ?? 12000
    const retries = sourceOptions.retries ?? options.retries ?? 0
    let lastError = null

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const page = await context.newPage()
      try {
        await page.goto(sourceUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
        await page.waitForSelector(READY_SELECTOR, { timeout: Math.min(timeoutMs, 5000) }).catch(() => {})
        const rawItems = await scrapeCards(page, sourceUrl)
        const normalized = rawItems.map((it) => normalizeItem(it, source.id))
        const valid = normalized.filter((it) => it.url && it.item_id)
        return dedupeItems(valid)
      } catch (error) {
        lastError = error
      } finally {
        await page.close().catch(() => {})
      }
    }

    throw new ScrapeError('SCRAPE_FAILED', `scrape failed for ${sourceUrl}`, lastError)
  }

  return {
    scrapeOne,
    close: async () => {
      await context.close().catch(() => {})
      await browser.close().catch(() => {})
    },
  }
}

export const scrapeSource = async (source, options = {}) => {
  const engine = await createScraperEngine(options)
  try {
    return await engine.scrapeOne(source, options)
  } finally {
    await engine.close()
  }
}
