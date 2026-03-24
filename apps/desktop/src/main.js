const API_BASE = 'http://localhost:2999'
const mode = new URLSearchParams(window.location.search).get('mode') || 'main'
const app = document.getElementById('app')
const EXPANDED_MIN_WIDTH = 320
const AUTO_COLLAPSE_MS = 5000

document.body.dataset.mode = mode

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
  return res.json()
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

  const refresh = async () => {
    try {
      const [status, sources, items] = await Promise.all([
        request('/api/status'),
        request('/api/sources'),
        request('/api/items?limit=24'),
      ])
      statusLine.textContent = `状态：${status.state} | 上次：${formatHms(status.last_run_at)} | 下次：${formatHms(status.next_run_at)}`
      renderSources(sources)
      renderItems(items)
    } catch (error) {
      statusLine.textContent = `离线：${error.message}`
    }
  }

  document.getElementById('run-now')?.addEventListener('click', async () => {
    await request('/api/scrape/run', { method: 'POST' })
    await refresh()
  })
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


  const getWidgetHeightFromDom = () => {
    const shellHeight = shellEl?.getBoundingClientRect().height || 66
    if (!rootEl?.classList.contains('has-feed')) return Math.ceil(shellHeight)
    const feedHeight = Math.min(feedEl?.scrollHeight || 0, 280)
    const gap = 8
    return Math.ceil(shellHeight + gap + feedHeight)
  }

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
    await resizeWidget(Math.max(EXPANDED_MIN_WIDTH, expandedWidth), 66)
    await new Promise((resolve) => requestAnimationFrame(resolve))
    await resizeWidgetHeight(getWidgetHeightFromDom())
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
    requestAnimationFrame(() => {
      resizeWidgetHeight(getWidgetHeightFromDom())
    })
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
    } catch (_) {
      statusEl.textContent = '离线'
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
  syncStatus()
  setInterval(syncStatus, 4000)
  setInterval(refreshDock, 1500)
}

if (mode === 'widget') createWidgetView()
else createMainView()
