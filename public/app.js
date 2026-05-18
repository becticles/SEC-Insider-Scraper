const state = {
  transactions: [],
  search: "",
  type: "all",
  minValue: 0,
  days: 7,
  requestId: 0
};

const elements = {
  pageTitle: document.querySelector("#pageTitle"),
  refresh: document.querySelector("#refresh"),
  status: document.querySelector("#status"),
  transactions: document.querySelector("#transactions"),
  search: document.querySelector("#search"),
  rangeFilter: document.querySelector("#rangeFilter"),
  typeFilter: document.querySelector("#typeFilter"),
  minValue: document.querySelector("#minValue"),
  transactionCount: document.querySelector("#transactionCount"),
  purchaseValue: document.querySelector("#purchaseValue"),
  saleValue: document.querySelector("#saleValue"),
  historyRows: document.querySelector("#historyRows"),
  netFlow: document.querySelector("#netFlow"),
  buySellMix: document.querySelector("#buySellMix"),
  largeTradeCount: document.querySelector("#largeTradeCount"),
  highHoldingSaleCount: document.querySelector("#highHoldingSaleCount"),
  topAccumulation: document.querySelector("#topAccumulation"),
  topDistribution: document.querySelector("#topDistribution"),
  clusterBuying: document.querySelector("#clusterBuying"),
  clusterSales: document.querySelector("#clusterSales"),
  tickerSummary: document.querySelector("#tickerSummary"),
  transactionMix: document.querySelector("#transactionMix"),
  roleMix: document.querySelector("#roleMix"),
  activityLabel: document.querySelector("#activityLabel"),
  dailyActivity: document.querySelector("#dailyActivity")
};

const number = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const compactMoney = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 });
const dateTime = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });
const percent = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1 });
const transactionTypes = ["all", "P", "S", "A", "M", "F", "C", "D", "J", "G", "X", "I", "U"];
let filterLoadTimer;

elements.refresh.addEventListener("click", () => loadTransactions({ refresh: true }));
elements.search.addEventListener("input", (event) => {
  state.search = event.target.value.trim().toLowerCase();
  updateUrl({ replace: true });
  queueLoadTransactions();
});
elements.rangeFilter.addEventListener("change", (event) => {
  state.days = Number(event.target.value || 7);
  updateTitle();
  updateUrl({ replace: true });
  loadTransactions();
});
elements.typeFilter.addEventListener("change", (event) => {
  state.type = event.target.value;
  updateUrl({ replace: true });
  loadTransactions();
});
elements.minValue.addEventListener("input", (event) => {
  state.minValue = Number(event.target.value || 0);
  updateUrl({ replace: true });
  queueLoadTransactions();
});
window.addEventListener("popstate", () => {
  applyUrlState();
  loadTransactions();
});

applyUrlState();
await loadTransactions();

async function loadTransactions({ refresh = false } = {}) {
  window.clearTimeout(filterLoadTimer);
  const requestId = ++state.requestId;
  elements.refresh.disabled = true;
  updateTitle();
  elements.status.textContent = refresh
    ? "Refreshing from SEC EDGAR..."
    : `Loading ${rangeLabel().toLowerCase()} Form 4 history...`;

  try {
    const response = await fetch(`/api/form4?days=${state.days}&limit=200${apiFilterQuery()}${refresh ? "&refresh=1" : ""}`);
    const payload = await response.json();

    if (!response.ok) throw new Error(payload.error || "Unable to load filings.");
    if (requestId !== state.requestId) return;

    state.transactions = payload.transactions || [];
    state.summary = payload.summary || null;
    state.analytics = payload.analytics || null;
    elements.historyRows.textContent = number.format(payload.persistedHistoryCount || state.transactions.length || 0);

    const skipped = payload.unavailableIndexes?.length
      ? ` ${payload.unavailableIndexes.length} daily index file(s) were unavailable, usually weekends or market holidays.`
      : "";
    const errors = payload.filingErrors?.length
      ? ` ${payload.filingErrors.length} filing document(s) could not be parsed or fetched.`
      : "";
    const history = payload.persistedHistoryCount != null
      ? ` ${payload.persistedHistoryCount} total transaction(s) in local history.`
      : "";
    const liveScan = payload.filingsScanned
      ? ` Scanned ${number.format(payload.filingsScanned)} live filing(s).`
      : "";
    const displayed = payload.summary?.transactionCount > state.transactions.length
      ? ` Displaying ${number.format(state.transactions.length)} table row(s).`
      : "";
    const source = payload.cached ? "Showing cached history" : "Updated from SEC";
    const warning = payload.warning ? ` ${payload.warning}` : "";
    const total = payload.summary?.transactionCount ?? state.transactions.length;
    elements.status.textContent = `${source}: ${number.format(total)} ${rangeLabel().toLowerCase()} transaction(s). Updated ${dateTime.format(new Date(payload.generatedAt))}.${history}${displayed}${liveScan}${skipped}${errors}${warning}`;
    render();
  } catch (error) {
    if (requestId !== state.requestId) return;
    elements.status.textContent = error.message;
    state.transactions = [];
    render();
  } finally {
    if (requestId === state.requestId) {
      elements.refresh.disabled = false;
    }
  }
}

