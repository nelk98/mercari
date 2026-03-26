const API_BASE = 'http://localhost:2999'
const mode = new URLSearchParams(window.location.search).get('mode') || 'main'
const app = document.getElementById('app')
const EXPANDED_MIN_WIDTH = 320
const AUTO_COLLAPSE_MS = 5000

document.body.dataset.mode = mode

/** 定时抓取暂停时用灰阶 favicon，与托盘/窗口图标一致 */
const setFaviconForSchedule = (scheduleActive) => {
  const link = document.querySelector('link[rel="icon"]')
  if (!link) return
  const href = scheduleActive ? '/assets/logo.svg' : '/assets/logo-mono.svg'
  if (link.getAttribute('href') !== href) {
    link.setAttribute('href', href)
  }
}

const invoke = (cmd, payload = {}) => window.__TAURI__?.core?.invoke?.(cmd, payload).catch(() => {})
const invokeResult = (cmd, payload = {}) => window.__TAURI__?.core?.invoke?.(cmd, payload).catch(() => null)

const formatHms = (input) => {
  if (!input) return '--'
  const date = new Date(input)
  if (Number.isNaN(date.getTime())) return '--'
  const pad = (v) => String(v).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

const formatAge = (input) => {
  if (!input) return '--'
  const ts = Date.parse(input)
  if (Number.isNaN(ts)) return '--'
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (diffSec < 60) return `${diffSec}秒前`
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}分钟前`
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}小时前`
  return `${Math.floor(diffSec / 86400)}天前`
}

const escHtml = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;')

const formatLogAt = (iso) => {
  if (!iso) return '--'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return escHtml(String(iso))
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

const scrapeLogStatusUi = (status) => {
  if (status === 'ok') return { text: '成功', cls: 'ok' }
  if (status === 'error') return { text: '失败', cls: 'error' }
  if (status === 'skipped') return { text: '跳过', cls: 'skipped' }
  return { text: escHtml(status || '—'), cls: '' }
}

const copyToClipboard = async (text) => {
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
    return
  } catch (_) {
    // fallback below
  }
  const input = document.createElement('textarea')
  input.value = text
  document.body.appendChild(input)
  input.select()
  document.execCommand('copy')
  input.remove()
}

const openItemUrl = async (url) => {
  if (!url) return
  await copyToClipboard(url)
  const opener = window.__TAURI__?.opener
  if (opener?.openUrl) {
    await opener.openUrl(url).catch(() => {})
    return
  }
  if (opener?.open) {
    await opener.open(url).catch(() => {})
    return
  }
  const opened = window.open(url, '_blank')
  if (!opened) {
    window.location.href = url
  }
}

const request = async (url, options = {}) => {
  const res = await fetch(`${API_BASE}${url}`, options)
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.error || `${res.status}`)
  }
  if (res.status === 204) return null
  return res.json().catch(() => ({}))
}

/** 订阅服务端 SSE：每完成一个监控源或整轮结束即通知（Tauri 跨源下可能不可用，故配合轮询） */
const connectScrapeEvents = (onNotify) => {
  try {
    const es = new EventSource(`${API_BASE}/api/events`)
    const bump = () => {
      void onNotify()
    }
    es.addEventListener('scrape_progress', bump)
    es.addEventListener('scrape_complete', bump)
    es.addEventListener('scrape_error', bump)
    es.addEventListener('scrape_skipped', bump)
    es.addEventListener('schedule_state', (ev) => {
      void onNotify()
      try {
        const d = JSON.parse(ev.data || '{}')
        if (typeof d.scheduled === 'boolean') {
          setFaviconForSchedule(d.scheduled)
          invoke('set_schedule_icon_state', { scheduled: d.scheduled })
        }
      } catch (_) {}
    })
    es.addEventListener('playwright_browser_closed', bump)
    es.onerror = () => {}
    return () => es.close()
  } catch (_) {
    return () => {}
  }
}

