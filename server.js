import http from "node:http";
import https from "node:https";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(__dirname, "public");
const dataDir = join(__dirname, "data");
const historyPath = join(dataDir, "form4-history.json");
const collectorPath = join(dataDir, "collector-state.json");
const collectorTokenPath = join(dataDir, "collector-token.txt");
const priceCachePath = join(dataDir, "price-cache.json");
const runtimeLog = join(__dirname, "server.runtime.log");
const httpPort = Number(process.env.HTTP_PORT || 3080);
const fallbackPort = Number(process.env.PORT || 3080);
const httpsPort = Number(process.env.HTTPS_PORT || 3443);
const letsEncryptDir = join(__dirname, "certs", "letsencrypt");
const httpsKeyPath = process.env.HTTPS_KEY || findLetsEncryptPem("-key.pem");
const httpsCertPath = process.env.HTTPS_CERT || findLetsEncryptPem("-chain.pem");
const httpsPfxPath = process.env.HTTPS_PFX || join(__dirname, "certs", "localhost.pfx");
const httpsPfxPassphrase = process.env.HTTPS_PFX_PASSPHRASE || "";
const SEC_HEADERS = {
  "User-Agent": process.env.SEC_USER_AGENT || "SEC Form 4 Tracker set SEC_USER_AGENT",
  "Accept-Encoding": "gzip, deflate",
  Accept: "application/json,text/plain,application/xml,text/xml,*/*"
};
const MAX_PUBLIC_REFRESH_FILINGS = 40;
const MAX_BACKFILL_FILINGS = 1000;

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

const cache = new Map();
const priceCache = new Map();

const requestHandler = async (req, res) => {
  try {
    log(`request ${req.method} ${req.url}`);
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === "/health") {
      sendJson(res, { ok: true, generatedAt: new Date().toISOString() });
      return;
    }

    if (url.pathname === "/api/form4") {
      const days = clamp(Number(url.searchParams.get("days") || 7), 1, 180);
      const limit = clamp(Number(url.searchParams.get("limit") || 40), 5, 300);
      const refresh = url.searchParams.get("refresh") === "1";
      const query = (url.searchParams.get("q") || "").trim();
      const type = (url.searchParams.get("type") || "all").trim();
      const minValue = clamp(Number(url.searchParams.get("minValue") || 0), 0, 1000000000);
      const data = await getRecentForm4({ days, limit, refresh, query, type, minValue });
      sendJson(res, data);
      return;
    }

    if (url.pathname === "/api/backfill") {
      if (!isAuthorizedCollectorRequest(url)) {
        log(`unauthorized collector request ${req.socket.remoteAddress || "unknown"} ${req.url}`);
        sendJson(res, { error: "Unauthorized collector request" }, 401);
        return;
      }

      const days = clamp(Number(url.searchParams.get("days") || 14), 1, 180);
      const limit = clamp(Number(url.searchParams.get("limit") || MAX_BACKFILL_FILINGS), 1, MAX_BACKFILL_FILINGS);
      const reset = url.searchParams.get("reset") === "1";
      const data = await runBackfillBatch({ days, limit, reset });
      sendJson(res, data);
      return;
    }

    if (url.pathname === "/api/collector/status") {
      const history = await readHistory();
      const collector = await readCollectorState();
      sendJson(res, {
        generatedAt: new Date().toISOString(),
        historyUpdatedAt: history.updatedAt,
        persistedHistoryCount: history.transactions.length,
        collector
      });
      return;
    }

    if (url.pathname === "/api/large-trades") {
      const days = clamp(Number(url.searchParams.get("days") || 93), 1, 180);
      const limit = clamp(Number(url.searchParams.get("limit") || 100), 5, 1000);
      const threshold = clamp(Number(url.searchParams.get("threshold") || 5000000), 1, 1000000000);
      const data = await getLargeTrades({ days, limit, threshold });
      sendJson(res, data);
      return;
    }

    if (url.pathname === "/api/holding-sales") {
      const days = clamp(Number(url.searchParams.get("days") || 180), 1, 180);
      const limit = clamp(Number(url.searchParams.get("limit") || 300), 5, 1000);
      const threshold = clamp(Number(url.searchParams.get("threshold") || 25), 1, 100);
      const data = await getHoldingSales({ days, limit, threshold });
      sendJson(res, data);
      return;
    }

    const staticPath = url.pathname === "/large" ? "/large.html"
      : url.pathname === "/holding-sales" ? "/holding-sales.html"
      : url.pathname;
    await serveStatic(staticPath, res);
  } catch (error) {
    log(`request error ${error.stack || error.message || error}`);
    console.error(error);
    sendJson(res, { error: error.message || "Unexpected server error" }, 500);
  }
};

const httpsOptions = getHttpsOptions();
const httpListenPort = httpsOptions ? httpPort : fallbackPort;

const server = http.createServer(requestHandler);
server.listen(httpListenPort, () => {
  log(`listening http://localhost:${httpListenPort}`);
  console.log(`SEC Form 4 tracker running at http://localhost:${httpListenPort}`);
});

server.on("error", (error) => {
  log(`server error ${error.stack || error.message || error}`);
});

if (httpsOptions) {
  const httpsServer = https.createServer(httpsOptions, requestHandler);

  httpsServer.listen(httpsPort, () => {
    log(`listening https://localhost:${httpsPort}`);
    console.log(`SEC Form 4 tracker running at https://localhost:${httpsPort}`);
  });

  httpsServer.on("error", (error) => {
    log(`https server error ${error.stack || error.message || error}`);
  });
} else {
  log(`https disabled; missing ${httpsKeyPath}/${httpsCertPath} or ${httpsPfxPath}`);
}