function queueLoadTransactions() {
  window.clearTimeout(filterLoadTimer);
  filterLoadTimer = window.setTimeout(() => loadTransactions(), 250);
}

function render() {
  const rows = filteredTransactions();
  const hasClientFilters = Boolean(state.search || state.type !== "all" || state.minValue);
  const purchaseValue = hasClientFilters || !state.summary
    ? rows.filter((item) => item.transactionCode === "P").reduce((sum, item) => sum + (item.value || 0), 0)
    : state.summary.purchaseValue;
  const saleValue = hasClientFilters || !state.summary
    ? rows.filter((item) => item.transactionCode === "S").reduce((sum, item) => sum + (item.value || 0), 0)
    : state.summary.saleValue;
  const transactionCount = hasClientFilters || !state.summary ? rows.length : state.summary.transactionCount;

  elements.transactionCount.textContent = number.format(transactionCount);
  elements.purchaseValue.textContent = compactMoney.format(purchaseValue);
  elements.saleValue.textContent = compactMoney.format(saleValue);
  renderInsights(rows);

  if (!rows.length) {
    elements.transactions.innerHTML = `<tr><td colspan="10">No matching transactions.</td></tr>`;
    return;
  }

  const holdingSoldStats = buildHoldingSoldStats(rows);
  elements.transactions.innerHTML = rows.map((row) => transactionRow(row, holdingSoldStats)).join("");
}

elements.transactions.addEventListener("click", (event) => {
  const ticker = event.target.closest("[data-ticker]")?.dataset.ticker;
  if (!ticker) return;
  filterToTicker(ticker);
});
document.querySelector(".insights").addEventListener("click", (event) => {
  const ticker = event.target.closest("[data-ticker]")?.dataset.ticker;
  if (!ticker) return;
  filterToTicker(ticker);
});
document.querySelector(".analytics-grid").addEventListener("click", (event) => {
  const ticker = event.target.closest("[data-ticker]")?.dataset.ticker;
  if (!ticker) return;
  filterToTicker(ticker);
});

function renderInsights(rows) {
  const hasClientFilters = Boolean(state.search || state.type !== "all" || state.minValue);
  const analytics = hasClientFilters || !state.analytics ? buildClientAnalytics(rows) : state.analytics;

  elements.netFlow.textContent = signedMoney(analytics.netFlow);
  elements.netFlow.classList.toggle("positive", analytics.netFlow > 0);
  elements.netFlow.classList.toggle("negative", analytics.netFlow < 0);
  elements.buySellMix.textContent = `${number.format(analytics.buyCount)} buys / ${number.format(analytics.saleCount)} sales`;
  elements.largeTradeCount.textContent = number.format(analytics.largeTradeCount);
  elements.highHoldingSaleCount.textContent = number.format(analytics.highHoldingSaleCount || 0);

  elements.topAccumulation.innerHTML = analytics.topAccumulation.length ? signalList(analytics.topAccumulation) : "None";
  elements.topDistribution.innerHTML = analytics.topDistribution.length ? signalList(analytics.topDistribution) : "None";
  elements.clusterBuying.innerHTML = analytics.clusterBuys.length ? clusterList(analytics.clusterBuys) : "None";
  elements.clusterSales.innerHTML = analytics.clusterSales.length ? clusterSaleList(analytics.clusterSales) : "None";
  elements.tickerSummary.innerHTML = analytics.tickerSummary.length ? tickerSummaryList(analytics.tickerSummary) : "None";
  elements.transactionMix.innerHTML = analytics.transactionMix.length ? mixList(analytics.transactionMix, "label") : "None";
  elements.roleMix.innerHTML = analytics.roleMix.length ? mixList(analytics.roleMix, "role") : "None";

  renderDailyActivity(rows);
}

