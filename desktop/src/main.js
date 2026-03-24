const API_BASE = 'http://localhost:2999'
const mode = new URLSearchParams(window.location.search).get('mode') || 'panel'

document.body.dataset.mode = mode

const appEl = document.getElementById('app')
const listEl = document.getElementById('list')
const sourcesEl = document.getElementById('sources')
const statusEl = document.getElementById('status')
const updatedEl = document.getElementById('updated')
const updatedInlineEl = document.getElementById('updated-inline')
const flashEl = document.getElementById('flash')
const titleWrapEl = document.querySelector('.title-wrap')
const topbarEl = document.querySelector('.topbar')

const refreshBtn = document.getElementById('refresh')
const runOnceBtn = document.getElementById('run-once')
const toggleBtn = document.getElementById('toggle-mode')
const addSourceBtn = document.getElementById('add-source')
const nameInput = document.getElementById('source-name')
const urlInput = document.getElementById('source-url')
const dragIcon = document.getElementById('drag-icon')

const sourceCountEl = document.getElementById('source-count')
const enabledCountEl = document.getElementById('enabled-count')
const itemCountEl = document.getElementById('item-count')
const failureCountEl = document.getElementById('failure-count')

const STATUS_POLL_MS = 1500
const ITEM_POLL_MS = 15000

let nextRefreshAt = null
let cycleKey = ''
let fetchedAfterCycle = false
let hasInitializedSeen = false
let widgetAccumulatedItems = []
let hasNewItemsAlert = false
let latestItems = []
let latestSources = []
let flashTimer = null
let widgetHoldUntilNew = false

const seenItemIds = new Set()
const WIDGET_WIDTH = 280

const getItemKey = (item) => {
  if (!item) return ''
  return item.item_id || item.id || item.url || ''
}

const resizeWindow = async (label, width, height) => {
  if (!window.__TAURI__?.core?.invoke) return
  try {
    await window.__TAURI__.core.invoke('resize_window', { label, width, height })
  } catch (_) {
    // ignore
  }
}

const fmtTime = (date) => {
  const pad = (value) => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

const setUpdatedTime = (value) => {
  if (updatedEl) updatedEl.textContent = value
  if (updatedInlineEl) updatedInlineEl.textContent = value
}

const getAgeText = (createdAt) => {
  if (!createdAt) return ''
  const ts = Date.parse(createdAt)
  if (Number.isNaN(ts)) return ''
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (diffSec < 60) return `${diffSec} 秒前`
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分钟前`
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} 小时前`
  return `${Math.floor(diffSec / 86400)} 天前`
}

const copyToClipboard = async (text) => {
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
    return
  } catch (_) {
    // Fallback for non-secure clipboard contexts.
  }
  const input = document.createElement('textarea')
  input.value = text
  document.body.appendChild(input)
  input.select()
  document.execCommand('copy')
  input.remove()
}

const setFlash = (message = '', type = '') => {
  if (!flashEl) return
  flashEl.textContent = message
  flashEl.dataset.type = type
  flashEl.classList.toggle('visible', Boolean(message))
  if (flashTimer) clearTimeout(flashTimer)
  if (!message) return
  flashTimer = setTimeout(() => {
    flashEl.textContent = ''
    flashEl.dataset.type = ''
    flashEl.classList.remove('visible')
  }, 2800)
}

const setNewItemsAlert = (enabled) => {
  hasNewItemsAlert = enabled
  appEl?.classList.toggle('new-alert', enabled)
  titleWrapEl?.classList.toggle('alert', enabled)
}

const getNewItemsAndUpdateSeen = (items) => {
  const incoming = Array.isArray(items) ? items : []
  const newItems = []

  if (!hasInitializedSeen) {
    for (const item of incoming) {
      const key = getItemKey(item)
      if (key) seenItemIds.add(key)
    }
    hasInitializedSeen = true
    return newItems
  }

  for (const item of incoming) {
    const key = getItemKey(item)
    if (!key) continue
    if (!seenItemIds.has(key)) {
      newItems.push(item)
    }
    seenItemIds.add(key)
  }

  return newItems
}