function getHttpsOptions() {
  if (existsSync(httpsKeyPath) && existsSync(httpsCertPath)) {
    return {
    key: readFileSync(httpsKeyPath),
    cert: readFileSync(httpsCertPath)
    };
  }

  if (existsSync(httpsPfxPath)) {
    return {
      pfx: readFileSync(httpsPfxPath),
      passphrase: httpsPfxPassphrase
    };
  }

  return null;
}

function findLetsEncryptPem(suffix) {
  try {
    const filename = readdirSync(letsEncryptDir).find((item) => item.endsWith(suffix));
    return filename ? join(letsEncryptDir, filename) : "";
  } catch {
    return "";
  }
}

function isAuthorizedCollectorRequest(url) {
  const expectedToken = getCollectorToken();

  if (!expectedToken) {
    log("collector token missing; denying backfill request");
    return false;
  }

  return url.searchParams.get("token") === expectedToken;
}

function getCollectorToken() {
  if (process.env.COLLECTOR_TOKEN) return process.env.COLLECTOR_TOKEN.trim();
  if (!existsSync(collectorTokenPath)) return "";
  return readFileSync(collectorTokenPath, "utf8").trim();
}

process.on("uncaughtException", (error) => {
  log(`uncaughtException ${error.stack || error.message || error}`);
  process.exitCode = 1;
});

process.on("unhandledRejection", (reason) => {
  log(`unhandledRejection ${reason?.stack || reason?.message || reason}`);
});

async function serveStatic(pathname, res) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const safePath = normalize(decodeURIComponent(requested)).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(publicDir, safePath);

  if (!filePath.startsWith(publicDir)) {
    sendText(res, "Forbidden", 403);
    return;
  }

  try {
    const file = await readFile(filePath);
    res.writeHead(200, { "Content-Type": contentTypes[extname(filePath)] || "application/octet-stream" });
    res.end(file);
  } catch {
    sendText(res, "Not found", 404);
  }
}

async function getRecentForm4({ days, limit, refresh = false, query = "", type = "all", minValue = 0 }) {
  const normalizedQuery = query.toLowerCase();
  const cacheKey = `${days}:${limit}:${refresh}:${normalizedQuery}:${type}:${minValue}:${new Date().toISOString().slice(0, 10)}`;
  const cached = cache.get(cacheKey);
  const history = await readHistory();
  const historyRows = applyTransactionFilters(recentHistoryRows(history.transactions, days, Number.MAX_SAFE_INTEGER), { query: normalizedQuery, type, minValue }).slice(0, limit);
  const historyIsFresh = history.updatedAt && Date.now() - Date.parse(history.updatedAt) < 6 * 60 * 60 * 1000;

  if (cached && Date.now() - cached.createdAt < 5 * 60 * 1000) {
    return { ...cached.data, cached: true };
  }

  if (!refresh && historyRows.length) {
    const data = buildHistoryResponse({ history, transactions: historyRows, days, limit, cached: true, query: normalizedQuery, type, minValue });
    cache.set(cacheKey, { createdAt: Date.now(), data });
    return data;
  }

  if (!refresh) {
    const data = buildHistoryResponse({
      history,
      transactions: [],
      days,
      limit,
      cached: true,
      warning: "No local history for this range yet. Run the incremental collector to populate data."
    });
    cache.set(cacheKey, { createdAt: Date.now(), data });
    return data;
  }

  let liveData;
  try {
    liveData = await fetchRecentForm4Live({ days, limit: Math.min(limit, MAX_PUBLIC_REFRESH_FILINGS) });
  } catch (error) {
    if (historyRows.length) {
      const data = buildHistoryResponse({
        history,
        transactions: historyRows,
        days,
        limit,
        cached: true,
        warning: `Live SEC refresh failed; showing persisted history. ${error.message}`
      });
      cache.set(cacheKey, { createdAt: Date.now(), data });
      return data;
    }
    throw error;
  }

  const mergedHistory = await mergeHistory(history, liveData.transactions);
  const transactions = applyTransactionFilters(recentHistoryRows(mergedHistory.transactions, days, Number.MAX_SAFE_INTEGER), { query: normalizedQuery, type, minValue }).slice(0, limit);
  const data = {
    ...liveData,
    transactions,
    summary: summarizeTransactions(applyTransactionFilters(recentHistoryRows(mergedHistory.transactions, days, Number.MAX_SAFE_INTEGER), { query: normalizedQuery, type, minValue })),
    analytics: buildAnalytics(applyTransactionFilters(recentHistoryRows(mergedHistory.transactions, days, Number.MAX_SAFE_INTEGER), { query: normalizedQuery, type, minValue })),
    persistedHistoryCount: mergedHistory.transactions.length,
    persistedAt: mergedHistory.updatedAt,
    cached: false
  };

  cache.set(cacheKey, { createdAt: Date.now(), data });
  return data;
}

