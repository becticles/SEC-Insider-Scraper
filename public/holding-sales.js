const state = {
  sales: [],
  search: "",
  days: 180,
  threshold: 25
};

const elements = {
  status: document.querySelector("#status"),
  sales: document.querySelector("#sales"),
  search: document.querySelector("#search"),
  rangeFilter: document.querySelector("#rangeFilter"),
  threshold: document.querySelector("#threshold"),
  thresholdValue: document.querySelector("#thresholdValue"),
  saleCount: document.querySelector("#saleCount"),
  saleValue: document.querySelector("#saleValue"),
  sharesSold: document.querySelector("#sharesSold")
};

const number = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const compactMoney = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 });
const percent = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1 });
const dateTime = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });

elements.search.addEventListener("input", (event) => {
  state.search = event.target.value.trim().toLowerCase();
  updateUrl({ replace: true });
  render();
});
elements.rangeFilter.addEventListener("change", (event) => {
  state.days = Number(event.target.value || 180);
  updateUrl({ replace: true });
  loadHoldingSales();
});
elements.threshold.addEventListener("change", (event) => {
  state.threshold = Number(event.target.value || 25);
  updateUrl({ replace: true });
  loadHoldingSales();
});
window.addEventListener("popstate", () => {
  const previousDays = state.days;
  const previousThreshold = state.threshold;
  applyUrlState();
  if (state.days !== previousDays || state.threshold !== previousThreshold) {
    loadHoldingSales();
  } else {
    render();
  }
});

applyUrlState();
await loadHoldingSales();

async function loadHoldingSales() {
  elements.status.textContent = "Loading holding sales from local history...";
  elements.thresholdValue.textContent = `${number.format(state.threshold)}%`;

  try {
    const response = await fetch(`/api/holding-sales?days=${state.days}&limit=500&threshold=${state.threshold}`);
    const payload = await response.json();

    if (!response.ok) throw new Error(payload.error || "Unable to load holding sales.");

    state.sales = payload.sales || [];
    const displayed = payload.summary?.displayed ?? state.sales.length;
    const total = payload.summary?.count ?? state.sales.length;
    const displayNote = total > displayed ? ` Showing top ${number.format(displayed)} of ${number.format(total)} sale group(s).` : ` Showing ${number.format(total)} sale group(s).`;
    elements.status.textContent = `${displayNote} Threshold is above ${number.format(payload.threshold)}% of estimated pre-sale holdings over ${rangeLabel()}. Updated ${dateTime.format(new Date(payload.generatedAt))}. ${payload.persistedHistoryCount} total transaction(s) in local history.`;
    render();
  } catch (error) {
    elements.status.textContent = error.message;
    state.sales = [];
    render();
  }
}

function render() {
  const rows = filteredSales();
  const saleValue = rows.reduce((sum, item) => sum + (item.saleValue || 0), 0);
  const sharesSold = rows.reduce((sum, item) => sum + (item.sharesSold || 0), 0);

  elements.saleCount.textContent = number.format(rows.length);
  elements.saleValue.textContent = compactMoney.format(saleValue);
  elements.sharesSold.textContent = number.format(sharesSold);

  if (!rows.length) {
    elements.sales.innerHTML = `<tr><td colspan="11">No matching holding sales.</td></tr>`;
    return;
  }

  elements.sales.innerHTML = rows.map(saleRow).join("");
}

elements.sales.addEventListener("click", (event) => {
  const ticker = event.target.closest("[data-ticker]")?.dataset.ticker;
  if (!ticker) return;
  state.search = ticker.toLowerCase();
  elements.search.value = ticker;
  updateUrl({ replace: false });
  render();
});

function filteredSales() {
  return state.sales.filter((item) => {
    const haystack = `${item.ticker} ${item.issuerName} ${item.ownerName} ${item.role}`.toLowerCase();
    return !state.search || haystack.includes(state.search);
  });
}

