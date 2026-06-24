const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

const INDEXES = [
  ["sh000001", "000001", "上证指数"],
  ["sz399001", "399001", "深证成指"],
  ["sz399006", "399006", "创业板指"],
  ["sh000688", "000688", "科创50"],
  ["sh000300", "000300", "沪深300"]
];

const FALLBACK_SECTORS = [
  { name: "半导体", todayPct: 2.8, amountChange: "成交活跃", fundFlow: "资金关注", score: 66, linkage: "关注核心权重", reason: "线上轻量模式兜底：半导体方向近期成交活跃，需结合本地深度版确认资金持续性。", risk: "云端数据源不稳定时展示兜底，不作为买入指令。" },
  { name: "机器人", todayPct: 1.9, amountChange: "成交放大", fundFlow: "资金分歧", score: 58, linkage: "观察龙头反馈", reason: "线上轻量模式兜底：机器人方向弹性较高，适合只做观察池。", risk: "若板块不能放量延续，应降低关注。" },
  { name: "创新药", todayPct: 1.4, amountChange: "温和放量", fundFlow: "资金回流", score: 55, linkage: "关注趋势股", reason: "线上轻量模式兜底：医药方向用于防守观察。", risk: "热点持续性弱时不要追高。" }
];

function toNum(value) {
  const n = Number(String(value ?? "").replace(/[%亿万,]/g, "").trim());
  return Number.isFinite(n) ? n : 0;
}

function moneyText(value) {
  const n = toNum(value);
  if (Math.abs(n) >= 100000000) return `${(n / 100000000).toFixed(1)}亿`;
  if (Math.abs(n) >= 10000) return `${(n / 10000).toFixed(1)}万`;
  return n ? String(Math.round(n)) : "0";
}

async function fetchText(url, timeoutMs = 1800) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": "Mozilla/5.0",
        referer: "https://finance.sina.com.cn/"
      }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, timeoutMs = 1800) {
  const text = await fetchText(url, timeoutMs);
  return JSON.parse(text);
}

function parseSinaIndex(text, symbol, code, name) {
  const match = text.match(new RegExp(`var hq_str_${symbol}="([^"]*)"`));
  const parts = match ? match[1].split(",") : [];
  const price = toNum(parts[1] || parts[3]);
  const previous = toNum(parts[2]);
  const pct = previous ? ((price - previous) / previous) * 100 : 0;
  return {
    code,
    name,
    price: Number(price.toFixed(2)),
    pct: Number(pct.toFixed(2)),
    amount: moneyText(toNum(parts[9]))
  };
}

async function getIndices() {
  const symbols = INDEXES.map(([symbol]) => symbol).join(",");
  const text = await fetchText(`https://hq.sinajs.cn/list=${symbols}`, 1800);
  return INDEXES.map(([symbol, code, name]) => parseSinaIndex(text, symbol, code, name))
    .filter((item) => item.price);
}

function normalizeStock(row, index) {
  const price = toNum(row.trade);
  const pct = toNum(row.changepercent);
  const amount = toNum(row.amount);
  const volumeRatio = toNum(row.volume) > 0 ? 1 + Math.min(1.8, Math.abs(pct) / 8) : 1;
  const score = Math.max(45, Math.min(92, Math.round(48 + pct * 4 + Math.log10(Math.max(amount, 1)) * 3)));
  return {
    id: `${row.code}-${index}`,
    name: row.name || row.code,
    code: row.code,
    sector: "线上实时活跃池",
    price,
    pct,
    amount: moneyText(amount),
    turnover: toNum(row.turnoverratio),
    volumeRatio: Number(volumeRatio.toFixed(2)),
    fundFlow: pct >= 3 ? "价格强势，资金需本地深度确认" : "资金待确认",
    stockScore: score,
    category: score >= 82 ? "A" : "B",
    selectedReason: [
      "线上轻量模式按实时涨幅、成交额、量能做快速排序",
      "完整资金面和技术面请用本地版刷新确认",
      pct >= 5 ? "涨幅靠前，适合加入观察但不追高" : "走势活跃，等待回踩确认"
    ],
    risks: ["线上轻量版不做深度资金流水，买入前必须回本地版复核。"],
    triggerConditions: ["回踩分时均价不破", "所属热点板块继续靠前", "成交额维持活跃"],
    abandonConditions: ["冲高回落放量", "跌破分时均价并不能收回", "板块联动转弱"],
    intradayWatch: ["看分时均价线", "看成交额排名", "看同板块核心股是否同步"],
    technical: {
      ma: "线上轻量版待本地补齐",
      support: "分时均价",
      pressure: "当日高点",
      pattern: pct >= 5 ? "强势回踩观察" : "活跃震荡"
    },
    funds: {
      todayMainNet: "待本地深度版确认",
      fund3: "待确认",
      fund5: "待确认",
      state: "线上轻量资金标记"
    },
    analysisReady: true
  };
}

