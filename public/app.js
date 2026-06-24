const state = {
  payload: null,
  selected: null,
  activeTab: "opportunities",
  watchlist: [],
  watchAnalysis: {},
  watchAnalysisLoading: false,
  watchSort: "addedAt",
  expandedHoldings: new Set(),
  buyAlerts: null,
  buyAlertsLoading: false,
  buyAlertFilter: "all",
  buyAlertSort: "smart",
  marketHistory: null,
  marketHistoryLoading: false
};

const el = (id) => document.getElementById(id);

function pctClass(value) {
  return Number(value) >= 0 ? "up" : "down";
}

function fmtPct(value) {
  if (value == null || value === "") return "--";
  const n = Number(value);
  if (!Number.isFinite(n)) return "--";
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function showToast(text) {
  const toast = el("toast");
  toast.textContent = text;
  toast.hidden = false;
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => {
    toast.hidden = true;
  }, 2400);
}

function hasCandidateData(payload) {
  const candidates = payload?.candidates || {};
  return ["A", "B", "C"].some((key) => (candidates[key] || []).length);
}

function normalizePayload(raw, fallbackMessage = "数据暂时不可用") {
  const payload = raw && typeof raw === "object" ? raw : {};
  const market = payload.market && typeof payload.market === "object" ? payload.market : {};
  const candidates = payload.candidates && typeof payload.candidates === "object" ? payload.candidates : {};
  const sourceMessage = payload.sourceMessage || payload.error || fallbackMessage;
  return {
    generatedAt: payload.generatedAt || new Date().toISOString(),
    dataSource: payload.dataSource || (payload.error ? "服务端接口异常" : "数据源待确认"),
    sourceMessage,
    cashMode: payload.cashMode ?? true,
    stale: Boolean(payload.stale),
    cachedAt: payload.cachedAt,
    market: {
      marketRegime: market.marketRegime || "highRisk",
      positionRange: market.positionRange || "0 - 2 成",
      attackable: market.attackable || "暂停筛选",
      avgIndexPct: Number.isFinite(Number(market.avgIndexPct)) ? Number(market.avgIndexPct) : 0,
      breadth: market.breadth || null,
      totalAmount: market.totalAmount || "--",
      indices: Array.isArray(market.indices) ? market.indices : [],
      description: market.description || sourceMessage || "暂时没有拿到完整行情，系统先保持防守状态。"
    },
    sectors: Array.isArray(payload.sectors) ? payload.sectors : [],
    candidates: {
      A: Array.isArray(candidates.A) ? candidates.A : [],
      B: Array.isArray(candidates.B) ? candidates.B : [],
      C: Array.isArray(candidates.C) ? candidates.C : []
    },
    safety: Array.isArray(payload.safety) ? payload.safety : []
  };
}

async function loadOpportunities() {
  el("refreshBtn").disabled = true;
  el("refreshBtnMobile").disabled = true;
  el("refreshBtn").textContent = "刷新中";
  el("refreshBtnMobile").textContent = "刷新中";
  try {
    const response = await fetch("/api/opportunities", { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    state.payload = normalizePayload(response.ok ? data : { ...data, error: data.error || `接口返回 ${response.status}` });
    const serverHasCandidates = hasCandidateData(state.payload);
    const serverHasIndices = (state.payload.market?.indices || []).length > 0;
    const serverHasSectors = (state.payload.sectors || []).length > 0;
    const serverIsStale = state.payload.stale || /缓存|最后成交/.test(state.payload.dataSource || "");
    if (serverIsStale || !serverHasCandidates || !serverHasIndices || !serverHasSectors) {
      const realtime = await loadEastmoneyRealtime().catch(() => null);
      if (realtime) {
        const normalizedRealtime = normalizePayload(realtime);
        state.payload = normalizePayload({
          ...state.payload,
          ...normalizedRealtime,
          candidates: hasCandidateData(normalizedRealtime) ? normalizedRealtime.candidates : state.payload.candidates,
          sectors: normalizedRealtime.sectors.length ? normalizedRealtime.sectors : state.payload.sectors,
          market: {
            ...state.payload.market,
            ...normalizedRealtime.market,
            indices: normalizedRealtime.market.indices.length ? normalizedRealtime.market.indices : state.payload.market.indices,
            breadth: normalizedRealtime.market.breadth || state.payload.market.breadth,
            totalAmount: normalizedRealtime.market.totalAmount !== "--" ? normalizedRealtime.market.totalAmount : state.payload.market.totalAmount
          },
          sourceMessage: normalizedRealtime.sourceMessage || state.payload.sourceMessage
        });
        saveOpportunityCache(realtime);
      } else if (serverIsStale || (!hasCandidateData(state.payload) && !state.payload.dataSource.includes("实时行情") && !(state.payload.sectors || []).length)) {
        state.payload = buildRealtimeIncompletePayload(state.payload, state.payload.sourceMessage || "东方财富实时行情暂时无法连接");
      }
    }
    render();
  } catch (error) {
    showToast(`机会池加载失败：${error.message}`);
    state.payload = normalizePayload(null, `机会池加载失败：${error.message}`);
    render();
  } finally {
    el("refreshBtn").disabled = false;
    el("refreshBtnMobile").disabled = false;
    el("refreshBtn").textContent = "刷新机会池";
    el("refreshBtnMobile").textContent = "刷新";
  }
}

function saveOpportunityCache(payload) {
  fetch("/api/opportunities/cache", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  }).catch(() => {});
}

function buildRealtimeFailedPayload(message) {
  return {
    generatedAt: new Date().toISOString(),
    dataSource: "实时行情未更新",
    sourceMessage: message,
    cashMode: true,
    market: {
      marketRegime: "highRisk",
      positionRange: "0 - 2 成",
      attackable: "暂停筛选",
      avgIndexPct: 0,
      description: "当前没有拿到东方财富实时行情，系统不展示旧候选池，避免误判。请稍后刷新或检查行情接口连接。"
    },
    sectors: [],
    candidates: { A: [], B: [], C: [] },
    safety: []
  };
}

function buildRealtimeIncompletePayload(existing, message) {
  const current = normalizePayload(existing, message);
  return normalizePayload({
    ...current,
    dataSource: "收盘最终行情未完整更新",
    sourceMessage: "15:00 后已重新拉取，但东方财富全 A/板块批量接口仍空返；当前只保留已确认的指数，不展示旧候选池或旧板块排行。",
    cashMode: true,
    sectors: [],
    candidates: { A: [], B: [], C: [] },
    market: {
      ...current.market,
      breadth: null,
      totalAmount: "--",
      attackable: "暂停筛选",
      description: "指数已更新；全 A 候选池和板块排行没有拿到 15:00 后最终数据，已清空旧内容，避免把盘中缓存当成收盘机会。"
    }
  });
}

function jsonp(url) {
  return new Promise((resolve, reject) => {
    const callback = `em_cb_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
    const script = document.createElement("script");
    const separator = url.includes("?") ? "&" : "?";
    window[callback] = (data) => {
      delete window[callback];
      script.remove();
      resolve(data);
    };
    script.onerror = () => {
      delete window[callback];
      script.remove();
      reject(new Error("东方财富实时接口加载失败"));
    };
    script.src = `${url}${separator}cb=${callback}`;
    document.head.appendChild(script);
    window.setTimeout(() => {
      if (window[callback]) {
        delete window[callback];
        script.remove();
        reject(new Error("东方财富实时接口超时"));
      }
    }, 12000);
  });
}

function moneyText(value) {
  const n = Number(value || 0);
  if (Math.abs(n) >= 100000000) return `${(n / 100000000).toFixed(1)}亿`;
  if (Math.abs(n) >= 10000) return `${(n / 10000).toFixed(1)}万`;
  return `${Math.round(n)}`;
}

function parseMoneyValue(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const text = String(value || "").replace(/,/g, "").trim();
  const match = text.match(/(-?\d+(?:\.\d+)?)/);
  if (!match) return 0;
  const n = Number(match[1]);
  if (!Number.isFinite(n)) return 0;
  if (text.includes("亿")) return n * 100000000;
  if (text.includes("万")) return n * 10000;
  return n;
}

function hotSectorNames() {
  return (state.payload?.sectors || [])
    .filter((sector) => Number(sector.score || 0) >= 45 || Number(sector.todayPct || 0) > 0)
    .slice(0, 6)
    .map((sector) => sector.name)
    .filter(Boolean);
}

function matchesHotSector(item, hotNames = hotSectorNames()) {
  const tags = [item.sector, ...(item.conceptTags || [])].filter(Boolean).join(" ");
  return hotNames.some((name) => tags.includes(name) || name.includes(item.sector || ""));
}

function buyAlertRankValue(item, hotNames) {
  const fund5 = parseMoneyValue(item.funds?.fund5);
  return (
    Number(item.triggered) * 900 +
    Number(item.nearTrigger) * 500 +
    Number(matchesHotSector(item, hotNames)) * 130 +
    Number(fund5 > 0) * 90 +
    Number(item.score || 0) +
    Math.max(0, 40 - Math.abs(Number(item.distancePct || 0)) * 4)
  );
}

function getFilteredBuyAlerts(data) {
  const hotNames = hotSectorNames();
  const source = [...(data.alerts || [])];
  const filtered = source.filter((item) => {
    if (state.buyAlertFilter === "ready") return item.triggered || item.nearTrigger;
    if (state.buyAlertFilter === "highScore") return Number(item.score || 0) >= 90;
    if (state.buyAlertFilter === "hot") return matchesHotSector(item, hotNames);
    if (state.buyAlertFilter === "fundIn") return parseMoneyValue(item.funds?.fund5) > 0;
    return true;
  });
  filtered.sort((a, b) => {
    if (state.buyAlertSort === "score") return Number(b.score || 0) - Number(a.score || 0);
    if (state.buyAlertSort === "distance") return Math.abs(Number(a.distancePct || 0)) - Math.abs(Number(b.distancePct || 0));
    if (state.buyAlertSort === "funds") return parseMoneyValue(b.funds?.fund5) - parseMoneyValue(a.funds?.fund5);
    if (state.buyAlertSort === "hot") return Number(matchesHotSector(b, hotNames)) - Number(matchesHotSector(a, hotNames)) || Number(b.score || 0) - Number(a.score || 0);
    return buyAlertRankValue(b, hotNames) - buyAlertRankValue(a, hotNames);
  });
  return { items: filtered, hotNames };
}

function secidForCode(code) {
  const normalized = String(code || "").replace(/\D/g, "").slice(0, 6);
  if (!normalized) return "";
  return /^(5|6|9)/.test(normalized) ? `1.${normalized}` : `0.${normalized}`;
}

function normalizeBrowserQuote(row) {
  if (!row || !row.f12) return null;
  return {
    code: String(row.f12),
    name: row.f14 || String(row.f12),
    price: Number(row.f2 || 0) || "--",
    pct: Number(row.f3 || 0),
    change: Number(row.f4 || 0),
    amount: moneyText(row.f6),
    turnover: Number(row.f8 || 0),
    volumeRatio: Number(row.f10 || 0),
    high: Number(row.f15 || 0),
    low: Number(row.f16 || 0),
    open: Number(row.f17 || 0),
    prevClose: Number(row.f18 || 0),
    mainNet: Number(row.f62 || 0)
  };
}

function normalizeBrowserStockQuote(data, fallbackCode) {
  if (!data) return null;
  const code = String(data.f57 || fallbackCode || "").replace(/\D/g, "").slice(0, 6);
  if (!code) return null;
  return {
    code,
    name: data.f58 || code,
    price: Number(data.f43 || 0) || "--",
    pct: Number(data.f170 || 0),
    change: Number(data.f169 || 0),
    amount: moneyText(data.f48),
    turnover: Number(data.f168 || 0),
    volumeRatio: Number(data.f50 || 0),
    high: Number(data.f44 || 0),
    low: Number(data.f45 || 0),
    open: Number(data.f46 || 0),
    prevClose: Number(data.f60 || 0),
    mainNet: Number(data.f62 || 0)
  };
}

async function loadBrowserQuotes(codes) {
  const uniqueCodes = [...new Set((codes || []).map((code) => String(code || "").replace(/\D/g, "").slice(0, 6)).filter(Boolean))];
  const secids = uniqueCodes.map(secidForCode).filter(Boolean);
  if (!secids.length) return new Map();
  const url = `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&fields=f12,f14,f2,f3,f4,f6,f7,f8,f10,f15,f16,f17,f18,f62&secids=${secids.join(",")}`;
  const result = await jsonp(url);
  const rows = result?.data?.diff || [];
  const quotes = new Map(rows.map(normalizeBrowserQuote).filter(Boolean).map((quote) => [quote.code, quote]));
  const missingCodes = uniqueCodes.filter((code) => !quotes.has(code));
  if (!missingCodes.length) return quotes;
  const fallbackRows = await Promise.allSettled(missingCodes.map(async (code) => {
    const secid = secidForCode(code);
    const stockUrl = `https://push2.eastmoney.com/api/qt/stock/get?ut=bd1d9ddb04089700cf9c27f6f7426281&fltt=2&invt=2&secid=${secid}&fields=f57,f58,f43,f169,f170,f48,f168,f50,f44,f45,f46,f60,f62`;
    const stockResult = await jsonp(stockUrl);
    return normalizeBrowserStockQuote(stockResult?.data, code);
  }));
  fallbackRows.forEach((result) => {
    if (result.status === "fulfilled" && result.value) quotes.set(result.value.code, result.value);
  });
  return quotes;
}