async function runBackfillBatch({ days, limit, reset = false }) {
  const startedAt = Date.now();
  const collector = reset ? {} : await readCollectorState();
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const targetStart = new Date(today);
  targetStart.setUTCDate(today.getUTCDate() - days + 1);
  const cursor = collector.cursorDate ? new Date(`${collector.cursorDate}T00:00:00Z`) : new Date(today);
  let filingOffset = Number(collector.filingOffset || 0);
  let filingsScanned = 0;
  let filingsPerDay = 0;
  const transactions = [];
  const filingErrors = [];
  const unavailableIndexes = [];
  const datesProcessed = [];

  while (filingsScanned < limit && cursor >= targetStart) {
    const date = new Date(cursor);
    const result = await fetchDailyFormIndexSettled(date);
    datesProcessed.push(formatDate(date));

    if (result.status === "rejected") {
      unavailableIndexes.push({ date: date.toISOString(), reason: result.reason.message });
      cursor.setUTCDate(cursor.getUTCDate() - 1);
      filingOffset = 0;
      continue;
    }

    const filings = result.value
      .filter((filing) => filing.formType === "4" || filing.formType === "4/A")
      .sort((a, b) => b.filedAt.localeCompare(a.filedAt));
    const remainingCapacity = limit - filingsScanned;
    const batch = filings.slice(filingOffset, filingOffset + remainingCapacity);
    filingsPerDay = Math.max(filingsPerDay, batch.length);

    if (!batch.length) {
      cursor.setUTCDate(cursor.getUTCDate() - 1);
      filingOffset = 0;
      continue;
    }

    const parsed = await mapWithConcurrency(batch, 2, async (filing) => parseFiling(filing));
    transactions.push(...parsed.flatMap((filing) => filing.transactions));
    filingErrors.push(...parsed
      .filter((filing) => filing.parseError)
      .map((filing) => ({ filingUrl: filing.filingUrl, reason: filing.parseError })));
    filingsScanned += batch.length;
    filingOffset += batch.length;

    if (filingOffset >= filings.length) {
      cursor.setUTCDate(cursor.getUTCDate() - 1);
      filingOffset = 0;
    }
  }

  if (!filingsScanned && cursor < targetStart) {
    const durationMs = Date.now() - startedAt;
    await writeCollectorState({
      cursorDate: formatDate(today),
      filingOffset: 0,
      targetDays: days,
      lastRunAt: new Date().toISOString(),
      lastBatchFilings: 0,
      lastBatchTransactions: 0,
      lastDurationMs: durationMs,
      lastDuration: formatDuration(durationMs),
      complete: true
    });
    const history = await readHistory();
    return {
      generatedAt: new Date().toISOString(),
      durationMs,
      duration: formatDuration(durationMs),
      complete: true,
      persistedHistoryCount: history.transactions.length,
      message: "Backfill window complete. Cursor reset for future incremental runs."
    };
  }

  const history = await readHistory();
  const newHistoryTransactions = countNewTransactions(history, transactions);
  const mergedHistory = await mergeHistory(history, transactions);
  const complete = cursor < targetStart;
  const nextCursorDate = complete ? formatDate(today) : formatDate(cursor);
  const durationMs = Date.now() - startedAt;

  await writeCollectorState({
    cursorDate: nextCursorDate,
    filingOffset: complete ? 0 : filingOffset,
    targetDays: days,
    lastRunAt: new Date().toISOString(),
    lastBatchFilings: filingsScanned,
    lastBatchTransactions: transactions.length,
    lastBatchNewTransactions: newHistoryTransactions,
    lastDurationMs: durationMs,
    lastDuration: formatDuration(durationMs),
    complete
  });

  return {
    generatedAt: new Date().toISOString(),
    durationMs,
    duration: formatDuration(durationMs),
    source: "SEC EDGAR daily indexes and Form 4 ownership XML",
    days: datesProcessed.length,
    datesProcessed,
    filingsPerDay,
    filingsScanned,
    transactions: transactions.sort(compareTransactions),
    summary: summarizeTransactions(transactions),
    filingErrors,
    unavailableIndexes,
    complete,
    filingOffset: complete ? 0 : filingOffset,
    nextCursorDate,
    persistedHistoryCount: mergedHistory.transactions.length,
    newHistoryTransactions,
    persistedAt: mergedHistory.updatedAt,
    message: complete ? "Backfill window complete." : "Backfill batch complete. Run again for the next chunk."
  };
}

async function fetchRecentForm4Live({ days, limit }) {
  const dates = trailingDates(days);
  return fetchForm4ForDates({ dates, limit });
}

async function fetchForm4ForDates({ dates, limit }) {
  const indexResults = await mapWithConcurrency(dates, 1, fetchDailyFormIndexSettled);
  const filingsPerDay = Math.max(1, Math.ceil(limit / Math.max(dates.length, 1)));
  const filings = indexResults
    .flatMap((result) => (result.status === "fulfilled" ? result.value
      .filter((filing) => filing.formType === "4" || filing.formType === "4/A")
      .sort((a, b) => b.filedAt.localeCompare(a.filedAt))
      .slice(0, filingsPerDay) : []))
    .filter((filing) => filing.formType === "4" || filing.formType === "4/A")
    .sort((a, b) => b.filedAt.localeCompare(a.filedAt))
    .slice(0, limit);

  const parsed = await mapWithConcurrency(filings, 2, async (filing) => parseFiling(filing));
  const transactions = parsed
    .flatMap((filing) => filing.transactions)
    .sort((a, b) => {
      const dateCompare = (b.transactionDate || b.filedAt).localeCompare(a.transactionDate || a.filedAt);
      return dateCompare || Math.abs(b.value || 0) - Math.abs(a.value || 0);
    });
  const filingErrors = parsed
    .filter((filing) => filing.parseError)
    .map((filing) => ({ filingUrl: filing.filingUrl, reason: filing.parseError }));

  const data = {
    generatedAt: new Date().toISOString(),
    source: "SEC EDGAR daily indexes and Form 4 ownership XML",
    days: dates.length,
    filingsPerDay,
    filingsScanned: filings.length,
    transactions,
    summary: summarizeTransactions(transactions),
    analytics: buildAnalytics(transactions),
    filingErrors,
    unavailableIndexes: indexResults
      .map((result, index) => (result.status === "rejected" ? { date: dates[index], reason: result.reason.message } : null))
      .filter(Boolean)
  };

  return data;
}