const prependUniqueItems = (baseItems, newItems) => {
  const merged = [...newItems, ...baseItems]
  const dedup = []
  const seen = new Set()
  for (const item of merged) {
    const key = getItemKey(item)
    if (!key || seen.has(key)) continue
    seen.add(key)
    dedup.push(item)
  }
  return dedup
}

const getEmptyMessage = () => (mode === 'widget' ? '暂无上新商品' : '暂无商品数据')

const renderItems = (items, emptyMessage = getEmptyMessage()) => {
  listEl.innerHTML = ''
  appEl?.classList.toggle('is-empty', items.length === 0)

  if (!items.length) {
    listEl.innerHTML = `<div class="empty">${emptyMessage}</div>`
    if (mode === 'widget') {
      resizeWindow('widget', WIDGET_WIDTH, 84)
    }
    return
  }

  items.forEach((item) => {
    const row = document.createElement('article')
    row.className = mode === 'widget' ? 'row row-widget' : 'row row-panel'

    const img = document.createElement('div')
    img.className = 'thumb'
    if (item.image) img.style.backgroundImage = `url(${item.image})`

    const body = document.createElement('div')
    body.className = 'body'

    const title = document.createElement('div')
    title.className = 'item-title'
    title.textContent = item.title || '无标题'

    const meta = document.createElement('div')
    meta.className = 'meta'
    const ageText = getAgeText(item.created_at || item.published_at)
    meta.textContent = ageText
      ? `${item.price || '价格未知'}  ·  ${ageText}`
      : (item.price || '价格未知')

    body.appendChild(title)
    body.appendChild(meta)

    if (mode !== 'widget') {
      const foot = document.createElement('div')
      foot.className = 'row-foot'

      const sourceTag = document.createElement('span')
      sourceTag.className = 'pill'
      const source = latestSources.find((entry) => entry.id === item.source_id)
      sourceTag.textContent = source?.name || `源 #${item.source_id || '--'}`

      const openHint = document.createElement('span')
      openHint.className = 'open-hint'
      openHint.textContent = '复制并打开'

      foot.appendChild(sourceTag)
      foot.appendChild(openHint)
      body.appendChild(foot)
    }

    row.appendChild(img)
    row.appendChild(body)
    row.addEventListener('click', async () => {
      await copyToClipboard(item.url)
      window.open(item.url, '_blank')
    })

    listEl.appendChild(row)
  })

  if (mode === 'widget') {
    const nextHeight = Math.min(280, 84 + items.length * 66)
    resizeWindow('widget', WIDGET_WIDTH, nextHeight)
  }
}

const renderSources = (sources) => {
  if (!sourcesEl) return

  sourcesEl.innerHTML = ''
  if (!sources.length) {
    sourcesEl.innerHTML = '<div class="empty">暂无监控链接</div>'
    return
  }

  sources.forEach((source) => {
    const row = document.createElement('article')
    row.className = 'source-row'

    const main = document.createElement('div')
    main.className = 'source-main'

    const head = document.createElement('div')
    head.className = 'source-head'

    const title = document.createElement('strong')
    title.textContent = source.name || '未命名'

    const state = document.createElement('span')
    state.className = `source-state ${source.enabled === 1 ? 'active' : 'paused'}`
    state.textContent = source.enabled === 1 ? '启用中' : '已暂停'

    head.appendChild(title)
    head.appendChild(state)

    const link = document.createElement('a')
    link.href = source.url
    link.target = '_blank'
    link.rel = 'noreferrer'
    link.textContent = source.url

    main.appendChild(head)
    main.appendChild(link)

    const actions = document.createElement('div')
    actions.className = 'source-actions'

    const toggle = document.createElement('button')
    toggle.className = 'button ghost small'
    toggle.textContent = source.enabled === 1 ? '暂停' : '启用'
    toggle.addEventListener('click', async () => {
      await updateSource(source.id, { enabled: source.enabled !== 1 })
      setFlash(source.enabled === 1 ? '已暂停该监控' : '已启用该监控', 'ok')
    })

    const remove = document.createElement('button')
    remove.className = 'button danger small'
    remove.textContent = '删除'
    remove.addEventListener('click', async () => {
      await removeSource(source.id)
      setFlash('监控已删除', 'ok')
    })

    actions.appendChild(toggle)
    actions.appendChild(remove)

    row.appendChild(main)
    row.appendChild(actions)
    sourcesEl.appendChild(row)
  })
}