function mergeAnalysisQuote(analysis, quote, item) {
  if (!quote) return analysis;
  const base = analysis && typeof analysis === "object" ? analysis : {};
  const funds = base.funds ? {
    ...base.funds,
    state: quote.mainNet > 0 ? "主力净流入" : quote.mainNet < 0 ? "主力净流出" : base.funds.state
  } : undefined;
  return {
    ...base,
    code: quote.code,
    name: base.name || quote.name || item?.name || quote.code,
    quote: { ...(base.quote || {}), ...quote },
    funds
  };
}

function normalizeRealtimeSector(row, index, maxAmount, maxFund) {
  const todayPct = Number(row.f3 || 0);
  const amount = Number(row.f6 || 0);
  const fund = Number(row.f62 || 0);
  const todayScore = Math.max(0, Math.min(20, todayPct * 3.4 + 2));
  const nearTermScore = Math.max(0, Math.min(20, todayPct * 2.2));
  const amountScore = Math.max(0, Math.min(20, amount / Math.max(1, maxAmount) * 20));
  const fundScore = fund > 0 ? Math.max(0, Math.min(20, fund / Math.max(1, maxFund) * 20)) : 0;
  const limitScore = Math.max(0, Math.min(20, todayPct * 2.4 + (row.f128 ? 4 : 0)));
  const score = Math.round(todayScore + nearTermScore + amountScore + fundScore + limitScore);
  return {
    name: row.f14,
    todayPct,
    threeDayPct: null,
    amountChange: amount ? `成交额 ${moneyText(amount)}` : "成交额待补充",
    fundFlow: fund > 0 ? `净流入 ${moneyText(fund)}` : fund < 0 ? `净流出 ${moneyText(Math.abs(fund))}` : "资金待补充",
    limitCount: null,
    linkage: row.f128 ? `领涨 ${row.f128}` : "--",
    score: Math.max(0, Math.min(100, score)),
    reason: [
      `东方财富板块实时涨幅 ${fmtPct(todayPct)}`,
      amount ? `成交额 ${moneyText(amount)}` : "成交额待补充",
      fund > 0 ? `主力资金净流入 ${moneyText(fund)}` : "主力资金未显示净流入",
      row.f128 ? `领涨股 ${row.f128}` : ""
    ].filter(Boolean).join("；"),
    risk: "近3日强度和板块内涨停数待历史/成分股接口补充，盘中需复核持续性"
  };
}

function normalizeRealtimeStock(row, index, sectors) {
  const pct = Number(row.f3 || 0);
  const amountScore = Math.min(100, Number(row.f6 || 0) / 100000000 * 5);
  const volumeScore = Math.min(100, Number(row.f10 || 0) * 22);
  const riskDistance = Math.max(20, 88 - Math.max(0, pct - 5) * 7 - Math.max(0, Number(row.f8 || 0) - 18) * 2);
  const sectorPool = sectors.length ? sectors : [{ name: "实时强势股池", score: 60 }];
  const sectorScore = sectorPool[index % sectorPool.length].score;
  const technical = Math.min(100, 50 + Math.max(0, pct) * 4 + Number(row.f10 || 0) * 5);
  const stockScore = Math.round(sectorScore * .25 + volumeScore * .2 + technical * .25 + amountScore * .15 + riskDistance * .15);
  const highRisk = pct > 8 || Number(row.f8 || 0) > 25;
  const category = stockScore >= 80 && !highRisk ? "A" : stockScore >= 65 ? "B" : "C";
  const sector = sectorPool[index % sectorPool.length].name;
  return {
    id: `${row.f12}-${index}`,
    name: row.f14,
    code: row.f12,
    sector,
    price: row.f2,
    pct,
    amount: moneyText(row.f6),
    turnover: row.f8,
    volumeRatio: row.f10 || 0,
    fundFlow: "实时行情池，主力资金待资金接口补充",
    stockScore,
    category,
    selectedReason: ["来自东方财富全 A 实时行情", "成交额、涨幅、量比或换手率满足候选池条件", "仅作为候选观察，不代表买入"],
    risks: highRisk ? ["当日涨幅或换手偏高，追高风险增加"] : ["若板块转弱或资金流出，需要降低关注级别"],
    triggerConditions: ["板块继续走强", "分时回踩均价线不破", "回踩 MA5/MA10 不破", "放量突破或站稳前高"],
    abandonConditions: ["跌破 MA10 或关键分时均价线", "板块转弱", "高开低走", "放量滞涨"],
    intradayWatch: ["看成交额是否继续放大", "看量比是否维持", "看同类个股是否联动", "看回踩是否缩量"],
    technical: {
      ma: "前端实时模式暂不计算完整 MA，需接历史 K 线后补全",
      support: "分时均价线 / MA5 / MA10",
      pressure: "当日前高 / 近端高点",
      pattern: pct > 5 ? "强势后等待确认" : "观察回踩不破"
    },
    aiExplanation: category === "A"
      ? "个股实时强度较高，但仍需要等待分时承接或突破确认，不做确定性预测。"
      : "当前更适合观察等待，重点看回踩确认、板块配合和资金延续。"
  };
}