async function getLargeTrades({ days, limit, threshold }) {
  const history = await readHistory();
  const transactions = recentHistoryRows(history.transactions, days, Number.MAX_SAFE_INTEGER)
    .filter((transaction) => Math.abs(transaction.value || 0) >= threshold)
    .slice(0, limit);

  return {
    generatedAt: history.updatedAt || new Date().toISOString(),
    source: "Persisted Form 4 transaction history",
    days,
    limit,
    threshold,
    transactions,
    persistedHistoryCount: history.transactions.length,
    persistedAt: history.updatedAt,
    cached: true
  };
}

async function getHoldingSales({ days, limit, threshold }) {
  const cacheKey = `holding-sales:${days}:${limit}:${threshold}:${new Date().toISOString().slice(0, 10)}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < 5 * 60 * 1000) {
    return { ...cached.data, cached: true };
  }

  await loadPriceCache();
  const history = await readHistory();
  const thresholdRate = threshold / 100;
  const groups = buildHoldingSaleGroups(recentHistoryRows(history.transactions, days, Number.MAX_SAFE_INTEGER))
    .filter((group) => group.percentSold > thresholdRate)
    .sort((a, b) => b.percentSold - a.percentSold || b.saleValue - a.saleValue);
  const sales = groups.slice(0, limit);
  const enrichedSales = await enrichHoldingSalesWithPrices(sales);

  const data = {
    generatedAt: history.updatedAt || new Date().toISOString(),
    source: "Persisted Form 4 transaction history",
    days,
    limit,
    threshold,
    sales: enrichedSales,
    summary: {
      count: groups.length,
      displayed: enrichedSales.length,
      saleValue: groups.reduce((sum, group) => sum + group.saleValue, 0),
      sharesSold: groups.reduce((sum, group) => sum + group.sharesSold, 0)
    },
    persistedHistoryCount: history.transactions.length,
    persistedAt: history.updatedAt,
    cached: true
  };
  cache.set(cacheKey, { createdAt: Date.now(), data });
  return data;
}

async function readHistory() {
  try {
    const text = await readFile(historyPath, "utf8");
    const parsed = JSON.parse(text);
    const byId = new Map();
    for (const rawTransaction of Array.isArray(parsed.transactions) ? parsed.transactions : []) {
      const transaction = normalizeTransaction(rawTransaction);
      byId.set(transaction.id, transaction);
    }
    return {
      updatedAt: parsed.updatedAt || null,
      transactions: [...byId.values()].sort(compareTransactions)
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { updatedAt: null, transactions: [] };
    }
    throw error;
  }
}

async function writeHistory(history) {
  await mkdir(dataDir, { recursive: true });
  await writeFile(historyPath, JSON.stringify(history, null, 2), "utf8");
}

async function loadPriceCache() {
  if (priceCache.size) return;

  try {
    const text = await readFile(priceCachePath, "utf8");
    const parsed = JSON.parse(text);
    for (const quote of Object.values(parsed.quotes || {})) {
      if (quote?.ticker) priceCache.set(quote.ticker, quote);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function savePriceCache() {
  await mkdir(dataDir, { recursive: true });
  await writeFile(priceCachePath, JSON.stringify({
    updatedAt: new Date().toISOString(),
    quotes: Object.fromEntries(priceCache)
  }, null, 2), "utf8");
}

async function readCollectorState() {
  try {
    const text = await readFile(collectorPath, "utf8");
    return JSON.parse(text);
  } catch (error) {
    if (error.code === "ENOENT") {
      return { cursorDate: null, targetDays: null, lastRunAt: null, complete: false };
    }
    throw error;
  }
}

async function writeCollectorState(state) {
  await mkdir(dataDir, { recursive: true });
  await writeFile(collectorPath, JSON.stringify(state, null, 2), "utf8");
}

async function mergeHistory(history, transactions) {
  const byId = new Map();
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - 180);

  for (const rawTransaction of [...history.transactions, ...transactions]) {
    const transaction = normalizeTransaction(rawTransaction);
    const date = Date.parse(transaction.transactionDate || transaction.filedAt || "");
    if (Number.isFinite(date) && date < cutoff.getTime()) continue;
    byId.set(transaction.id, transaction);
  }

  const merged = {
    updatedAt: new Date().toISOString(),
    transactions: [...byId.values()].sort(compareTransactions)
  };
  await writeHistory(merged);
  return merged;
}

function countNewTransactions(history, transactions) {
  const existingIds = new Set(history.transactions.map((transaction) => transaction.id));
  const incomingIds = new Set(transactions.map((transaction) => normalizeTransaction(transaction).id));
  let count = 0;

  for (const id of incomingIds) {
    if (!existingIds.has(id)) count += 1;
  }

  return count;
}

function buildHistoryResponse({ history, transactions, days, limit, cached, warning = "", query = "", type = "all", minValue = 0 }) {
  const fullRangeTransactions = applyTransactionFilters(recentHistoryRows(history.transactions, days, Number.MAX_SAFE_INTEGER), { query, type, minValue });
  const summary = summarizeTransactions(fullRangeTransactions);
  return {
    generatedAt: history.updatedAt || new Date().toISOString(),
    source: "Persisted Form 4 transaction history",
    days,
    limit,
    filingsScanned: 0,
    transactions,
    filingErrors: [],
    unavailableIndexes: [],
    persistedHistoryCount: history.transactions.length,
    persistedAt: history.updatedAt,
    summary,
    analytics: buildAnalytics(fullRangeTransactions),
    cached,
    warning
  };
}

function summarizeTransactions(transactions) {
  return transactions.reduce((summary, transaction) => {
    summary.transactionCount += 1;
    if (transaction.transactionCode === "P") summary.purchaseValue += transaction.value || 0;
    if (transaction.transactionCode === "S") summary.saleValue += transaction.value || 0;
    return summary;
  }, { transactionCount: 0, purchaseValue: 0, saleValue: 0 });
}

function buildAnalytics(transactions) {
  const buys = transactions.filter((transaction) => transaction.transactionCode === "P");
  const sales = transactions.filter((transaction) => transaction.transactionCode === "S");
  const purchaseValue = buys.reduce((sum, transaction) => sum + (transaction.value || 0), 0);
  const saleValue = sales.reduce((sum, transaction) => sum + (transaction.value || 0), 0);
  const tickerStats = summarizeByTicker(transactions);

  return {
    netFlow: purchaseValue - saleValue,
    buyCount: buys.length,
    saleCount: sales.length,
    largeTradeCount: transactions.filter((transaction) => Math.abs(transaction.value || 0) >= 5000000).length,
    highHoldingSaleCount: countHighHoldingSales(transactions),
    topAccumulation: [...tickerStats.values()]
      .filter((item) => item.netValue > 0)
      .sort((a, b) => b.netValue - a.netValue)
      .slice(0, 10)
      .map(serializedTickerStat),
    topDistribution: [...tickerStats.values()]
      .filter((item) => item.netValue < 0)
      .sort((a, b) => a.netValue - b.netValue)
      .slice(0, 10)
      .map(serializedTickerStat),
    clusterBuys: [...tickerStats.values()]
      .filter((item) => item.buyOwners.size >= 2)
      .sort((a, b) => b.buyOwners.size - a.buyOwners.size || b.buyValue - a.buyValue)
      .slice(0, 10)
      .map(serializedTickerStat),
    clusterSales: [...tickerStats.values()]
      .filter((item) => item.saleOwners.size >= 2)
      .sort((a, b) => b.saleOwners.size - a.saleOwners.size || b.saleValue - a.saleValue)
      .slice(0, 10)
      .map(serializedTickerStat),
    activity: {
      daily: buildActivity(transactions, "daily"),
      weekly: buildActivity(transactions, "weekly"),
      monthly: buildActivity(transactions, "monthly")
    },
    tickerSummary: buildTickerSummary(tickerStats),
    transactionMix: buildTransactionMix(transactions),
    roleMix: buildRoleMix(transactions)
  };
}

function buildTickerSummary(tickerStats) {
  return [...tickerStats.values()]
    .sort((a, b) => Math.abs(b.netValue) - Math.abs(a.netValue))
    .slice(0, 15)
    .map((stat) => ({
      ticker: stat.ticker,
      netValue: stat.netValue,
      buyValue: stat.buyValue,
      saleValue: stat.saleValue,
      buyOwnerCount: stat.buyOwners.size,
      saleOwnerCount: stat.saleOwners.size
    }));
}

function countHighHoldingSales(transactions) {
  return buildHoldingSaleGroups(transactions).filter((group) => group.percentSold > 0.25).length;
}

function buildHoldingSaleGroups(transactions) {
  const stats = new Map();

  for (const transaction of transactions) {
    if (!isSaleTransaction(transaction)) continue;
    const shares = Number(transaction.shares || 0);
    const sharesOwnedFollowing = Number(transaction.sharesOwnedFollowing || 0);
    if (!shares || !sharesOwnedFollowing) continue;

    const key = holdingSoldKey(transaction);
    if (!stats.has(key)) {
      stats.set(key, {
        ticker: transaction.ticker || "N/A",
        issuerName: transaction.issuerName || "",
        ownerName: transaction.ownerName || "",
        ownerCik: transaction.ownerCik || "",
        role: transaction.role || "",
        securityTitle: transaction.securityTitle || transaction.instrumentType || "",
        transactionDate: transaction.transactionDate || transaction.filedAt || "",
        filedAt: transaction.filedAt || "",
        filingUrl: transaction.filingUrl || "",
        sharesSold: 0,
        sharesOwnedFollowing,
        saleValue: 0,
        rowCount: 0
      });
    }

    const stat = stats.get(key);
    stat.sharesSold += shares;
    stat.sharesOwnedFollowing = Math.min(stat.sharesOwnedFollowing, sharesOwnedFollowing);
    stat.saleValue += transaction.value || 0;
    stat.rowCount += 1;
  }

  return [...stats.values()]
    .map((stat) => {
      const startingShares = stat.sharesSold + stat.sharesOwnedFollowing;
      return {
        ...stat,
        startingShares,
        percentSold: startingShares ? stat.sharesSold / startingShares : 0
      };
    })
    .filter((stat) => stat.percentSold > 0);
}

function buildHoldingSoldStats(transactions) {
  return new Map(buildHoldingSaleGroups(transactions).map((group) => [holdingSoldKey(group), group]));
}

async function enrichHoldingSalesWithPrices(sales) {
  const uniqueTickers = [...new Set(sales.map((sale) => sale.ticker).filter(isQuoteableTicker))];
  const quotes = new Map();

  await mapFastWithConcurrency(uniqueTickers, 12, async (ticker) => {
    const quote = await getLatestQuote(ticker);
    if (quote) quotes.set(ticker, quote);
  });
  await savePriceCache();

  return sales.map((sale) => {
    const quote = quotes.get(sale.ticker);
    const salePrice = sale.sharesSold ? sale.saleValue / sale.sharesSold : null;
    const priceDelta = quote && salePrice ? quote.close - salePrice : null;
    const priceDeltaPercent = priceDelta != null && salePrice ? priceDelta / salePrice : null;
    const quoteableTicker = isQuoteableTicker(sale.ticker);
    const priceStatus = priceDeltaPercent != null ? "ok"
      : !salePrice ? "missing-sale-price"
      : !quoteableTicker ? "unsupported-ticker"
      : "missing-quote";

    return {
      ...sale,
      salePrice,
      latestPrice: quote?.close ?? null,
      latestPriceDate: quote?.date ?? null,
      priceDelta,
      priceDeltaPercent,
      priceStatus
    };
  });
}

async function getLatestQuote(ticker) {
  const cached = priceCache.get(ticker);
  if (cached && Date.now() - Date.parse(cached.cachedAt || 0) < 6 * 60 * 60 * 1000) {
    return cached;
  }

  try {
    const url = `https://stooq.com/q/l/?s=${encodeURIComponent(ticker.toLowerCase())}.us&f=sd2t2ohlcv&h&e=csv`;
    const response = await fetch(url, { headers: { "User-Agent": SEC_HEADERS["User-Agent"] } });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const quote = parseStooqQuote(await response.text());
    if (!quote) return null;

    const cachedQuote = { ...quote, ticker, cachedAt: new Date().toISOString() };
    priceCache.set(ticker, cachedQuote);
    return cachedQuote;
  } catch (error) {
    log(`quote error ${ticker} ${error.message || error}`);
    return cached || null;
  }
}

