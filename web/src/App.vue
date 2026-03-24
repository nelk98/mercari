<template>
  <div class="page">
    <header class="hero">
      <div>
        <h1>Mercari 推送控制台</h1>
        <p>添加搜索链接，系统每 30 秒抓取一次，有新商品就推送到企业微信。</p>
      </div>
      <div class="actions">
        <button class="primary" @click="runOnce">立即抓取</button>
      </div>
    </header>

    <section class="card">
      <h2>新增监控</h2>
      <div class="form">
        <input v-model="form.name" placeholder="名称（可选）" />
        <input v-model="form.url" placeholder="Mercari 搜索链接" />
        <button class="primary" @click="addSource">添加</button>
      </div>
      <p class="hint">示例：https://jp.mercari.com/search?keyword=...&order=desc&sort=created_time</p>
    </section>

    <section class="card">
      <h2>监控列表</h2>
      <div v-if="sources.length === 0" class="empty">暂无监控链接</div>
      <div v-for="s in sources" :key="s.id" class="source">
        <div class="source-main">
          <strong>{{ s.name || '未命名' }}</strong>
          <a :href="s.url" target="_blank">{{ s.url }}</a>
        </div>
        <div class="source-actions">
          <label class="toggle">
            <input type="checkbox" :checked="s.enabled === 1" @change="toggleSource(s)" />
            <span>{{ s.enabled === 1 ? '启用中' : '已暂停' }}</span>
          </label>
          <button class="ghost" @click="removeSource(s)">删除</button>
        </div>
      </div>
    </section>

    <section class="card">
      <h2>最新商品</h2>
      <div v-if="items.length === 0" class="empty">暂无数据</div>
      <div class="grid">
        <article v-for="item in items" :key="item.id" class="item">
          <div class="thumb" :style="{ backgroundImage: item.image ? `url(${item.image})` : '' }"></div>
          <div class="item-body">
            <h3>{{ item.title || '无标题' }}</h3>
            <p class="price">{{ item.price || '价格未知' }}</p>
            <a :href="item.url" target="_blank">打开详情</a>
          </div>
        </article>
      </div>
    </section>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue'

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:2999'

const sources = ref([])
const items = ref([])
const form = reactive({ name: '', url: '' })

const fetchSources = async () => {
  const res = await fetch(`${API_BASE}/api/sources`)
  sources.value = await res.json()
}

const fetchItems = async () => {
  const res = await fetch(`${API_BASE}/api/items?limit=50`)
  items.value = await res.json()
}

const addSource = async () => {
  if (!form.url) return
  await fetch(`${API_BASE}/api/sources`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: form.name, url: form.url })
  })
  form.name = ''
  form.url = ''
  await fetchSources()
}

const toggleSource = async (source) => {
  await fetch(`${API_BASE}/api/sources/${source.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: source.enabled !== 1 })
  })
  await fetchSources()
}

const removeSource = async (source) => {
  await fetch(`${API_BASE}/api/sources/${source.id}`, { method: 'DELETE' })
  await fetchSources()
}

const runOnce = async () => {
  await fetch(`${API_BASE}/api/scrape/run`, { method: 'POST' })
  await fetchItems()
}

onMounted(async () => {
  await fetchSources()
  await fetchItems()
  setInterval(fetchItems, 15000)
})
</script>