async function getStocks() {
  const urls = [1, 2, 3].map((page) => `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData?page=${page}&num=40&sort=changepercent&asc=0&node=hs_a&symbol=&_s_r_a=page`);
  const results = await Promise.allSettled(urls.map((url) => fetchJson(url, 1800)));
  const rows = results.flatMap((result) => Array.isArray(result.value) ? result.value : []);
  const seen = new Set();
  return rows
    .filter((row) => row?.code && !seen.has(row.code) && seen.add(row.code))
    .map(normalizeStock)
    .filter((stock) => stock.price && stock.pct > 0)
    .sort((a, b) => b.stockScore - a.stockScore)
    .slice(0, 12);
}

function fallbackStocks() {
  return ["中芯国际", "海光信息", "工业富联", "中际旭创", "新易盛", "北方华创"].map((name, index) => normalizeStock({
    code: ["688981", "688041", "601138", "300308", "300502", "002371"][index],
    name,
    trade: [151.53, 337.1, 76.78, 395.2, 318.6, 492.8][index],
    changepercent: [6.9, 6.3, 3.6, 2.8, 2.5, 2.1][index],
    amount: [21160000000, 14960000000, 16220000000, 11900000000, 10500000000, 9800000000][index],
    turnoverratio: [7.1, 2, 1.1, 4.8, 5.2, 2.4][index]
  }, index));
}

function buildMarket(indices, stocks) {
  const avgIndexPct = indices.length
    ? indices.reduce((sum, item) => sum + item.pct, 0) / indices.length
    : 0;
  const upCount = stocks.filter((stock) => stock.pct > 0).length;
  const downCount = stocks.filter((stock) => stock.pct < 0).length;
  return {
    marketRegime: avgIndexPct >= 0.5 ? "watch" : "highRisk",
    positionRange: avgIndexPct >= 0.5 ? "2 - 4 成" : "0 - 2 成",
    attackable: avgIndexPct >= 0.5 ? "只做低吸观察" : "不适合强行出手",
    avgIndexPct: Number(avgIndexPct.toFixed(2)),
    description: "Netlify 线上轻量模式：优先保证页面可用；深度资金面、技术面和持仓分析请打开本地版。",
    breadth: {
      upCount,
      downCount,
      flatCount: Math.max(0, stocks.length - upCount - downCount),
      limitUpCount: stocks.filter((stock) => stock.pct >= 9.8).length,
      limitDownCount: stocks.filter((stock) => stock.pct <= -9.8).length
    },
    totalAmount: moneyText(stocks.reduce((sum, stock) => sum + toNum(stock.amount), 0)),
    indices
  };
}

export async function handler() {
  try {
    const [indicesResult, stocksResult] = await Promise.allSettled([getIndices(), getStocks()]);
    const indices = indicesResult.status === "fulfilled" && indicesResult.value.length ? indicesResult.value : [];
    const stocks = stocksResult.status === "fulfilled" && stocksResult.value.length ? stocksResult.value : fallbackStocks();
    const a = stocks.filter((stock) => stock.category === "A").slice(0, 4);
    const b = stocks.filter((stock) => stock.category !== "A").slice(0, 8);
    const payload = {
      generatedAt: new Date().toISOString(),
      dataSource: "Netlify 线上轻量行情",
      sourceMessage: "线上已拆出轻量机会池函数，避免云函数超时；本地版继续提供东方财富资金面、技术面和更完整的分析。",
      cashMode: true,
      market: buildMarket(indices, stocks),
      sectors: FALLBACK_SECTORS,
      candidates: { A: a, B: b, C: [] },
      safety: [
        "仅做候选池、风险提示、盯盘提醒和复盘",
        "不做自动交易，不连接券商下单",
        "线上轻量版只解决随时查看，交易前请用本地深度版复核"
      ]
    };
    return { statusCode: 200, headers: jsonHeaders, body: JSON.stringify(payload) };
  } catch (error) {
    return {
      statusCode: 200,
      headers: jsonHeaders,
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        dataSource: "Netlify 线上轻量兜底",
        sourceMessage: `线上行情源临时不可用，已返回兜底观察池：${error.message}`,
        cashMode: true,
        market: buildMarket([], fallbackStocks()),
        sectors: FALLBACK_SECTORS,
        candidates: { A: fallbackStocks().slice(0, 2), B: fallbackStocks().slice(2), C: [] },
        safety: ["兜底数据只用于页面可用性，交易前请用本地深度版复核。"]
      })
    };
  }
}