function parseStooqQuote(csv) {
  const [, row] = String(csv || "").trim().split(/\r?\n/);
  if (!row) return null;
  const [symbol, date, time, open, high, low, close, volume] = row.split(",");
  const closePrice = Number(close);
  if (!symbol || symbol === "N/D" || !Number.isFinite(closePrice)) return null;
  return {
    symbol,
    date,
    time,
    open: Number(open) || null,
    high: Number(high) || null,
    low: Number(low) || null,
    close: closePrice,
    volume: Number(volume) || null
  };
}

function isQuoteableTicker(ticker) {
  return /^[A-Z][A-Z0-9.-]{0,9}$/.test(String(ticker || "")) && ticker !== "NONE" && ticker !== "N/A";
}

function holdingSoldKey(transaction) {
  return [
    transaction.ticker || "",
    transaction.ownerCik || transaction.ownerName || "",
    transaction.transactionDate || transaction.filedAt || "",
    transaction.securityTitle || transaction.instrumentType || ""
  ].join("|");
}

function buildTransactionMix(transactions) {
  const labels = {
    P: "Purchases",
    S: "Sales",
    A: "Awards",
    M: "Option exercises",
    F: "Tax withholding",
    G: "Gifts",
    D: "Dispositions",
    C: "Conversions",
    J: "Other acquisition/disposition",
    X: "Option exercises",
    I: "Discretionary transaction",
    U: "Tender of shares"
  };
  const counts = new Map();

  for (const transaction of transactions) {
    const code = transaction.transactionCode || "Other";
    counts.set(code, (counts.get(code) || 0) + 1);
  }

  return [...counts.entries()]
    .map(([code, count]) => ({ code, label: labels[code] || code, count }))
    .sort((a, b) => b.count - a.count);
}

