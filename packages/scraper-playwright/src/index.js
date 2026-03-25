import { chromium } from 'playwright'

const CARD_SELECTOR = 'li[data-testid="item-cell"], div[data-testid="item-cell"], a[href*="/item/"]'
const READY_SELECTOR = '[data-testid="item-cell"], a[href*="/item/"]'
const SEARCH_TOP_BODY = '[data-location="search_top:body"]'

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

const userAgentPool = [
  defaultUserAgent,
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
]

const viewportPool = [
  { width: 1280, height: 720 },
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1536, height: 864 },
]

const pickRandom = (list) => list[Math.floor(Math.random() * list.length)]

/** 用于判断「是否已在目标页」：忽略 hash，主机小写、去 www */
const urlKey = (href) => {
  try {
    const u = new URL(href)
    if (u.protocol === 'about:' || u.protocol === 'chrome:') return ''
    u.hash = ''
    const host = u.hostname.toLowerCase().replace(/^www\./, '')
    return `${host}${u.pathname}${u.search}`
  } catch {
    return ''
  }
}

const pooledPageKey = (source) => {
  if (source?.id != null && String(source.id).length > 0) return `id:${source.id}`
  return `url:${urlKey(source?.url || '')}`
}

const isMercariSearchUrl = (raw) => {
  try {
    const u = new URL(raw)
    if (!u.hostname.includes('mercari.com')) return false
    return u.pathname === '/search' || u.pathname.startsWith('/search')
  } catch {
    return false
  }
}

const buildContextOptions = (options, { rotateProfile } = {}) => {
  const ua =
    options.userAgent ||
    (rotateProfile ? pickRandom(userAgentPool) : defaultUserAgent)
  const viewport =
    rotateProfile && !options.viewport ? pickRandom(viewportPool) : options.viewport || { width: 1280, height: 720 }
  return {
    locale: options.locale || 'ja-JP',
    timezoneId: options.timezoneId || 'Asia/Tokyo',
    userAgent: ua,
    viewport,
    ...(options.extraHTTPHeaders ? { extraHTTPHeaders: options.extraHTTPHeaders } : {}),
  }
}

/** 降低 headless 与 headed 行为差（站点常根据 webdriver / automation 标记拦截无头） */
const attachContextStealth = async (context) => {
  await context.addInitScript(() => {
    try {
      Object.defineProperty(navigator, 'webdriver', {
        configurable: true,
        get: () => undefined,
      })
    } catch {
      /* ignore */
    }
  })
}

const buildChromiumLaunchOptions = (options) => {
  const headless = options.headless ?? true
  const launchOpts = {
    headless,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
    ],
  }
  if (Array.isArray(options.chromiumArgs) && options.chromiumArgs.length > 0) {
    launchOpts.args.push(...options.chromiumArgs)
  }
  if (options.proxyServer) {
    launchOpts.proxy = { server: options.proxyServer }
  }
  if (typeof options.slowMo === 'number' && options.slowMo > 0) {
    launchOpts.slowMo = options.slowMo
  }
  const ch = typeof options.channel === 'string' ? options.channel.trim() : ''
  if (ch) {
    launchOpts.channel = ch
  }
  return launchOpts
}

const waitForListReady = async (page, timeoutMs) => {
  await page.waitForSelector(READY_SELECTOR, { timeout: Math.min(timeoutMs, 25000) }).catch(() => {})
}

const countCards = async (page) => page.locator(CARD_SELECTOR).count().catch(() => 0)

/**
 * Mercari 搜索顶栏：把当前标签页提到最前，再用 Playwright 真实点击（有头模式下可见），避免仅用 evaluate 脚本点击导致「像没切换、没点」。
 * @returns {Promise<boolean>} 是否成功执行 click
 */
const tryMercariSearchTopRefresh = async (page, timeoutMs) => {
  const waitTop = Math.min(8000, timeoutMs)
  await page.bringToFront().catch(() => {})
  try {
    const btn = page.locator(SEARCH_TOP_BODY).locator('button').first()
    await btn.waitFor({ state: 'visible', timeout: waitTop })
    await btn.scrollIntoViewIfNeeded().catch(() => {})
    await btn.click({ timeout: waitTop })
    return true
  } catch {
    return false
  }
}