function saleRow(item) {
  const ticker = item.ticker || "N/A";

  return `
    <tr>
      <td>${escapeHtml(item.transactionDate || item.filedAt)}<span class="subtext">Filed ${escapeHtml(item.filedAt)}</span></td>
      <td><button class="ticker ticker-button" type="button" data-ticker="${escapeHtml(ticker)}">${escapeHtml(ticker)}</button></td>
      <td>${escapeHtml(item.issuerName)}</td>
      <td>${escapeHtml(item.ownerName)}<span class="subtext">${escapeHtml(item.role)}</span></td>
      <td>${escapeHtml(item.securityTitle)}<span class="subtext">${number.format(item.rowCount || 1)} sale row(s)</span></td>
      <td class="numeric">${percent.format(item.percentSold || 0)}</td>
      <td class="numeric">${priceMoveLabel(item)}</td>
      <td class="numeric">${number.format(item.sharesSold || 0)}</td>
      <td class="numeric">${number.format(item.sharesOwnedFollowing || 0)}</td>
      <td class="numeric">${money.format(item.saleValue || 0)}</td>
      <td><a href="${item.filingUrl}" target="_blank" rel="noreferrer">Filing</a></td>
    </tr>
  `;
}

function priceMoveLabel(item) {
  if (item.priceDeltaPercent == null || item.priceDelta == null || item.salePrice == null || item.latestPrice == null) {
    return missingPriceLabel(item);
  }

  const moveClass = item.priceDelta > 0 ? "positive" : item.priceDelta < 0 ? "negative" : "";
  const movePrefix = item.priceDelta > 0 ? "+" : "";
  const title = `Sale avg ${money.format(item.salePrice)}; latest ${money.format(item.latestPrice)}${item.latestPriceDate ? ` on ${item.latestPriceDate}` : ""}`;
  return `
    <span class="${moveClass}" title="${escapeHtml(title)}">${movePrefix}${percent.format(item.priceDeltaPercent)}</span>
    <span class="subtext">${movePrefix}${money.format(item.priceDelta)} / sh</span>
  `;
}

function missingPriceLabel(item) {
  const labels = {
    "missing-sale-price": "No sale price",
    "unsupported-ticker": "No quote symbol",
    "missing-quote": "No latest quote"
  };
  const details = {
    "missing-sale-price": "The Form 4 row did not include enough price/share/value data to calculate a weighted sale price.",
    "unsupported-ticker": "The ticker is not a normal quoteable US common-stock symbol for the current quote source.",
    "missing-quote": "The latest quote lookup did not return a usable price for this ticker."
  };
  const status = item.priceStatus || "missing-quote";
  return `<span class="missing-price" title="${escapeHtml(details[status] || details["missing-quote"])}">${escapeHtml(labels[status] || "No latest quote")}</span>`;
}

function rangeLabel() {
  if (state.days >= 180) return "6 months";
  if (state.days >= 93) return "3 months";
  return "1 month";
}

function applyUrlState() {
  const params = new URLSearchParams(window.location.search);
  const q = params.get("q") || params.get("search") || "";
  const days = Number(params.get("days") || "");
  const threshold = Number(params.get("threshold") || "");

  state.search = q.toLowerCase();
  elements.search.value = q;

  if ([31, 93, 180].includes(days)) {
    state.days = days;
    elements.rangeFilter.value = String(days);
  } else {
    state.days = 180;
    elements.rangeFilter.value = "180";
  }

  if (Number.isFinite(threshold) && threshold > 0) {
    state.threshold = threshold;
    elements.threshold.value = String(threshold);
  } else {
    state.threshold = 25;
    elements.threshold.value = "25";
  }
}

function updateUrl({ replace = true } = {}) {
  const params = new URLSearchParams();

  if (state.search) params.set("q", state.search);
  if (state.days !== 180) params.set("days", String(state.days));
  if (state.threshold !== 25) params.set("threshold", String(state.threshold));

  const query = params.toString();
  const nextUrl = `${window.location.pathname}${query ? `?${query}` : ""}`;
  if (`${window.location.pathname}${window.location.search}` === nextUrl) return;
  const method = replace ? "replaceState" : "pushState";
  window.history[method](null, "", nextUrl);
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