function buildRoleMix(transactions) {
  const counts = new Map();

  for (const transaction of transactions) {
    const role = transaction.role?.includes("Director") ? "Director"
      : transaction.ownerTitle ? "Officer"
      : transaction.role?.includes("10%") ? "10% Owner"
      : "Reporting owner";
    counts.set(role, (counts.get(role) || 0) + 1);
  }

  return [...counts.entries()]
    .map(([role, count]) => ({ role, count }))
    .sort((a, b) => b.count - a.count);
}

function buildActivity(transactions, grouping) {
  const buckets = new Map();

  for (const transaction of transactions) {
    const date = normalizeDate(transaction.transactionDate || transaction.filedAt);
    if (!date) continue;
    const key = activityBucketKey(date, grouping);
    if (!buckets.has(key.sortKey)) {
      buckets.set(key.sortKey, { label: key.label, title: key.title, purchase: 0, sale: 0 });
    }
    const bucket = buckets.get(key.sortKey);
    if (transaction.transactionCode === "P") bucket.purchase += transaction.value || 0;
    if (transaction.transactionCode === "S") bucket.sale += transaction.value || 0;
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, value]) => value)
    .slice(-20);
}

function activityBucketKey(dateString, grouping) {
  const date = new Date(`${dateString}T00:00:00Z`);

  if (grouping === "monthly") {
    const month = dateString.slice(0, 7);
    return { sortKey: month, label: month.slice(5), title: month };
  }

  if (grouping === "weekly") {
    const monday = new Date(date);
    const day = monday.getUTCDay() || 7;
    monday.setUTCDate(monday.getUTCDate() - day + 1);
    const weekStart = monday.toISOString().slice(0, 10);
    return { sortKey: weekStart, label: `Wk ${weekStart.slice(5)}`, title: `Week of ${weekStart}` };
  }

  return { sortKey: dateString, label: dateString.slice(5), title: dateString };
}

function summarizeByTicker(transactions) {
  const stats = new Map();

  for (const transaction of transactions) {
    const ticker = transaction.ticker || "N/A";
    if (!stats.has(ticker)) {
      stats.set(ticker, {
        ticker,
        netValue: 0,
        buyValue: 0,
        saleValue: 0,
        buyOwners: new Set(),
        saleOwners: new Set()
      });
    }

    const stat = stats.get(ticker);
    if (transaction.transactionCode === "P") {
      stat.netValue += transaction.value || 0;
      stat.buyValue += transaction.value || 0;
      stat.buyOwners.add(transaction.ownerCik || transaction.ownerName);
    }
    if (transaction.transactionCode === "S") {
      stat.netValue -= transaction.value || 0;
      stat.saleValue += transaction.value || 0;
      stat.saleOwners.add(transaction.ownerCik || transaction.ownerName);
    }
  }

  return stats;
}

