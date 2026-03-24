const path = require("path");
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const {
  listSources,
  addSource,
  setSourceEnabled,
  deleteSource,
  listItems,
  insertItemIfNew,
} = require("./db");
const { scrapeMercariSearch, closeBrowser } = require("./scrape");
const { pushQQ, pushQQAlert, saveLastOpenId } = require("./notify");

const crypto = require("crypto");

dotenv.config({ path: path.join(__dirname, "..", ".env") });

const app = express();
app.use(cors());

const QQ_APP_SECRET = process.env.QQ_APP_SECRET || "";

const PORT = process.env.PORT ? Number(process.env.PORT) : 2999;
const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const defaultMin = 20000;
const defaultMax = 30000;
const envMin = process.env.INTERVAL_MIN_MS
  ? Number(process.env.INTERVAL_MIN_MS)
  : null;
const envMax = process.env.INTERVAL_MAX_MS
  ? Number(process.env.INTERVAL_MAX_MS)
  : null;
const envFixed = process.env.INTERVAL_MS ? Number(process.env.INTERVAL_MS) : null;

const MIN_INTERVAL_MS = clamp(envMin ?? envFixed ?? defaultMin, 20000, 30000);
const MAX_INTERVAL_MS = clamp(envMax ?? envFixed ?? defaultMax, 20000, 30000);

let isRunning = false;
let consecutiveFailures = 0;
let alertSentAt = null;
let nextTimer = null;
let nextRunAt = new Date(Date.now() + 2000).toISOString();
let lastRunAt = null;

const nextDelay = () => {
  if (consecutiveFailures > 0) return MAX_INTERVAL_MS;
  const min = Math.min(MIN_INTERVAL_MS, MAX_INTERVAL_MS);
  const max = Math.max(MIN_INTERVAL_MS, MAX_INTERVAL_MS);
  return Math.floor(Math.random() * (max - min + 1)) + min;
};

const scheduleNext = () => {
  if (nextTimer) clearTimeout(nextTimer);
  const delay = nextDelay();
  nextRunAt = new Date(Date.now() + delay).toISOString();
  nextTimer = setTimeout(runOnce, delay);
};

const isMercari = (url) => /mercari\.com/.test(url);

const runOnce = async () => {
  if (isRunning) return;
  isRunning = true;
  lastRunAt = new Date().toISOString();
  try {
    const sources = listSources().filter((s) => s.enabled === 1);
    for (const source of sources) {
      if (!isMercari(source.url)) {
        continue;
      }
      let items = [];
      let apiStatus = null;
      try {
        const result = await scrapeMercariSearch(source.url);
        items = result.items || [];
        apiStatus = result.meta ? result.meta.apiStatus : null;
      } catch (err) {
        console.error("[scrape] failed", source.url, err.message);
        consecutiveFailures += 1;
        if (consecutiveFailures >= 3 && !alertSentAt) {
          alertSentAt = new Date().toISOString();
          await pushQQAlert(`连续失败 ${consecutiveFailures} 次，请检查网络或站点状态。`);
        }
        continue;
      }

      if (apiStatus && apiStatus >= 400) {
        consecutiveFailures += 1;
      } else if (items.length === 0) {
        consecutiveFailures += 1;
      } else {
        consecutiveFailures = 0;
        alertSentAt = null;
      }

      for (const item of items.slice(0, 30)) {
        const isNew = insertItemIfNew({
          ...item,
          source_id: source.id,
        });
        if (isNew) {
          const res = await pushQQ(item, source);
          if (!res.ok) {
            console.warn("[notify] failed", res);
          }
        }
      }
    }
  } finally {
    isRunning = false;
    scheduleNext();
  }
};

const getRawBody = (req) => {
  if (req.body && Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === "string") return Buffer.from(req.body);
  return Buffer.from("");
};

const repeatToSeed = (secret) => {
  let seed = secret || "";
  while (seed.length < 32) {
    seed = seed.repeat(2);
  }
  return seed.slice(0, 32);
};