function buildClientAnalytics(rows) {
  const buys = rows.filter((item) => item.transactionCode === "P");
  const sales = rows.filter((item) => item.transactionCode === "S");
  const purchaseValue = buys.reduce((sum, item) => sum + (item.value || 0), 0);
  const saleValue = sales.reduce((sum, item) => sum + (item.value || 0), 0);
  const tickerStats = summarizeByTicker(rows);

  return {
    netFlow: purchaseValue - saleValue,
    buyCount: buys.length,
    saleCount: sales.length,
    largeTradeCount: rows.filter((item) => Math.abs(item.value || 0) >= 5000000).length,
    highHoldingSaleCount: countHighHoldingSales(rows),
    topAccumulation: [...tickerStats.values()].filter((item) => item.netValue > 0).sort((a, b) => b.netValue - a.netValue).slice(0, 10),
    topDistribution: [...tickerStats.values()].filter((item) => item.netValue < 0).sort((a, b) => a.netValue - b.netValue).slice(0, 10),
    clusterBuys: [...tickerStats.values()]
      .filter((item) => item.buyOwners.size >= 2)
      .sort((a, b) => b.buyOwners.size - a.buyOwners.size || b.buyValue - a.buyValue)
      .slice(0, 10)
      .map((item) => ({ ...item, buyOwnerCount: item.buyOwners.size })),
    clusterSales: [...tickerStats.values()]
      .filter((item) => item.saleOwners.size >= 2)
      .sort((a, b) => b.saleOwners.size - a.saleOwners.size || b.saleValue - a.saleValue)
      .slice(0, 10)
      .map((item) => ({ ...item, saleOwnerCount: item.saleOwners.size })),
    tickerSummary: [...tickerStats.values()]
      .sort((a, b) => Math.abs(b.netValue) - Math.abs(a.netValue))
      .slice(0, 15)
      .map((item) => ({
        ticker: item.ticker,
        netValue: item.netValue,
        buyValue: item.buyValue,
        saleValue: item.saleValue,
        buyOwnerCount: item.buyOwners.size,
        saleOwnerCount: item.saleOwners.size
      })),
    transactionMix: transactionMix(rows),
    roleMix: roleMix(rows)
  };
}

function signalList(items) {
  return items.map((item) => `
    <span>
      <button class="ticker ticker-button" type="button" data-ticker="${escapeHtml(item.ticker)}">${escapeHtml(item.ticker)}</button>
      <em>${escapeHtml(signedMoney(item.netValue))}</em>
    </span>
  `).join("");
}

function clusterList(items) {
  return items.map((item) => `
    <span>
      <button class="ticker ticker-button" type="button" data-ticker="${escapeHtml(item.ticker)}">${escapeHtml(item.ticker)}</button>
      <em>${item.buyOwnerCount} buyers / ${escapeHtml(compactMoney.format(item.buyValue))}</em>
    </span>
  `).join("");
}

function clusterSaleList(items) {
  return items.map((item) => `
    <span>
      <button class="ticker ticker-button" type="button" data-ticker="${escapeHtml(item.ticker)}">${escapeHtml(item.ticker)}</button>
      <em>${item.saleOwnerCount} sellers / ${escapeHtml(compactMoney.format(item.saleValue))}</em>
    </span>
  `).join("");
}

