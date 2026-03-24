const fs = require("fs");
const path = require("path");

const QQ_APP_ID = process.env.QQ_APP_ID || "";
const QQ_APP_SECRET = process.env.QQ_APP_SECRET || "";
const QQ_USER_OPENID = process.env.QQ_USER_OPENID || "";

const dataDir = path.join(__dirname, "..", "data");
const openidPath = path.join(dataDir, "qq-openid.json");

const TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";
const API_BASE = "https://api.sgroup.qq.com";

let cachedToken = null;
let cachedTokenExpiry = 0;

const getAccessToken = async () => {
  const now = Date.now();
  if (cachedToken && cachedTokenExpiry - now > 60000) {
    return cachedToken;
  }
  if (!QQ_APP_ID || !QQ_APP_SECRET) {
    throw new Error("Missing QQ_APP_ID or QQ_APP_SECRET");
  }
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      appId: QQ_APP_ID,
      clientSecret: QQ_APP_SECRET,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`AccessToken request failed: ${res.status} ${text}`);
  }
  const json = await res.json();
  cachedToken = json.access_token;
  const expiresIn = Number(json.expires_in || 0) * 1000;
  cachedTokenExpiry = Date.now() + expiresIn;
  return cachedToken;
};

const buildText = (item, source) => {
  const lines = [];
  lines.push("新商品发布");
  if (source && source.name) lines.push(`来源: ${source.name}`);
  if (item.title) lines.push(`标题: ${item.title}`);
  if (item.price) lines.push(`价格: ${item.price}`);
  lines.push(`链接: ${item.url}`);
  return lines.join("\n");
};

const ensureDir = () => {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
};

const saveLastOpenId = (openid) => {
  if (!openid) return;
  ensureDir();
  fs.writeFileSync(openidPath, JSON.stringify({ openid }, null, 2));
};

const getLastOpenId = () => {
  try {
    if (fs.existsSync(openidPath)) {
      const json = JSON.parse(fs.readFileSync(openidPath, "utf-8"));
      return json.openid || "";
    }
  } catch (err) {
    return "";
  }
  return "";
};

const getTargetOpenId = () => QQ_USER_OPENID || getLastOpenId();

const sendC2CMessage = async (content) => {
  const targetOpenId = getTargetOpenId();
  if (!targetOpenId) return { ok: false, reason: "Missing QQ_USER_OPENID" };
  const token = await getAccessToken();
  const res = await fetch(`${API_BASE}/v2/users/${targetOpenId}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `QQBot ${token}`,
    },
    body: JSON.stringify({
      msg_type: 0,
      content,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    return { ok: false, status: res.status, text };
  }
  return { ok: true };
};

const pushQQ = async (item, source) => {
  return sendC2CMessage(buildText(item, source));
};

const pushQQAlert = async (message) => {
  return sendC2CMessage(`抓取告警\n${message}`);
};

module.exports = {
  pushQQ,
  pushQQAlert,
  saveLastOpenId,
  getLastOpenId,
};