const verifyQQSignature = (req, rawBody) => {
  const sig = req.get("X-Signature-Ed25519");
  const ts = req.get("X-Signature-Timestamp");
  if (!sig || !ts || !QQ_APP_SECRET) return false;

  const seed = repeatToSeed(QQ_APP_SECRET);
  const keyPair = crypto.generateKeyPairSync("ed25519", {
    seed: Buffer.from(seed),
  });
  const publicKey = keyPair.publicKey;
  const msg = Buffer.concat([Buffer.from(ts), rawBody]);
  try {
    return crypto.verify(
      null,
      msg,
      publicKey,
      Buffer.from(sig, "hex")
    );
  } catch (err) {
    return false;
  }
};

app.post(
  "/api/qq/webhook",
  express.raw({ type: "*/*" }),
  (req, res) => {
    const rawBody = getRawBody(req);
    if (!verifyQQSignature(req, rawBody)) {
      return res.status(401).json({ error: "invalid signature" });
    }

    let payload = null;
    try {
      payload = JSON.parse(rawBody.toString("utf-8"));
    } catch (err) {
      return res.status(400).json({ error: "bad json" });
    }

    if (payload && payload.op === 13 && payload.d) {
      const plainToken = payload.d.plain_token || "";
      const eventTs = payload.d.event_ts || "";
      const seed = repeatToSeed(QQ_APP_SECRET);
      const keyPair = crypto.generateKeyPairSync("ed25519", {
        seed: Buffer.from(seed),
      });
      const msg = Buffer.from(`${eventTs}${plainToken}`);
      const signature = crypto
        .sign(null, msg, keyPair.privateKey)
        .toString("hex");
      return res.json({ plain_token: plainToken, signature });
    }

    if (payload && payload.op === 0 && payload.t === "C2C_MESSAGE_CREATE") {
      const openid = payload.d?.author?.user_openid;
      if (openid) {
        saveLastOpenId(openid);
      }
    }

    return res.json({ op: 12 });
  }
);

app.use(express.json());

app.get("/api/qq/openid", (req, res) => {
  const { getLastOpenId } = require("./notify");
  res.json({ openid: getLastOpenId() });
});

app.get("/api/status", (req, res) => {
  res.json({
    ok: true,
    interval_min_ms: MIN_INTERVAL_MS,
    interval_max_ms: MAX_INTERVAL_MS,
    consecutive_failures: consecutiveFailures,
    next_run_at: nextRunAt,
    last_run_at: lastRunAt,
    server_now: new Date().toISOString(),
  });
});

app.get("/api/sources", (req, res) => {
  res.json(listSources());
});

app.post("/api/sources", (req, res) => {
  const { url, name } = req.body || {};
  if (!url) return res.status(400).json({ error: "url required" });
  try {
    const source = addSource(url, name);
    res.json(source);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch("/api/sources/:id", (req, res) => {
  const id = Number(req.params.id);
  const { enabled } = req.body || {};
  if (!Number.isFinite(id)) return res.status(400).json({ error: "bad id" });
  const source = setSourceEnabled(id, !!enabled);
  res.json(source);
});

app.delete("/api/sources/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "bad id" });
  res.json(deleteSource(id));
});

app.get("/api/items", (req, res) => {
  const limit = req.query.limit ? Number(req.query.limit) : 50;
  const sourceId = req.query.source_id ? Number(req.query.source_id) : null;
  res.json(listItems(limit, sourceId));
});

app.post("/api/scrape/run", async (req, res) => {
  await runOnce();
  res.json({ ok: true });
});

const server = app.listen(PORT, () => {
  console.log(`[server] http://localhost:${PORT}`);
  console.log(
    `[server] interval ${MIN_INTERVAL_MS}-${MAX_INTERVAL_MS}ms (random)`
  );
});

setTimeout(runOnce, 2000);

const shutdown = async () => {
  console.log("\n[server] shutting down...");
  server.close();
  await closeBrowser();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