async function loadEastmoneyRealtime() {
  const indicesUrl = "https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&fields=f12,f14,f2,f3,f4,f6&secids=1.000001,0.399001,0.399006,1.000688,1.000300,1.000852";
  const stockUrls = [1, 2, 3, 4, 5, 6].map((pn) => `https://push2.eastmoney.com/api/qt/clist/get?pn=${pn}&pz=120&po=1&np=1&ut=bd1d9ddb04089700cf9c27f6f7426281&fltt=2&invt=2&fid=f3&fs=m:0%2Bt:6,m:0%2Bt:80,m:1%2Bt:2,m:1%2Bt:23&fields=f12,f14,f2,f3,f6,f8,f10`);
  const sectorUrls = [
    "https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=30&po=1&np=1&ut=bd1d9ddb04089700cf9c27f6f7426281&fltt=2&invt=2&fid=f3&fs=m:90%2Bt:2&fields=f12,f14,f2,f3,f6,f62,f128,f140",
    "https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=30&po=1&np=1&ut=bd1d9ddb04089700cf9c27f6f7426281&fltt=2&invt=2&fid=f3&fs=m:90%2Bt:3&fields=f12,f14,f2,f3,f6,f62,f128,f140"
  ];
  const [indicesResult, ...results] = await Promise.all([jsonp(indicesUrl), ...stockUrls.map((url) => jsonp(url)), ...sectorUrls.map((url) => jsonp(url))]);
  const stockResults = results.slice(0, stockUrls.length);
  const sectorResults = results.slice(stockUrls.length);
  const indices = indicesResult?.data?.diff || [];
  const stocks = stockResults.flatMap((result) => result?.data?.diff || []);
  if (!indices.length || !stocks.length) return null;
  const sectorRows = sectorResults
    .flatMap((result) => result?.data?.diff || [])
    .filter((row) => /^BK/.test(String(row.f12 || "")))
    .filter((row) => row.f14 && !/ST|退|昨日|融资融券|标准普尔|MSCI|富时|证金持股/.test(String(row.f14)));
  const maxAmount = Math.max(1, ...sectorRows.map((row) => Number(row.f6 || 0)));
  const maxFund = Math.max(1, ...sectorRows.map((row) => Math.max(0, Number(row.f62 || 0))));
  const sectors = sectorRows
    .map((row, index) => normalizeRealtimeSector(row, index, maxAmount, maxFund))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  const valid = stocks.filter((row) => row.f14 && !/ST|退/.test(row.f14) && Number(row.f6) >= 100000000);
  const hasWideSample = stocks.length >= 1000;
  const upCount = hasWideSample ? stocks.filter((row) => Number(row.f3) > 0).length : null;
  const downCount = hasWideSample ? stocks.filter((row) => Number(row.f3) < 0).length : null;
  const limitUpCount = stocks.filter((row) => Number(row.f3) >= 9.8).length;
  const limitDownCount = stocks.filter((row) => Number(row.f3) <= -9.8).length;
  const avgIndexPct = indices.reduce((sum, row) => sum + Number(row.f3 || 0), 0) / indices.length;
  const candidates = valid
    .sort((a, b) => (Number(b.f6) / 100000000 + Number(b.f10 || 0) * 8 + Number(b.f3 || 0) * 2) - (Number(a.f6) / 100000000 + Number(a.f10 || 0) * 8 + Number(a.f3 || 0) * 2))
    .slice(0, 36)
    .map((row, index) => normalizeRealtimeStock(row, index, sectors));
  return {
    generatedAt: new Date().toISOString(),
    dataSource: "东方财富收盘行情 API（浏览器直连 push2）",
    sourceMessage: "已在浏览器端直连东方财富 push2 重新拉取当日收盘行情、行业/概念板块排行和候选池",
    cashMode: true,
    market: {
      marketRegime: avgIndexPct > .7 ? "attack" : avgIndexPct < -1.2 ? "highRisk" : avgIndexPct < -.35 ? "defensive" : "neutral",
      positionRange: avgIndexPct > .7 ? "4 - 7 成" : avgIndexPct < -1.2 ? "0 - 2 成" : avgIndexPct < -.35 ? "0 - 3 成" : "2 - 5 成",
      attackable: avgIndexPct > .7 ? "适合进攻观察" : "等待确认",
      avgIndexPct: Number(avgIndexPct.toFixed(2)),
      breadth: hasWideSample ? { upCount, downCount, flatCount: stocks.length - upCount - downCount, limitUpCount, limitDownCount } : null,
      totalAmount: moneyText(stocks.reduce((sum, row) => sum + Number(row.f6 || 0), 0)),
      description: hasWideSample
        ? `浏览器直连东方财富收盘行情：上涨 ${upCount} 家，下跌 ${downCount} 家，涨停约 ${limitUpCount} 家，跌停约 ${limitDownCount} 家。`
        : `浏览器直连东方财富收盘行情：已拉取指数、板块和高成交候选样本；涨跌家数等待全市场接口恢复后展示。`
    },
    sectors,
    candidates: {
      A: candidates.filter((item) => item.category === "A").slice(0, 12),
      B: candidates.filter((item) => item.category === "B").slice(0, 12),
      C: candidates.filter((item) => item.category === "C").slice(0, 12)
    },
    safety: []
  };
}

function render() {
  const data = normalizePayload(state.payload);
  state.payload = data;
  if (!data) return;
  el("dataSource").textContent = `${data.dataSource} · ${new Date(data.generatedAt).toLocaleTimeString("zh-CN", { hour12: false })}`;
  renderIndexStrip(data.market?.indices || []);
  renderMarket(data.market);
  renderSectors(data.sectors);
  renderCandidates("classA", data.candidates.A, "A");
  renderCandidates("classB", data.candidates.B, "B");
  renderCandidates("classC", data.candidates.C, "C");
  renderActiveTab();
  if (data.sourceMessage) showToast(data.sourceMessage);
}

function renderIndexStrip(indices) {
  const target = el("indexStrip");
  const fallback = [
    { name: "上证指数", price: "--", pct: 0 },
    { name: "深证成指", price: "--", pct: 0 },
    { name: "创业板指", price: "--", pct: 0 },
    { name: "科创50", price: "--", pct: 0 },
    { name: "沪深300", price: "--", pct: 0 },
    { name: "中证1000", price: "--", pct: 0 }
  ];
  target.innerHTML = (indices.length ? indices : fallback).slice(0, 6).map((item) => `
    <article class="index-card ${pctClass(item.pct)}">
      <div class="index-name">${item.name}</div>
      <b class="index-price">${item.price}</b>
      <span class="index-pct">${fmtPct(item.pct)}</span>
    </article>
  `).join("");
}

function renderMarket(market) {
  const label = el("regimeLabel");
  label.textContent = market.marketRegime;
  label.className = market.marketRegime;
  el("attackable").textContent = market.attackable;
  el("positionRange").textContent = market.positionRange;
  el("avgIndex").textContent = fmtPct(market.avgIndexPct);
  el("avgIndex").className = pctClass(market.avgIndexPct);
  el("marketDescription").textContent = market.description;
  const breadth = market.breadth;
  el("marketStats").innerHTML = breadth ? [
    `上涨 ${breadth.upCount}`,
    `下跌 ${breadth.downCount}`,
    `涨停 ${breadth.limitUpCount}`,
    `跌停 ${breadth.limitDownCount}`,
    `成交额 ${market.totalAmount || "--"}`
  ].map((item) => `<span>${item}</span>`).join("") : "";
  el("cashQuote").textContent = market.marketRegime === "highRisk" || market.marketRegime === "defensive"
    ? "今天没有高质量机会时，空仓也是策略。"
    : "当前可生成候选池，但仍只做观察，等待触发条件确认。";
}