/** POST 抓取后服务端异步启动，补几次短间隔刷新以尽快进入 running 并拉到首批商品 */
const scheduleDenseRefreshes = (fn, delaysMs = [0, 80, 200, 450, 900, 1600]) => {
  for (const ms of delaysMs) {
    setTimeout(() => void fn(), ms)
  }
}

const createMainView = () => {
  const tpl = document.getElementById('main-template')
  app.innerHTML = ''
  app.appendChild(tpl.content.cloneNode(true))

  const statusLine = document.getElementById('status-line')
  const sourcesEl = document.getElementById('sources')
  const itemsEl = document.getElementById('items')
  const nameInput = document.getElementById('source-name')
  const urlInput = document.getElementById('source-url')
  const logDayInput = document.getElementById('log-day')
  const logHintEl = document.getElementById('log-hint')
  const logBodyEl = document.getElementById('log-body')

  const todayStr = new Date().toISOString().slice(0, 10)
  if (logDayInput && !logDayInput.value) logDayInput.value = todayStr

  const renderScrapeLogs = (logs = []) => {
    if (!logBodyEl) return
    if (!logs.length) {
      logBodyEl.innerHTML = '<tr><td colspan="7">暂无记录</td></tr>'
      return
    }
    logBodyEl.innerHTML = logs
      .map((row) => {
        const st = scrapeLogStatusUi(row.status)
        const time = formatLogAt(row.at)
        const url = escHtml(row.url || '')
        const err = escHtml(row.error || '')
        const dur = row.duration_ms != null ? `${Number(row.duration_ms)} ms` : '—'
        const ins = row.inserted ?? 0
        const cnt = row.item_count ?? 0
        return `<tr>
          <td class="col-time">${time}</td>
          <td><span class="log-status ${st.cls}">${st.text}</span></td>
          <td class="col-num">${ins}</td>
          <td class="col-num">${cnt}</td>
          <td class="col-num">${dur}</td>
          <td class="col-url" title="${url}">${url}</td>
          <td class="col-err">${err || '—'}</td>
        </tr>`
      })
      .join('')
  }

  let lastLogFetchAt = 0
  const loadScrapeLogs = async (force = false) => {
    if (!logDayInput || !logBodyEl) return
    if (!force && Date.now() - lastLogFetchAt < 1400) return
    lastLogFetchAt = Date.now()
    const day = logDayInput.value || todayStr
    try {
      const q = new URLSearchParams({ day, limit: '200' })
      const data = await request(`/api/scrape/logs?${q}`)
      renderScrapeLogs(data.logs || [])
      if (logHintEl) {
        logHintEl.textContent = `当日 ${data.day || day} · 共 ${(data.logs || []).length} 条（本地文件，不入库 Git）`
      }
    } catch (e) {
      if (logHintEl) logHintEl.textContent = `日志加载失败：${e.message}`
      renderScrapeLogs([])
    }
  }

  const renderSources = (sources = []) => {
    sourcesEl.innerHTML = ''
    if (!sources.length) {
      sourcesEl.innerHTML = '<div class="row"><p>暂无监控源</p></div>'
      return
    }
    for (const source of sources) {
      const el = document.createElement('div')
      el.className = 'row'
      el.innerHTML = `
        <h3>${source.name || `源 #${source.id}`}</h3>
        <p>${source.url}</p>
        <p>${source.enabled === 1 ? '已启用' : '已暂停'}</p>
        <div class="actions">
          <button class="btn ghost" data-action="toggle">${source.enabled === 1 ? '暂停' : '启用'}</button>
          <button class="btn ghost" data-action="delete">删除</button>
        </div>
      `
      el.querySelector('[data-action="toggle"]')?.addEventListener('click', async () => {
        await request(`/api/sources/${source.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: source.enabled !== 1 }),
        })
        await refresh()
      })
      el.querySelector('[data-action="delete"]')?.addEventListener('click', async () => {
        await request(`/api/sources/${source.id}`, { method: 'DELETE' })
        await refresh()
      })
      sourcesEl.appendChild(el)
    }
  }

  const renderItems = (items = []) => {
    itemsEl.innerHTML = ''
    if (!items.length) {
      itemsEl.innerHTML = '<div class="row"><p>暂无商品数据</p></div>'
      return
    }
    for (const item of items) {
      const el = document.createElement('div')
      el.className = 'row'
      el.innerHTML = `<h3>${item.title || '无标题'}</h3><p>${item.price || '价格未知'}</p><p>${item.url}</p>`
      el.addEventListener('click', async () => {
        await openItemUrl(item.url)
      })
      itemsEl.appendChild(el)
    }
  }

  let mainScrapePollTimer = null
  const stopMainScrapePoll = () => {
    if (mainScrapePollTimer != null) {
      clearInterval(mainScrapePollTimer)
      mainScrapePollTimer = null
    }
  }

  const refresh = async () => {
    try {
      const [status, sources, items] = await Promise.all([
        request('/api/status'),
        request('/api/sources'),
        request('/api/items?limit=24'),
      ])
      statusLine.textContent = `状态：${status.state} | 上次：${formatHms(status.last_run_at)} | 下次：${formatHms(status.next_run_at)}`
      setFaviconForSchedule(status.schedule_active !== false)
      renderSources(sources)
      renderItems(items)
      if (status.state === 'running') {
        if (mainScrapePollTimer == null) {
          mainScrapePollTimer = setInterval(() => void refresh(), 400)
        }
      } else {
        stopMainScrapePoll()
      }
    } catch (error) {
      statusLine.textContent = `离线：${error.message}`
      stopMainScrapePoll()
    }
    void loadScrapeLogs(false)
  }

  document.getElementById('run-now')?.addEventListener('click', async () => {
    await request('/api/scrape/run', { method: 'POST' })
    scheduleDenseRefreshes(refresh)
    await refresh()
  })

  connectScrapeEvents(refresh)
  document.getElementById('to-widget')?.addEventListener('click', () => invoke('show_widget'))
  document.getElementById('source-add')?.addEventListener('click', async () => {
    await request('/api/sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: nameInput.value, url: urlInput.value }),
    })
    nameInput.value = ''
    urlInput.value = ''
    await refresh()
  })

  logDayInput?.addEventListener('change', () => void loadScrapeLogs(true))
  document.getElementById('log-refresh')?.addEventListener('click', () => void loadScrapeLogs(true))

  refresh()
  setInterval(refresh, 5000)
}