/**
 * 首轮或 URL 变化：goto；同 URL 时 Mercari 搜索页优先顶栏按钮刷新，失败则 reload。
 */
const navigateForScrape = async (page, sourceUrl, timeoutMs, { softMercariRefresh }) => {
  await page.bringToFront().catch(() => {})

  const want = urlKey(sourceUrl)
  const have = urlKey(page.url())
  const isBlank = !have || page.url() === 'about:blank'

  if (isBlank || have !== want) {
    await page.goto(sourceUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
    await waitForListReady(page, timeoutMs)
    return
  }

  const useSoft = softMercariRefresh && isMercariSearchUrl(sourceUrl)
  if (useSoft) {
    const clicked = await tryMercariSearchTopRefresh(page, timeoutMs)
    if (clicked) {
      await waitForListReady(page, timeoutMs)
      if ((await countCards(page)) > 0) return
    }
  }

  await page.reload({ waitUntil: 'domcontentloaded', timeout: timeoutMs })
  await waitForListReady(page, timeoutMs)
}

export const createScraperEngine = async (options = {}) => {
  const browser = await chromium.launch(buildChromiumLaunchOptions(options))

  if (typeof options.onBrowserDisconnected === 'function') {
    browser.on('disconnected', () => {
      try {
        options.onBrowserDisconnected()
      } catch {
        /* ignore */
      }
    })
  }

  const freshContextPerScrape = Boolean(options.freshContextPerScrape)
  const softMercariRefresh = options.softMercariRefresh !== false

  let sharedContext = null
  if (!freshContextPerScrape) {
    sharedContext = await browser.newContext(buildContextOptions(options, { rotateProfile: false }))
    await attachContextStealth(sharedContext)
  }

  /** 共享 Context 下每个监控源一个 Page */
  const pageBySourceKey = new Map()

  const getOrCreatePooledPage = async (context, source) => {
    const key = pooledPageKey(source)
    let page = pageBySourceKey.get(key)
    if (!page || page.isClosed()) {
      page = await context.newPage()
      pageBySourceKey.set(key, page)
    }
    return { key, page }
  }

  const handlePooledPageError = async (key, page) => {
    await page.close().catch(() => {})
    pageBySourceKey.delete(key)
  }

  /** 仅切换/导航/点搜索刷新，不读列表（阶段一） */
  const refreshOnlyPooledPage = async (context, source, sourceUrl, timeoutMs, softFlag) => {
    const { key, page } = await getOrCreatePooledPage(context, source)
    try {
      await navigateForScrape(page, sourceUrl, timeoutMs, { softMercariRefresh: softFlag })
    } catch (error) {
      await handlePooledPageError(key, page)
      throw error
    }
  }

  /** 在已有标签上等待列表就绪并抓取卡片（阶段二） */
  const readOnlyPooledPage = async (source, sourceUrl, timeoutMs) => {
    const key = pooledPageKey(source)
    const page = pageBySourceKey.get(key)
    if (!page || page.isClosed()) {
      throw new ScrapeError('NO_TAB', `no browser tab for source ${source?.id}; refresh pass failed or missing`)
    }
    await page.bringToFront().catch(() => {})
    await waitForListReady(page, timeoutMs)
    const rawItems = await scrapeCards(page, sourceUrl)
    const normalized = rawItems.map((it) => normalizeItem(it, source.id))
    const valid = normalized.filter((it) => it.url && it.item_id)
    return dedupeItems(valid)
  }

  const scrapeWithPooledPage = async (context, source, sourceUrl, timeoutMs, softFlag) => {
    const { key, page } = await getOrCreatePooledPage(context, source)
    try {
      await navigateForScrape(page, sourceUrl, timeoutMs, { softMercariRefresh: softFlag })
      const rawItems = await scrapeCards(page, sourceUrl)
      const normalized = rawItems.map((it) => normalizeItem(it, source.id))
      const valid = normalized.filter((it) => it.url && it.item_id)
      return dedupeItems(valid)
    } catch (error) {
      await handlePooledPageError(key, page)
      throw error
    }
  }

  const scrapeOne = async (source, sourceOptions = {}) => {
    const sourceUrl = source?.url
    if (!sourceUrl) {
      throw new ScrapeError('INVALID_INPUT', 'source.url is required')
    }

    const timeoutMs = sourceOptions.timeoutMs ?? options.timeoutMs ?? 30000
    const retries = sourceOptions.retries ?? options.retries ?? 0
    const soft =
      sourceOptions.softMercariRefresh !== undefined
        ? sourceOptions.softMercariRefresh !== false
        : softMercariRefresh
    let lastError = null

    const runInEphemeralContext = async (context) => {
      const page = await context.newPage()
      try {
        await navigateForScrape(page, sourceUrl, timeoutMs, { softMercariRefresh: soft })
        const rawItems = await scrapeCards(page, sourceUrl)
        const normalized = rawItems.map((it) => normalizeItem(it, source.id))
        const valid = normalized.filter((it) => it.url && it.item_id)
        return dedupeItems(valid)
      } finally {
        await page.close().catch(() => {})
      }
    }

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (freshContextPerScrape) {
        const ctx = await browser.newContext(
          buildContextOptions(options, { rotateProfile: true }),
        )
        await attachContextStealth(ctx)
        try {
          return await runInEphemeralContext(ctx)
        } catch (error) {
          lastError = error
        } finally {
          await ctx.close().catch(() => {})
        }
      } else {
        try {
          return await scrapeWithPooledPage(sharedContext, source, sourceUrl, timeoutMs, soft)
        } catch (error) {
          lastError = error
        }
      }
    }

    throw new ScrapeError('SCRAPE_FAILED', `scrape failed for ${sourceUrl}`, lastError)
  }

  const refreshSource = async (source, sourceOptions = {}) => {
    if (freshContextPerScrape) {
      throw new ScrapeError('UNSUPPORTED', 'refreshSource requires shared context (SCRAPE_FRESH_CONTEXT=0)')
    }
    const sourceUrl = source?.url
    if (!sourceUrl) {
      throw new ScrapeError('INVALID_INPUT', 'source.url is required')
    }
    const timeoutMs = sourceOptions.timeoutMs ?? options.timeoutMs ?? 30000
    const soft =
      sourceOptions.softMercariRefresh !== undefined
        ? sourceOptions.softMercariRefresh !== false
        : softMercariRefresh
    await refreshOnlyPooledPage(sharedContext, source, sourceUrl, timeoutMs, soft)
  }

  const readSourceList = async (source, sourceOptions = {}) => {
    if (freshContextPerScrape) {
      throw new ScrapeError('UNSUPPORTED', 'readSourceList requires shared context (SCRAPE_FRESH_CONTEXT=0)')
    }
    const sourceUrl = source?.url
    if (!sourceUrl) {
      throw new ScrapeError('INVALID_INPUT', 'source.url is required')
    }
    const timeoutMs = sourceOptions.timeoutMs ?? options.timeoutMs ?? 30000
    return readOnlyPooledPage(source, sourceUrl, timeoutMs)
  }

  const pruneSourcePages = async (activeSourceIds) => {
    if (!activeSourceIds || !(activeSourceIds instanceof Set)) return
    for (const key of [...pageBySourceKey.keys()]) {
      if (!key.startsWith('id:')) continue
      const id = key.slice(3)
      if (activeSourceIds.has(id)) continue
      const page = pageBySourceKey.get(key)
      await page?.close().catch(() => {})
      pageBySourceKey.delete(key)
    }
  }

  const closeAllPooledPages = async () => {
    for (const page of pageBySourceKey.values()) {
      await page.close().catch(() => {})
    }
    pageBySourceKey.clear()
  }

  return {
    scrapeOne,
    refreshSource,
    readSourceList,
    pruneSourcePages,
    close: async () => {
      await closeAllPooledPages()
      await sharedContext?.close().catch(() => {})
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
