import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { networkInterfaces } from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadLocalEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    if (key && process.env[key] == null) process.env[key] = value;
  }
}

loadLocalEnv();

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "0.0.0.0";
const MX_APIKEY = process.env.MX_APIKEY;
const MX_BASE = process.env.MX_API_URL || "https://mkapi2.dfcfs.com/finskillshub";
const EM_UT = "bd1d9ddb04089700cf9c27f6f7426281";
const INDEX_SECIDS = [
  { secid: "1.000001", code: "000001", name: "上证指数" },
  { secid: "0.399001", code: "399001", name: "深证成指" },
  { secid: "0.399006", code: "399006", name: "创业板指" },
  { secid: "1.000688", code: "000688", name: "科创50" },
  { secid: "1.000300", code: "000300", name: "沪深300" },
  { secid: "1.000852", code: "000852", name: "中证1000" }
];
const A_STOCK_FS = "m:0%2Bt:6,m:0%2Bt:80,m:1%2Bt:2,m:1%2Bt:23";
const SECTOR_FS = ["m:90%2Bt:2", "m:90%2Bt:3"];
const DATA_DIR = process.env.NETLIFY ? path.join("/tmp", "a-share-data") : path.join(__dirname, "data");
const WATCHLIST_FILE = path.join(DATA_DIR, "watchlist.json");
const INDEX_CACHE_FILE = path.join(DATA_DIR, "index-cache.json");
const SECTOR_CACHE_FILE = path.join(DATA_DIR, "sector-cache.json");
const OPPORTUNITY_CACHE_FILE = path.join(DATA_DIR, "opportunity-cache.json");
const BUY_ALERT_CACHE_FILE = path.join(DATA_DIR, "buy-alert-cache.json");
const MARKET_HISTORY_FILE = path.join(DATA_DIR, "market-history.json");
const execFileAsync = promisify(execFile);
const FUND_FLOW_MEMORY = new Map();
const FUND_FLOW_TTL_MS = 5 * 60 * 1000;
const INTRADAY_AVG_MEMORY = new Map();
const CONCEPT_TAG_MEMORY = new Map();
const MARKET_BREADTH_MEMORY = { savedAt: 0, value: null };