async function loadMarketHistory({ force = false } = {}) {
  if (state.marketHistory && !force) return state.marketHistory;
  state.marketHistoryLoading = true;
  try {
    const response = await fetch("/api/market-history", { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `接口返回 ${response.status}`);
    state.marketHistory = {
      ...data,
      history: Array.isArray(data.history) ? data.history : []
    };
    return state.marketHistory;
  } finally {
    state.marketHistoryLoading = false;
  }
}

function regimeText(regime) {
  if (regime === "attack") return "进攻";
  if (regime === "defensive") return "防守";
  if (regime === "highRisk") return "高风险";
  return "震荡";
}

function renderHistoryChart(history) {
  if (!history.length) return `<div class="empty small-empty">暂无历史数据。</div>`;
  const width = 640;
  const height = 210;
  const padX = 34;
  const padY = 24;
  const values = history.map((item) => Number(item.avgIndexPct || 0));
  const min = Math.min(-2, ...values);
  const max = Math.max(2, ...values);
  const span = Math.max(1, max - min);
  const pointAt = (value, index) => {
    const x = history.length === 1 ? width / 2 : padX + (index * (width - padX * 2)) / (history.length - 1);
    const y = padY + ((max - value) / span) * (height - padY * 2);
    return { x, y };
  };
  const points = history.map((item, index) => pointAt(Number(item.avgIndexPct || 0), index));
  const zero = pointAt(0, 0).y;
  return `
    <div class="history-chart-wrap">
      <svg class="history-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="市场环境历史走势">
        <line x1="${padX}" y1="${zero}" x2="${width - padX}" y2="${zero}" class="history-zero"></line>
        <polyline points="${points.map((point) => `${point.x},${point.y}`).join(" ")}" class="history-line"></polyline>
        ${points.map((point, index) => `
          <circle cx="${point.x}" cy="${point.y}" r="6" class="history-dot ${history[index].marketRegime || "neutral"}"></circle>
        `).join("")}
      </svg>
      <div class="history-axis">
        <span>${history[0]?.date || "--"}</span>
        <span>指数均值</span>
        <span>${history.at(-1)?.date || "--"}</span>
      </div>
    </div>
  `;
}

function renderHistoryContent(data) {
  const history = data.history || [];
  const latest = history.at(-1);
  const source = data.dataSource || "东方财富/腾讯指数历史K线 + 本地建议记录";
  return `
    <section class="history-head">
      <div>
        <h2>市场环境历史</h2>
        <p>最多回看 20 个交易日；今天起保存实际建议，之前交易日用指数历史 K 线回测。</p>
      </div>
      ${latest ? `<strong class="${latest.marketRegime || "neutral"}">${regimeText(latest.marketRegime)}</strong>` : ""}
    </section>
    ${renderHistoryChart(history)}
    <div class="history-summary-grid">
      <div><small>最新日期</small><b>${latest?.date || "--"}</b></div>
      <div><small>指数均值</small><b class="${pctClass(latest?.avgIndexPct || 0)}">${fmtPct(latest?.avgIndexPct)}</b></div>
      <div><small>建议仓位</small><b>${latest?.positionRange || "--"}</b></div>
    </div>
    <p class="market-description history-source">${source}</p>
    <div class="history-list">
      ${history.slice().reverse().map((item) => `
        <article class="history-row">
          <div class="history-row-main">
            <span>${item.date}</span>
            <b class="${item.marketRegime || "neutral"}">${regimeText(item.marketRegime)}</b>
            <strong class="${pctClass(item.avgIndexPct)}">${fmtPct(item.avgIndexPct)}</strong>
          </div>
          <p>${item.advice || "--"}</p>
          <div class="history-tags">
            <span>仓位 ${item.positionRange || "--"}</span>
            <span>上涨/下跌 ${item.upDown || "样本不足"}</span>
            <span>涨停/跌停 ${item.limitUpDown || "样本不足"}</span>
            ${(item.sectorLeaders || []).slice(0, 3).map((name) => `<span>${name}</span>`).join("")}
          </div>
        </article>
      `).join("") || `<div class="empty small-empty">暂无历史记录。</div>`}
    </div>
  `;
}

async function openMarketHistory() {
  const content = el("historyContent");
  content.innerHTML = `<div class="empty small-empty">正在读取历史走势...</div>`;
  el("historyDialog").showModal();
  try {
    const data = await loadMarketHistory({ force: true });
    content.innerHTML = renderHistoryContent(data);
  } catch (error) {
    content.innerHTML = `<div class="empty small-empty">历史走势加载失败：${error.message}</div>`;
  }
}

function renderSectors(sectors) {
  if (!sectors.length) {
    el("sectorRank").innerHTML = `<div class="empty">实时板块数据暂未更新。当前不展示旧板块排行。</div>`;
    return;
  }
  el("sectorRank").innerHTML = sectors.map((sector, index) => `
    <div class="sector-row">
      <div>
        <div class="sector-name">${index + 1}. ${sector.name}</div>
        <div class="sector-meta">今日 ${fmtPct(sector.todayPct)} · 3日 ${fmtPct(sector.threeDayPct)} · 联动 ${sector.linkage}</div>
      </div>
      <div>
        <div class="scorebar"><span style="width:${sector.score}%"></span></div>
        <div class="sector-reason">${sector.reason}；风险：${sector.risk}</div>
      </div>
      <div class="sector-score">${sector.score}</div>
    </div>
  `).join("");
}

async function loadWatchlist() {
  try {
    const response = await fetch("/api/watchlist", { cache: "no-store" });
    const data = await response.json();
    state.watchlist = data.watchlist || [];
  } catch {
    state.watchlist = [];
  }
}

async function loadWatchlistAnalysis() {
  if (!state.watchlist.length) {
    state.watchAnalysis = {};
    return;
  }
  state.watchAnalysisLoading = true;
  renderActiveTab();
  try {
    const [analysisResult, quoteResult] = await Promise.allSettled([
      fetch("/api/watchlist/analysis", { cache: "no-store" }).then((response) => response.json()),
      loadBrowserQuotes(state.watchlist.map((item) => item.code))
    ]);
    const data = analysisResult.status === "fulfilled" ? analysisResult.value : { analyses: [] };
    const quotes = quoteResult.status === "fulfilled" ? quoteResult.value : new Map();
    state.watchlist = state.watchlist.map((item) => ({
      ...item,
      realtimeQuote: quotes.get(item.code) || item.realtimeQuote
    }));
    const analysisByCode = new Map((data.analyses || []).map((item) => [item.code, item]));
    state.watchAnalysis = Object.fromEntries(state.watchlist.map((item) => {
      const analysis = analysisByCode.get(item.code);
      const quote = quotes.get(item.code);
      return [item.code, mergeAnalysisQuote(analysis, quote, item)];
    }));
  } catch (error) {
    showToast(`持仓分析失败：${error.message}`);
    state.watchAnalysis = {};
  } finally {
    state.watchAnalysisLoading = false;
    renderActiveTab();
  }
}

async function loadBuyAlerts(options = {}) {
  const full = Boolean(options.full);
  state.buyAlertsLoading = true;
  renderActiveTab();
  try {
    const response = await fetch(full ? "/api/buy-alerts" : "/api/buy-alerts/cache", { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `接口返回 ${response.status}`);
    state.buyAlerts = {
      generatedAt: data.generatedAt || new Date().toISOString(),
      dataSource: data.dataSource || "数据源待确认",
      sourceMessage: data.sourceMessage || "",
      stats: data.stats || { scanned: 0, total: 0, triggered: 0, nearTrigger: 0 },
      alerts: Array.isArray(data.alerts) ? data.alerts : [],
      rules: Array.isArray(data.rules) ? data.rules : []
    };
    if (state.buyAlerts.sourceMessage) showToast(state.buyAlerts.sourceMessage);
  } catch (error) {
    state.buyAlerts = {
      generatedAt: new Date().toISOString(),
      dataSource: "买入提醒暂不可用",
      sourceMessage: error.message,
      stats: { scanned: 0, total: 0, triggered: 0, nearTrigger: 0 },
      alerts: [],
      rules: []
    };
    showToast(`买入提醒加载失败：${error.message}`);
  } finally {
    state.buyAlertsLoading = false;
    renderActiveTab();
  }
}

function setActiveTab(tab) {
  state.activeTab = tab;
  document.querySelectorAll("[data-tab]").forEach((node) => {
    node.classList.toggle("active", node.dataset.tab === tab);
  });
  updateChromeTitle(tab);
  renderActiveTab();
}

function updateChromeTitle(tab) {
  const labels = {
    watchlist: ["持仓盯盘", "手里的股票怎么处理"],
    opportunities: ["机会池", "空仓模式"],
    buyAlerts: ["买入提醒", "昨日涨停回踩触发"],
    market: ["板块雷达", "今日市场主线"],
    review: ["盘后复盘", "规则有效性检查"]
  };
  const [title, subtitle] = labels[tab] || labels.opportunities;
  const phoneTitle = document.querySelector(".phone-top h1");
  const phoneSubtitle = document.querySelector(".phone-top span");
  const desktopTitle = document.querySelector(".topbar h1");
  const desktopSubtitle = document.querySelector(".topbar p");
  if (phoneTitle) phoneTitle.textContent = title;
  if (phoneSubtitle) phoneSubtitle.textContent = subtitle;
  if (desktopTitle) desktopTitle.textContent = title;
  if (desktopSubtitle) desktopSubtitle.textContent = subtitle;
}

function renderActiveTab() {
  const isOpportunity = state.activeTab === "opportunities";
  const main = el("opportunityView");
  const panel = el("tabView");
  if (!main || !panel) return;
  main.hidden = !isOpportunity;
  panel.hidden = isOpportunity;
  if (isOpportunity) {
    panel.innerHTML = "";
    return;
  }
  if (state.activeTab === "watchlist") renderWatchlistTab(panel);
  if (state.activeTab === "buyAlerts") renderBuyAlertsTab(panel);
  if (state.activeTab === "market") renderMarketTab(panel);
  if (state.activeTab === "review") renderReviewTab(panel);
}

function renderBuyAlertsTab(panel) {
  const data = state.buyAlerts || {
    generatedAt: new Date().toISOString(),
    dataSource: "等待刷新",
    sourceMessage: "点击刷新提醒后扫描昨日涨停回踩候选。",
    stats: { scanned: 0, total: 0, triggered: 0, nearTrigger: 0 },
    alerts: [],
    rules: []
  };
  const stats = data.stats || {};
  const filtered = getFilteredBuyAlerts(data);
  const fundInCount = (data.alerts || []).filter((item) => parseMoneyValue(item.funds?.fund5) > 0).length;
  const hotCount = (data.alerts || []).filter((item) => matchesHotSector(item, filtered.hotNames)).length;
  panel.innerHTML = `
    <section class="panel tab-panel">
      <div class="panel-head">
        <div>
          <h2>买入提醒</h2>
          <p>前一交易日涨停，今天回踩到涨停日分时均价附近时提醒；再按资金和技术面排序。</p>
        </div>
        <button class="primary small-action" id="reloadBuyAlerts">${state.buyAlertsLoading ? "扫描中" : "刷新提醒"}</button>
      </div>
      <div class="market-dashboard buy-alert-dashboard">
        <div class="metric"><small>扫描股票</small><b>${stats.scanned || 0}</b></div>
        <div class="metric"><small>入选候选</small><b>${stats.total || 0}</b></div>
        <div class="metric"><small>已触发</small><b>${stats.triggered || 0}</b></div>
        <div class="metric"><small>接近触发</small><b>${stats.nearTrigger || 0}</b></div>
      </div>
      <div class="buy-filter-panel">
        <div class="filter-headline">
          <div>
            <small>快速筛选</small>
            <b>精选 ${filtered.items.length} / ${data.alerts.length || 0}</b>
          </div>
          <span>热点匹配 ${hotCount} · 资金流入 ${fundInCount}</span>
        </div>
        <div class="segmented filter-segmented" role="group" aria-label="买入筛选">
          <button type="button" data-buy-filter="all" class="${state.buyAlertFilter === "all" ? "active" : ""}">全部</button>
          <button type="button" data-buy-filter="ready" class="${state.buyAlertFilter === "ready" ? "active" : ""}">已到位</button>
          <button type="button" data-buy-filter="highScore" class="${state.buyAlertFilter === "highScore" ? "active" : ""}">高评分</button>
          <button type="button" data-buy-filter="hot" class="${state.buyAlertFilter === "hot" ? "active" : ""}">热点板块</button>
          <button type="button" data-buy-filter="fundIn" class="${state.buyAlertFilter === "fundIn" ? "active" : ""}">资金流入</button>
        </div>
        <div class="segmented filter-segmented" role="group" aria-label="买入排序">
          <button type="button" data-buy-sort="smart" class="${state.buyAlertSort === "smart" ? "active" : ""}">综合优先</button>
          <button type="button" data-buy-sort="score" class="${state.buyAlertSort === "score" ? "active" : ""}">评分</button>
          <button type="button" data-buy-sort="distance" class="${state.buyAlertSort === "distance" ? "active" : ""}">距触发</button>
          <button type="button" data-buy-sort="funds" class="${state.buyAlertSort === "funds" ? "active" : ""}">资金</button>
        </div>
        <div class="hot-sector-strip">
          ${(filtered.hotNames.length ? filtered.hotNames : ["热点板块待确认"]).slice(0, 6).map((name) => `<span>${name}</span>`).join("")}
        </div>
      </div>
      <article class="detail-block alert-source">
        <h3>当前数据状态</h3>
        <p class="market-description">${data.dataSource} · ${new Date(data.generatedAt).toLocaleTimeString("zh-CN", { hour12: false })}</p>
        <p class="market-description">${data.sourceMessage || "暂无额外信息"}</p>
      </article>
      <div class="buy-alert-list">
        ${filtered.items.length ? filtered.items.map((item, index) => renderBuyAlertCard(item, index, filtered.hotNames)).join("") : `<div class="empty">当前筛选条件下没有标的。可以切回“全部”，或等待热点/资金重新匹配。</div>`}
      </div>
      <div class="diagnostic-list buy-rules">
        <article class="detail-block">
          <h3>筛选规则</h3>
          ${list(data.rules.length ? data.rules : [
            "前一交易日涨停后，今天回踩到涨停日分时均价附近才提醒。",
            "资金、均线、量能和板块强度共同打分。",
            "只做提醒和排序，不自动下单。"
          ])}
        </article>
        <article class="detail-block">
          <h3>额外风控</h3>
          ${list([
            "近5日主力持续流出时降权，避免只做回光返照反抽。",
            "跌破 MA20 或较涨停价回撤过深时降权。",
            "未到触发价时只显示等待，不追高。"
          ])}
        </article>
      </div>
    </section>
  `;
  el("reloadBuyAlerts").addEventListener("click", () => loadBuyAlerts({ full: true }));
  panel.querySelectorAll("[data-buy-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      state.buyAlertFilter = button.dataset.buyFilter;
      renderActiveTab();
    });
  });
  panel.querySelectorAll("[data-buy-sort]").forEach((button) => {
    button.addEventListener("click", () => {
      state.buyAlertSort = button.dataset.buySort;
      renderActiveTab();
    });
  });
  panel.querySelectorAll("[data-alert-detail]").forEach((button) => {
    button.addEventListener("click", () => {
      const alert = (state.buyAlerts?.alerts || []).find((item) => item.code === button.dataset.alertDetail);
      if (alert) openBuyAlertDetail(alert);
    });
  });
  panel.querySelectorAll("[data-alert-watch]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      const alert = (state.buyAlerts?.alerts || []).find((item) => item.code === button.dataset.alertWatch);
      if (!alert) return;
      await addWatchlist({
        code: alert.code,
        name: alert.name,
        sector: alert.sector || "涨停回踩",
        category: "买入提醒",
        stockScore: alert.score,
        triggerConditions: alert.reasons,
        abandonConditions: alert.risks
      });
    });
  });
}

