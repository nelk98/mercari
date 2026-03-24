const { chromium } = require("playwright");

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

let browserPromise = null;

const getBrowser = async () => {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: true,
      args: ["--no-sandbox"],
    });
  }
  return browserPromise;
};

const closeBrowser = async () => {
  if (browserPromise) {
    const browser = await browserPromise;
    await browser.close();
    browserPromise = null;
  }
};

const normalizeItem = (item) => {
  if (!item || !item.url) return null;
  const idMatch = item.url.match(/item\/(\w+)/i);
  const itemId = idMatch ? idMatch[1] : null;
  return {
    item_id: itemId || item.url,
    title: item.title || "",
    price: item.price || "",
    currency: item.currency || "JPY",
    url: item.url,
    image: item.image || "",
    published_at: item.published_at || null,
  };
};

const scrapeMercariSearch = async (url) => {
  const browser = await getBrowser();
  const page = await browser.newPage({
    userAgent: DEFAULT_USER_AGENT,
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
  });
  page.setDefaultTimeout(60000);
  await page.setExtraHTTPHeaders({
    "Accept-Language": "ja-JP,ja;q=0.9,en;q=0.8",
  });

  let apiStatus = null;
  const apiPromise = page.waitForResponse(
    (res) =>
      res.url().includes("api.mercari.jp/v2/entities:search") && res.ok(),
    { timeout: 15000 }
  );

  await page.goto(url, { waitUntil: "domcontentloaded" });

  let items = [];
  try {
    const resp = await apiPromise;
    apiStatus = resp.status();
    const json = await resp.json();
    if (json && Array.isArray(json.items)) {
      items = json.items.map((item) => ({
        item_id: item.id,
        title: item.name || item.title || "",
        price: item.price ? `¥${item.price}` : "",
        currency: "JPY",
        url: item.id ? `https://jp.mercari.com/item/${item.id}` : "",
        image:
          (Array.isArray(item.thumbnails) && item.thumbnails[0]) ||
          (Array.isArray(item.photos) && item.photos[0]?.uri) ||
          "",
        published_at: item.created
          ? new Date(Number(item.created) * 1000).toISOString()
          : null,
      }));
    }
  } catch (err) {
    console.warn("[scrape] api response not found, fallback to DOM", err.message);
  }

  if (items.length === 0) {
    const domItems = await page.evaluate(() => {
      const results = [];
      const anchors = Array.from(document.querySelectorAll('a[href*="/item/"]'));

      const pickText = (el) => (el && el.textContent ? el.textContent.trim() : "");

      const findPrice = (el) => {
        const container = el.closest("li,div");
        if (!container) return "";
        const nodes = Array.from(container.querySelectorAll("*"));
        const priceNode = nodes.find((n) => pickText(n).startsWith("¥"));
        return priceNode ? pickText(priceNode) : "";
      };

      for (const a of anchors) {
        const href = a.getAttribute("href");
        if (!href) continue;
        const itemUrl = href.startsWith("http") ? href : `${location.origin}${href}`;

        const img = a.querySelector("img");
        const title =
          (img && img.getAttribute("alt")) ||
          a.getAttribute("aria-label") ||
          pickText(a);

        results.push({
          url: itemUrl,
          title,
          price: findPrice(a),
          currency: "JPY",
          image: img ? img.getAttribute("src") || "" : "",
        });
      }

      return results;
    });

    items = domItems;
  }

  await page.close();

  const seen = new Set();
  const normalized = [];
  for (const item of items) {
    const data = normalizeItem(item);
    if (!data) continue;
    if (seen.has(data.item_id)) continue;
    seen.add(data.item_id);
    normalized.push(data);
  }
  return { items: normalized, meta: { apiStatus } };
};

module.exports = {
  scrapeMercariSearch,
  closeBrowser,
};
