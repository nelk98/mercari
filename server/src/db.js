const fs = require("fs");
const path = require("path");

const dataDir = path.join(__dirname, "..", "data");
const sourcesPath = path.join(dataDir, "sources.json");

const ensureDir = () => {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
};

const todayKey = () => {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};

const itemsPathForDay = (dayKey) => path.join(dataDir, `items-${dayKey}.json`);

const initSources = () => ({ counters: { source: 1 }, sources: [] });
const initItems = () => ({ items: [] });

const readJson = (file, fallback) => {
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify(fallback, null, 2));
    return JSON.parse(JSON.stringify(fallback));
  }
  return JSON.parse(fs.readFileSync(file, "utf-8"));
};

const writeJson = (file, data) => {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
};

const loadSources = () => {
  ensureDir();
  return readJson(sourcesPath, initSources());
};

const saveSources = (data) => {
  ensureDir();
  writeJson(sourcesPath, data);
};

const loadItemsForDay = (dayKey) => {
  ensureDir();
  return readJson(itemsPathForDay(dayKey), initItems());
};

const saveItemsForDay = (dayKey, data) => {
  ensureDir();
  writeJson(itemsPathForDay(dayKey), data);
};

const listSources = () => {
  const data = loadSources();
  return data.sources.slice().sort((a, b) => b.id - a.id);
};

const addSource = (url, name) => {
  const data = loadSources();
  const exists = data.sources.find((s) => s.url === url);
  if (exists) {
    throw new Error("source already exists");
  }
  const source = {
    id: data.counters.source++,
    url,
    name: name || null,
    enabled: 1,
    created_at: new Date().toISOString(),
  };
  data.sources.push(source);
  saveSources(data);
  return source;
};

const setSourceEnabled = (id, enabled) => {
  const data = loadSources();
  const source = data.sources.find((s) => s.id === id);
  if (!source) return null;
  source.enabled = enabled ? 1 : 0;
  saveSources(data);
  return source;
};

const deleteSource = (id) => {
  const data = loadSources();
  data.sources = data.sources.filter((s) => s.id !== id);
  saveSources(data);

  const files = fs
    .readdirSync(dataDir)
    .filter((f) => f.startsWith("items-") && f.endsWith(".json"));
  for (const file of files) {
    const dayKey = file.replace("items-", "").replace(".json", "");
    const itemsData = loadItemsForDay(dayKey);
    itemsData.items = itemsData.items.filter((i) => i.source_id !== id);
    saveItemsForDay(dayKey, itemsData);
  }

  return { ok: true };
};

const listItems = (limit = 50, sourceId = null) => {
  ensureDir();
  const files = fs
    .readdirSync(dataDir)
    .filter((f) => f.startsWith("items-") && f.endsWith(".json"));

  let items = [];
  for (const file of files) {
    const dayKey = file.replace("items-", "").replace(".json", "");
    const data = loadItemsForDay(dayKey);
    items = items.concat(data.items);
  }

  if (sourceId) items = items.filter((i) => i.source_id === sourceId);

  return items
    .slice()
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    .slice(0, limit);
};

const insertItemIfNew = (item) => {
  const dayKey = todayKey();
  const data = loadItemsForDay(dayKey);
  const exists = data.items.find(
    (i) => i.source_id === item.source_id && i.item_id === item.item_id
  );
  if (exists) return false;

  const record = {
    id: `${item.source_id}-${item.item_id}`,
    source_id: item.source_id,
    item_id: item.item_id,
    title: item.title || "",
    price: item.price || "",
    currency: item.currency || "JPY",
    url: item.url,
    image: item.image || "",
    published_at: item.published_at || null,
    created_at: new Date().toISOString(),
  };

  data.items.push(record);
  saveItemsForDay(dayKey, data);
  return true;
};

module.exports = {
  listSources,
  addSource,
  setSourceEnabled,
  deleteSource,
  listItems,
  insertItemIfNew,
};