function renderBuyAlertCard(item, index, hotNames = hotSectorNames()) {
  const conceptTags = Array.isArray(item.conceptTags) ? item.conceptTags : [];
  const fund5Value = parseMoneyValue(item.funds?.fund5);
  const hotMatched = matchesHotSector(item, hotNames);
  return `
    <article class="stock-card buy-alert-card ${item.triggered ? "is-triggered" : item.nearTrigger ? "is-near" : ""}">
      <div class="stock-top">
        <div>
          <div class="stock-name">${index + 1}. ${item.name}</div>
          <div class="stock-code">${item.code} · ${item.sector || "涨停回踩"} · ${item.status}</div>
          ${conceptTags.length ? `<div class="concept-tags">${conceptTags.slice(0, 5).map((tag) => `<span>${tag}</span>`).join("")}</div>` : ""}
        </div>
        <div class="score-pill">${item.score}</div>
      </div>
      <div class="quick-badges">
        <span class="${Number(item.score || 0) >= 90 ? "strong" : ""}">评分 ${item.score}</span>
        <span class="${hotMatched ? "strong" : ""}">${hotMatched ? "匹配热点" : "热点待确认"}</span>
        <span class="${fund5Value > 0 ? "strong" : fund5Value < 0 ? "weak" : ""}">${fund5Value > 0 ? "资金流入" : fund5Value < 0 ? "资金流出" : "资金待确认"}</span>
      </div>
      <div class="alert-price-grid">
        <div><small>当前价</small><b>${item.currentPrice}</b><span class="${pctClass(item.pct)}">${fmtPct(item.pct)}</span></div>
        <div class="key-price"><small>涨停日分时均价</small><b>${item.triggerPrice}</b><span>距触发 ${item.distancePct}%</span></div>
        <div><small>前日涨停</small><b>${item.prevLimitPrice}</b><span>${item.prevTradeDate}</span></div>
        <div><small>近5日主力</small><b>${item.funds?.fund5 || "--"}</b><span>量能 ${item.technical?.amountRatio || "--"}x</span></div>
      </div>
      <div class="alert-status ${item.triggered ? "triggered" : item.nearTrigger ? "near" : "waiting"}">${item.action}</div>
      <div class="watch-rules">
        <b>推荐理由</b>
        <span>${(item.reasons || []).slice(0, 3).join("；")}</span>
      </div>
      <div class="tags">
        <span class="tag">${item.status}</span>
        <span class="tag">回撤 ${item.pullbackFromLimitPct}%</span>
        <span class="tag">MA10 ${item.technical?.ma10 || "--"}</span>
        <span class="tag">${item.averagePriceSource || "分时均价"}</span>
      </div>
      <div class="alert-actions">
        <button class="watch-btn inline-watch" data-alert-detail="${item.code}" type="button">查看理由</button>
        <button class="watch-btn inline-watch" data-alert-watch="${item.code}" type="button">加入盯盘</button>
      </div>
    </article>
  `;
}

function renderWatchlistTab(panel) {
  const scoreOf = (item) => Number(state.watchAnalysis[item.code]?.tPlan?.score || item.stockScore || -1);
  const items = [...state.watchlist].sort((a, b) => {
    if (state.watchSort === "score") return scoreOf(b) - scoreOf(a);
    return new Date(b.addedAt || 0) - new Date(a.addedAt || 0);
  });
  panel.innerHTML = `
    <section class="panel tab-panel">
      <div class="panel-head">
        <div>
          <h2>持仓盯盘</h2>
          <p>看手里的股票怎么处理：触发、放弃、风险和盘中观察都放在这里。</p>
        </div>
        <button class="primary small-action" id="reloadWatchlist">${state.watchAnalysisLoading ? "分析中" : "刷新分析"}</button>
      </div>
      <div class="mobile-toolbar">
        <div class="segmented" role="group" aria-label="持仓排序">
          <button type="button" data-watch-sort="addedAt" class="${state.watchSort === "addedAt" ? "active" : ""}">按添加时间</button>
          <button type="button" data-watch-sort="score" class="${state.watchSort === "score" ? "active" : ""}">按个股评分</button>
        </div>
      </div>
      <form class="add-stock-form" id="addStockForm">
        <div>
          <label>股票代码</label>
          <input id="addStockCode" inputmode="numeric" maxlength="6" placeholder="例如 300059" />
        </div>
        <div>
          <label>股票名称</label>
          <input id="addStockName" placeholder="例如 东方财富" />
        </div>
        <button class="primary" type="submit">添加股票</button>
      </form>
      <div class="tab-card-grid">
        ${items.length ? items.map((item) => {
          const analysis = state.watchAnalysis[item.code];
          const hasAnalysis = analysis && !analysis.error && analysis.technical && analysis.funds && analysis.tPlan;
          const quote = analysis?.quote || item.realtimeQuote;
          const hasQuote = quote && quote.price !== "--" && Number(quote.price) !== 0;
          const technical = analysis?.technical;
          const funds = analysis?.funds;
          const tPlan = analysis?.tPlan;
          const expanded = state.expandedHoldings.has(item.code);
          return `
          <article class="stock-card holding-card ${expanded ? "expanded" : "collapsed"}" data-holding-code="${item.code}">
            <div class="stock-top">
              <div>
                <div class="stock-name">${hasAnalysis ? analysis.name : item.name}</div>
                <div class="stock-code">${item.code} · ${technical?.state || item.category || "持仓观察"}</div>
              </div>
              <div class="holding-actions">
                <div class="score-pill">${tPlan?.score || item.stockScore || "--"}</div>
                <button class="expand-watch-btn" data-expand-watch="${item.code}" type="button" aria-label="${expanded ? "收起" : "展开"} ${item.name || item.code}">${expanded ? "收起" : "展开"}</button>
                <button class="delete-watch-btn" data-delete-watch="${item.code}" data-delete-name="${item.name || item.code}" type="button" aria-label="删除 ${item.name || item.code}">删除</button>
              </div>
            </div>
            ${analysis?.error ? `<div class="empty small-empty">${analysis.error}</div>` : (quote || hasAnalysis) ? `
              ${hasQuote ? `<div class="stock-metrics">
                <span>${quote.price}</span>
                <span class="${pctClass(quote.pct)}">${fmtPct(quote.pct)}</span>
                <span>量比 ${Number(quote.volumeRatio || 0).toFixed(2)}</span>
              </div>` : `<div class="empty small-empty">报价待更新；先按简版持仓处理观察。</div>`}
              ${hasAnalysis && expanded ? `
              <div class="holding-analysis">
                <div><small>资金面</small><b>${funds.state}</b><span>今日主力 ${moneyText(quote.mainNet)}</span></div>
                <div><small>技术面</small><b>${technical.state}</b><span>MA5 ${technical.ma5} / MA20 ${technical.ma20}</span></div>
                <div><small>做T参考</small><b>${tPlan.bias}</b><span>${tPlan.supportName} ${tPlan.support} → ${tPlan.pressureName} ${tPlan.pressure}</span></div>
              </div>
              ` : hasAnalysis ? `<div class="holding-compact"><span>${funds.state}</span><span>${technical.state}</span><span>${tPlan.bias}</span></div>` : `<div class="empty small-empty">已同步实时报价和量比；点击刷新分析后生成资金面、技术面和做 T 剧本。</div>`}
            ` : `<div class="empty small-empty">${state.watchAnalysisLoading ? "正在读取东方财富行情、资金和历史走势..." : "点击刷新分析后生成资金面、技术面和做 T 剧本。"}</div>`}
            <div class="tags ${expanded ? "" : "compact-tags"}">
              <span class="tag">${item.category || "持仓观察"}</span>
              <span class="tag">手动持仓</span>
              <span class="tag">${item.addedAt ? new Date(item.addedAt).toLocaleString("zh-CN", { hour12: false }) : "已加入"}</span>
            </div>
            ${expanded ? `<div class="watch-rules">
              <b>盘中处理</b>
              <span>${tPlan ? tPlan.positiveT[0] : "先等系统分析支撑、压力和资金状态，再决定是否做 T。"}</span>
            </div>
            <button class="watch-btn inline-watch" data-holding-detail="${item.code}" type="button">查看做T剧本</button>
            ` : ""}
          </article>
        `;
        }).join("") : `<div class="empty">还没有持仓/盯盘股票。可以用上方“添加股票”先加入观察。</div>`}
      </div>
    </section>
  `;
  panel.querySelectorAll("[data-watch-sort]").forEach((button) => {
    button.addEventListener("click", () => {
      state.watchSort = button.dataset.watchSort;
      renderActiveTab();
    });
  });
  panel.querySelectorAll("[data-expand-watch]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const code = button.dataset.expandWatch;
      if (state.expandedHoldings.has(code)) state.expandedHoldings.delete(code);
      else state.expandedHoldings.add(code);
      renderActiveTab();
    });
  });
  el("reloadWatchlist").addEventListener("click", async () => {
    await loadWatchlist();
    await loadWatchlistAnalysis();
    renderActiveTab();
    showToast("持仓分析已刷新");
  });
  panel.querySelectorAll("[data-holding-detail]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const analysis = state.watchAnalysis[button.dataset.holdingDetail];
      if (analysis && !analysis.error && analysis.technical && analysis.funds && analysis.tPlan) {
        openHoldingDetail(analysis);
      } else {
        showToast("这只股票的分析还没生成，先刷新分析");
      }
    });
  });
  panel.querySelectorAll("[data-delete-watch]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      const code = button.dataset.deleteWatch;
      const name = button.dataset.deleteName || code;
      if (!confirm(`确定删除 ${name}（${code}）吗？`)) return;
      try {
        await deleteWatchlist(code, name);
        await loadWatchlist();
        renderActiveTab();
      } catch (error) {
        showToast(`删除失败：${error.message}`);
      }
    });
  });
  panel.querySelectorAll("[data-holding-code]").forEach((card) => {
    card.addEventListener("click", () => {
      const code = card.dataset.holdingCode;
      if (state.expandedHoldings.has(code)) state.expandedHoldings.delete(code);
      else state.expandedHoldings.add(code);
      renderActiveTab();
    });
  });
  el("addStockForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const code = el("addStockCode").value.trim();
    const name = el("addStockName").value.trim();
    if (!/^\d{6}$/.test(code)) {
      showToast("请输入 6 位股票代码");
      return;
    }
    await addWatchlist({
      code,
      name: name || code,
      sector: "手动添加",
      category: "持仓观察",
      stockScore: "--",
      triggerConditions: ["等待触发确认", "板块配合", "分时承接有效"],
      abandonConditions: ["跌破关键均线", "板块转弱", "放量滞涨"]
    });
    el("addStockCode").value = "";
    el("addStockName").value = "";
    await loadWatchlist();
    await loadWatchlistAnalysis();
    renderActiveTab();
  });
}