function json(res, status, body) {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(text);
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function toNum(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (value == null) return 0;
  const text = String(value).replace(/[%亿万,]/g, "").trim();
  const n = Number(text);
  return Number.isFinite(n) ? n : 0;
}

function moneyText(value) {
  const n = toNum(value);
  if (!n) return "0";
  if (Math.abs(n) >= 100000000) return `${(n / 100000000).toFixed(1)}亿`;
  if (Math.abs(n) >= 10000) return `${(n / 10000).toFixed(1)}万`;
  return String(Math.round(n));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeTradeDate(value) {
  const text = String(value || "").trim();
  const compact = text.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  const match = text.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (match) return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
  return text.slice(0, 10);
}

async function writeSectorCache(sectors) {
  if (!sectors.length) return;
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(SECTOR_CACHE_FILE, JSON.stringify({
    generatedAt: new Date().toISOString(),
    sectors
  }, null, 2), "utf8");
}

async function readSectorCache() {
  if (!existsSync(SECTOR_CACHE_FILE)) return [];
  try {
    const cached = JSON.parse(await readFile(SECTOR_CACHE_FILE, "utf8"));
    return (cached.sectors || []).map((sector) => ({
      ...sector,
      reason: `${sector.reason}；东方财富板块接口临时空返，当前使用最近一次真实缓存`,
      risk: `${sector.risk}；缓存时间 ${new Date(cached.generatedAt).toLocaleString("zh-CN", { hour12: false })}`
    }));
  } catch {
    return [];
  }
}

async function writeIndexCache(indices) {
  if (!indices.length) return;
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(INDEX_CACHE_FILE, JSON.stringify({
    generatedAt: new Date().toISOString(),
    indices
  }, null, 2), "utf8");
}

async function readIndexCache() {
  if (!existsSync(INDEX_CACHE_FILE)) return [];
  try {
    const cached = JSON.parse(await readFile(INDEX_CACHE_FILE, "utf8"));
    return cached.indices || [];
  } catch {
    return [];
  }
}

function chinaTimeParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function chinaDateString(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function isAshareTradingSession(date = new Date()) {
  const parts = chinaTimeParts(date);
  if (["Sat", "Sun"].includes(parts.weekday)) return false;
  const minuteOfDay = Number(parts.hour) * 60 + Number(parts.minute);
  return (minuteOfDay >= 9 * 60 + 25 && minuteOfDay <= 11 * 60 + 30)
    || (minuteOfDay >= 13 * 60 && minuteOfDay <= 15 * 60);
}

function shouldPreferCacheOutsideSession(date = new Date()) {
  const parts = chinaTimeParts(date);
  if (["Sat", "Sun"].includes(parts.weekday)) return true;
  const minuteOfDay = Number(parts.hour) * 60 + Number(parts.minute);
  return minuteOfDay < 9 * 60 + 25;
}

function cacheAgeText(generatedAt) {
  if (!generatedAt) return "未知时间";
  return new Date(generatedAt).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour12: false
  });
}

function hasOpportunityCandidates(payload) {
  const groups = payload?.candidates || {};
  return ["A", "B", "C"].some((key) => (groups[key] || []).length);
}

async function writeOpportunityCache(payload) {
  if (!payload?.market || !hasOpportunityCandidates(payload)) return;
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(OPPORTUNITY_CACHE_FILE, JSON.stringify({
    cachedAt: new Date().toISOString(),
    payload
  }, null, 2), "utf8");
}

async function readOpportunityCache(reason) {
  if (!existsSync(OPPORTUNITY_CACHE_FILE)) return null;
  try {
    const cached = JSON.parse(await readFile(OPPORTUNITY_CACHE_FILE, "utf8"));
    const payload = cached.payload;
    if (!payload) return null;
    return {
      ...payload,
      generatedAt: new Date().toISOString(),
      dataSource: "东方财富最后成交行情缓存",
      sourceMessage: `${reason}；当前展示 ${cacheAgeText(cached.cachedAt || payload.generatedAt)} 保存的最后一份完整行情。`,
      stale: true,
      cachedAt: cached.cachedAt || payload.generatedAt
    };
  } catch {
    return null;
  }
}

async function readOpportunityCachePayload() {
  if (!existsSync(OPPORTUNITY_CACHE_FILE)) return null;
  try {
    const cached = JSON.parse(await readFile(OPPORTUNITY_CACHE_FILE, "utf8"));
    return cached.payload ? {
      cachedAt: cached.cachedAt || cached.payload.generatedAt,
      payload: cached.payload
    } : null;
  } catch {
    return null;
  }
}

function hasValidBuyAlerts(payload) {
  return (payload?.alerts || []).some((item) => /分时均价/.test(String(item.averagePriceSource || "")));
}

async function writeBuyAlertCache(payload) {
  if (!hasValidBuyAlerts(payload)) return;
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(BUY_ALERT_CACHE_FILE, JSON.stringify({
    cachedAt: new Date().toISOString(),
    payload
  }, null, 2), "utf8");
}

async function readBuyAlertCache(reason) {
  if (!existsSync(BUY_ALERT_CACHE_FILE)) return null;
  try {
    const cached = JSON.parse(await readFile(BUY_ALERT_CACHE_FILE, "utf8"));
    const payload = cached.payload;
    if (!hasValidBuyAlerts(payload)) return null;
    const alerts = (payload.alerts || []).filter((item) => /分时均价/.test(String(item.averagePriceSource || "")));
    return {
      ...payload,
      generatedAt: new Date().toISOString(),
      dataSource: "东方财富涨停日分时均价缓存",
      sourceMessage: `${reason}；当前展示 ${cacheAgeText(cached.cachedAt || payload.generatedAt)} 保存的最近一次真实分时均价结果，不使用日K均价兜底。`,
      stale: true,
      cachedAt: cached.cachedAt || payload.generatedAt,
      stats: {
        ...(payload.stats || {}),
        total: alerts.length,
        triggered: alerts.filter((item) => item.triggered).length,
        nearTrigger: alerts.filter((item) => item.nearTrigger).length
      },
      alerts
    };
  } catch {
    return null;
  }
}

async function mxPost(endpoint, payload) {
  if (!MX_APIKEY) throw new Error("MX_APIKEY is not configured on the server");
  const response = await fetch(`${MX_BASE}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: MX_APIKEY
    },
    body: JSON.stringify(payload)
  });
  if (!response.ok) throw new Error(`MX API ${response.status}: ${await response.text()}`);
  return response.json();
}

async function mxQuery(toolQuery) {
  return mxPost("/api/claw/query", { toolQuery });
}

async function mxScreen(keyword) {
  return mxPost("/api/claw/stock-screen", { keyword });
}

function fundCacheKey(code, limit) {
  return `${String(code || "").replace(/\D/g, "").slice(0, 6)}:${limit}`;
}

function getCachedFundFlow(code, limit) {
  const cached = FUND_FLOW_MEMORY.get(fundCacheKey(code, limit));
  if (!cached || Date.now() - cached.savedAt > FUND_FLOW_TTL_MS) return null;
  return cached.rows;
}

function setCachedFundFlow(code, limit, rows) {
  if (!rows?.length) return;
  FUND_FLOW_MEMORY.set(fundCacheKey(code, limit), { savedAt: Date.now(), rows });
}

function parseMxFundRows(dto, limit) {
  const code = String(dto?.code || dto?.entityTagDTO?.secuCode || "").replace(/\D/g, "").slice(0, 6);
  const table = dto?.rawTable || dto?.table || {};
  const nameMap = dto?.nameMap || {};
  const heads = Array.isArray(table.headName) ? table.headName : [];
  if (!code || !heads.length) return null;
  const keys = Object.keys(table).filter((key) => key !== "headName");
  const mainKey = keys.find((key) => /主力净流入资金/.test(String(nameMap[key] || "")))
    || keys.find((key) => key === "100000000006404")
    || keys.find((key) => key === "328083");
  if (!mainKey || !Array.isArray(table[mainKey])) return null;
  const rows = heads.map((date, index) => ({
    date: String(date).match(/\d{4}-\d{2}-\d{2}/)?.[0] || String(date),
    mainNet: toNum(table[mainKey][index]),
    source: "eastmoney-mx"
  })).filter((row) => row.date);
  rows.sort((a, b) => a.date.localeCompare(b.date));
  return { code, rows: rows.slice(-limit) };
}

async function getMxFundFlowsForStocks(stocks, limit = 10) {
  const map = new Map();
  const pending = [];
  const seen = new Set();
  for (const stock of stocks) {
    const code = String(stock?.code || "").replace(/\D/g, "").slice(0, 6);
    if (!code || seen.has(code)) continue;
    seen.add(code);
    const cached = getCachedFundFlow(code, limit);
    if (cached?.length) {
      map.set(code, cached);
    } else {
      pending.push({ code, name: stock.name || "" });
    }
  }
  const chunks = [];
  for (let index = 0; index < pending.length; index += 8) chunks.push(pending.slice(index, index + 8));
  for (const chunk of chunks) {
    const query = `${chunk.map((stock) => `${stock.name || ""}${stock.code}`).join("、")} 近${limit}个交易日主力资金流向`;
    const result = await mxQuery(query);
    const tables = extractDataTables(result);
    for (const dto of tables) {
      const parsed = parseMxFundRows(dto, limit);
      if (!parsed?.rows?.length || map.has(parsed.code)) continue;
      setCachedFundFlow(parsed.code, limit, parsed.rows);
      map.set(parsed.code, parsed.rows);
    }
    if (chunks.length > 1) await sleep(350);
  }
  return map;
}

async function eastmoneyJson(url) {
  let lastError;
  const attempts = Number(process.env.EASTMONEY_ATTEMPTS || 1);
  const timeoutSeconds = Number(process.env.EASTMONEY_TIMEOUT_SECONDS || 4);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const { stdout } = await execFileAsync("curl", [
        "-4",
        "-sS",
        "--max-time",
        String(timeoutSeconds),
        "-A",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
        "-e",
        "https://quote.eastmoney.com/",
        url
      ], { maxBuffer: 8 * 1024 * 1024 });
      return JSON.parse(stdout);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, attempt * 450));
    }
  }
  throw lastError;
}

async function eastmoneyFetchJson(url, timeoutMs = 6000) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      referer: "https://quote.eastmoney.com/"
    },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) throw new Error(`Eastmoney fetch ${response.status}`);
  return response.json();
}

async function publicFetchText(url, timeoutMs = 8000, headers = {}) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      ...headers
    },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) throw new Error(`Public quote fetch ${response.status}`);
  const buffer = await response.arrayBuffer();
  return new TextDecoder("gb18030").decode(buffer);
}

async function publicFetchJson(url, timeoutMs = 8000, headers = {}) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      ...headers
    },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) throw new Error(`Public quote JSON ${response.status}`);
  return response.json();
}

function eastmoneyClistUrl({ pn = 1, pz = 100, fid = "f3", fs, fields }) {
  return `https://push2.eastmoney.com/api/qt/clist/get?pn=${pn}&pz=${pz}&po=1&np=1&ut=${EM_UT}&fltt=2&invt=2&fid=${fid}&fs=${fs}&fields=${fields}`;
}

function marketPrefix(code) {
  const normalized = String(code || "").replace(/\D/g, "").slice(0, 6);
  if (/^(6|9)/.test(normalized)) return "sh";
  if (/^(0|2|3)/.test(normalized)) return "sz";
  if (/^(8|4|9)/.test(normalized)) return "bj";
  return "sz";
}

function normalizeSinaStock(row) {
  if (!row?.code || !row?.name || /ST|退/.test(row.name)) return null;
  const code = String(row.code).replace(/\D/g, "").slice(0, 6);
  if (!/^(0|2|3|6|8|4)/.test(code)) return null;
  return {
    f12: code,
    f14: row.name,
    f2: toNum(row.trade),
    f3: toNum(row.changepercent),
    f4: toNum(row.pricechange),
    f5: toNum(row.volume),
    f6: toNum(row.amount),
    f7: toNum(row.high) && toNum(row.low) ? ((toNum(row.high) - toNum(row.low)) / Math.max(0.01, toNum(row.settlement))) * 100 : 0,
    f8: toNum(row.turnoverratio),
    f10: 1,
    f15: toNum(row.high),
    f16: toNum(row.low),
    f17: toNum(row.open),
    f18: toNum(row.settlement),
    f62: 0,
    publicSource: "sina"
  };
}

async function getSinaAStocks({ pages = 8, pageSize = 80 } = {}) {
  const urls = Array.from({ length: pages }, (_, index) => `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData?page=${index + 1}&num=${pageSize}&sort=changepercent&asc=0&node=hs_a&symbol=&_s_r_a=page`);
  const results = await mapLimit(urls, 8, async (url) => {
    try {
      return await publicFetchJson(url, 9000, { referer: "https://finance.sina.com.cn/" });
    } catch {
      return null;
    }
  });
  const rows = results
    .filter(Array.isArray)
    .flatMap((result) => result)
    .map(normalizeSinaStock)
    .filter(Boolean);
  const seen = new Set();
  return rows.filter((row) => {
    if (seen.has(row.f12)) return false;
    seen.add(row.f12);
    return true;
  });
}

function parseTencentQuoteLine(line) {
  const match = String(line).match(/^v_([a-z]{2}\d{6})="(.*)";?$/);
  if (!match) return null;
  const symbol = match[1];
  const parts = match[2].split("~");
  const code = parts[2] || symbol.slice(2);
  return {
    f12: code,
    f14: parts[1] || code,
    f2: toNum(parts[3]),
    f3: toNum(parts[32]),
    f4: toNum(parts[31]),
    f5: toNum(parts[36]),
    f6: toNum(parts[37]) * 10000,
    f7: toNum(parts[43]),
    f8: toNum(parts[38]),
    f10: toNum(parts[49]),
    f15: toNum(parts[33]),
    f16: toNum(parts[34]),
    f17: toNum(parts[5]),
    f18: toNum(parts[4]),
    f62: 0
  };
}

async function getTencentQuotes(codes) {
  const symbols = [...new Set(codes.map((code) => `${marketPrefix(code)}${String(code).replace(/\D/g, "").slice(0, 6)}`).filter((item) => /\d{6}$/.test(item)))];
  if (!symbols.length) return new Map();
  const text = await publicFetchText(`https://qt.gtimg.cn/q=${symbols.join(",")}`, 9000, { referer: "https://gu.qq.com/" });
  return new Map(text
    .split(/\n+/)
    .map(parseTencentQuoteLine)
    .filter((row) => row && row.f12)
    .map((row) => [String(row.f12), row]));
}

async function getTencentQuotesBySymbols(symbols) {
  const clean = [...new Set(symbols.filter((item) => /^[a-z]{2}\d{6}$/.test(item)))];
  if (!clean.length) return new Map();
  const text = await publicFetchText(`https://qt.gtimg.cn/q=${clean.join(",")}`, 9000, { referer: "https://gu.qq.com/" });
  return new Map(text
    .split(/\n+/)
    .map(parseTencentQuoteLine)
    .filter((row) => row && row.f12)
    .map((row) => [String(row.f12), row]));
}

async function getRealtimeIndices() {
  try {
    const result = await eastmoneyFetchJson(eastmoneyClistUrl({
      pn: 1,
      pz: 100,
      fid: "f3",
      fs: "b:MK0010",
      fields: "f12,f14,f2,f3,f4,f6"
    }));
    const byCode = new Map((result?.data?.diff || []).map((row) => [String(row.f12), row]));
    const rows = INDEX_SECIDS.map((item) => byCode.get(item.code)).filter(Boolean);
    if (rows.length) return rows;
  } catch {
    // Fall through to other Eastmoney index endpoints.
  }
  try {
    const secids = INDEX_SECIDS.map((item) => item.secid).join(",");
    const result = await eastmoneyJson(`https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&fields=f12,f14,f2,f3,f4,f6&secids=${secids}`);
    const rows = result?.data?.diff || [];
    if (rows.length) return rows;
  } catch {
    // Fall through to per-index quote requests; the batch endpoint can intermittently empty-return.
  }
  try {
    const result = await eastmoneyJson(eastmoneyClistUrl({
      pn: 1,
      pz: 100,
      fid: "f3",
      fs: "b:MK0010",
      fields: "f12,f14,f2,f3,f4,f6"
    }));
    const byCode = new Map((result?.data?.diff || []).map((row) => [String(row.f12), row]));
    const rows = INDEX_SECIDS.map((item) => byCode.get(item.code)).filter(Boolean);
    if (rows.length) return rows;
  } catch {
    // Fall through to single-index quote requests.
  }
  const rows = [];
  for (const item of INDEX_SECIDS) {
    try {
      const result = await eastmoneyJson(`https://push2.eastmoney.com/api/qt/stock/get?ut=${EM_UT}&fltt=2&invt=2&fields=f43,f57,f58,f169,f170,f48&secid=${item.secid}`);
      const row = result?.data || {};
      if (row.f43 != null) {
        rows.push({
          f2: toNum(row.f43),
          f3: toNum(row.f170),
          f4: toNum(row.f169),
          f6: toNum(row.f48),
          f12: row.f57 || item.code,
          f14: row.f58 || item.name
        });
      }
    } catch {
      // Keep trying the rest; one index request should not blank the whole strip.
    }
  }
  if (rows.length) return rows;
  try {
    const quoteMap = await getTencentQuotesBySymbols(INDEX_SECIDS.map((item) => item.secid.startsWith("1.") ? `sh${item.code}` : `sz${item.code}`));
    const fallbackRows = INDEX_SECIDS.map((item) => {
      const row = quoteMap.get(item.code);
      return row ? { ...row, f14: item.name } : null;
    }).filter(Boolean);
    if (fallbackRows.length) return fallbackRows;
  } catch {
    // Tencent public quote fallback can also fail; caller will use cache/protection.
  }
  return [];
}

async function getRealtimeAStocks() {
  try {
    const result = await eastmoneyJson(eastmoneyClistUrl({
      pn: 1,
      pz: 6000,
      fid: "f3",
      fs: A_STOCK_FS,
      fields: "f12,f14,f2,f3,f6,f8,f10"
    }));
    const rows = result?.data?.diff || [];
    if (rows.length) return rows;
  } catch (error) {
    console.warn("Eastmoney A-stock pool unavailable:", error.message);
  }
  return getSinaAStocks({ pages: 10, pageSize: 80 });
}

function calculateBreadthFromStocks(stocks, minSample = 2000) {
  const valid = stocks.filter((row) => row?.f12 && Number.isFinite(Number(row.f3)));
  if (valid.length < minSample) return null;
  const upCount = valid.filter((row) => toNum(row.f3) > 0).length;
  const downCount = valid.filter((row) => toNum(row.f3) < 0).length;
  const flatCount = valid.length - upCount - downCount;
  const limitUpCount = valid.filter((row) => toNum(row.f3) >= 9.8).length;
  const limitDownCount = valid.filter((row) => toNum(row.f3) <= -9.8).length;
  const totalAmount = valid.reduce((sum, row) => sum + toNum(row.f6), 0);
  return {
    sampleSize: valid.length,
    upCount,
    downCount,
    flatCount,
    limitUpCount,
    limitDownCount,
    totalAmount
  };
}

async function getEastmoneyBroadAStocks() {
  const fields = "f12,f14,f2,f3,f4,f5,f6,f7,f8,f10,f15,f16,f17,f18";
  const urls = Array.from({ length: 12 }, (_, index) => eastmoneyClistUrl({
    pn: index + 1,
    pz: 500,
    fid: "f3",
    fs: A_STOCK_FS,
    fields
  }));
  const results = await mapLimit(urls, 4, async (url) => {
    try {
      return await eastmoneyFetchJson(url, 9000);
    } catch {
      return null;
    }
  });
  return results
    .flatMap((result) => result?.data?.diff || [])
    .filter((row) => row?.f12 && row?.f14 && !/ST|退/.test(String(row.f14)));
}

async function getBroadMarketBreadth() {
  const now = Date.now();
  if (MARKET_BREADTH_MEMORY.value && now - MARKET_BREADTH_MEMORY.savedAt < 2 * 60 * 1000) {
    return MARKET_BREADTH_MEMORY.value;
  }
  let breadth = null;
  try {
    breadth = calculateBreadthFromStocks(await getEastmoneyBroadAStocks(), 2500);
  } catch (error) {
    console.warn("Eastmoney breadth unavailable:", error.message);
  }
  if (!breadth) {
    try {
      breadth = calculateBreadthFromStocks(await getSinaAStocks({ pages: 60, pageSize: 100 }), 2500);
    } catch (error) {
      console.warn("Sina breadth unavailable:", error.message);
    }
  }
  if (breadth) {
    MARKET_BREADTH_MEMORY.savedAt = now;
    MARKET_BREADTH_MEMORY.value = breadth;
  }
  return breadth;
}

async function getRealtimeSectors() {
  const fields = "f12,f14,f2,f3,f6,f62,f128,f140";
  const results = await Promise.allSettled(SECTOR_FS.map((fs) => eastmoneyJson(eastmoneyClistUrl({
    pn: 1,
    pz: 30,
    fid: "f3",
    fs,
    fields
  }))));
  return results
    .filter((result) => result.status === "fulfilled")
    .flatMap((result) => result.value?.data?.diff || [])
    .filter((row) => /^BK/.test(String(row.f12 || "")))
    .filter((row) => row.f14 && !/ST|退|昨日|融资融券|标准普尔|MSCI|富时|证金持股/.test(String(row.f14)));
}

function secidFor(code) {
  const normalized = String(code || "").replace(/\D/g, "").slice(0, 6);
  const market = /^(6|9)/.test(normalized) ? "1" : "0";
  return `${market}.${normalized}`;
}

function parseKline(text) {
  const [date, open, close, high, low, volume, amount, amplitude, pct, change, turnover] = String(text).split(",");
  return {
    date,
    open: toNum(open),
    close: toNum(close),
    high: toNum(high),
    low: toNum(low),
    volume: toNum(volume),
    amount: toNum(amount),
    amplitude: toNum(amplitude),
    pct: toNum(pct),
    change: toNum(change),
    turnover: toNum(turnover)
  };
}

function parseTrendLine(text) {
  const [time, open, close, high, low, volume, amount, avgPrice] = String(text).split(",");
  const date = String(time || "").slice(0, 10);
  return {
    time,
    date,
    open: toNum(open),
    close: toNum(close),
    high: toNum(high),
    low: toNum(low),
    volume: toNum(volume),
    amount: toNum(amount),
    avgPrice: toNum(avgPrice)
  };
}

function parseTencentKline(row) {
  const [date, open, close, high, low, volume] = row;
  const closePrice = toNum(close);
  const volumeHands = toNum(volume);
  return {
    date,
    open: toNum(open),
    close: closePrice,
    high: toNum(high),
    low: toNum(low),
    volume: volumeHands,
    amount: closePrice * volumeHands * 100,
    amplitude: closePrice ? ((toNum(high) - toNum(low)) / closePrice) * 100 : 0,
    pct: 0,
    change: 0,
    turnover: 0
  };
}

async function getTencentDailyKlines(code, limit = 90) {
  const symbol = `${marketPrefix(code)}${String(code || "").replace(/\D/g, "").slice(0, 6)}`;
  const result = await publicFetchJson(`https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${symbol},day,,,${limit},qfq`, 9000, { referer: "https://gu.qq.com/" });
  const rows = result?.data?.[symbol]?.qfqday || result?.data?.[symbol]?.day || [];
  const parsed = rows.map(parseTencentKline);
  return parsed.map((row, index) => {
    const previous = parsed[index - 1];
    const pct = previous?.close ? ((row.close - previous.close) / previous.close) * 100 : 0;
    return {
      ...row,
      pct,
      change: previous?.close ? row.close - previous.close : 0
    };
  });
}

async function getTencentIndexDailyKlines(index, limit = 24) {
  const symbol = `${index.secid.startsWith("1.") ? "sh" : "sz"}${index.code}`;
  const result = await publicFetchJson(`https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${symbol},day,,,${limit},qfq`, 9000, { referer: "https://gu.qq.com/" });
  const rows = result?.data?.[symbol]?.qfqday || result?.data?.[symbol]?.day || [];
  const parsed = rows.map(parseTencentKline);
  return parsed.map((row, rowIndex) => {
    const previous = parsed[rowIndex - 1];
    const pct = previous?.close ? ((row.close - previous.close) / previous.close) * 100 : 0;
    return {
      ...row,
      pct,
      change: previous?.close ? row.close - previous.close : 0
    };
  });
}

function parseFundLine(text) {
  const [date, mainNet, smallNet, midNet, largeNet, superNet, mainPct, smallPct, midPct, largePct, superPct, close, pct] = String(text).split(",");
  return {
    date,
    mainNet: toNum(mainNet),
    smallNet: toNum(smallNet),
    midNet: toNum(midNet),
    largeNet: toNum(largeNet),
    superNet: toNum(superNet),
    mainPct: toNum(mainPct),
    close: toNum(close),
    pct: toNum(pct)
  };
}

function avg(values) {
  const nums = values.filter((value) => Number.isFinite(value));
  return nums.length ? nums.reduce((sum, value) => sum + value, 0) / nums.length : 0;
}

function ma(klines, days) {
  return avg(klines.slice(-days).map((row) => row.close));
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function readWatchlist() {
  return existsSync(WATCHLIST_FILE) ? JSON.parse(await readFile(WATCHLIST_FILE, "utf8")) : [];
}

async function getRealtimeQuotes(codes) {
  const uniqueCodes = [...new Set(codes.map((code) => String(code || "").replace(/\D/g, "").slice(0, 6)).filter(Boolean))];
  const secids = uniqueCodes.map(secidFor).join(",");
  if (!secids) return new Map();
  try {
    const result = await eastmoneyJson(`https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&fields=f12,f14,f2,f3,f4,f5,f6,f7,f8,f10,f15,f16,f17,f18,f62&secids=${secids}`);
    const rows = result?.data?.diff || [];
    if (rows.length) return new Map(rows.map((row) => [String(row.f12), row]));
  } catch {
    // Fall through to the per-stock quote endpoint; the batch endpoint can intermittently empty-return.
  }
  const results = await Promise.allSettled(uniqueCodes.map(getRealtimeQuote));
  const quoteMap = new Map(results
    .filter((result) => result.status === "fulfilled" && result.value)
    .map((result) => [String(result.value.f12), result.value]));
  const missing = uniqueCodes.filter((code) => !quoteMap.has(code));
  if (missing.length) {
    try {
      const publicQuotes = await getTencentQuotes(missing);
      for (const [code, row] of publicQuotes) quoteMap.set(code, row);
    } catch (error) {
      console.warn("Tencent quote fallback unavailable:", error.message);
    }
  }
  return quoteMap;
}

async function getRealtimeQuote(code) {
  const result = await eastmoneyJson(`https://push2.eastmoney.com/api/qt/stock/get?ut=${EM_UT}&fltt=2&invt=2&fields=f43,f44,f45,f46,f47,f48,f50,f57,f58,f60,f62,f168,f169,f170,f171&secid=${secidFor(code)}`);
  const row = result?.data;
  if (!row?.f57) return null;
  return {
    f12: row.f57,
    f14: row.f58,
    f2: row.f43,
    f3: row.f170,
    f4: row.f169,
    f5: row.f47,
    f6: row.f48,
    f7: row.f171,
    f8: row.f168,
    f10: row.f50,
    f15: row.f44,
    f16: row.f45,
    f17: row.f46,
    f18: row.f60,
    f62: row.f62
  };
}

function normalizeRealtimeQuote(row) {
  if (!row) return null;
  return {
    price: toNum(row.f2),
    pct: toNum(row.f3),
    change: toNum(row.f4),
    volume: toNum(row.f5),
    amount: moneyText(row.f6),
    amplitude: toNum(row.f7),
    turnover: toNum(row.f8),
    volumeRatio: toNum(row.f10),
    high: toNum(row.f15),
    low: toNum(row.f16),
    open: toNum(row.f17),
    preClose: toNum(row.f18),
    mainNet: toNum(row.f62)
  };
}

async function getWatchlist({ withQuotes = false } = {}) {
  const list = await readWatchlist();
  if (!withQuotes || !list.length) return list;
  const quotes = await getRealtimeQuotes(list.map((item) => item.code).filter(Boolean)).catch(() => new Map());
  return list.map((item) => ({
    ...item,
    realtimeQuote: normalizeRealtimeQuote(quotes.get(item.code))
  }));
}

async function getDailyKlines(code, limit = 90) {
  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secidFor(code)}&klt=101&fqt=1&lmt=${limit}&end=20500101&iscca=1&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61`;
  try {
    const result = await eastmoneyFetchJson(url, 8000);
    const rows = (result?.data?.klines || []).map(parseKline);
    if (rows.length) return rows;
  } catch {
    // Fall through to curl and public historical K-line fallback.
  }
  try {
    const result = await eastmoneyJson(url);
    const rows = (result?.data?.klines || []).map(parseKline);
    if (rows.length) return rows;
  } catch {
    // Fall through to Tencent historical K-line.
  }
  return getTencentDailyKlines(code, limit);
}

async function getIndexDailyKlines(index, limit = 24) {
  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${index.secid}&klt=101&fqt=1&lmt=${limit}&end=20500101&iscca=1&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61`;
  try {
    const result = await eastmoneyFetchJson(url, 8000);
    const rows = (result?.data?.klines || []).map(parseKline);
    if (rows.length) return rows;
  } catch {
    // Try curl-backed Eastmoney access below.
  }
  try {
    const result = await eastmoneyJson(url);
    const rows = (result?.data?.klines || []).map(parseKline);
    if (rows.length) return rows;
  } catch {
    // Fall through to Tencent historical index K-line.
  }
  return getTencentIndexDailyKlines(index, limit).catch(() => []);
}

async function getFundFlow(code, limit = 30) {
  const cached = getCachedFundFlow(code, limit);
  if (cached?.length) return cached;
  try {
    const mxRows = await getMxFundFlowsForStocks([{ code }], limit);
    const rows = mxRows.get(String(code).replace(/\D/g, "").slice(0, 6));
    if (rows?.length) return rows;
  } catch {
    // Fall through to Eastmoney public fund-flow endpoints.
  }
  const secid = secidFor(code);
  const fields = "fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55";
  const urls = [
    `https://push2his.eastmoney.com/api/qt/stock/fflow/kline/get?secid=${secid}&lmt=${limit}&klt=101&${fields}`,
    `https://push2.eastmoney.com/api/qt/stock/fflow/kline/get?secid=${secid}&lmt=${limit}&klt=101&${fields}`,
    `https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get?secid=${secid}&lmt=${limit}&klt=101&${fields}`
  ];
  let lastError;
  for (const url of urls) {
    try {
      const result = await eastmoneyFetchJson(url, 8000);
      const rows = (result?.data?.klines || []).map(parseFundLine).filter((row) => row.date);
      if (rows.length) {
        setCachedFundFlow(code, limit, rows);
        return rows;
      }
    } catch (error) {
      lastError = error;
    }
    try {
      const result = await eastmoneyJson(url);
      const rows = (result?.data?.klines || []).map(parseFundLine).filter((row) => row.date);
      if (rows.length) {
        setCachedFundFlow(code, limit, rows);
        return rows;
      }
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`东方财富主力资金接口空返: ${lastError?.message || "no rows"}`);
}

function nearestBelow(price, levels) {
  return levels
    .filter((item) => Number.isFinite(item.value) && item.value > 0 && item.value <= price)
    .sort((a, b) => b.value - a.value)[0] || null;
}

function nearestAbove(price, levels) {
  return levels
    .filter((item) => Number.isFinite(item.value) && item.value > 0 && item.value >= price)
    .sort((a, b) => a.value - b.value)[0] || null;
}

function analyzeHolding(item, quote, klines, fundLines) {
  const last = klines.at(-1) || {};
  const price = toNum(quote?.f2 || last.close);
  const pct = toNum(quote?.f3 || last.pct);
  const ma5 = ma(klines, 5);
  const ma10 = ma(klines, 10);
  const ma20 = ma(klines, 20);
  const ma60 = ma(klines, 60);
  const recent5 = klines.slice(-5);
  const recent10 = klines.slice(-10);
  const recent20 = klines.slice(-20);
  const high5 = Math.max(...recent5.map((row) => row.high));
  const low5 = Math.min(...recent5.map((row) => row.low));
  const high10 = Math.max(...recent10.map((row) => row.high));
  const low10 = Math.min(...recent10.map((row) => row.low));
  const high20 = Math.max(...recent20.map((row) => row.high));
  const low20 = Math.min(...recent20.map((row) => row.low));
  const avgAmount5 = avg(recent5.map((row) => row.amount));
  const avgAmount20 = avg(recent20.map((row) => row.amount));
  const amountRatio = avgAmount20 ? avgAmount5 / avgAmount20 : 0;
  const fund3 = fundLines.slice(-3).reduce((sum, row) => sum + row.mainNet, 0);
  const fund5 = fundLines.slice(-5).reduce((sum, row) => sum + row.mainNet, 0);
  const fund10 = fundLines.slice(-10).reduce((sum, row) => sum + row.mainNet, 0);
  const latestFund = fundLines.at(-1)?.mainNet || 0;
  const realtimeMainNet = toNum(quote?.f62);
  const levels = [
    { name: "MA5", value: ma5 },
    { name: "MA10", value: ma10 },
    { name: "MA20", value: ma20 },
    { name: "MA60", value: ma60 },
    { name: "5日低点", value: low5 },
    { name: "10日低点", value: low10 },
    { name: "20日低点", value: low20 },
    { name: "5日高点", value: high5 },
    { name: "10日高点", value: high10 },
    { name: "20日高点", value: high20 }
  ];
  const support = nearestBelow(price, levels);
  const pressure = nearestAbove(price, levels.filter((level) => level.name.includes("高点") || level.name === "MA5" || level.name === "MA10" || level.name === "MA20"));
  const aboveCount = [ma5, ma10, ma20, ma60].filter((value) => price >= value).length;
  const isBullish = price >= ma5 && ma5 >= ma10 && ma10 >= ma20;
  const isRepair = price >= ma10 && price < ma20;
  const isWeak = price < ma20;
  const fundState = fund3 > 0 && fund5 > 0 ? "资金连续回流" : fund3 > 0 ? "短线资金回流" : fund5 < 0 ? "资金持续流出" : "资金分歧";
  const technicalState = isBullish ? "多头结构" : isRepair ? "修复观察" : isWeak ? "弱势防守" : "震荡结构";
  const tBias = isWeak || fund5 < 0
    ? "防守型反 T 优先"
    : isBullish && fund3 > 0
      ? "顺势低吸高抛"
      : "小区间观察做 T";
  const buyRef = support ? support.value : low5;
  const sellRef = pressure ? pressure.value : high5;
  const tRangePct = price ? ((sellRef - buyRef) / price) * 100 : 0;
  const tScore = Math.round(clamp(
    45 +
    aboveCount * 8 +
    (fund3 > 0 ? 10 : -8) +
    (fund5 > 0 ? 8 : -8) +
    (amountRatio > 1 ? 6 : -3) -
    (Math.abs(pct) > 7 ? 12 : 0),
    0,
    100
  ));
  const positiveHistory = recent20.filter((row) => row.pct > 0);
  const avgPositiveAmp = avg(positiveHistory.map((row) => row.amplitude));
  const riskFlags = [];
  if (price < ma20) riskFlags.push("收盘价/现价在 MA20 下方，做 T 应以防守为主");
  if (fund5 < 0) riskFlags.push(`近5日主力净流出 ${moneyText(Math.abs(fund5))}`);
  if (amountRatio < 0.75) riskFlags.push("近5日成交额低于20日均量，弹性可能不足");
  if (Math.abs(pct) > 7) riskFlags.push("当日波动过大，盘中做 T 容错低");
  return {
    code: item.code,
    name: quote?.f14 || item.name || item.code,
    generatedAt: new Date().toISOString(),
    quote: {
      price,
      pct,
      change: toNum(quote?.f4 || last.change),
      amount: moneyText(quote?.f6 || last.amount),
      turnover: toNum(quote?.f8 || last.turnover),
      volumeRatio: toNum(quote?.f10),
      high: toNum(quote?.f15 || last.high),
      low: toNum(quote?.f16 || last.low),
      open: toNum(quote?.f17 || last.open),
      preClose: toNum(quote?.f18),
      mainNet: realtimeMainNet || latestFund
    },
    technical: {
      ma5: Number(ma5.toFixed(2)),
      ma10: Number(ma10.toFixed(2)),
      ma20: Number(ma20.toFixed(2)),
      ma60: Number(ma60.toFixed(2)),
      high5: Number(high5.toFixed(2)),
      low5: Number(low5.toFixed(2)),
      high10: Number(high10.toFixed(2)),
      low10: Number(low10.toFixed(2)),
      high20: Number(high20.toFixed(2)),
      low20: Number(low20.toFixed(2)),
      state: technicalState,
      structure: [
        price >= ma5 ? "站上 MA5" : "未站上 MA5",
        price >= ma10 ? "站上 MA10" : "未站上 MA10",
        price >= ma20 ? "站上 MA20" : "未站上 MA20",
        isBullish ? "MA5/10/20 多头排列" : "均线未形成完整多头"
      ]
    },
    funds: {
      todayMainNet: moneyText(latestFund),
      fund3: moneyText(fund3),
      fund5: moneyText(fund5),
      fund10: moneyText(fund10),
      state: fundState,
      continuity: fundLines.slice(-5).map((row) => ({ date: row.date, mainNet: row.mainNet, pct: row.pct }))
    },
    tPlan: {
      score: tScore,
      bias: tBias,
      supportName: support?.name || "5日低点",
      support: Number(buyRef.toFixed(2)),
      pressureName: pressure?.name || "5日高点",
      pressure: Number(sellRef.toFixed(2)),
      rangePct: Number(tRangePct.toFixed(2)),
      positiveT: [
        `只在回踩 ${support?.name || "5日低点"} 附近不破、分时重新站回均价线时考虑正 T。`,
        `观察区间：${(buyRef * 0.997).toFixed(2)} - ${(buyRef * 1.006).toFixed(2)}，需要缩量回踩或资金回流配合。`,
        `反弹到 ${pressure?.name || "5日高点"} 附近、量能不能继续放大时，优先把 T 仓降回原持仓。`
      ],
      reverseT: [
        `如果冲高到 ${(sellRef * 0.994).toFixed(2)} - ${(sellRef * 1.004).toFixed(2)} 附近放量滞涨，适合观察反 T。`,
        `回落不破 ${support?.name || "支撑"} 或重新站回均价线，再考虑接回 T 仓。`,
        "如果卖出后继续放量突破压力位，不急着接回，等下一次回踩确认。"
      ],
      stopRules: [
        `跌破 ${support?.name || "支撑"} ${buyRef.toFixed(2)} 且 15-30 分钟不能收回，放弃做 T，先看风险。`,
        "板块转弱、主力资金突然大幅流出、分时高点下移时，不做加仓型 T。",
        "单日振幅不足或成交额明显萎缩时，做 T 空间不够，宁可不动。"
      ],
      historyBasis: [
        `近20日高低区间 ${low20.toFixed(2)} - ${high20.toFixed(2)}，当前靠近${price - low20 < high20 - price ? "下沿/支撑区" : "上沿/压力区"}。`,
        `近5日均成交额 ${moneyText(avgAmount5)}，相对20日均成交额为 ${(amountRatio * 100).toFixed(0)}%。`,
        `近20日上涨日平均振幅 ${avgPositiveAmp.toFixed(2)}%，可作为日内 T 空间是否足够的参考。`
      ]
    },
    risks: riskFlags.length ? riskFlags : ["当前没有明显单项风险，但仍需结合板块、分时承接和个人持仓成本人工判断。"],
    aiExplanation: `${quote?.f14 || item.name || item.code}当前为${technicalState}，资金面显示${fundState}。做 T 更适合按${tBias}处理，核心是围绕支撑 ${buyRef.toFixed(2)} 和压力 ${sellRef.toFixed(2)} 做观察，不做确定性买卖指令。`
  };
}

function userFacingAnalysisError(error) {
  const message = String(error?.message || error || "");
  if (/Empty reply|fetch failed|timeout|aborted|ECONN|ENOTFOUND|ETIMEDOUT|Eastmoney/.test(message)) {
    return "暂时无法读取东方财富历史走势，请稍后刷新分析。";
  }
  if (/历史 K 线为空/.test(message)) {
    return "暂时没有拿到足够的历史 K 线，无法生成做 T 剧本。";
  }
  return "暂时无法生成分析，请稍后刷新。";
}

function buildHoldingFallback(item, quote, reason = "历史走势暂不可用") {
  const price = toNum(quote?.f2);
  const pct = toNum(quote?.f3);
  const amount = moneyText(quote?.f6 || 0);
  const mainNet = toNum(quote?.f62);
  const riskFlags = [];
  if (Math.abs(pct) > 7) riskFlags.push("当日波动较大，盘中操作容错较低");
  if (mainNet < 0) riskFlags.push(`今日主力净流出 ${moneyText(Math.abs(mainNet))}`);
  return {
    code: item.code,
    name: quote?.f14 || item.name || item.code,
    generatedAt: new Date().toISOString(),
    partial: true,
    quote: {
      price: price || "--",
      pct,
      change: toNum(quote?.f4),
      amount,
      turnover: toNum(quote?.f8),
      volumeRatio: toNum(quote?.f10),
      high: toNum(quote?.f15),
      low: toNum(quote?.f16),
      open: toNum(quote?.f17),
      preClose: toNum(quote?.f18),
      mainNet
    },
    technical: {
      ma5: "--",
      ma10: "--",
      ma20: "--",
      ma60: "--",
      high5: "--",
      low5: "--",
      high10: "--",
      low10: "--",
      high20: "--",
      low20: "--",
      state: "走势待确认",
      structure: [
        "历史 K 线暂时不可用，暂不判断均线结构。",
        "暂不展示支撑、压力和形态识别，避免误判。"
      ]
    },
    funds: {
      todayMainNet: moneyText(mainNet),
      fund3: "--",
      fund5: "--",
      fund10: "--",
      state: mainNet > 0 ? "今日资金流入" : mainNet < 0 ? "今日资金流出" : "资金待确认",
      continuity: []
    },
    tPlan: {
      score: "--",
      bias: "先观察，不做剧本化做 T",
      supportName: "待历史走势恢复",
      support: "--",
      pressureName: "待历史走势恢复",
      pressure: "--",
      rangePct: "--",
      positiveT: [
        "历史 K 线暂时不可用，先不生成低吸高抛区间。",
        "只观察分时均价线、成交额变化和板块强弱，等待历史走势恢复后再生成完整剧本。"
      ],
      reverseT: [
        "暂不生成反 T 价格区间。",
        "如果盘中放量滞涨或板块转弱，优先降低操作频率。"
      ],
      stopRules: [
        "没有历史支撑位时，不做加仓型 T。",
        "若分时跌破均价线且无法收回，先按风险处理。",
        "等系统拿到历史 K 线后，再重新刷新完整分析。"
      ],
      historyBasis: [
        reason,
        "当前只使用实时价格、涨跌幅、成交额、换手率和主力资金做简版判断。"
      ]
    },
    risks: riskFlags.length ? riskFlags : ["历史走势暂不可用，支撑、压力、均线形态需要稍后刷新确认。"],
    aiExplanation: `${quote?.f14 || item.name || item.code}当前只能读取实时行情，暂时不能可靠识别 K 线形态。系统已隐藏形态、支撑和压力判断，只给出简版持仓处理：先观察分时承接、板块强弱和资金方向，不做剧本化做 T。`
  };
}

async function analyzeWatchlist() {
  const list = await getWatchlist();
  const codes = list.map((item) => item.code).filter(Boolean);
  const quotes = await getRealtimeQuotes(codes).catch(() => new Map());
  const fundMap = await getMxFundFlowsForStocks(list, 10).catch(() => new Map());
  const analyses = [];
  for (const item of list) {
    try {
      const quote = quotes.get(item.code);
      const [klines, fundLines] = await Promise.all([
        getDailyKlines(item.code, 90).catch(() => []),
        (async () => fundMap.get(item.code) || getCachedFundFlow(item.code, 10) || await getFundFlow(item.code, 10).catch(() => []))()
      ]);
      if (!klines.length) {
        analyses.push(buildHoldingFallback(item, quote, "东方财富历史 K 线接口暂时空返"));
        continue;
      }
      if (!fundLines.length) {
        const fallback = buildHoldingFallback(item, quote, "东方财富主力资金接口暂时空返");
        analyses.push({
          ...fallback,
          funds: {
            ...fallback.funds,
            todayMainNet: "--",
            fund3: "--",
            fund5: "--",
            fund10: "--",
            state: "资金未完成",
            continuity: []
          },
          aiExplanation: `${fallback.name}暂时没有拿到东方财富主力资金流水，系统不生成资金判断；请稍后刷新。`
        });
        continue;
      }
      analyses.push(analyzeHolding(item, quote, klines, fundLines));
    } catch (error) {
      analyses.push({
        code: item.code,
        name: item.name || item.code,
        error: userFacingAnalysisError(error),
        generatedAt: new Date().toISOString()
      });
    }
  }
  return { generatedAt: new Date().toISOString(), analyses };
}

function limitUpThreshold(code) {
  return /^(300|301|688|689)/.test(String(code || "")) ? 19 : 9.5;
}

function estimateVwap(kline) {
  const volumeShares = toNum(kline?.volume) * 100;
  const amount = toNum(kline?.amount);
  if (volumeShares > 0 && amount > 0) return amount / volumeShares;
  const prices = [kline?.open, kline?.high, kline?.low, kline?.close].map(toNum).filter((value) => value > 0);
  return prices.length ? avg(prices) : 0;
}

async function getLimitDayAveragePrice(code, tradeDate, fallbackKline, name = "") {
  const normalized = String(code || "").replace(/\D/g, "").slice(0, 6);
  const date = normalizeTradeDate(tradeDate);
  const cacheKey = `${normalized}:${date}`;
  const cached = INTRADAY_AVG_MEMORY.get(cacheKey);
  if (cached && Date.now() - cached.savedAt < FUND_FLOW_TTL_MS) return cached.value;
  const fallbackPrice = estimateVwap(fallbackKline);
  const fallback = {
    price: fallbackPrice,
    source: fallbackPrice ? "日K成交均价兜底" : "均价待确认",
    samples: 0
  };
  if (!normalized || !date) return fallback;
  try {
    const result = await mxQuery(`${name || ""}${normalized} ${date} 分时均价 成交均价`);
    const tables = extractDataTables(result);
    for (const dto of tables) {
      const table = dto?.rawTable || dto?.table || {};
      const nameMap = dto?.nameMap || {};
      const key = Object.keys(table).find((item) => item !== "headName" && /均价/.test(String(nameMap[item] || "")));
      const value = key && Array.isArray(table[key]) ? toNum(table[key][0]) : 0;
      if (value > 0) {
        const mxValue = {
          price: value,
          source: "东方财富妙想涨停日分时均价",
          samples: 1
        };
        INTRADAY_AVG_MEMORY.set(cacheKey, { savedAt: Date.now(), value: mxValue });
        return mxValue;
      }
    }
  } catch {
    // Fall through to public Eastmoney intraday trends.
  }
  const url = `https://push2his.eastmoney.com/api/qt/stock/trends2/get?secid=${secidFor(normalized)}&fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13&fields2=f51,f52,f53,f54,f55,f56,f57,f58&ndays=5&iscr=0&iscca=0`;
  try {
    const result = await eastmoneyJson(url);
    const rows = (result?.data?.trends || []).map(parseTrendLine).filter((row) => row.date === date && row.avgPrice > 0);
    const last = rows.at(-1);
    if (last?.avgPrice) {
      const value = {
        price: last.avgPrice,
        source: "东方财富涨停日分时均价",
        samples: rows.length
      };
      INTRADAY_AVG_MEMORY.set(cacheKey, { savedAt: Date.now(), value });
      return value;
    }
  } catch {
    // Use the daily K-line VWAP fallback below.
  }
  INTRADAY_AVG_MEMORY.set(cacheKey, { savedAt: Date.now(), value: fallback });
  return fallback;
}

function parseMxAverageRows(dto) {
  const table = dto?.rawTable || dto?.table || {};
  const output = new Map();
  for (const [key, values] of Object.entries(table)) {
    if (key === "headName" || !Array.isArray(values) || !values.length) continue;
    const match = key.match(/\((\d{6})\./) || key.match(/(\d{6})/);
    const code = match?.[1];
    const price = toNum(values[0]);
    if (code && price > 0) {
      output.set(code, {
        price,
        source: "东方财富妙想涨停日分时均价",
        samples: 1
      });
    }
  }
  if (!output.size) {
    const code = String(dto?.code || "").replace(/\D/g, "").slice(0, 6);
    const tableKey = Object.keys(table).find((key) => key !== "headName");
    const price = tableKey && Array.isArray(table[tableKey]) ? toNum(table[tableKey][0]) : 0;
    if (code && price > 0) {
      output.set(code, {
        price,
        source: "东方财富妙想涨停日分时均价",
        samples: 1
      });
    }
  }
  return output;
}

async function getMxLimitDayAveragePrices(items) {
  const output = new Map();
  const pending = [];
  for (const item of items) {
    const code = String(item?.seed?.code || "").replace(/\D/g, "").slice(0, 6);
    const date = normalizeTradeDate(item?.previous?.date);
    const cacheKey = `${code}:${date}`;
    const cached = INTRADAY_AVG_MEMORY.get(cacheKey);
    if (cached && Date.now() - cached.savedAt < FUND_FLOW_TTL_MS) {
      output.set(code, cached.value);
      continue;
    }
    if (code && date) pending.push({ item, code, date, cacheKey });
  }
  const byDate = new Map();
  for (const row of pending) {
    if (!byDate.has(row.date)) byDate.set(row.date, []);
    byDate.get(row.date).push(row);
  }
  for (const [date, rows] of byDate.entries()) {
    for (let index = 0; index < rows.length; index += 8) {
      const chunk = rows.slice(index, index + 8);
      const targetCodes = new Set(chunk.map((row) => row.code));
      const names = chunk.map((row) => `${row.item.seed.name || ""}${row.code}`);
      const anchor = targetCodes.has("003031") ? [] : ["中瓷电子003031"];
      const query = `${[...anchor, ...names].join("、")} ${date} 分时均价 成交均价`;
      try {
        const result = await mxQuery(query);
        const tables = extractDataTables(result);
        for (const dto of tables) {
          const parsed = parseMxAverageRows(dto);
          for (const [code, value] of parsed.entries()) {
            if (!targetCodes.has(code) || !value?.price) continue;
            const row = chunk.find((item) => item.code === code);
            if (!row) continue;
            INTRADAY_AVG_MEMORY.set(row.cacheKey, { savedAt: Date.now(), value });
            output.set(code, value);
          }
        }
      } catch (error) {
        console.warn("MX limit-day average unavailable:", query, error.message);
      }
      await sleep(900);
    }
  }
  return output;
}

function normalizeBuyAlertSeed(row, index = 0) {
  const code = String(pick(row, ["f12", "SECURITY_CODE", "股票代码", "证券代码", "代码", "code"], "")).replace(/\D/g, "").slice(0, 6);
  const name = String(pick(row, ["f14", "SECURITY_SHORT_NAME", "股票简称", "证券简称", "名称", "name"], code || `候选${index + 1}`));
  if (!code || /ST|退/.test(name)) return null;
  const rawTags = [
    pick(row, ["所属行业", "行业", "板块", "sector"], ""),
    pick(row, ["所属概念", "所属概念板块", "概念题材", "题材概念", "概念"], "")
  ].filter(Boolean).join(",");
  return {
    code,
    name,
    quoteRow: row.f12 ? row : null,
    sector: String(pick(row, ["行业", "所属行业", "板块", "sector"], "涨停回踩")),
    conceptTags: cleanConceptTags(rawTags)
  };
}

function cleanConceptTags(text, limit = 5) {
  const noise = /昨日|融资|融券|深股通|沪股通|富时|罗素|MSCI|中证|深成|上证|百元股|小盘|中盘|大盘|成长|价值|风格|近期新高|百日新高|历史新高|高振幅|高换手|东方财富热股|题材股|最近多板/;
  const tags = String(text || "")
    .split(/[，,、\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => !noise.test(item));
  return [...new Set(tags)].slice(0, limit);
}

function parseMxConceptTagRows(dto) {
  const table = dto?.rawTable || dto?.table || {};
  const result = new Map();
  for (const [key, values] of Object.entries(table)) {
    if (key === "headName" || !Array.isArray(values) || !values.length) continue;
    const match = key.match(/\((\d{6})\./) || key.match(/(\d{6})/);
    const code = match?.[1];
    if (!code) continue;
    const tags = cleanConceptTags(values[0], 5);
    if (tags.length && !result.has(code)) result.set(code, tags);
  }
  return result;
}

async function getMxConceptTagsForStocks(stocks) {
  const output = new Map();
  const pending = [];
  for (const stock of stocks) {
    const code = String(stock?.code || "").replace(/\D/g, "").slice(0, 6);
    if (!code) continue;
    const cached = CONCEPT_TAG_MEMORY.get(code);
    if (cached && Date.now() - cached.savedAt < 24 * 60 * 60 * 1000) {
      output.set(code, cached.tags);
    } else {
      pending.push({ code, name: stock.name || "" });
    }
  }
  for (let index = 0; index < pending.length; index += 10) {
    const chunk = pending.slice(index, index + 10);
    const query = `${chunk.map((stock) => `${stock.name}${stock.code}`).join("、")} 所属行业 所属概念板块 概念题材`;
    try {
      const result = await mxQuery(query);
      const tables = extractDataTables(result);
      for (const dto of tables) {
        const parsed = parseMxConceptTagRows(dto);
        for (const [code, tags] of parsed.entries()) {
          if (!tags.length) continue;
          CONCEPT_TAG_MEMORY.set(code, { savedAt: Date.now(), tags });
          output.set(code, tags);
        }
      }
    } catch (error) {
      console.warn("MX concept tags unavailable:", error.message);
    }
  }
  return output;
}

async function getBuyAlertUniverse() {
  if (MX_APIKEY) {
    try {
      const result = await mxScreen("前一个交易日涨停、今日非ST的A股，返回股票代码、股票简称、最新价、涨跌幅、成交额、换手率、量比、所属行业、所属概念板块");
      const rows = extractScreenRows(result).map(normalizeBuyAlertSeed).filter(Boolean);
      if (rows.length) return { rows, source: "东方财富妙想昨日涨停筛选" };
    } catch (error) {
      console.warn("Buy alert MX universe unavailable:", error.message);
    }
  }
  try {
    const stocks = await getRealtimeAStocks();
    const rows = stocks.map(normalizeBuyAlertSeed).filter(Boolean);
    if (rows.length) return { rows, source: "东方财富全 A 实时股票池兜底" };
  } catch (error) {
    console.warn("Buy alert realtime universe unavailable:", error.message);
  }
  const cached = await readOpportunityCachePayload();
  const cachedRows = [
    ...(cached?.payload?.candidates?.A || []),
    ...(cached?.payload?.candidates?.B || []),
    ...(cached?.payload?.candidates?.C || [])
  ].map((item, index) => normalizeBuyAlertSeed({
    code: item.code,
    name: item.name,
    sector: item.sector
  }, index)).filter(Boolean);
  return { rows: cachedRows, source: cachedRows.length ? "最近机会池缓存候选复核" : "无可用股票池" };
}

function scoreBuyAlert({ seed, quote, klines, fundLines, sectors, averageRef }) {
  const today = klines.at(-1);
  const previous = klines.at(-2);
  if (!today || !previous) return null;
  const threshold = limitUpThreshold(seed.code);
  if (toNum(previous.pct) < threshold) return null;
  const prevLimitPrice = toNum(previous.close);
  const averageSource = averageRef?.source || "日K成交均价兜底";
  const triggerPrice = toNum(averageRef?.price) || estimateVwap(previous);
  if (!/分时均价/.test(averageSource)) return null;
  const currentPrice = toNum(quote?.f2 || today.close);
  if (!currentPrice || !triggerPrice) return null;
  const distancePct = ((currentPrice - triggerPrice) / triggerPrice) * 100;
  const triggered = currentPrice <= triggerPrice * 1.003;
  const nearTrigger = !triggered && distancePct <= 1.2;
  const recent5 = klines.slice(-5);
  const recent20 = klines.slice(-20);
  const ma5 = ma(klines, 5);
  const ma10 = ma(klines, 10);
  const ma20 = ma(klines, 20);
  const fund3 = fundLines.slice(-3).reduce((sum, row) => sum + row.mainNet, 0);
  const fund5 = fundLines.slice(-5).reduce((sum, row) => sum + row.mainNet, 0);
  const fund10 = fundLines.slice(-10).reduce((sum, row) => sum + row.mainNet, 0);
  const avgAmount5 = avg(recent5.map((row) => row.amount));
  const avgAmount20 = avg(recent20.map((row) => row.amount));
  const amountRatio = avgAmount20 ? avgAmount5 / avgAmount20 : 0;
  const pullbackFromLimitPct = prevLimitPrice ? ((prevLimitPrice - currentPrice) / prevLimitPrice) * 100 : 0;
  const sector = sectors.find((item) => seed.sector && (seed.sector.includes(item.name) || item.name.includes(seed.sector))) || null;
  const techScore = clamp(
    28 +
    (currentPrice >= ma5 ? 10 : 0) +
    (currentPrice >= ma10 ? 12 : 0) +
    (currentPrice >= ma20 ? 12 : 0) +
    (triggered ? 12 : nearTrigger ? 6 : -8) -
    (distancePct > 3 ? 12 : 0),
    0,
    70
  );
  const fundScore = clamp((fund3 > 0 ? 12 : -6) + (fund5 > 0 ? 14 : -8) + (fund10 > 0 ? 8 : 0), -16, 34);
  const qualityScore = clamp(
    (amountRatio >= 0.8 && amountRatio <= 1.8 ? 8 : 0) +
    (pullbackFromLimitPct >= 3 && pullbackFromLimitPct <= 12 ? 8 : 0) +
    (sector ? Math.round(sector.score / 10) : 0),
    0,
    24
  );
  const riskPenalty =
    (fund5 < 0 ? 10 : 0) +
    (currentPrice < ma20 ? 8 : 0) +
    (pullbackFromLimitPct > 15 ? 10 : 0) +
    (distancePct > 2.5 ? 8 : 0);
  const score = Math.round(clamp(45 + techScore * 0.45 + fundScore + qualityScore - riskPenalty, 0, 100));
  const status = triggered ? "触发提醒" : nearTrigger ? "接近提醒" : "等待回踩";
  const reasons = [
    `前一交易日涨停 ${fmtServerPct(previous.pct)}，涨停收盘 ${prevLimitPrice.toFixed(2)}`,
    `涨停日分时均价约 ${triggerPrice.toFixed(2)}，来源：${averageSource}，当前距触发价 ${distancePct.toFixed(2)}%`,
    fund5 > 0 ? `近5日主力净流入 ${moneyText(fund5)}` : `近5日主力净流出 ${moneyText(Math.abs(fund5))}`,
    currentPrice >= ma10 ? "当前仍在 MA10 上方" : "当前未站上 MA10",
    sector ? `所属方向接近强势板块：${sector.name}` : "板块强度待确认"
  ];
  const risks = [
    fund5 < 0 ? "近5日主力资金为净流出，可能只是反抽" : "",
    currentPrice < ma20 ? "当前低于 MA20，趋势修复不充分" : "",
    pullbackFromLimitPct > 15 ? "较涨停价回撤过深，涨停溢价可能失效" : "",
    distancePct > 1.2 ? "尚未跌到触发区，先等待价格到位" : ""
  ].filter(Boolean);
  return {
    code: seed.code,
    name: quote?.f14 || seed.name,
    sector: seed.sector,
    conceptTags: seed.conceptTags || [],
    status,
    triggered,
    nearTrigger,
    score,
    currentPrice: Number(currentPrice.toFixed(2)),
    pct: toNum(quote?.f3 || today.pct),
    prevTradeDate: previous.date,
    prevLimitPrice: Number(prevLimitPrice.toFixed(2)),
    prevAveragePrice: Number(triggerPrice.toFixed(2)),
    averagePriceSource: averageSource,
    triggerPrice: Number(triggerPrice.toFixed(2)),
    distancePct: Number(distancePct.toFixed(2)),
    pullbackFromLimitPct: Number(pullbackFromLimitPct.toFixed(2)),
    amount: moneyText(quote?.f6 || today.amount),
    turnover: toNum(quote?.f8 || today.turnover),
    volumeRatio: toNum(quote?.f10),
    funds: {
      fund3: moneyText(fund3),
      fund5: moneyText(fund5),
      fund10: moneyText(fund10)
    },
    technical: {
      ma5: Number(ma5.toFixed(2)),
      ma10: Number(ma10.toFixed(2)),
      ma20: Number(ma20.toFixed(2)),
      amountRatio: Number(amountRatio.toFixed(2))
    },
    reasons,
    risks: risks.length ? risks : ["暂未发现明显资金/趋势硬伤，但仍需看板块和分时承接。"],
    action: triggered
      ? "已到触发区，只能作为观察提醒；需要分时止跌、重新站回均价线，再考虑是否进入交易计划。"
      : nearTrigger
        ? "离触发区很近，等待价格触碰且不继续放量下杀。"
        : "价格还没到触发区，先不追，等待回踩到涨停日分时均价附近。"
  };
}

function fmtServerPct(value) {
  const n = toNum(value);
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function buyAlertRules() {
  return [
    "前一交易日涨停：主板按约 9.5% 以上，创业板/科创板按约 19% 以上识别。",
    "触发价：必须使用东方财富返回的涨停日分时均价；拿不到分时均价的股票不展示。",
    "二次筛选：近3/5/10日主力资金、MA5/10/20、回撤幅度、量能和板块强度综合评分。",
    "只做提醒和排序，不自动下单，也不输出确定性买入指令。"
  ];
}

async function readBuyAlertCachePayload() {
  return await readBuyAlertCache("快速打开买入提醒，先展示最近一次真实分时均价结果") || {
    generatedAt: new Date().toISOString(),
    dataSource: "买入提醒缓存待生成",
    sourceMessage: "当前还没有可用的涨停日分时均价缓存；点击刷新提醒后会重新向东方财富复核。",
    stats: { scanned: 0, total: 0, triggered: 0, nearTrigger: 0 },
    alerts: [],
    rules: buyAlertRules()
  };
}

async function buildBuyAlerts() {
  const { rows, source } = await getBuyAlertUniverse();
  const unique = [];
  const seen = new Set();
  for (const row of rows) {
    if (!row?.code || seen.has(row.code)) continue;
    seen.add(row.code);
    unique.push(row);
  }
  const limited = unique.slice(0, source.includes("全 A") ? 180 : 80);
  const sectors = await readSectorCache();
  const quotes = await getRealtimeQuotes(limited.map((row) => row.code)).catch(() => new Map());
  const fundMap = await getMxFundFlowsForStocks(limited, 10).catch(() => new Map());
  const prepared = (await mapLimit(limited, 6, async (seed) => {
    try {
      const [klines, fundLines] = await Promise.all([
        getDailyKlines(seed.code, 35).catch(() => []),
        (async () => fundMap.get(seed.code) || getCachedFundFlow(seed.code, 10) || await getFundFlow(seed.code, 10).catch(() => []))()
      ]);
      if (klines.length < 2 || !fundLines.length) return null;
      const previous = klines.at(-2);
      if (!previous || toNum(previous.pct) < limitUpThreshold(seed.code)) return null;
      const quote = quotes.get(seed.code) || seed.quoteRow;
      return { seed, quote, klines, fundLines, previous };
    } catch (error) {
      console.warn("Buy alert analysis failed:", seed.code, error.message);
      return null;
    }
  })).filter(Boolean);
  const averageMap = await getMxLimitDayAveragePrices(prepared).catch(() => new Map());
  const alerts = prepared.map((item) => {
    const averageRef = averageMap.get(item.seed.code);
    return scoreBuyAlert({ ...item, sectors, averageRef });
  }).filter(Boolean);
  const sorted = alerts
    .sort((a, b) => Number(b.triggered) - Number(a.triggered) || Number(b.nearTrigger) - Number(a.nearTrigger) || b.score - a.score)
    .slice(0, 30);
  const conceptMap = await getMxConceptTagsForStocks(sorted).catch(() => new Map());
  const tagged = sorted.map((alert) => ({
    ...alert,
    conceptTags: cleanConceptTags([...(conceptMap.get(alert.code) || []), ...(alert.conceptTags || []), alert.sector].join(","), 5)
  }));
  const payload = {
    generatedAt: new Date().toISOString(),
    dataSource: source,
    sourceMessage: sorted.length
      ? `已复核 ${limited.length} 只股票，仅展示已拿到东方财富涨停日分时均价的 ${sorted.length} 只回踩候选。`
      : `已尝试复核 ${limited.length} 只股票，但当前没有拿到可用于触发价的东方财富涨停日分时均价；不展示日K均价兜底候选。`,
    stats: {
      scanned: limited.length,
      total: tagged.length,
      triggered: tagged.filter((item) => item.triggered).length,
      nearTrigger: tagged.filter((item) => item.nearTrigger).length
    },
    alerts: tagged,
    rules: buyAlertRules()
  };
  if (tagged.length) {
    await writeBuyAlertCache(payload);
    return payload;
  }
  return await readBuyAlertCache(payload.sourceMessage) || payload;
}

function extractDataTables(result) {
  return result?.data?.data?.searchDataResultDTO?.dataTableDTOList || [];
}

function extractLatestTableRows(result) {
  const tables = extractDataTables(result);
  return tables.flatMap((dto) => {
    const raw = dto.rawTable || dto.table || {};
    const nameMap = dto.nameMap || {};
    const headers = raw.headName || [];
    const keys = Object.keys(raw).filter((key) => key !== "headName");
    return headers.map((date, index) => {
      const row = {
        date: String(date).slice(0, 16),
        name: dto.entityName || dto.title || "",
        code: dto.code || ""
      };
      for (const key of keys) {
        row[nameMap[key] || key] = Array.isArray(raw[key]) ? raw[key][index] : raw[key];
      }
      return row;
    });
  });
}

function extractScreenRows(result) {
  const inner = result?.data?.data || {};
  const dataList = inner?.allResults?.result?.dataList || [];
  const columns = inner?.allResults?.result?.columns || [];
  const columnMap = new Map(
    columns.map((col) => [
      col.field || col.name || col.key,
      col.displayName || col.title || col.label || col.key
    ])
  );
  if (Array.isArray(dataList) && dataList.length) {
    return dataList.map((row) => {
      const normalized = {};
      for (const [key, value] of Object.entries(row)) {
        normalized[columnMap.get(key) || key] = value;
        normalized[key] = value;
      }
      return normalized;
    });
  }
  const partial = inner.partialResults;
  if (!partial || typeof partial !== "string") return [];
  const lines = partial.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length < 3) return [];
  const headers = lines[0].split("|").map((cell) => cell.trim()).filter(Boolean);
  return lines.slice(2).map((line) => {
    const cells = line.split("|").map((cell) => cell.trim()).filter(Boolean);
    return Object.fromEntries(headers.map((header, index) => [header, cells[index] || ""]));
  });
}

function pick(row, names, fallback = "") {
  for (const name of names) {
    if (row[name] != null && row[name] !== "") return row[name];
  }
  return fallback;
}

function normalizeStock(row, index, sectorRank) {
  const name = String(pick(row, ["SECURITY_SHORT_NAME", "股票简称", "证券简称", "名称"], `候选股${index + 1}`));
  const code = String(pick(row, ["SECURITY_CODE", "股票代码", "证券代码", "代码"], "")).replace(/\D/g, "").slice(0, 6);
  const pct = toNum(pick(row, ["CHG", "涨跌幅 (%)", "涨跌幅", "今日涨跌幅"]));
  const price = toNum(pick(row, ["NEWEST_PRICE", "最新价 (元)", "最新价", "收盘价"]));
  const amount = pick(row, ["成交额", "成交额 (元)", "AMOUNT", "成交金额"], "");
  const turnover = toNum(pick(row, ["换手率", "换手率 (%)", "TURNOVERRATE"]));
  const volumeRatio = toNum(pick(row, ["量比", "VOLUME_RATIO"], 1 + (index % 6) * 0.25));
  const fundFlow = pick(row, ["主力净流入", "主力资金流入", "资金流向", "主力净额"], pct > 0 ? "净流入" : "流出观察");
  const sector = sectorRank[index % sectorRank.length]?.name || "强势主题";
  const maBias = clamp(55 + pct * 3 + volumeRatio * 4 - Math.max(0, pct - 7) * 4, 0, 100);
  const fundStrength = clamp(45 + volumeRatio * 10 + Math.max(0, pct) * 2, 0, 100);
  const sectorStrength = sectorRank[index % sectorRank.length]?.score || 68;
  const volumeQuality = clamp(45 + volumeRatio * 12 + (pct > 0 && pct < 7 ? 12 : 0) - (pct > 8 ? 18 : 0), 0, 100);
  const riskDistance = clamp(80 - Math.max(0, pct - 4) * 6 - (turnover > 18 ? 15 : 0), 0, 100);
  const stockScore = Math.round(
    sectorStrength * 0.25 +
    fundStrength * 0.2 +
    maBias * 0.25 +
    volumeQuality * 0.15 +
    riskDistance * 0.15
  );
  const riskFlags = [];
  if (pct > 8) riskFlags.push("当日涨幅偏大，追高风险增加");
  if (volumeRatio > 3.5 && pct < 2) riskFlags.push("量能放大但价格弹性不足，警惕放量滞涨");
  if (turnover > 18) riskFlags.push("换手过高，分歧偏大");
  if (!code) riskFlags.push("证券代码识别不完整，需要人工复核");
  const category = stockScore >= 80 && riskFlags.length <= 1 ? "A" : stockScore >= 65 ? "B" : "C";
  const trigger = category === "A"
    ? ["板块继续走强", "分时回踩均价线不破", "放量突破或站稳前高"]
    : ["等待回踩 MA5/MA10 不破", "等待资金重新净流入", "等待所属板块排名保持前列"];
  return {
    id: `${code || "NA"}-${index}`,
    name,
    code,
    sector,
    price: price || "--",
    pct,
    amount: amount ? moneyText(amount) : "待接口补充",
    turnover,
    volumeRatio,
    fundFlow: String(fundFlow),
    stockScore,
    category,
    selectedReason: [
      `来自${sector}或资金/量能强势池`,
      volumeRatio >= 1.5 ? "量比高于常态，盘中关注度提升" : "量能处于温和区间",
      pct >= 0 ? "价格表现相对活跃" : "价格仍需修复确认"
    ],
    risks: riskFlags.length ? riskFlags : ["若板块转弱或资金流出，需要降低关注级别"],
    triggerConditions: trigger,
    abandonConditions: ["跌破 MA10 或关键分时均价线", "板块转弱且联动下降", "资金大幅流出", "高开低走或放量滞涨"],
    intradayWatch: ["看板块排名是否保持前 5", "看成交额是否持续放大", "看回踩关键均线是否缩量", "看同板块个股是否继续联动"],
    technical: {
      ma: "MA5/MA10/MA20 结构由实时接口和历史补充数据计算；当前为候选评分占位摘要",
      support: "MA10 / 近 20 日低点",
      pressure: "前高 / 近 20 日高点",
      pattern: pct > 5 ? "突破后等待确认" : "观察回踩不破"
    },
    aiExplanation: buildExplanation(category, pct, volumeRatio, sector)
  };
}

function normalizeRealtimeStock(row, index, sectorRank) {
  const rank = row.publicSource === "sina" ? [{ name: "公开行情高成交池", score: 62 }] : sectorRank;
  const normalized = {
    SECURITY_SHORT_NAME: row.f14,
    SECURITY_CODE: row.f12,
    NEWEST_PRICE: row.f2,
    CHG: row.f3,
    "成交额": row.f6,
    "换手率": row.f8,
    "量比": row.f10,
    "主力净流入": "实时行情池，资金明细待资金接口补充"
  };
  return normalizeStock(normalized, index, rank);
}

function buildRealtimeMarket(indices, stocks, sectors) {
  const valid = stocks.filter((row) => Number.isFinite(Number(row.f3)));
  const breadth = calculateBreadthFromStocks(valid, 2500);
  const avgIndex = indices.length
    ? indices.reduce((sum, row) => sum + toNum(row.f3), 0) / indices.length
    : 0;
  const market = classifyRegime(indices.map((row) => ({ "涨跌幅": row.f3 })), sectors);
  return {
    ...market,
    avgIndexPct: Number(avgIndex.toFixed(2)),
    breadth: breadth ? {
      upCount: breadth.upCount,
      downCount: breadth.downCount,
      flatCount: breadth.flatCount,
      limitUpCount: breadth.limitUpCount,
      limitDownCount: breadth.limitDownCount
    } : null,
    totalAmount: breadth ? moneyText(breadth.totalAmount) : "--",
    indices: indices.map((row) => ({
      code: row.f12,
      name: row.f14,
      price: row.f2,
      pct: row.f3,
      amount: moneyText(row.f6)
    })),
    description: breadth
      ? `${market.description} 实时统计：上涨 ${breadth.upCount} 家，下跌 ${breadth.downCount} 家，涨停约 ${breadth.limitUpCount} 家，跌停约 ${breadth.limitDownCount} 家。`
      : `${market.description} 指数和板块为实时数据；全 A 宽度统计等待批量股票池接口恢复后展示。`
  };
}

function scoreRealtimeCandidates(stocks, sectors) {
  return stocks
    .filter((row) => row.f12 && row.f14 && !/ST|退/.test(row.f14))
    .filter((row) => toNum(row.f6) >= 100000000)
    .filter((row) => toNum(row.f2) > 0 && toNum(row.f3) > -3)
    .filter((row) => !(toNum(row.f3) >= 19.8 && toNum(row.f10) < 0.8))
    .sort((a, b) => {
      const scoreA = toNum(a.f6) * 0.00000001 + toNum(a.f10) * 8 + Math.max(0, toNum(a.f3)) * 2;
      const scoreB = toNum(b.f6) * 0.00000001 + toNum(b.f10) * 8 + Math.max(0, toNum(b.f3)) * 2;
      return scoreB - scoreA;
    })
    .slice(0, 36)
    .map((row, index) => normalizeRealtimeStock(row, index, sectors));
}

function buildExplanation(category, pct, volumeRatio, sector) {
  if (category === "A") {
    return `${sector}强度较高，个股资金和量能配合较好。当前更适合重点盯盘，仍需要等待分时承接或突破确认，不做确定性预测。`;
  }
  if (category === "B") {
    return `${sector}有一定活跃度，但个股还缺少更清晰的确认信号。更适合观察等待，重点看回踩均线不破或资金重新流入。`;
  }
  return `个股存在位置、量价或板块分化风险。当前风险收益比不佳，适合暂不参与或仅做盘中观察。`;
}

function classifyRegime(marketRows, sectors) {
  const pctValues = marketRows.map((row) => toNum(pick(row, ["涨跌幅", "涨跌幅(%)", "f3"], 0)));
  const avgIndex = pctValues.length ? pctValues.reduce((a, b) => a + b, 0) / pctValues.length : 0;
  const strongSectors = sectors.filter((sector) => sector.score >= 72).length;
  let marketRegime = "neutral";
  let positionRange = "2 - 5 成";
  let attackable = "等待确认";
  if (avgIndex > 0.7 && strongSectors >= 3) {
    marketRegime = "attack";
    positionRange = "4 - 7 成";
    attackable = "适合进攻观察";
  } else if (avgIndex < -1.2 || strongSectors <= 1) {
    marketRegime = "highRisk";
    positionRange = "0 - 2 成";
    attackable = "不适合强行出手";
  } else if (avgIndex < -0.35) {
    marketRegime = "defensive";
    positionRange = "0 - 3 成";
    attackable = "防守观察";
  }
  return {
    marketRegime,
    positionRange,
    attackable,
    avgIndexPct: Number(avgIndex.toFixed(2)),
    description: marketRegime === "highRisk"
      ? "当前市场风险偏高，系统不强行推荐，优先空仓或轻仓观察。"
      : marketRegime === "attack"
        ? "指数与板块共振较好，可以提高候选池观察密度，但仍需触发条件确认。"
        : marketRegime === "defensive"
          ? "指数偏弱，候选池以低风险观察和回踩确认优先。"
          : "市场处于震荡观察区，适合等板块持续性和个股触发条件。"
  };
}

function scoreSectors(rawRows, { allowFallback = false } = {}) {
  const fallbackNames = ["机器人", "固态电池", "半导体", "电力设备", "创新药"];
  const looksLikeStocks = rawRows.some((row) => pick(row, ["SECURITY_CODE", "股票代码", "证券代码", "代码"], ""));
  const cleanRows = rawRows.filter((row) => {
    const name = String(pick(row, ["f14", "板块名称", "行业名称", "概念名称", "name"], ""));
    const code = String(pick(row, ["f12", "板块代码", "代码"], ""));
    return name && !/ST|退|昨日|融资融券|标准普尔|MSCI|富时|证金持股/.test(name) && (!code || /^BK/.test(code));
  });
  const source = !looksLikeStocks && cleanRows.length ? cleanRows : [];
  if (!source.length && !allowFallback) return [];
  const rows = source.length ? source : fallbackNames.map((name, index) => ({ name, index }));
  const maxAmount = Math.max(1, ...rows.map((row) => toNum(pick(row, ["f6", "成交额", "成交额 (元)", "AMOUNT"], 0))));
  const positiveFunds = rows.map((row) => Math.max(0, toNum(pick(row, ["f62", "主力净流入", "资金流向", "主力净额"], 0))));
  const maxFund = Math.max(1, ...positiveFunds);
  return rows
    .map((row, index) => {
      const name = String(pick(row, ["f14", "板块名称", "行业名称", "概念名称", "SECURITY_SHORT_NAME", "name"], fallbackNames[index] || "强势板块"));
      const todayPct = clamp(toNum(pick(row, ["f3", "涨跌幅", "今日涨幅", "CHG"], allowFallback ? 2.8 - index * 0.25 : 0)), -12, 12);
      const threeDayRaw = pick(row, ["近3日涨跌幅", "近三日涨幅"], "");
      const threeDayPct = threeDayRaw === "" ? null : clamp(toNum(threeDayRaw), -20, 20);
      const amount = toNum(pick(row, ["f6", "成交额", "成交额 (元)", "AMOUNT"], 0));
      const fund = toNum(pick(row, ["f62", "主力净流入", "资金流向", "主力净额"], 0));
      const leader = String(pick(row, ["f128"], ""));
      const todayScore = clamp(todayPct * 3.4 + 2, 0, 20);
      const nearTermScore = threeDayPct == null ? clamp(todayPct * 2.2, 0, 20) : clamp(threeDayPct * 2 + 5, 0, 20);
      const amountScore = clamp((amount / maxAmount) * 20, 0, 20);
      const fundScore = fund > 0 ? clamp((fund / maxFund) * 20, 0, 20) : 0;
      const limitScore = clamp(todayPct * 2.4 + (leader ? 4 : 0), 0, 20);
    const score = Math.round(
      todayScore +
      nearTermScore +
      amountScore +
      fundScore +
      limitScore
    );
      return {
        name,
        todayPct: Number(todayPct.toFixed(2)),
        threeDayPct: threeDayPct == null ? null : Number(threeDayPct.toFixed(2)),
        amountChange: amount ? `成交额 ${moneyText(amount)}` : "成交额待补充",
        fundFlow: fund > 0 ? `净流入 ${moneyText(fund)}` : fund < 0 ? `净流出 ${moneyText(Math.abs(fund))}` : "资金待补充",
        limitCount: null,
        linkage: leader ? `领涨 ${leader}` : "--",
        score: clamp(score, 0, 100),
        reason: [
          `东方财富板块实时涨幅 ${todayPct.toFixed(2)}%`,
          amount ? `成交额 ${moneyText(amount)}` : "成交额待补充",
          fund > 0 ? `主力资金净流入 ${moneyText(fund)}` : "主力资金未显示净流入",
          leader ? `领涨股 ${leader}` : ""
        ].filter(Boolean).join("；"),
        risk: threeDayPct == null
          ? "近3日强度和板块内涨停数待历史/成分股接口补充，盘中需复核持续性"
          : "若成交额无法延续放大，可能出现分化"
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

function buildSamplePayload(reason = "未能实时获取完整 API 数据，展示本地演示数据") {
  const sectors = scoreSectors([], { allowFallback: true });
  const market = classifyRegime([{ "涨跌幅": 0.38 }, { "涨跌幅": 0.21 }, { "涨跌幅": -0.08 }], sectors);
  const rows = [
    { "股票简称": "样例股份A", "股票代码": "600001", "涨跌幅": "3.2", "最新价": "12.30", "量比": "1.8", "换手率": "5.4", "成交额": "860000000" },
    { "股票简称": "样例科技B", "股票代码": "300002", "涨跌幅": "5.6", "最新价": "28.42", "量比": "2.4", "换手率": "8.1", "成交额": "1210000000" },
    { "股票简称": "样例能源C", "股票代码": "002003", "涨跌幅": "1.1", "最新价": "9.88", "量比": "1.3", "换手率": "3.2", "成交额": "420000000" },
    { "股票简称": "样例材料D", "股票代码": "603004", "涨跌幅": "8.7", "最新价": "41.20", "量比": "4.1", "换手率": "19.6", "成交额": "1680000000" }
  ];
  const candidates = rows.map((row, index) => normalizeStock(row, index, sectors));
  return packagePayload(market, sectors, candidates, false, reason);
}

function packagePayload(market, sectors, candidates, live, sourceMessage) {
  const filtered = market.marketRegime === "highRisk"
    ? candidates.sort((a, b) => b.stockScore - a.stockScore).slice(0, 6)
    : candidates.sort((a, b) => b.stockScore - a.stockScore).slice(0, 12);
  const cacheOnly = sourceMessage.includes("缓存") && !candidates.length && !(market.indices || []).length;
  return {
    generatedAt: new Date().toISOString(),
    dataSource: cacheOnly
      ? "东方财富板块缓存（指数/个股实时接口空返）"
      : /新浪|腾讯|公开行情/.test(sourceMessage)
        ? "新浪/腾讯公开行情 API（服务端兜底）"
      : live && sourceMessage.includes("push2")
      ? "东方财富实时行情 API（push2 服务端代理）"
      : live
        ? "东方财富妙想 API（服务端代理）"
        : "本地演示数据",
    sourceMessage,
    cashMode: true,
    market,
    sectors,
    candidates: {
      A: filtered.filter((item) => item.category === "A"),
      B: filtered.filter((item) => item.category === "B"),
      C: filtered.filter((item) => item.category === "C")
    },
    safety: [
      "仅做候选池、风险提示、盯盘提醒和复盘",
      "不做自动交易，不连接券商下单",
      "不承诺收益，不输出确定性买卖指令",
      "东方财富 API Key 仅在服务端读取"
    ]
  };
}

function packageMixedRealtimePayload(market, sectors, cached, sourceMessage) {
  const candidates = cached?.payload?.candidates || { A: [], B: [], C: [] };
  return {
    generatedAt: new Date().toISOString(),
    dataSource: "东方财富实时指数/板块 + 候选池缓存",
    sourceMessage: `${sourceMessage}；全 A 批量股票池接口临时空返，候选股沿用 ${cacheAgeText(cached?.cachedAt)} 的最近完整缓存。`,
    cashMode: true,
    market,
    sectors,
    candidates: {
      A: Array.isArray(candidates.A) ? candidates.A : [],
      B: Array.isArray(candidates.B) ? candidates.B : [],
      C: Array.isArray(candidates.C) ? candidates.C : []
    },
    safety: cached?.payload?.safety || [
      "仅做候选池、风险提示、盯盘提醒和复盘",
      "不做自动交易，不连接券商下单",
      "不承诺收益，不输出确定性买卖指令",
      "东方财富 API Key 仅在服务端读取"
    ],
    partialRealtime: true,
    cachedAt: cached?.cachedAt
  };
}

function classifyHistoryRegime(avgIndex) {
  let marketRegime = "neutral";
  let positionRange = "2 - 5 成";
  let attackable = "等待确认";
  if (avgIndex > 0.7) {
    marketRegime = "attack";
    positionRange = "4 - 7 成";
    attackable = "适合进攻观察";
  } else if (avgIndex < -1.2) {
    marketRegime = "highRisk";
    positionRange = "0 - 2 成";
    attackable = "不适合强行出手";
  } else if (avgIndex < -0.35) {
    marketRegime = "defensive";
    positionRange = "0 - 3 成";
    attackable = "防守观察";
  }
  return {
    marketRegime,
    positionRange,
    attackable,
    description: marketAdviceFromRegime(marketRegime)
  };
}

function marketAdviceFromRegime(regime) {
  if (regime === "attack") return "可提高候选池观察密度，但仍只等触发确认。";
  if (regime === "defensive") return "防守观察，控制仓位，优先等低风险回踩确认。";
  if (regime === "highRisk") return "不强行出手，优先空仓或轻仓观察。";
  return "轻仓观察，等待板块和资金共振。";
}

function normalizeMarketHistoryEntry(payload) {
  const market = payload?.market || {};
  const breadth = market.breadth || null;
  const regime = market.marketRegime || classifyHistoryRegime(toNum(market.avgIndexPct)).marketRegime;
  return {
    date: chinaDateString(),
    generatedAt: payload?.generatedAt || new Date().toISOString(),
    avgIndexPct: Number(toNum(market.avgIndexPct).toFixed(2)),
    marketRegime: regime,
    positionRange: market.positionRange || classifyHistoryRegime(toNum(market.avgIndexPct)).positionRange,
    attackable: market.attackable || classifyHistoryRegime(toNum(market.avgIndexPct)).attackable,
    advice: marketAdviceFromRegime(regime),
    breadth,
    upDown: breadth ? `${breadth.upCount} / ${breadth.downCount}` : "样本不足",
    limitUpDown: breadth ? `${breadth.limitUpCount} / ${breadth.limitDownCount}` : "样本不足",
    sectorLeaders: (payload?.sectors || []).slice(0, 3).map((sector) => sector.name).filter(Boolean),
    source: payload?.dataSource || "本地记录"
  };
}

async function readMarketHistoryFile() {
  if (!existsSync(MARKET_HISTORY_FILE)) return [];
  try {
    const data = JSON.parse(await readFile(MARKET_HISTORY_FILE, "utf8"));
    return Array.isArray(data.history) ? data.history : [];
  } catch {
    return [];
  }
}

async function writeMarketHistorySnapshot(payload) {
  if (!payload?.market) return;
  const entry = normalizeMarketHistoryEntry(payload);
  const history = await readMarketHistoryFile();
  const byDate = new Map(history.map((item) => [item.date, item]));
  byDate.set(entry.date, { ...byDate.get(entry.date), ...entry });
  const next = [...byDate.values()]
    .filter((item) => /^\d{4}-\d{2}-\d{2}$/.test(String(item.date)))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .slice(-60);
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(MARKET_HISTORY_FILE, JSON.stringify({
    updatedAt: new Date().toISOString(),
    history: next
  }, null, 2), "utf8");
}

async function buildIndexBacktestHistory() {
  const rowsByIndex = await mapLimit(INDEX_SECIDS, 3, async (index) => ({
    index,
    rows: await getIndexDailyKlines(index, 24).catch(() => [])
  }));
  const byDate = new Map();
  for (const item of rowsByIndex) {
    for (const row of item.rows) {
      if (!row.date) continue;
      if (!byDate.has(row.date)) byDate.set(row.date, []);
      byDate.get(row.date).push(row);
    }
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-20)
    .map(([date, rows]) => {
      const avgIndexPct = rows.length ? rows.reduce((sum, row) => sum + toNum(row.pct), 0) / rows.length : 0;
      const regime = classifyHistoryRegime(avgIndexPct);
      return {
        date,
        generatedAt: `${date}T15:00:00+08:00`,
        avgIndexPct: Number(avgIndexPct.toFixed(2)),
        marketRegime: regime.marketRegime,
        positionRange: regime.positionRange,
        attackable: regime.attackable,
        advice: regime.description,
        breadth: null,
        upDown: "历史指数回测",
        limitUpDown: "历史指数回测",
        sectorLeaders: [],
        source: "东方财富/腾讯指数历史K线回测"
      };
    });
}

async function buildMarketHistory() {
  const [stored, backtest] = await Promise.all([
    readMarketHistoryFile(),
    buildIndexBacktestHistory().catch(() => [])
  ]);
  const byDate = new Map(backtest.map((item) => [item.date, item]));
  for (const item of stored) byDate.set(item.date, { ...byDate.get(item.date), ...item, source: item.source || "本地建议记录" });
  const history = [...byDate.values()]
    .filter((item) => item?.date)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .slice(-20);
  return {
    generatedAt: new Date().toISOString(),
    limit: 20,
    dataSource: "东方财富/腾讯指数历史K线 + 本地建议记录",
    history
  };
}

function appendBreadthDescription(description, breadth) {
  const base = String(description || "市场环境已更新。")
    .replace(/指数和板块为实时数据；全 A 宽度统计等待批量股票池接口恢复后展示。?/u, "")
    .replace(/全A宽度：上涨 \d+ 家，下跌 \d+ 家，涨停约 \d+ 家，跌停约 \d+ 家。?/u, "")
    .trim();
  return `${base} 全A宽度：上涨 ${breadth.upCount} 家，下跌 ${breadth.downCount} 家，涨停约 ${breadth.limitUpCount} 家，跌停约 ${breadth.limitDownCount} 家。`;
}

async function finalizeOpportunityPayload(payload) {
  if (!payload?.market) return payload;
  let next = payload;
  if (!next.market.breadth) {
    const breadth = await getBroadMarketBreadth().catch(() => null);
    if (breadth) {
      next = {
        ...next,
        sourceMessage: `${String(next.sourceMessage || "").replace(/[；;。]+$/u, "")}；全A上涨/下跌、涨停/跌停已由全市场公开行情补齐。`,
        market: {
          ...next.market,
          breadth: {
            upCount: breadth.upCount,
            downCount: breadth.downCount,
            flatCount: breadth.flatCount,
            limitUpCount: breadth.limitUpCount,
            limitDownCount: breadth.limitDownCount
          },
          totalAmount: moneyText(breadth.totalAmount),
          description: appendBreadthDescription(next.market.description, breadth)
        }
      };
    }
  }
  await writeMarketHistorySnapshot(next).catch((error) => console.warn("Market history write failed:", error.message));
  return next;
}

function emptyCandidateAnalysis(stock, reason) {
  return {
    ...stock,
    funds: {
      fund3: "--",
      fund5: "--",
      fund10: "--",
      state: "资金待确认",
      detail: reason
    },
    technical: {
      ...stock.technical,
      ma: "东方财富历史 K 线暂时不可用，均线待刷新",
      ma5: "--",
      ma10: "--",
      ma20: "--",
      ma60: "--",
      support: stock.technical?.support || "--",
      pressure: stock.technical?.pressure || "--",
      pattern: "走势待确认",
      state: "走势待确认"
    },
    analysisReady: false
  };
}

function enrichCandidateFromEastmoney(stock, quote, klines, fundLines) {
  if (!klines.length) return emptyCandidateAnalysis(stock, "东方财富历史 K 线暂时空返");
  const price = toNum(quote?.f2 || stock.price || klines.at(-1)?.close);
  const pct = toNum(quote?.f3 || stock.pct || klines.at(-1)?.pct);
  const recent5 = klines.slice(-5);
  const recent10 = klines.slice(-10);
  const recent20 = klines.slice(-20);
  const ma5 = ma(klines, 5);
  const ma10 = ma(klines, 10);
  const ma20 = ma(klines, 20);
  const ma60 = ma(klines, 60);
  const high20 = Math.max(...recent20.map((row) => row.high));
  const low20 = Math.min(...recent20.map((row) => row.low));
  const high10 = Math.max(...recent10.map((row) => row.high));
  const low10 = Math.min(...recent10.map((row) => row.low));
  const avgAmount5 = avg(recent5.map((row) => row.amount));
  const avgAmount20 = avg(recent20.map((row) => row.amount));
  const amountRatio = avgAmount20 ? avgAmount5 / avgAmount20 : 0;
  if (!fundLines.length) return emptyCandidateAnalysis(stock, "东方财富主力资金接口空返，资金面未完成；系统不会用成交额估算主力资金。");
  const fund3 = fundLines.slice(-3).reduce((sum, row) => sum + row.mainNet, 0);
  const fund5 = fundLines.slice(-5).reduce((sum, row) => sum + row.mainNet, 0);
  const fund10 = fundLines.slice(-10).reduce((sum, row) => sum + row.mainNet, 0);
  const latestFund = fundLines.at(-1)?.mainNet || 0;
  const fundStateBase = fund3 > 0 && fund5 > 0
    ? "资金连续流入"
    : fund3 > 0
      ? "短线资金回流"
      : fund5 < 0
        ? "近5日资金流出"
        : "资金分歧";
  const fundState = fundStateBase;
  const isBullish = price >= ma5 && ma5 >= ma10 && ma10 >= ma20;
  const isRepair = price >= ma10 && price < ma20;
  const isWeak = price < ma20;
  const technicalState = isBullish ? "多头结构" : isRepair ? "修复观察" : isWeak ? "弱势防守" : "震荡结构";
  const support = nearestBelow(price, [
    { name: "MA5", value: ma5 },
    { name: "MA10", value: ma10 },
    { name: "MA20", value: ma20 },
    { name: "10日低点", value: low10 },
    { name: "20日低点", value: low20 }
  ]);
  const pressure = nearestAbove(price, [
    { name: "MA5", value: ma5 },
    { name: "MA10", value: ma10 },
    { name: "MA20", value: ma20 },
    { name: "10日高点", value: high10 },
    { name: "20日高点", value: high20 }
  ]);
  const enrichedScore = Math.round(clamp(
    stock.stockScore +
      (fund3 > 0 ? 4 : -3) +
      (fund5 > 0 ? 5 : -5) +
      (price >= ma10 ? 4 : -4) +
      (price >= ma20 ? 4 : -6) +
      (amountRatio >= 0.8 ? 3 : -3) -
      (pct > 8 ? 6 : 0),
    0,
    100
  ));
  const risks = [...(stock.risks || [])];
  if (fund5 < 0) risks.push(`近5日主力净流出 ${moneyText(Math.abs(fund5))}`);
  if (price < ma20) risks.push("当前价低于 MA20，趋势修复不完整");
  if (amountRatio < 0.65) risks.push("近5日成交额低于20日均量，资金参与度不足");
  return {
    ...stock,
    price: price || stock.price,
    pct,
    amount: quote?.f6 ? moneyText(quote.f6) : stock.amount,
    turnover: toNum(quote?.f8 || stock.turnover),
    volumeRatio: toNum(quote?.f10 || stock.volumeRatio),
    fundFlow: `${fundState}，近5日主力 ${moneyText(fund5)}`,
    stockScore: enrichedScore,
    funds: {
      todayMainNet: moneyText(latestFund),
      fund3: moneyText(fund3),
      fund5: moneyText(fund5),
      fund10: moneyText(fund10),
      state: fundState,
      detail: `东方财富主力资金流水：最新日 ${moneyText(latestFund)} / 近3日 ${moneyText(fund3)} / 近5日 ${moneyText(fund5)} / 近10日 ${moneyText(fund10)}`
    },
    technical: {
      ma: `MA5 ${ma5.toFixed(2)} / MA10 ${ma10.toFixed(2)} / MA20 ${ma20.toFixed(2)} / MA60 ${ma60.toFixed(2)}`,
      ma5: Number(ma5.toFixed(2)),
      ma10: Number(ma10.toFixed(2)),
      ma20: Number(ma20.toFixed(2)),
      ma60: Number(ma60.toFixed(2)),
      support: support ? `${support.name} ${support.value.toFixed(2)}` : `20日低点 ${low20.toFixed(2)}`,
      pressure: pressure ? `${pressure.name} ${pressure.value.toFixed(2)}` : `20日高点 ${high20.toFixed(2)}`,
      pattern: technicalState,
      state: technicalState,
      high20: Number(high20.toFixed(2)),
      low20: Number(low20.toFixed(2)),
      amountRatio: Number(amountRatio.toFixed(2))
    },
    selectedReason: [
      ...(stock.selectedReason || []),
      `资金面：${fundState}`,
      `技术面：${technicalState}`,
      "资金数据来自东方财富主力资金流",
      amountRatio >= 1 ? `近5日量能为20日均量 ${(amountRatio * 100).toFixed(0)}%` : `量能偏谨慎：近5日/20日 ${(amountRatio * 100).toFixed(0)}%`
    ],
    risks: [...new Set(risks)],
    triggerConditions: [
      ...(stock.triggerConditions || []),
      `站稳 ${support?.name || "关键支撑"} 后再观察`,
      fund3 > 0 ? "短线主力资金继续流入" : "等待主力资金重新流入"
    ],
    abandonConditions: [
      ...(stock.abandonConditions || []),
      `跌破 ${support?.name || "关键支撑"} 且不能收回`,
      "近3日主力继续净流出"
    ],
    intradayWatch: [
      ...(stock.intradayWatch || []),
      "看分时是否重新站回均价线",
      "看成交额是否保持在5日均量附近"
    ],
    aiExplanation: `${stock.name} 当前资金面为${fundState}，技术面为${technicalState}。近20日区间 ${low20.toFixed(2)} - ${high20.toFixed(2)}，支撑看 ${support?.name || "20日低点"}，压力看 ${pressure?.name || "20日高点"}。候选只作为观察，不构成确定性买入。`,
    analysisReady: true
  };
}

async function enrichPayloadCandidates(payload) {
  const all = [
    ...(payload.candidates?.A || []),
    ...(payload.candidates?.B || []),
    ...(payload.candidates?.C || [])
  ];
  if (!all.length) return payload;
  const quotes = await getRealtimeQuotes(all.map((stock) => stock.code)).catch(() => new Map());
  const fundMap = await getMxFundFlowsForStocks(all, 10).catch(() => new Map());
  const enriched = await mapLimit(all, 4, async (stock) => {
    try {
      const [klines, fundLines] = await Promise.all([
        getDailyKlines(stock.code, 90).catch(() => []),
        (async () => fundMap.get(stock.code) || getCachedFundFlow(stock.code, 10) || await getFundFlow(stock.code, 10).catch(() => []))()
      ]);
      return enrichCandidateFromEastmoney(stock, quotes.get(stock.code), klines, fundLines);
    } catch (error) {
      return emptyCandidateAnalysis(stock, userFacingAnalysisError(error));
    }
  });
  const byId = new Map(enriched.map((stock) => [stock.id, stock]));
  const groups = {};
  for (const key of ["A", "B", "C"]) {
    groups[key] = (payload.candidates?.[key] || [])
      .map((stock) => byId.get(stock.id) || stock)
      .sort((a, b) => b.stockScore - a.stockScore);
  }
  return {
    ...payload,
    sourceMessage: `${String(payload.sourceMessage || "").replace(/[；;。]+$/u, "")}；展示股票资金面已改用东方财富主力资金流水，技术面使用东方财富日K优先、公开历史行情兜底。`,
    candidates: groups
  };
}

async function buildOpportunityPool() {
  const inTradingSession = isAshareTradingSession();
  const preferCacheOutsideSession = shouldPreferCacheOutsideSession();
  let realtimeIssueMessage = "";
  if (!inTradingSession && preferCacheOutsideSession) {
    const cached = await readOpportunityCache("当前在盘前或非交易日，优先展示最近一次完整机会池缓存");
    if (cached) return cached;
  }
  try {
    let indices = [];
    let stocks = [];
    let sectorRows = [];
    try {
      indices = await getRealtimeIndices();
    } catch (error) {
      console.warn("Eastmoney indices unavailable:", error.message);
    }
    try {
      sectorRows = await getRealtimeSectors();
    } catch (error) {
      console.warn("Eastmoney sectors unavailable:", error.message);
    }
    try {
      stocks = await getRealtimeAStocks();
    } catch (error) {
      console.warn("Eastmoney stocks unavailable:", error.message);
    }
    if (indices.length) {
      await writeIndexCache(indices);
    } else {
      indices = await readIndexCache();
    }
    let sectors = scoreSectors(sectorRows);
    let usedSectorCache = false;
    if (sectors.length) {
      await writeSectorCache(sectors);
    } else {
      sectors = await readSectorCache();
      usedSectorCache = sectors.length > 0;
    }
    if ((!indices.length || !stocks.length) && !inTradingSession && preferCacheOutsideSession) {
      realtimeIssueMessage = "当前不在 A 股交易时段，东方财富批量实时接口未返回完整指数/个股数据";
      const cached = await readOpportunityCache(realtimeIssueMessage);
      if (cached) return cached;
    }
    if (!stocks.length) {
      realtimeIssueMessage = inTradingSession
        ? "当前在 A 股交易时段内，但东方财富全 A 批量接口临时空返"
        : "当前已过 15:00，正在重新拉取当日收盘行情；服务端全 A 批量接口临时空返";
      const cached = await readOpportunityCachePayload();
      if ((indices.length || sectors.length) && cached) {
        const market = buildRealtimeMarket(indices, [], sectors);
        return packageMixedRealtimePayload(market, sectors, cached, realtimeIssueMessage);
      }
      if (preferCacheOutsideSession) {
        const cachedPayload = await readOpportunityCache(realtimeIssueMessage);
        if (cachedPayload) return cachedPayload;
      }
    }
    if (indices.length || stocks.length || (sectors.length && !MX_APIKEY)) {
      const market = buildRealtimeMarket(indices, stocks, sectors);
      const candidates = scoreRealtimeCandidates(stocks, sectors);
      const parts = [
        indices.length ? "指数" : "",
        stocks.length ? "全 A" : "",
        sectors.length ? (usedSectorCache ? "行业/概念板块排行缓存" : "行业/概念板块排行") : ""
      ].filter(Boolean).join("、");
      const usedPublicStockFallback = stocks.some((row) => row.publicSource === "sina");
      let payload = packagePayload(
        market,
        sectors,
        candidates,
        true,
        usedSectorCache && !indices.length && !stocks.length
          ? `${realtimeIssueMessage || "东方财富 push2 指数和全 A 实时接口当前空返"}；本地尚未生成完整机会池缓存，暂用最近一次行业/概念板块排行缓存，候选股不展示旧数据。`
          : usedPublicStockFallback
            ? `东方财富全 A 接口空返，已切换新浪公开行情补全${parts || "部分实时数据"}；指数/个股报价可用腾讯公开行情兜底。`
            : `已通过东方财富 push2 实时行情接口获取${parts || "部分实时数据"}`
      );
      payload = await enrichPayloadCandidates(payload);
      if (indices.length && stocks.length && candidates.length) await writeOpportunityCache(payload);
      return payload;
    }
  } catch (error) {
    console.warn("Eastmoney realtime fallback:", error.message);
  }

  if (!MX_APIKEY) {
    return buildSamplePayload("服务端未检测到 MX_APIKEY。请用已配置环境变量的 shell 启动服务。");
  }

  try {
    const [marketResult, sectorResult, screenA, screenB, screenC] = await Promise.all([
      mxQuery("上证指数 深成指 创业板指 科创50 沪深300 中证1000 今日涨跌幅 成交额"),
      mxScreen("今日涨幅靠前的A股行业板块或概念板块，包含涨跌幅、成交额、资金流入"),
      mxScreen("今日主力资金净流入靠前、量比大于1.2、成交额较高、非ST的A股"),
      mxScreen("近5日强势、近10日强势、站上MA20、非ST的A股"),
      mxScreen("回踩均线不破、成交额放大、技术形态转强、非ST的A股")
    ]);
    const marketRows = extractLatestTableRows(marketResult);
    const sectorRows = extractScreenRows(sectorResult);
    const sectors = scoreSectors(sectorRows);
    const rawCandidates = [...extractScreenRows(screenA), ...extractScreenRows(screenB), ...extractScreenRows(screenC)];
    const unique = [];
    const seen = new Set();
    for (const row of rawCandidates) {
      const code = String(pick(row, ["SECURITY_CODE", "股票代码", "证券代码", "代码"], "")).replace(/\D/g, "").slice(0, 6);
      const name = String(pick(row, ["SECURITY_SHORT_NAME", "股票简称", "证券简称", "名称"], ""));
      if (!code || seen.has(code) || /ST|退/.test(name)) continue;
      seen.add(code);
      unique.push(row);
    }
    const candidates = unique.map((row, index) => normalizeStock(row, index, sectors));
    const market = classifyRegime(marketRows, sectors);
    let payload = packagePayload(market, sectors, candidates, true, "已通过服务端调用东方财富妙想 API 生成");
    payload = await enrichPayloadCandidates(payload);
    if (marketRows.length && candidates.length) await writeOpportunityCache(payload);
    return payload;
  } catch (error) {
    return buildSamplePayload(`东方财富 API 调用失败，已降级演示：${error.message}`);
  }
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function saveOpportunityCacheFromClient(payload) {
  if (!payload?.market || !hasOpportunityCandidates(payload)) {
    return { saved: false, reason: "缺少市场摘要或候选股数据" };
  }
  await writeOpportunityCache({
    ...payload,
    sourceMessage: payload.sourceMessage || "浏览器直连东方财富 push2 获取的完整实时行情"
  });
  return { saved: true };
}

async function addWatchlist(item) {
  await mkdir(DATA_DIR, { recursive: true });
  const list = await readWatchlist();
  const exists = list.some((entry) => entry.code === item.code);
  const next = exists ? list : [{ ...item, addedAt: new Date().toISOString(), source: "opportunities" }, ...list];
  await writeFile(WATCHLIST_FILE, JSON.stringify(next, null, 2), "utf8");
  return { added: !exists, watchlist: next };
}

async function deleteWatchlist(code) {
  const normalized = String(code || "").replace(/\D/g, "").slice(0, 6);
  if (!normalized) throw new Error("缺少股票代码");
  const list = await readWatchlist();
  const next = list.filter((entry) => entry.code !== normalized);
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(WATCHLIST_FILE, JSON.stringify(next, null, 2), "utf8");
  return { deleted: next.length !== list.length, watchlist: next };
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname === "/" ? "/opportunities" : url.pathname;
  const filePath = pathname === "/opportunities"
    ? path.join(__dirname, "public", "opportunities.html")
    : path.join(__dirname, "public", pathname.replace(/^\/+/, ""));
  if (!filePath.startsWith(path.join(__dirname, "public"))) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  const ext = path.extname(filePath);
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8"
  };
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404).end("Not found");
  }
}

function getLanUrls(port) {
  return Object.values(networkInterfaces())
    .flat()
    .filter((item) => item && item.family === "IPv4" && !item.internal)
    .map((item) => `http://${item.address}:${port}/opportunities`);
}

function normalizeApiPath(pathname) {
  return String(pathname || "")
    .replace(/^\/\.netlify\/functions\/api\/?/u, "/api/")
    .replace(/\/$/u, "");
}

export async function handleApiRequest({ method = "GET", path: requestPath = "", body = {} } = {}) {
  const pathname = normalizeApiPath(requestPath);
  if (method === "GET" && pathname === "/api/opportunities") {
    return finalizeOpportunityPayload(await buildOpportunityPool());
  }
  if (method === "GET" && pathname === "/api/market-history") {
    return buildMarketHistory();
  }
  if (method === "POST" && pathname === "/api/opportunities/cache") {
    return saveOpportunityCacheFromClient(body);
  }
  if (method === "GET" && pathname === "/api/watchlist") {
    return { watchlist: await getWatchlist({ withQuotes: true }) };
  }
  if (method === "GET" && pathname === "/api/watchlist/analysis") {
    return analyzeWatchlist();
  }
  if (method === "GET" && pathname === "/api/buy-alerts") {
    return buildBuyAlerts();
  }
  if (method === "GET" && pathname === "/api/buy-alerts/cache") {
    return readBuyAlertCachePayload();
  }
  if (method === "POST" && pathname === "/api/watchlist") {
    return addWatchlist(body);
  }
  if (method === "DELETE" && pathname.startsWith("/api/watchlist/")) {
    return deleteWatchlist(decodeURIComponent(pathname.split("/").at(-1)));
  }
  const error = new Error("API route not found");
  error.statusCode = 404;
  throw error;
}

async function routeLocalRequest(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/")) {
      json(res, 200, await handleApiRequest({
        method: req.method,
        path: url.pathname,
        body: ["POST", "PUT", "PATCH"].includes(req.method) ? await readBody(req) : {}
      }));
      return;
    }
    await serveStatic(req, res);
  } catch (error) {
    json(res, error.statusCode || 500, { error: error.message });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createServer(routeLocalRequest).listen(PORT, HOST, () => {
    const localUrl = `http://127.0.0.1:${PORT}/opportunities`;
    const lanUrls = getLanUrls(PORT);
    console.log(`机会池页面已启动：${localUrl}`);
    if (lanUrls.length) console.log(`手机同 Wi-Fi 访问：${lanUrls.join("  ")}`);
  });
}