const updateStats = () => {
  const total = latestSources.length
  const enabled = latestSources.filter((source) => source.enabled === 1).length
  if (sourceCountEl) sourceCountEl.textContent = String(total)
  if (enabledCountEl) enabledCountEl.textContent = String(enabled)
  if (itemCountEl) itemCountEl.textContent = String(latestItems.length)
}

const renderCurrentList = (items) => {
  const list = Array.isArray(items) ? items : []
  renderItems(list, getEmptyMessage())
}

const applyWidgetModeData = (incomingItems) => {
  const newItems = getNewItemsAndUpdateSeen(incomingItems)
  if (newItems.length > 0) {
    widgetHoldUntilNew = false
    widgetAccumulatedItems = prependUniqueItems(widgetAccumulatedItems, newItems)
    setNewItemsAlert(true)
  }
  // Keep widget usable even when there are no "new since startup" items.
  // Fallback to latest fetched items so the compact mode always shows products.
  if (widgetAccumulatedItems.length === 0 && !widgetHoldUntilNew) {
    widgetAccumulatedItems = (Array.isArray(incomingItems) ? incomingItems : []).slice(0, 3)
  }
  renderCurrentList(widgetAccumulatedItems)
}

const resetNewItemsAlert = () => {
  setNewItemsAlert(false)
  if (mode === 'widget') {
    hasInitializedSeen = true
    for (const item of latestItems) {
      const key = getItemKey(item)
      if (key) seenItemIds.add(key)
    }
    widgetHoldUntilNew = true
    widgetAccumulatedItems = []
    renderCurrentList(widgetAccumulatedItems)
    resizeWindow('widget', WIDGET_WIDTH, 84)
  }
}

const updateStatusTone = (online) => {
  statusEl?.classList.toggle('offline', !online)
}

const fetchSources = async () => {
  const res = await fetch(`${API_BASE}/api/sources`)
  if (!res.ok) throw new Error('sources fetch failed')
  latestSources = await res.json()
  renderSources(latestSources)
  updateStats()
}

const fetchItems = async () => {
  statusEl.textContent = '更新中...'
  updateStatusTone(true)

  const limit = mode === 'widget' ? 3 : 18
  const res = await fetch(`${API_BASE}/api/items?limit=${limit}`)
  if (!res.ok) throw new Error('items fetch failed')

  const data = await res.json()
  latestItems = Array.isArray(data) ? data : []

  if (mode === 'widget') {
    applyWidgetModeData(latestItems)
  } else {
    const panelNewItems = getNewItemsAndUpdateSeen(latestItems)
    if (panelNewItems.length > 0) {
      setNewItemsAlert(true)
    }
    renderCurrentList(latestItems)
  }

  statusEl.textContent = '在线'
  setUpdatedTime(`上次刷新 ${fmtTime(new Date())}`)
  updateStats()
}

const fetchStatus = async () => {
  try {
    const res = await fetch(`${API_BASE}/api/status`)
    if (!res.ok) throw new Error('status fetch failed')
    const data = await res.json()

    if (failureCountEl) {
      failureCountEl.textContent = String(data?.consecutive_failures ?? 0)
    }

    if (!data?.next_run_at) return
    const nextMs = Date.parse(data.next_run_at)
    if (Number.isNaN(nextMs)) return

    nextRefreshAt = nextMs
    const newCycleKey = data.next_run_at
    if (newCycleKey !== cycleKey) {
      cycleKey = newCycleKey
      fetchedAfterCycle = false
    }
  } catch (_) {
    statusEl.textContent = '离线'
    setUpdatedTime('上次刷新 --')
    updateStatusTone(false)
  }
}

const refreshAll = async () => {
  try {
    await Promise.all([fetchItems(), fetchSources(), fetchStatus()])
  } catch (_) {
    statusEl.textContent = '离线'
    setUpdatedTime('上次刷新 --')
    updateStatusTone(false)
  }
}