function renderMarketTab(panel) {
  const market = state.payload?.market || {};
  const indices = market.indices || [];
  panel.innerHTML = `
    <section class="panel tab-panel">
      <div class="panel-head">
        <div>
          <h2>板块雷达</h2>
          <p>看今天市场主线在哪里：板块强度、联动、持续性和风险提示。</p>
        </div>
      </div>
      <div class="market-dashboard">
        <div class="metric"><small>市场环境</small><b>${market.marketRegime || "--"}</b></div>
        <div class="metric"><small>建议风险仓位</small><b>${market.positionRange || "--"}</b></div>
        <div class="metric"><small>上涨 / 下跌</small><b>${market.breadth ? `${market.breadth.upCount} / ${market.breadth.downCount}` : "样本不足"}</b></div>
        <div class="metric"><small>涨停 / 跌停</small><b>${market.breadth ? `${market.breadth.limitUpCount} / ${market.breadth.limitDownCount}` : "样本不足"}</b></div>
      </div>
      <div class="tab-card-grid">
        ${(state.payload?.sectors || []).length ? state.payload.sectors.map((sector, index) => `
          <article class="stock-card">
            <div class="stock-top">
              <div>
                <div class="stock-name">${index + 1}. ${sector.name}</div>
                <div class="stock-code">今日 ${fmtPct(sector.todayPct)} · 3日 ${fmtPct(sector.threeDayPct)}</div>
              </div>
              <div class="score-pill">${sector.score}</div>
            </div>
            <div class="scorebar"><span style="width:${sector.score}%"></span></div>
            <div class="watch-rules">
              <b>主线判断</b>
              <span>${sector.reason}</span>
            </div>
            <div class="watch-rules">
              <b>风险提示</b>
              <span>${sector.risk}</span>
            </div>
          </article>
        `).join("") : `<div class="empty">实时板块数据暂未更新。当前不展示旧板块主线。</div>`}
      </div>
    </section>
  `;
}

function reviewIndexRows(indices = []) {
  const preferred = ["000001", "399001", "399006"];
  const byCode = new Map(indices.map((item) => [String(item.code), item]));
  const rows = preferred.map((code) => byCode.get(code)).filter(Boolean);
  return rows.length ? rows : indices.slice(0, 3);
}

function reviewMarketFeature(indices = [], market = {}) {
  const rows = reviewIndexRows(indices);
  const sh = rows.find((item) => String(item.code) === "000001");
  const sz = rows.find((item) => String(item.code) === "399001");
  const cy = rows.find((item) => String(item.code) === "399006");
  const weakMain = sh && Number(sh.pct || 0) < 0;
  const growthRebound = [sz, cy].filter(Boolean).some((item) => Number(item.pct || 0) > 0);
  if (weakMain && growthRebound) return "沪弱深强分化格局，上证偏弱，深成/创业板有反弹。";
  if (rows.length && rows.every((item) => Number(item.pct || 0) > 0)) return "主要指数共振走强，市场情绪较活跃。";
  if (rows.length && rows.every((item) => Number(item.pct || 0) < 0)) return "主要指数同步走弱，先按防守环境处理。";
  if (market.marketRegime === "highRisk") return "指数结构分化但风险偏高，不适合强行进攻。";
  return "指数表现分化，等待板块持续性和资金确认。";
}

function reviewLimitFeature(breadth) {
  if (!breadth) return "涨停/跌停样本不足，先不判断连板高度。";
  const limitUp = Number(breadth.limitUpCount || 0);
  const limitDown = Number(breadth.limitDownCount || 0);
  const up = Number(breadth.upCount || 0);
  const down = Number(breadth.downCount || 0);
  if (limitUp >= 80 && down > up * 2) return "局部涨停活跃，但全市场下跌家数偏多，追高意愿仍弱。";
  if (limitUp >= 80 && up > down) return "涨停数量较高且上涨家数占优，短线情绪较强。";
  if (limitUp < 40) return "涨停家数偏少，短线接力情绪不足。";
  if (limitDown >= 20) return "跌停压力抬升，连板接力需要降级观察。";
  return "涨停数量中性，重点看热点板块是否持续扩散。";
}

function reviewHoldingAdvice(analyzedHoldings) {
  if (!analyzedHoldings.length) return "持仓者：暂无持仓样本；先按市场环境控制仓位。";
  const best = [...analyzedHoldings].sort((a, b) => Number(b.tPlan?.score || 0) - Number(a.tPlan?.score || 0))[0];
  const weak = analyzedHoldings.filter((item) => Number(item.quote?.pct || 0) < -2).map((item) => item.name).slice(0, 2);
  return `持仓者：优先处理 ${best?.name || "高分持仓"}，评分 ${best?.tPlan?.score || "--"}；${weak.length ? `${weak.join("、")} 跌幅偏大，先看止损/减仓条件。` : "未见明显大跌持仓，继续看资金和均线承接。"}`;
}

function reviewCashAdvice(market, topSector, topCandidate) {
  if (market.marketRegime === "highRisk") {
    return `空仓者：不要追高，等${topSector?.name || "热点板块"}回调后再观察；只看上午未涨停、下午仍有资金承接的个股。`;
  }
  if (topCandidate) return `空仓者：优先观察 ${topCandidate.name}，但必须同时满足板块持续、资金回流和分时站回均价线。`;
  return "空仓者：等待候选池重新出现高分标的，不为交易而交易。";
}