function tickerSummaryList(items) {
  const header = `
    <p class="ticker-summary-note">Net is purchases minus sales. Owners are buyers / sellers.</p>
    <div class="ticker-summary-header">
      <span>Ticker</span>
      <span>Net</span>
      <span>Bought</span>
      <span>Sold</span>
      <span>Owners B/S</span>
    </div>
  `;
  const rows = items.map((item) => `
    <button class="ticker-summary-row" type="button" data-ticker="${escapeHtml(item.ticker)}">
      <span class="ticker">${escapeHtml(item.ticker)}</span>
      <span class="${item.netValue > 0 ? "positive" : item.netValue < 0 ? "negative" : ""}">${escapeHtml(signedMoney(item.netValue))}</span>
      <span>${escapeHtml(compactMoney.format(item.buyValue || 0))}</span>
      <span>${escapeHtml(compactMoney.format(item.saleValue || 0))}</span>
      <span>${number.format(item.buyOwnerCount || 0)} / ${number.format(item.saleOwnerCount || 0)}</span>
    </button>
  `).join("");
  return `${header}${rows}`;
}

function mixList(items, labelKey) {
  const total = items.reduce((sum, item) => sum + item.count, 0) || 1;
  return items.slice(0, 8).map((item) => `
    <div class="mix-row">
      <span>${escapeHtml(item[labelKey])}</span>
      <strong>${number.format(item.count)}</strong>
      <i style="width:${Math.max(4, (item.count / total) * 100)}%"></i>
    </div>
  `).join("");
}