const addSource = async () => {
  const url = urlInput?.value.trim()
  const name = nameInput?.value.trim()

  if (!url) {
    setFlash('请先输入 Mercari 搜索链接', 'warn')
    urlInput?.focus()
    return
  }

  const res = await fetch(`${API_BASE}/api/sources`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, url }),
  })

  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data?.error || 'add source failed')
  }

  if (nameInput) nameInput.value = ''
  if (urlInput) urlInput.value = ''
  await fetchSources()
  setFlash('监控已添加', 'ok')
}

const updateSource = async (id, payload) => {
  const res = await fetch(`${API_BASE}/api/sources/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) throw new Error('update source failed')
  await fetchSources()
}

const removeSource = async (id) => {
  const res = await fetch(`${API_BASE}/api/sources/${id}`, { method: 'DELETE' })
  if (!res.ok) throw new Error('delete source failed')
  await Promise.all([fetchSources(), fetchItems()])
}

const runOnce = async () => {
  runOnceBtn?.setAttribute('disabled', 'true')
  try {
    const res = await fetch(`${API_BASE}/api/scrape/run`, { method: 'POST' })
    if (!res.ok) throw new Error('run once failed')
    await refreshAll()
    setFlash('已触发一次抓取', 'ok')
  } finally {
    runOnceBtn?.removeAttribute('disabled')
  }
}

const invoke = async (cmd) => {
  if (!window.__TAURI__?.core?.invoke) return
  try {
    await window.__TAURI__.core.invoke(cmd)
  } catch (_) {
    // ignore
  }
}

dragIcon?.addEventListener('mousedown', (event) => {
  event.preventDefault()
  const label = mode === 'widget' ? 'widget' : 'panel'
  window.__TAURI__?.core?.invoke('start_dragging', { label }).catch(() => {})
})

refreshBtn?.addEventListener('click', async () => {
  await refreshAll()
})

runOnceBtn?.addEventListener('click', async () => {
  try {
    await runOnce()
  } catch (error) {
    setFlash(error.message || '抓取失败', 'warn')
  }
})

toggleBtn?.addEventListener('click', () => {
  if (mode === 'widget') {
    invoke('show_panel')
  } else {
    invoke('show_widget')
  }
})

addSourceBtn?.addEventListener('click', async () => {
  try {
    await addSource()
  } catch (error) {
    setFlash(error.message || '添加失败', 'warn')
  }
})

urlInput?.addEventListener('keydown', async (event) => {
  if (event.key !== 'Enter') return
  event.preventDefault()
  try {
    await addSource()
  } catch (error) {
    setFlash(error.message || '添加失败', 'warn')
  }
})

titleWrapEl?.addEventListener('click', resetNewItemsAlert)
topbarEl?.addEventListener('click', (event) => {
  if (mode !== 'widget') return
  const interactiveTarget = event.target.closest('button, a, input')
  if (interactiveTarget) return
  resetNewItemsAlert()
})

window.__TAURI__?.event?.listen?.('mark-read-shortcut', () => {
  resetNewItemsAlert()
})

window.addEventListener('keydown', (event) => {
  const isResetShortcut = (event.metaKey || event.ctrlKey) && (event.key === 'd' || event.key === 'D')
  if (!isResetShortcut) return
  event.preventDefault()
  resetNewItemsAlert()
})

if (mode === 'widget') {
  toggleBtn.textContent = '↗'
  toggleBtn.setAttribute('title', '展开完整面板')
  resizeWindow('widget', WIDGET_WIDTH, 84)
} else {
  toggleBtn.textContent = '精简'
  toggleBtn.setAttribute('title', '切换到精简模式')
}

refreshAll()

setInterval(fetchStatus, STATUS_POLL_MS)
setInterval(() => {
  if (!nextRefreshAt) return

  if (Date.now() >= nextRefreshAt + 1200 && !fetchedAfterCycle) {
    fetchedAfterCycle = true
    refreshAll()
  }
}, 1000)

setInterval(() => {
  fetchItems().catch(() => {
    statusEl.textContent = '离线'
    updatedEl.textContent = '获取失败'
    updateStatusTone(false)
  })
}, ITEM_POLL_MS)