function renderReviewTab(panel) {
  const data = state.payload || {};
  const candidates = data.candidates || { A: [], B: [], C: [] };
  const totalCandidates = (candidates.A || []).length + (candidates.B || []).length + (candidates.C || []).length;
  const market = data.market || {};
  const breadth = market.breadth;
  const sectors = data.sectors || [];
  const indexRows = reviewIndexRows(market.indices || []);
  const holdingRows = state.watchlist.map((item) => ({
    item,
    analysis: state.watchAnalysis[item.code]
  }));
  const allCandidates = [...(candidates.A || []), ...(candidates.B || []), ...(candidates.C || [])];
  const topSector = [...sectors].sort((a, b) => Number(b.score || 0) - Number(a.score || 0))[0];
  const topCandidate = [...allCandidates].sort((a, b) => Number(b.stockScore || 0) - Number(a.stockScore || 0))[0];
  const analyzedHoldings = holdingRows.map(({ analysis }) => analysis).filter((analysis) => analysis && !analysis.error);
  const bestHolding = [...analyzedHoldings].sort((a, b) => Number(b.tPlan?.score || 0) - Number(a.tPlan?.score || 0))[0];
  const riskHolding = [...analyzedHoldings].sort((a, b) => Number(a.quote?.pct || 0) - Number(b.quote?.pct || 0))[0];
  const marketFocus = market.marketRegime === "highRisk"
    ? "防守优先"
    : market.marketRegime === "attack"
      ? "可进攻观察"
      : "等待确认";
  const ruleFocus = market.marketRegime === "highRisk"
    ? "明日只看低风险触发，候选降级观察。"
    : topCandidate
      ? `明日优先跟踪 ${topCandidate.name} 这类高分候选是否继续满足资金和板块条件。`
      : "明日先等待候选池重新出现高分标的。";
  const upDownText = breadth ? `${breadth.upCount} / ${breadth.downCount}` : "样本不足";
  const limitText = breadth ? `${breadth.limitUpCount} / ${breadth.limitDownCount}` : "样本不足";
  const hotSectors = [...sectors]
    .sort((a, b) => Number(b.todayPct || 0) - Number(a.todayPct || 0))
    .slice(0, 5);
  const afternoonWatch = [
    topSector ? `${topSector.name}持续性：关注领涨股和板块成交额是否继续放大。` : "主线持续性：先等待板块数据确认。",
    "市场分化是否加剧：看上证与深成/创业板是否继续背离。",
    breadth ? `连板高度是否突破：当前涨停 ${breadth.limitUpCount}、跌停 ${breadth.limitDownCount}，重点看明日涨停家数是否扩散。` : "连板高度是否突破：等待涨停/跌停统计补齐。",
    "资金流向变化：看主力净流入板块是否从单点扩散到同链条个股。"
  ];
  const risks = [
    breadth && Number(breadth.downCount || 0) > Number(breadth.upCount || 0) * 2 ? "上涨家数明显少于下跌家数，局部热点不能代表整体风险解除。" : "上涨/下跌结构仍需连续观察，单日数据不代表趋势确认。",
    topSector ? `${topSector.name}若明日放量滞涨，可能出现获利回吐。` : "热点板块未清晰时，不要强行归因。",
    market.marketRegime === "highRisk" ? "系统仍判定高风险，候选股只能作为观察提醒，不作为买入指令。" : "市场可观察，但仍要等待触发条件。"
  ];
  panel.innerHTML = `
    <section class="panel tab-panel">
      <div class="panel-head">
        <div>
          <h2>盘后复盘</h2>
          <p>按市场核心数据、涨停情绪、热点主线、持仓处理和明日风险逐层复盘。</p>
        </div>
      </div>
      <div class="review-focus-grid">
        <article class="review-focus-card ${market.marketRegime === "highRisk" ? "danger" : market.marketRegime === "attack" ? "positive" : ""}">
          <small>今日重点</small>
          <b>${marketFocus}</b>
          <span>指数均值 ${fmtPct(market.avgIndexPct)} · 仓位 ${market.positionRange || "--"}</span>
        </article>
        <article class="review-focus-card">
          <small>市场主线</small>
          <b>${topSector ? topSector.name : "待确认"}</b>
          <span>${topSector ? `评分 ${topSector.score} · 今日 ${fmtPct(topSector.todayPct)}` : "板块数据不足，先不强行归因"}</span>
        </article>
        <article class="review-focus-card ${riskHolding && Number(riskHolding.quote?.pct || 0) < 0 ? "warning" : "positive"}">
          <small>持股重点</small>
          <b>${bestHolding ? `${bestHolding.name} ${bestHolding.tPlan?.score || "--"}` : "暂无持仓"}</b>
          <span>${riskHolding ? `风险观察：${riskHolding.name} ${fmtPct(riskHolding.quote?.pct)}` : "无持仓风险样本"}</span>
        </article>
        <article class="review-focus-card action">
          <small>明日动作</small>
          <b>${topCandidate ? `${topCandidate.name} ${topCandidate.stockScore}` : "等信号"}</b>
          <span>${ruleFocus}</span>
        </article>
      </div>
      <div class="review-report">
        <article class="review-section">
          <h3>市场核心数据</h3>
          <div class="review-table-wrap">
            <table class="review-index-table">
              <thead>
                <tr><th>指数</th><th>收盘</th><th>涨跌幅</th><th>成交额</th></tr>
              </thead>
              <tbody>
                ${indexRows.length ? indexRows.map((item) => `
                  <tr>
                    <td>${item.name}</td>
                    <td>${item.price || "--"}</td>
                    <td class="${pctClass(item.pct)}">${Number(item.pct || 0) >= 0 ? "▲" : "▼"} ${fmtPct(item.pct)}</td>
                    <td>${item.amount || "--"}</td>
                  </tr>
                `).join("") : `<tr><td colspan="4">指数数据暂未返回</td></tr>`}
              </tbody>
            </table>
          </div>
          <p class="review-conclusion"><b>市场特征：</b>${reviewMarketFeature(market.indices || [], market)}</p>
          <p class="market-description">${data.dataSource || "--"} · ${market.description || data.sourceMessage || "暂无额外信息"}</p>
        </article>

        <article class="review-section">
          <h3>涨停情绪</h3>
          <div class="review-stat-row">
            <div><small>上涨 / 下跌</small><b>${upDownText}</b></div>
            <div><small>涨停 / 跌停</small><b>${limitText}</b></div>
            <div><small>指数均值</small><b class="${pctClass(market.avgIndexPct)}">${fmtPct(market.avgIndexPct)}</b></div>
          </div>
          ${list([
            breadth ? `涨停总数：${breadth.limitUpCount} 只；跌停：${breadth.limitDownCount} 只；上涨 ${breadth.upCount} / 下跌 ${breadth.downCount}。` : "涨停、跌停和上涨/下跌宽度仍待补齐。",
            `连板特征：${reviewLimitFeature(breadth)}`
          ])}
        </article>

        <article class="review-section">
          <h3>热点板块</h3>
          <div class="review-hot-list">
            ${hotSectors.length ? hotSectors.map((sector, index) => `
              <div class="review-hot-row">
                <span>${index + 1}</span>
                <div>
                  <b>${sector.name}</b>
                  <p>${sector.reason}</p>
                  <small>${sector.risk}</small>
                </div>
                <strong>${fmtPct(sector.todayPct)}</strong>
              </div>
            `).join("") : `<div class="empty small-empty">实时板块主线暂未完整返回，先按市场环境控制仓位。</div>`}
          </div>
        </article>

        <article class="review-section">
          <h3>午后/明日展望</h3>
          ${list(afternoonWatch)}
          <h4>操作建议</h4>
          ${list([
            reviewHoldingAdvice(analyzedHoldings),
            reviewCashAdvice(market, topSector, topCandidate)
          ])}
        </article>

        <article class="review-section">
          <h3>持股复盘</h3>
          ${holdingRows.length ? list(holdingRows.map(({ item, analysis }) => {
            if (!analysis || analysis.error) return `${item.name || item.code}：等待刷新分析。`;
            return `${analysis.name}：${fmtPct(analysis.quote?.pct)}，${analysis.funds?.state || "资金待确认"}，${analysis.technical?.state || "技术待确认"}，做T倾向 ${analysis.tPlan?.bias || "--"}`;
          })) : list(["当前没有持仓盯盘股票。"])}
        </article>

        <article class="review-section">
          <h3>规则复盘与风险提示</h3>
          ${list([
            `今日候选 ${totalCandidates} 只：A 类 ${(candidates.A || []).length}，B 类 ${(candidates.B || []).length}，C 类 ${(candidates.C || []).length}。`,
            market.marketRegime === "highRisk" ? "高风险环境下候选降级为观察，不强行进攻。" : "市场环境允许继续观察触发条件。",
            "后续重点看候选次日 1/3/5 日表现，再调整资金、板块和技术权重。",
            ...risks
          ])}
        </article>
      </div>
    </section>
  `;
}

function renderCandidates(targetId, list, category) {
  const target = el(targetId);
  if (!list.length) {
    target.innerHTML = `<div class="empty">${category === "A" ? "暂无高质量重点盯盘标的" : "暂无候选"}</div>`;
    return;
  }
  target.innerHTML = list.map((stock) => `
    <article class="stock-card" data-id="${stock.id}">
      <div class="stock-top">
        <div>
          <div class="stock-name">${stock.name}</div>
          <div class="stock-code">${stock.code || "代码待确认"} · ${stock.sector}</div>
        </div>
        <div class="score-pill">${stock.stockScore}</div>
      </div>
      <div class="stock-metrics">
        <span>${stock.price}</span>
        <span class="${pctClass(stock.pct)}">${fmtPct(stock.pct)}</span>
        <span>量比 ${Number(stock.volumeRatio || 0).toFixed(2)}</span>
      </div>
      <div class="tags">
        <span class="tag">${stock.category} 类</span>
        <span class="tag">${stock.fundFlow}</span>
        <span class="tag">${stock.technical?.pattern || "技术待确认"}</span>
        <span class="tag">${stock.amount}</span>
      </div>
    </article>
  `).join("");
  target.querySelectorAll(".stock-card").forEach((card) => {
    card.addEventListener("click", () => {
      const stock = findStock(card.dataset.id);
      if (stock) openDetail(stock);
    });
  });
}

function findStock(id) {
  const groups = state.payload?.candidates || {};
  return [...(groups.A || []), ...(groups.B || []), ...(groups.C || [])].find((item) => item.id === id);
}

function list(items) {
  return `<ul>${items.map((item) => `<li>${item}</li>`).join("")}</ul>`;
}