const createWidgetView = () => {
  const tpl = document.getElementById('widget-template')
  app.innerHTML = ''
  app.appendChild(tpl.content.cloneNode(true))

  const shellEl = document.getElementById('widget-shell')
  const rootEl = document.querySelector('.widget-root')
  const feedEl = document.getElementById('widget-feed')
  const statusEl = document.getElementById('widget-status')
  const clearBtn = document.getElementById('widget-clear')
  let unreadItems = []
  let isCollapsed = true
  let expandedWidth = 420
  let collapseTimer = null
  let isHovered = false
  let dockVertical = 'bottom'
  let dockHorizontal = 'right'
  const applyDockClass = () => {
    if (!rootEl) return
    rootEl.classList.toggle('dock-top', dockVertical === 'top')
    rootEl.classList.toggle('dock-bottom', dockVertical !== 'top')
  }

  const refreshDock = async () => {
    const dock = await invokeResult('get_widget_dock')
    if (dock?.vertical) dockVertical = dock.vertical
    if (dock?.horizontal) dockHorizontal = dock.horizontal
    applyDockClass()
  }

  const resizeWidget = (width, height) =>
    invokeResult('resize_widget', {
      width,
      height,
      anchorVertical: dockVertical,
      anchorHorizontal: dockHorizontal,
    })

  const resizeWidgetHeight = (height) =>
    invokeResult('resize_widget_height', {
      height,
      anchorVertical: dockVertical,
      anchorHorizontal: dockHorizontal,
    })


  const WIDGET_ROOT_GAP = 8
  const WIDGET_GRID_GAP = 6
  const WIDGET_COLS = 2
  const SCREEN_HEIGHT_CAP = 0.8

  const getMaxWindowHeightPx = () =>
    Math.max(160, Math.floor((window.screen?.availHeight || window.innerHeight) * SCREEN_HEIGHT_CAP))

  /** 商品区最大高度：整体窗口不超过屏高 80%，减去 toolbar 与间距 */
  const getMaxFeedHeightPx = () => {
    const shellHeight = shellEl?.getBoundingClientRect().height || 66
    return Math.max(100, getMaxWindowHeightPx() - shellHeight - WIDGET_ROOT_GAP)
  }

  const applyFeedMaxHeightVar = () => {
    rootEl?.style.setProperty('--widget-feed-max', `${getMaxFeedHeightPx()}px`)
  }

  /** 按商品数量与窗口宽度估算所需窗口高度（避免先压成 66px 再量，导致数秒内网格堆叠） */
  const estimateWindowHeightForItems = (itemCount, widthLogical) => {
    const shellH = shellEl?.getBoundingClientRect().height || 66
    if (itemCount <= 0) return Math.ceil(shellH)
    const maxFeed = getMaxFeedHeightPx()
    const rows = Math.ceil(itemCount / WIDGET_COLS)
    const colW = (widthLogical - WIDGET_GRID_GAP) / WIDGET_COLS
    const rowH = colW
    const feedContentH = rows * rowH + Math.max(0, rows - 1) * WIDGET_GRID_GAP
    const feedH = Math.min(feedContentH, maxFeed)
    const h = Math.ceil(shellH + WIDGET_ROOT_GAP + feedH) + 2
    return Math.min(h, getMaxWindowHeightPx())
  }

  const getWidgetHeightFromDom = () => {
    const shellHeight = shellEl?.getBoundingClientRect().height || 66
    if (!rootEl?.classList.contains('has-feed')) {
      return Math.min(Math.ceil(shellHeight), getMaxWindowHeightPx())
    }
    const feedCap = getMaxFeedHeightPx()
    const feedHeight = Math.min(feedEl?.scrollHeight || 0, feedCap)
    const h = Math.ceil(shellHeight + WIDGET_ROOT_GAP + feedHeight) + 2
    return Math.min(h, getMaxWindowHeightPx())
  }

  const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve))

  /** 与亚像素/舍入抖动区分，小于此差值不再调 Tauri 改窗口高度 */
  const WIDGET_HEIGHT_COMMIT_EPS = 6
  let lastCommittedWidgetHeight = null
  let fitWidgetGeneration = 0

  const resetWidgetSizeTracking = () => {
    lastCommittedWidgetHeight = null
    fitWidgetGeneration += 1
  }

  /** 强制同步布局后再读高度 */
  const flushLayoutAndWidgetHeight = () => {
    void rootEl?.offsetHeight
    void feedEl?.offsetWidth
    void feedEl?.offsetHeight
    return getWidgetHeightFromDom()
  }

  const syncWidgetWindowToContent = async () => {
    if (isCollapsed) return
    const h = flushLayoutAndWidgetHeight()
    if (
      lastCommittedWidgetHeight != null &&
      Math.abs(h - lastCommittedWidgetHeight) < WIDGET_HEIGHT_COMMIT_EPS
    ) {
      return
    }
    lastCommittedWidgetHeight = h
    await resizeWidgetHeight(h)
  }

  /** 一次设定宽度与足够的高度（公式 + DOM 微调），展开态专用 */
  const fitWidgetWindow = async () => {
    if (isCollapsed) return
    const gen = (fitWidgetGeneration += 1)
    applyFeedMaxHeightVar()
    const w = Math.max(EXPANDED_MIN_WIDTH, expandedWidth)
    const n = unreadItems.length
    const h = estimateWindowHeightForItems(n, w)
    await resizeWidget(w, h)
    if (gen !== fitWidgetGeneration) return
    await nextFrame()
    await nextFrame()
    if (gen !== fitWidgetGeneration) return
    await syncWidgetWindowToContent()
  }

  /** 仅屏/视口变化时重算上限与高度，禁止再调 fitWidget（否则会与 Tauri 改窗尺寸形成 resize 回路抖动） */
  let viewportResizeTimer = null
  window.addEventListener('resize', () => {
    if (isCollapsed) return
    if (viewportResizeTimer != null) clearTimeout(viewportResizeTimer)
    viewportResizeTimer = setTimeout(() => {
      viewportResizeTimer = null
      applyFeedMaxHeightVar()
      void syncWidgetWindowToContent()
    }, 200)
  })

  const clearCollapseTimer = () => {
    if (!collapseTimer) return
    clearTimeout(collapseTimer)
    collapseTimer = null
  }

  const scheduleAutoCollapse = () => {
    clearCollapseTimer()
    if (isCollapsed) return
    if (unreadItems.length > 0) return
    if (isHovered) return
    collapseTimer = setTimeout(() => {
      collapseWidget()
    }, AUTO_COLLAPSE_MS)
  }

  const collapseWidget = async () => {
    if (isCollapsed) return
    const size = await invokeResult('get_widget_size')
    if (size?.width) {
      expandedWidth = Math.max(EXPANDED_MIN_WIDTH, size.width)
    }
    resetWidgetSizeTracking()
    isCollapsed = true
    await invokeResult('hide_widget')
    refreshDock()
    clearCollapseTimer()
  }

  const expandWidget = async () => {
    if (!isCollapsed) {
      scheduleAutoCollapse()
      return
    }
    isCollapsed = false
    await invokeResult('show_widget')
    await fitWidgetWindow()
    invoke('sync_widget_position')
    refreshDock()
    scheduleAutoCollapse()
  }

  const renderUnreadList = () => {
    feedEl.innerHTML = ''
    if (unreadItems.length === 0) {
      shellEl.classList.remove('has-unread')
      rootEl?.classList.remove('has-feed')
      if (clearBtn) clearBtn.disabled = true
      if (!isCollapsed) {
        resetWidgetSizeTracking()
        lastCommittedWidgetHeight = 66
        resizeWidgetHeight(66)
      }
      scheduleAutoCollapse()
      return
    }

    shellEl.classList.add('has-unread')
    rootEl?.classList.add('has-feed')
    if (clearBtn) clearBtn.disabled = false
    for (const item of unreadItems) {
      const row = document.createElement('article')
      row.className = 'widget-item'
      const timeText = formatAge(item.first_seen_at || item.created_at || item.published_at)
      const priceText = item.price || '价格未知'

      row.innerHTML = `
        <div class="widget-item-thumb">
          <span class="widget-item-meta">${priceText} <small>${timeText}</small></span>
        </div>
      `
      const thumbEl = row.querySelector('.widget-item-thumb')
      const titleEl = document.createElement('span')
      titleEl.className = 'widget-item-title'
      titleEl.textContent = item.title || '无标题'
      thumbEl.prepend(titleEl)
      if (item.image) {
        thumbEl.style.backgroundImage = `url(${item.image})`
      }
      row.addEventListener('click', async (event) => {
        event.stopPropagation()
        await openItemUrl(item.url)
      })
      feedEl.appendChild(row)
    }
    if (isCollapsed) {
      expandWidget()
      return
    }
    applyFeedMaxHeightVar()
    void fitWidgetWindow()
    clearCollapseTimer()
  }

  const markAllRead = () => {
    return request('/api/items/mark-read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ all: true }),
    }).then(() => {
      unreadItems = []
      renderUnreadList()
      collapseWidget()
    })
  }

  const bindLongPressDrag = (el, { allowButtons = false } = {}) => {
    if (!el) return
    let timer = null
    let longPressed = false

    const clear = () => {
      if (!timer) return
      clearTimeout(timer)
      timer = null
    }

    el.addEventListener('mousedown', (event) => {
      if (!allowButtons && event.target.closest('button')) return
      longPressed = false
      timer = setTimeout(() => {
        longPressed = true
        invoke('start_dragging', { label: 'widget' })
      }, 180)
    })

    el.addEventListener('mouseup', clear)
    el.addEventListener('mouseleave', clear)
    el.addEventListener('mousemove', (event) => {
      if (!timer) return
      if (Math.abs(event.movementX) > 3 || Math.abs(event.movementY) > 3) {
        clear()
      }
    })

    return () => longPressed
  }

  let widgetScrapePollTimer = null
  const stopWidgetScrapePoll = () => {
    if (widgetScrapePollTimer != null) {
      clearInterval(widgetScrapePollTimer)
      widgetScrapePollTimer = null
    }
  }

  const syncStatus = async () => {
    try {
      const [data, items] = await Promise.all([
        request('/api/status'),
        request('/api/items?limit=40&widget=1&unread=1&recent_minutes=360'),
      ])

      unreadItems = Array.isArray(items) ? items : []
      renderUnreadList()

      const unreadCountText = unreadItems.length > 0 ? `上新 ${unreadItems.length} 条` : '暂无未读'
      statusEl.textContent = `${data.state === 'online' ? '在线' : '更新中'} · ${formatHms(data.last_run_at)} · ${unreadCountText}`
      setFaviconForSchedule(data.schedule_active !== false)

      if (data.state === 'running') {
        if (widgetScrapePollTimer == null) {
          widgetScrapePollTimer = setInterval(() => void syncStatus(), 400)
        }
      } else {
        stopWidgetScrapePoll()
      }
    } catch (_) {
      statusEl.textContent = '离线'
      stopWidgetScrapePoll()
    }
  }

  document.getElementById('widget-open-main')?.addEventListener('click', () => {
    scheduleAutoCollapse()
    invoke('show_main')
  })
  clearBtn?.addEventListener('click', () => {
    markAllRead().then(() => syncStatus())
  })
  document.getElementById('widget-refresh')?.addEventListener('click', async () => {
    await request('/api/scrape/run', { method: 'POST' })
    scheduleDenseRefreshes(syncStatus)
    await syncStatus()
    scheduleAutoCollapse()
  })
  bindLongPressDrag(shellEl, { allowButtons: false })
  rootEl?.addEventListener('mouseenter', () => {
    isHovered = true
    clearCollapseTimer()
  })
  rootEl?.addEventListener('mouseleave', () => {
    isHovered = false
    scheduleAutoCollapse()
  })
  rootEl?.addEventListener('mousemove', () => {
    if (!isCollapsed) scheduleAutoCollapse()
  })
  rootEl?.addEventListener('click', () => {
    if (!isCollapsed) scheduleAutoCollapse()
  })

  window.__TAURI__?.event?.listen?.('mark-read-shortcut', () => {
    markAllRead().then(() => syncStatus())
  })

  window.addEventListener('keydown', (event) => {
    const isShortcut = (event.metaKey || event.ctrlKey) && (event.key === 'd' || event.key === 'D')
    if (!isShortcut) return
    event.preventDefault()
    markAllRead().then(() => syncStatus())
  })

  refreshDock()
  invokeResult('hide_widget')
  connectScrapeEvents(syncStatus)
  syncStatus()
  setInterval(syncStatus, 2500)
  setInterval(refreshDock, 1500)
}

if (mode === 'widget') createWidgetView()
else createMainView()