function serializedTickerStat(stat) {
  return {
    ticker: stat.ticker,
    netValue: stat.netValue,
    buyValue: stat.buyValue,
    saleValue: stat.saleValue,
    buyOwnerCount: stat.buyOwners.size,
    saleOwnerCount: stat.saleOwners.size
  };
}

function recentHistoryRows(transactions, days, limit) {
  const cutoff = new Date();
  cutoff.setUTCHours(0, 0, 0, 0);
  cutoff.setUTCDate(cutoff.getUTCDate() - days + 1);

  return transactions
    .filter((transaction) => {
      const date = Date.parse(transaction.transactionDate || transaction.filedAt || "");
      return Number.isFinite(date) && date >= cutoff.getTime();
    })
    .sort(compareTransactions)
    .slice(0, limit);
}

function applyTransactionFilters(transactions, { query = "", type = "all", minValue = 0 } = {}) {
  const normalizedQuery = String(query || "").toLowerCase();
  return transactions.filter((transaction) => {
    const haystack = `${transaction.ticker} ${transaction.issuerName} ${transaction.ownerName} ${transaction.ownerTitle}`.toLowerCase();
    const matchesQuery = !normalizedQuery || haystack.includes(normalizedQuery);
    const matchesType = type === "all" || transaction.transactionCode === type;
    const matchesValue = !minValue || (transaction.value || 0) >= minValue;
    return matchesQuery && matchesType && matchesValue;
  });
}

function normalizeTransaction(transaction) {
  const acquiredDisposed = String(transaction.action || "").includes("(Disposed)") ? "D"
    : String(transaction.action || "").includes("(Acquired)") ? "A"
    : "";
  const normalized = {
    ...transaction,
    action: describeTransaction(transaction.transactionCode, acquiredDisposed),
    transactionDate: normalizeDate(transaction.transactionDate),
    filedAt: normalizeDate(transaction.filedAt)
  };
  return {
    ...normalized,
    id: canonicalTransactionId(normalized)
  };
}

function normalizeDate(value) {
  const match = String(value || "").match(/\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : String(value || "");
}

function canonicalTransactionId(transaction) {
  const filingKey = String(transaction.filingUrl || transaction.id || "")
    .match(/(\d{10}-\d{2}-\d{6})/)?.[1] || String(transaction.filingUrl || transaction.id || "");
  return [
    filingKey,
    transaction.instrumentType,
    transaction.transactionDate,
    transaction.transactionCode,
    transaction.ticker,
    transaction.ownerCik || transaction.ownerName,
    transaction.securityTitle,
    transaction.shares,
    transaction.price,
    transaction.sharesOwnedFollowing
  ].map((part) => String(part ?? "").trim()).join("|");
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes) return `${minutes}m ${seconds}s`;
  if (totalSeconds) return `${totalSeconds}s`;
  return `${ms}ms`;
}

function compareTransactions(a, b) {
  const dateCompare = (b.transactionDate || b.filedAt || "").localeCompare(a.transactionDate || a.filedAt || "");
  return dateCompare || Math.abs(b.value || 0) - Math.abs(a.value || 0);
}

async function fetchDailyFormIndex(date) {
  const year = date.getUTCFullYear();
  const quarter = Math.floor(date.getUTCMonth() / 3) + 1;
  const yyyymmdd = formatDateCompact(date);
  const url = `https://www.sec.gov/Archives/edgar/daily-index/${year}/QTR${quarter}/form.${yyyymmdd}.idx`;
  const response = await fetchSec(url);

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }

  const text = await response.text();
  return parseDailyIndex(text);
}

async function fetchDailyFormIndexSettled(date) {
  try {
    return { status: "fulfilled", value: await fetchDailyFormIndex(date) };
  } catch (reason) {
    return { status: "rejected", reason };
  }
}

function parseDailyIndex(text) {
  const lines = text.split(/\r?\n/);
  const firstDataLine = lines.findIndex((line) => /^-+$/.test(line.trim())) + 1;

  if (firstDataLine <= 0) return [];

  return lines.slice(firstDataLine).map((line) => {
    const formType = line.slice(0, 12).trim();
    const details = line.slice(12).trim().match(/^(.*?)\s+(\d+)\s+(\d{8})\s+(edgar\/data\/.+)$/);

    if (!formType || !details) return null;

    const [, companyName, cik, filedAtCompact, filename] = details;
    const filedAt = `${filedAtCompact.slice(0, 4)}-${filedAtCompact.slice(4, 6)}-${filedAtCompact.slice(6, 8)}`;

    return {
      formType,
      companyName: companyName.trim(),
      cik: cik.padStart(10, "0"),
      filedAt,
      filingUrl: `https://www.sec.gov/Archives/${filename.trim()}`
    };
  }).filter(Boolean);
}