function openDetail(stock) {
  state.selected = stock;
  el("detailContent").innerHTML = `
    <div class="detail-title">
      <div>
        <h2>${stock.name} <span class="stock-code">${stock.code}</span></h2>
        <p class="market-description">${stock.sector} · ${stock.category} 类候选 · 当前只做观察，不构成买卖指令</p>
      </div>
      <div class="score-pill">${stock.stockScore}</div>
    </div>
    <div class="detail-grid">
      <div class="metric"><small>当前价</small><b>${stock.price}</b></div>
      <div class="metric"><small>今日涨跌幅</small><b class="${pctClass(stock.pct)}">${fmtPct(stock.pct)}</b></div>
      <div class="metric"><small>成交额</small><b>${stock.amount}</b></div>
      <div class="metric"><small>量比</small><b>${Number(stock.volumeRatio || 0).toFixed(2)}</b></div>
      <div class="metric"><small>主力资金</small><b>${stock.fundFlow}</b></div>
      <div class="metric"><small>支撑参考</small><b>${stock.technical.support}</b></div>
      <div class="metric"><small>压力参考</small><b>${stock.technical.pressure}</b></div>
      <div class="metric"><small>技术结构</small><b>${stock.technical.pattern}</b></div>
    </div>
    <div class="detail-sections">
      <section class="detail-block"><h3>入选原因</h3>${list(stock.selectedReason)}</section>
      <section class="detail-block"><h3>风险点</h3>${list(stock.risks)}</section>
      <section class="detail-block"><h3>触发条件</h3>${list(stock.triggerConditions)}</section>
      <section class="detail-block"><h3>放弃条件</h3>${list(stock.abandonConditions)}</section>
      <section class="detail-block"><h3>盘中观察点</h3>${list(stock.intradayWatch)}</section>
      <section class="detail-block"><h3>资金面</h3>${list([
        `今日主力 ${stock.funds?.todayMainNet || "--"}`,
        `近3日主力 ${stock.funds?.fund3 || "--"}`,
        `近5日主力 ${stock.funds?.fund5 || "--"}`,
        `近10日主力 ${stock.funds?.fund10 || "--"}`,
        stock.funds?.detail || `资金：${stock.fundFlow}`
      ])}</section>
      <section class="detail-block"><h3>技术面</h3>${list([
        stock.technical.ma,
        `支撑：${stock.technical.support}`,
        `压力：${stock.technical.pressure}`,
        `近20日区间 ${stock.technical.low20 || "--"} - ${stock.technical.high20 || "--"}`,
        `量能：近5日/20日 ${stock.technical.amountRatio || "--"}x`
      ])}</section>
      <section class="detail-block ai-box"><h3>AI 解释</h3><p class="market-description">${stock.aiExplanation}</p></section>
    </div>
    <button class="watch-btn" id="addWatchBtn">一键加入盯盘</button>
  `;
  el("addWatchBtn").addEventListener("click", () => addWatchlist(stock));
  el("detailDialog").showModal();
}

function openHoldingDetail(analysis) {
  const q = analysis.quote;
  const t = analysis.technical;
  const f = analysis.funds;
  const plan = analysis.tPlan;
  el("detailContent").innerHTML = `
    <div class="detail-title">
      <div>
        <h2>${analysis.name} <span class="stock-code">${analysis.code}</span></h2>
        <p class="market-description">持仓分析 · ${t.state} · ${f.state} · 只做盘中规则提醒，不构成买卖指令</p>
      </div>
      <div class="score-pill">${plan.score}</div>
    </div>
    <div class="detail-grid">
      <div class="metric"><small>当前价</small><b>${q.price}</b></div>
      <div class="metric"><small>今日涨跌幅</small><b class="${pctClass(q.pct)}">${fmtPct(q.pct)}</b></div>
      <div class="metric"><small>成交额</small><b>${q.amount}</b></div>
      <div class="metric"><small>量比 / 换手</small><b>${Number(q.volumeRatio || 0).toFixed(2)} / ${Number(q.turnover || 0).toFixed(2)}%</b></div>
      <div class="metric"><small>今日主力</small><b class="${pctClass(q.mainNet)}">${moneyText(q.mainNet)}</b></div>
      <div class="metric"><small>近5日主力</small><b>${f.fund5}</b></div>
      <div class="metric"><small>支撑</small><b>${plan.supportName} ${plan.support}</b></div>
      <div class="metric"><small>压力</small><b>${plan.pressureName} ${plan.pressure}</b></div>
    </div>
    <div class="t-summary">
      <div>
        <small>做T倾向</small>
        <b>${plan.bias}</b>
        <span>参考空间 ${plan.rangePct}%</span>
      </div>
      <p>${analysis.aiExplanation}</p>
    </div>
    <div class="detail-sections">
      <section class="detail-block"><h3>技术面</h3>${list([
        `MA5 ${t.ma5} / MA10 ${t.ma10} / MA20 ${t.ma20} / MA60 ${t.ma60}`,
        `近20日区间 ${t.low20} - ${t.high20}`,
        ...t.structure
      ])}</section>
      <section class="detail-block"><h3>资金面</h3>${list([
        `今日主力 ${moneyText(q.mainNet)}`,
        `近3日主力 ${f.fund3}`,
        `近5日主力 ${f.fund5}`,
        `近10日主力 ${f.fund10}`
      ])}</section>
      <section class="detail-block"><h3>正T：先低吸后高抛</h3>${list(plan.positiveT)}</section>
      <section class="detail-block"><h3>反T：先减后接回</h3>${list(plan.reverseT)}</section>
      <section class="detail-block"><h3>失败/放弃条件</h3>${list(plan.stopRules)}</section>
      <section class="detail-block"><h3>历史走势依据</h3>${list(plan.historyBasis)}</section>
      <section class="detail-block ai-box"><h3>必须人工判断</h3>${list([
        "你的实际持仓成本、仓位比例和可用现金。",
        "盘口承接、板块强弱、分时均价线是否有效。",
        "做 T 后必须回到你能接受的原计划仓位，不做自动交易。"
      ])}</section>
    </div>
  `;
  el("detailDialog").showModal();
}

function openBuyAlertDetail(alert) {
  el("detailContent").innerHTML = `
    <div class="detail-title">
      <div>
        <h2>${alert.name} <span class="stock-code">${alert.code}</span></h2>
        <p class="market-description">${alert.status} · 评分 ${alert.score} · 只做提醒，不构成买入指令</p>
      </div>
      <div class="score-pill">${alert.score}</div>
    </div>
    <div class="detail-grid">
      <div class="metric"><small>当前价</small><b>${alert.currentPrice}</b></div>
      <div class="metric"><small>今日涨跌幅</small><b class="${pctClass(alert.pct)}">${fmtPct(alert.pct)}</b></div>
      <div class="metric"><small>涨停日分时均价</small><b>${alert.triggerPrice}</b></div>
      <div class="metric"><small>距触发价</small><b>${alert.distancePct}%</b></div>
      <div class="metric"><small>前日涨停价</small><b>${alert.prevLimitPrice}</b></div>
      <div class="metric"><small>均价来源</small><b>${alert.averagePriceSource || "东方财富分时"}</b></div>
      <div class="metric"><small>近5日主力</small><b>${alert.funds?.fund5 || "--"}</b></div>
      <div class="metric"><small>MA10 / MA20</small><b>${alert.technical?.ma10 || "--"} / ${alert.technical?.ma20 || "--"}</b></div>
    </div>
    <div class="t-summary">
      <div>
        <small>提醒状态</small>
        <b>${alert.status}</b>
        <span>回撤 ${alert.pullbackFromLimitPct}%</span>
      </div>
      <p>${alert.action}</p>
    </div>
    <div class="detail-sections">
      <section class="detail-block"><h3>推荐理由</h3>${list(alert.reasons || [])}</section>
      ${Array.isArray(alert.conceptTags) && alert.conceptTags.length ? `<section class="detail-block"><h3>板块 / 概念</h3>${list(alert.conceptTags)}</section>` : ""}
      <section class="detail-block"><h3>风险点</h3>${list(alert.risks || [])}</section>
      <section class="detail-block"><h3>资金面</h3>${list([
        `近3日主力 ${alert.funds?.fund3 || "--"}`,
        `近5日主力 ${alert.funds?.fund5 || "--"}`,
        `近10日主力 ${alert.funds?.fund10 || "--"}`
      ])}</section>
      <section class="detail-block"><h3>技术面</h3>${list([
        `MA5 ${alert.technical?.ma5 || "--"} / MA10 ${alert.technical?.ma10 || "--"} / MA20 ${alert.technical?.ma20 || "--"}`,
        `近5日量能相对20日 ${alert.technical?.amountRatio || "--"}x`,
        `前一交易日 ${alert.prevTradeDate} 涨停后回踩观察`
      ])}</section>
      <section class="detail-block ai-box"><h3>人工确认</h3>${list([
        "触发后仍要看分时是否止跌、是否重新站回当日均价线。",
        "如果板块不联动、主力继续流出或放量下杀，不按提醒动作。",
        "提醒只负责把价格到位的股票提出来，不替代你的仓位和风控判断。"
      ])}</section>
    </div>
  `;
  el("detailDialog").showModal();
}

async function addWatchlist(stock) {
  const response = await fetch("/api/watchlist", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code: stock.code,
      name: stock.name,
      sector: stock.sector,
      category: stock.category,
      stockScore: stock.stockScore,
      triggerConditions: stock.triggerConditions,
      abandonConditions: stock.abandonConditions
    })
  });
  const result = await response.json();
  showToast(result.added ? `${stock.name} 已加入盯盘` : `${stock.name} 已在盯盘列表`);
}

async function deleteWatchlist(code, name) {
  const response = await fetch(`/api/watchlist/${encodeURIComponent(code)}`, { method: "DELETE" });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "删除失败");
  delete state.watchAnalysis[code];
  showToast(result.deleted ? `${name} 已删除` : `${name} 不在盯盘列表`);
}

el("refreshBtn").addEventListener("click", loadOpportunities);
el("refreshBtnMobile").addEventListener("click", loadOpportunities);
el("closeDialog").addEventListener("click", () => el("detailDialog").close());
el("marketHistoryBtn").addEventListener("click", openMarketHistory);
el("closeHistoryDialog").addEventListener("click", () => el("historyDialog").close());
document.querySelectorAll("[data-tab]").forEach((node) => {
  node.addEventListener("click", async (event) => {
    event.preventDefault();
    setActiveTab(node.dataset.tab);
    if (node.dataset.tab === "watchlist") {
      await loadWatchlist();
      await loadWatchlistAnalysis();
    }
    if (node.dataset.tab === "review") {
      await loadWatchlist();
      if (state.watchlist.length && !Object.keys(state.watchAnalysis).length) await loadWatchlistAnalysis();
    }
    if (node.dataset.tab === "buyAlerts" && !state.buyAlerts) {
      await loadBuyAlerts();
    }
  });
});

loadWatchlist();
loadOpportunities();