function transactionMix(rows) {
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
  for (const row of rows) {
    const code = row.transactionCode || "Other";
    counts.set(code, (counts.get(code) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([code, count]) => ({ code, label: labels[code] || code, count }))
    .sort((a, b) => b.count - a.count);
}

function roleMix(rows) {
  const counts = new Map();
  for (const row of rows) {
    const role = row.role?.includes("Director") ? "Director"
      : row.ownerTitle ? "Officer"
      : row.role?.includes("10%") ? "10% Owner"
      : "Reporting owner";
    counts.set(role, (counts.get(role) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([role, count]) => ({ role, count }))
    .sort((a, b) => b.count - a.count);
}

function filterToTicker(ticker) {
  state.search = ticker.toLowerCase();
  elements.search.value = ticker;
  updateUrl({ replace: false });
  loadTransactions();
}

function apiFilterQuery() {
  const params = new URLSearchParams();
  if (state.search) params.set("q", state.search);
  if (state.type !== "all") params.set("type", state.type);
  if (state.minValue > 0) params.set("minValue", String(state.minValue));
  const query = params.toString();
  return query ? `&${query}` : "";
}

function summarizeByTicker(rows) {
  const stats = new Map();

  for (const item of rows) {
    const ticker = item.ticker || "N/A";
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
    if (item.transactionCode === "P") {
      stat.netValue += item.value || 0;
      stat.buyValue += item.value || 0;
      stat.buyOwners.add(item.ownerCik || item.ownerName);
    }
    if (item.transactionCode === "S") {
      stat.netValue -= item.value || 0;
      stat.saleValue += item.value || 0;
      stat.saleOwners.add(item.ownerCik || item.ownerName);
    }
  }

  return stats;
}

function renderDailyActivity(rows) {
  elements.activityLabel.textContent = activityLabel();
  const hasClientFilters = Boolean(state.search || state.type !== "all" || state.minValue);
  const periods = hasClientFilters || !state.analytics?.activity
    ? buildClientActivity(rows)
    : state.analytics.activity[activityGrouping()] || [];
  const maxValue = Math.max(1, ...periods.flatMap((period) => [period.purchase, period.sale]));

  elements.dailyActivity.innerHTML = periods.map((period) => `
    <div class="activity-day" title="${escapeHtml(period.title)} buys ${money.format(period.purchase)} sales ${money.format(period.sale)}">
      <span class="activity-date">${escapeHtml(period.label)}</span>
      <span class="activity-bars">
        <i class="buy-bar" style="height:${Math.max(2, (period.purchase / maxValue) * 54)}px"></i>
        <i class="sell-bar" style="height:${Math.max(2, (period.sale / maxValue) * 54)}px"></i>
      </span>
    </div>
  `).join("");
}

function buildClientActivity(rows) {
  const buckets = new Map();

  for (const item of rows) {
    const date = normalizeDate(item.transactionDate || item.filedAt || "");
    if (!date) continue;
    const key = activityBucketKey(date);
    if (!buckets.has(key.sortKey)) {
      buckets.set(key.sortKey, { label: key.label, title: key.title, purchase: 0, sale: 0 });
    }
    const bucket = buckets.get(key.sortKey);
    if (item.transactionCode === "P") bucket.purchase += item.value || 0;
    if (item.transactionCode === "S") bucket.sale += item.value || 0;
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, value]) => value)
    .slice(-20);
}

function activityBucketKey(dateString) {
  const date = new Date(`${dateString}T00:00:00Z`);

  if (activityGrouping() === "monthly") {
    const month = dateString.slice(0, 7);
    return {
      sortKey: month,
      label: month.slice(5),
      title: month
    };
  }

  if (activityGrouping() === "weekly") {
    const monday = new Date(date);
    const day = monday.getUTCDay() || 7;
    monday.setUTCDate(monday.getUTCDate() - day + 1);
    const weekStart = monday.toISOString().slice(0, 10);
    return {
      sortKey: weekStart,
      label: `Wk ${weekStart.slice(5)}`,
      title: `Week of ${weekStart}`
    };
  }

  return {
    sortKey: dateString,
    label: dateString.slice(5),
    title: dateString
  };
}

function normalizeDate(value) {
  const match = String(value || "").match(/\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : "";
}

function signedMoney(value) {
  const formatted = compactMoney.format(Math.abs(value));
  return value > 0 ? `+${formatted}` : value < 0 ? `-${formatted}` : formatted;
}

function filteredTransactions() {
  return state.transactions.filter((item) => {
    const haystack = `${item.ticker} ${item.issuerName} ${item.ownerName} ${item.ownerTitle}`.toLowerCase();
    const matchesSearch = !state.search || haystack.includes(state.search);
    const matchesType = state.type === "all" || item.transactionCode === state.type;
    const matchesValue = !state.minValue || (item.value || 0) >= state.minValue;
    return matchesSearch && matchesType && matchesValue;
  });
}

function transactionRow(item, holdingSoldStats) {
  const ticker = item.ticker || "N/A";
  const pillClass = item.transactionCode === "P" ? "buy" : item.transactionCode === "S" ? "sell" : item.transactionCode === "A" ? "award" : "";

  return `
    <tr>
      <td>${escapeHtml(item.transactionDate || item.filedAt)}<span class="subtext">Filed ${escapeHtml(item.filedAt)}</span></td>
      <td><button class="ticker ticker-button" type="button" data-ticker="${escapeHtml(ticker)}">${escapeHtml(ticker)}</button></td>
      <td>${escapeHtml(item.issuerName)}<span class="subtext">CIK ${escapeHtml(item.cik)}</span></td>
      <td>${escapeHtml(item.ownerName)}<span class="subtext">${escapeHtml(item.role)}</span></td>
      <td><span class="pill ${pillClass}">${escapeHtml(item.action)}</span><span class="subtext">${escapeHtml(item.securityTitle || item.instrumentType)}</span></td>
      <td class="numeric">${item.shares == null ? "-" : number.format(item.shares)}</td>
      <td class="numeric">${holdingSoldLabel(item, holdingSoldStats)}</td>
      <td class="numeric">${item.price == null ? "-" : money.format(item.price)}</td>
      <td class="numeric">${item.value == null ? "-" : money.format(item.value)}</td>
      <td><a href="${item.filingUrl}" target="_blank" rel="noreferrer">Filing</a></td>
    </tr>
  `;
}

function buildHoldingSoldStats(rows) {
  const stats = new Map();

  for (const item of rows) {
    if (!isSaleTransaction(item)) continue;
    const shares = Number(item.shares || 0);
    const sharesOwnedFollowing = Number(item.sharesOwnedFollowing || 0);
    if (!shares || !sharesOwnedFollowing) continue;

    const key = holdingSoldKey(item);
    if (!stats.has(key)) {
      stats.set(key, {
        sharesSold: 0,
        sharesOwnedFollowing,
        rowCount: 0
      });
    }
    const stat = stats.get(key);
    stat.sharesSold += shares;
    stat.sharesOwnedFollowing = Math.min(stat.sharesOwnedFollowing, sharesOwnedFollowing);
    stat.rowCount += 1;
  }

  return stats;
}

function countHighHoldingSales(rows) {
  return [...buildHoldingSoldStats(rows).values()]
    .filter((stat) => {
      const startingShares = stat.sharesSold + stat.sharesOwnedFollowing;
      return startingShares && stat.sharesSold / startingShares > 0.25;
    }).length;
}

function holdingSoldLabel(item, holdingSoldStats) {
  if (!isSaleTransaction(item)) return "-";
  const stat = holdingSoldStats.get(holdingSoldKey(item));
  if (!stat) return "-";
  const startingShares = stat.sharesSold + stat.sharesOwnedFollowing;

  if (!stat.sharesSold || !stat.sharesOwnedFollowing || !startingShares) return "-";
  const qualifier = stat.rowCount > 1 ? ` across ${number.format(stat.rowCount)} sale rows` : "";
  return `<span title="${escapeHtml(number.format(stat.sharesSold))} sold${qualifier} from estimated pre-sale holding of ${escapeHtml(number.format(startingShares))} shares">${escapeHtml(percent.format(stat.sharesSold / startingShares))}</span>`;
}

function holdingSoldKey(item) {
  return [
    item.ticker || "",
    item.ownerCik || item.ownerName || "",
    item.transactionDate || item.filedAt || "",
    item.securityTitle || item.instrumentType || ""
  ].join("|");
}

function isSaleTransaction(item) {
  const isSale = item.transactionCode === "S" || String(item.action || "").includes("(Disposed)");
  return isSale;
}

function updateTitle() {
  elements.pageTitle.textContent = `${rangeLabel()} insider stock transactions`;
  document.title = `${rangeLabel()} SEC Form 4 Tracker`;
}

function applyUrlState() {
  const params = new URLSearchParams(window.location.search);
  const q = params.get("q") || params.get("search") || "";
  const days = Number(params.get("days") || "");
  const type = params.get("type") || "all";
  const minValue = Number(params.get("minValue") || "");

  state.search = q.toLowerCase();
  elements.search.value = q;

  if ([1, 7, 31, 93, 180].includes(days)) {
    state.days = days;
    elements.rangeFilter.value = String(days);
  } else {
    state.days = 7;
    elements.rangeFilter.value = "7";
  }

  if (transactionTypes.includes(type)) {
    state.type = type;
    elements.typeFilter.value = type;
  } else {
    state.type = "all";
    elements.typeFilter.value = "all";
  }

  if (Number.isFinite(minValue) && minValue > 0) {
    state.minValue = minValue;
    elements.minValue.value = String(minValue);
  } else {
    state.minValue = 0;
    elements.minValue.value = "";
  }

  updateTitle();
}

function updateUrl({ replace = true } = {}) {
  const params = new URLSearchParams();

  if (state.search) params.set("q", state.search);
  if (state.days !== 7) params.set("days", String(state.days));
  if (state.type !== "all") params.set("type", state.type);
  if (state.minValue > 0) params.set("minValue", String(state.minValue));

  const query = params.toString();
  const nextUrl = `${window.location.pathname}${query ? `?${query}` : ""}`;
  if (`${window.location.pathname}${window.location.search}` === nextUrl) return;
  const method = replace ? "replaceState" : "pushState";
  window.history[method](null, "", nextUrl);
}

function rangeLabel() {
  if (state.days >= 180) return "6-month";
  if (state.days >= 93) return "3-month";
  if (state.days <= 1) return "Daily";
  return state.days >= 31 ? "Monthly" : "Weekly";
}

function activityLabel() {
  const grouping = activityGrouping();
  return `${grouping[0].toUpperCase()}${grouping.slice(1)} activity`;
}

function activityGrouping() {
  if (state.days >= 93) return "monthly";
  if (state.days >= 31) return "weekly";
  return "daily";
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;"
  })[char]);
}