async function parseFiling(filing) {
  try {
    const response = await fetchSec(filing.filingUrl);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const text = await response.text();
    const xml = extractOwnershipXml(text);

    if (!xml) {
      return { ...filing, transactions: [] };
    }

    const issuerName = firstTag(xml, "issuerName") || filing.companyName;
    const ticker = firstTag(xml, "issuerTradingSymbol") || "";
    const ownerName = firstTag(xml, "rptOwnerName") || "Unknown insider";
    const ownerCik = firstTag(xml, "rptOwnerCik") || "";
    const ownerTitle = firstTag(xml, "officerTitle") || "";
    const isDirector = firstTag(xml, "isDirector") === "1";
    const isOfficer = firstTag(xml, "isOfficer") === "1";
    const isTenPercentOwner = firstTag(xml, "isTenPercentOwner") === "1";
    const nonDerivative = collectBlocks(xml, "nonDerivativeTransaction").map((block) =>
      transactionFromBlock(block, filing, { issuerName, ticker, ownerName, ownerCik, ownerTitle, isDirector, isOfficer, isTenPercentOwner, instrumentType: "Equity" })
    );
    const derivative = collectBlocks(xml, "derivativeTransaction").map((block) =>
      transactionFromBlock(block, filing, { issuerName, ticker, ownerName, ownerCik, ownerTitle, isDirector, isOfficer, isTenPercentOwner, instrumentType: "Derivative" })
    );

    return { ...filing, transactions: [...nonDerivative, ...derivative].filter(Boolean) };
  } catch (error) {
    return { ...filing, transactions: [], parseError: error.message };
  }
}

function extractOwnershipXml(text) {
  const direct = text.match(/<ownershipDocument[\s\S]*?<\/ownershipDocument>/i);
  if (direct) return direct[0];
  const doc = text.match(/<XML>([\s\S]*?)<\/XML>/i);
  return doc?.[1] || "";
}

function transactionFromBlock(block, filing, context) {
  const shares = toNumber(firstNestedValue(block, "transactionShares"));
  const price = toNumber(firstNestedValue(block, "transactionPricePerShare"));
  const transactionCode = firstNestedValue(block, "transactionCode") || "";
  const acquiredDisposed = firstNestedValue(block, "transactionAcquiredDisposedCode") || "";
  const securityTitle = firstNestedValue(block, "securityTitle") || "";
  const transactionDate = normalizeDate(firstNestedValue(block, "transactionDate") || "");
  const sharesOwnedFollowing = toNumber(firstNestedValue(block, "sharesOwnedFollowingTransaction"));

  if (!transactionDate && !shares && !transactionCode) return null;

  return {
    id: `${filing.filingUrl}#${context.instrumentType}-${transactionDate}-${transactionCode}-${shares}-${price}`,
    issuerName: decodeXml(context.issuerName),
    ticker: decodeXml(context.ticker),
    ownerName: decodeXml(context.ownerName),
    ownerCik: context.ownerCik,
    ownerTitle: decodeXml(context.ownerTitle),
    role: ownerRole(context),
    transactionDate,
    filedAt: filing.filedAt,
    transactionCode,
    action: describeTransaction(transactionCode, acquiredDisposed),
    acquiredDisposed,
    securityTitle: decodeXml(securityTitle),
    instrumentType: context.instrumentType,
    shares,
    price,
    value: shares && price ? shares * price : null,
    sharesOwnedFollowing,
    filingUrl: filing.filingUrl,
    formType: filing.formType,
    cik: filing.cik
  };
}

function ownerRole({ isDirector, isOfficer, isTenPercentOwner, ownerTitle }) {
  const roles = [];
  if (isDirector) roles.push("Director");
  if (isOfficer) roles.push(decodeXml(ownerTitle) || "Officer");
  if (isTenPercentOwner) roles.push("10% Owner");
  return roles.join(", ") || "Reporting owner";
}

function describeTransaction(code, acquiredDisposed) {
  const labels = {
    P: "Purchase",
    S: "Sale",
    A: "Grant/Award",
    D: "Disposition",
    M: "Option exercise",
    F: "Tax withholding",
    G: "Gift",
    C: "Conversion",
    X: "Option exercise",
    J: "Other acquisition/disposition",
    I: "Discretionary transaction",
    U: "Tender of shares"
  };
  const label = labels[code] || `Code ${code || "unknown"}`;
  const side = acquiredDisposed === "A" ? "Acquired" : acquiredDisposed === "D" ? "Disposed" : "";
  return side ? `${label} (${side})` : label;
}

function isSaleTransaction(transaction) {
  return transaction.transactionCode === "S" || String(transaction.action || "").includes("(Disposed)");
}

function collectBlocks(xml, tag) {
  return [...xml.matchAll(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi"))].map((match) => match[1]);
}

function firstNestedValue(xml, tag) {
  const block = firstTag(xml, tag);
  return block ? firstTag(block, "value") || block : "";
}

function firstTag(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match?.[1]?.trim() || "";
}

function decodeXml(value) {
  return String(value || "")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'");
}

function toNumber(value) {
  const number = Number(String(value || "").replaceAll(",", ""));
  return Number.isFinite(number) ? number : null;
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = [];
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index], index);
      await sleep(1100);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

async function mapFastWithConcurrency(items, concurrency, mapper) {
  const results = [];
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

async function fetchSec(url, attempt = 0) {
  const response = await fetch(url, { headers: SEC_HEADERS });

  if ((response.status === 429 || response.status >= 500) && attempt < 3) {
    const retryAfter = Number(response.headers.get("retry-after"));
    const backoffMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : 2500 * (attempt + 1) ** 2;
    await sleep(backoffMs);
    return fetchSec(url, attempt + 1);
  }

  return response;
}

function trailingDates(days) {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(today);
    date.setUTCDate(today.getUTCDate() - index);
    return date;
  });
}

function formatDateCompact(date) {
  return date.toISOString().slice(0, 10).replaceAll("-", "");
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function clamp(value, min, max) {
  return Math.min(Math.max(Number.isFinite(value) ? value : min, min), max);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sendJson(res, payload, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload, null, 2));
}

function sendText(res, text, status = 200) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

function log(message) {
  appendFileSync(runtimeLog, `[${new Date().toISOString()}] ${message}\n`);
}
