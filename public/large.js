const state = {
  transactions: [],
  search: "",
  days: 93,
  threshold: 5000000
};

const elements = {
  status: document.querySelector("#status"),
  transactions: document.querySelector("#transactions"),
  search: document.querySelector("#search"),
  rangeFilter: document.querySelector("#rangeFilter"),
  threshold: document.querySelector("#threshold"),
  thresholdValue: document.querySelector("#thresholdValue"),
  largeCount: document.querySelector("#largeCount"),
  purchaseValue: document.querySelector("#purchaseValue"),
  saleValue: document.querySelector("#saleValue")
};

const number = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const compactMoney = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 });
const dateTime = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });

elements.search.addEventListener("input", (event) => {
  state.search = event.target.value.trim().toLowerCase();
  updateUrl({ replace: true });
  render();
});
elements.rangeFilter.addEventListener("change", (event) => {
  state.days = Number(event.target.value || 93);
  updateUrl({ replace: true });
  loadLargeTrades();
});
elements.threshold.addEventListener("change", (event) => {
  state.threshold = Number(event.target.value || 5000000);
  updateUrl({ replace: true });
  loadLargeTrades();
});
window.addEventListener("popstate", () => {
  const previousDays = state.days;
  const previousThreshold = state.threshold;
  applyUrlState();
  if (state.days !== previousDays || state.threshold !== previousThreshold) {
    loadLargeTrades();
  } else {
    render();
  }
});

applyUrlState();
await loadLargeTrades();

async function loadLargeTrades() {
  elements.status.textContent = "Loading large trades from local history...";
  elements.thresholdValue.textContent = compactMoney.format(state.threshold);

  try {
    const response = await fetch(`/api/large-trades?days=${state.days}&limit=300&threshold=${state.threshold}`);
    const payload = await response.json();

    if (!response.ok) throw new Error(payload.error || "Unable to load large trades.");

    state.transactions = payload.transactions || [];
    elements.status.textContent = `Showing ${state.transactions.length} trade(s) of ${compactMoney.format(payload.threshold)} or more over ${rangeLabel()}. Updated ${dateTime.format(new Date(payload.generatedAt))}. ${payload.persistedHistoryCount} total transaction(s) in local history.`;
    render();
  } catch (error) {
    elements.status.textContent = error.message;
    state.transactions = [];
    render();
  }
}

function render() {
  const rows = filteredTransactions();
  const purchaseValue = rows
    .filter((item) => item.transactionCode === "P")
    .reduce((sum, item) => sum + (item.value || 0), 0);
  const saleValue = rows
    .filter((item) => item.transactionCode === "S")
    .reduce((sum, item) => sum + (item.value || 0), 0);

  elements.largeCount.textContent = number.format(rows.length);
  elements.purchaseValue.textContent = compactMoney.format(purchaseValue);
  elements.saleValue.textContent = compactMoney.format(saleValue);

  if (!rows.length) {
    elements.transactions.innerHTML = `<tr><td colspan="9">No matching large trades.</td></tr>`;
    return;
  }

  elements.transactions.innerHTML = rows.map(transactionRow).join("");
}

elements.transactions.addEventListener("click", (event) => {
  const ticker = event.target.closest("[data-ticker]")?.dataset.ticker;
  if (!ticker) return;
  state.search = ticker.toLowerCase();
  elements.search.value = ticker;
  updateUrl({ replace: false });
  render();
});

function filteredTransactions() {
  return state.transactions.filter((item) => {
    const haystack = `${item.ticker} ${item.issuerName} ${item.ownerName} ${item.ownerTitle}`.toLowerCase();
    return !state.search || haystack.includes(state.search);
  });
}

function transactionRow(item) {
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
      <td class="numeric">${item.price == null ? "-" : money.format(item.price)}</td>
      <td class="numeric">${item.value == null ? "-" : money.format(item.value)}</td>
      <td><a href="${item.filingUrl}" target="_blank" rel="noreferrer">Filing</a></td>
    </tr>
  `;
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
    state.days = 93;
    elements.rangeFilter.value = "93";
  }

  if (Number.isFinite(threshold) && threshold > 0) {
    state.threshold = threshold;
    elements.threshold.value = String(threshold);
  } else {
    state.threshold = 5000000;
    elements.threshold.value = "5000000";
  }
}

function updateUrl({ replace = true } = {}) {
  const params = new URLSearchParams();

  if (state.search) params.set("q", state.search);
  if (state.days !== 93) params.set("days", String(state.days));
  if (state.threshold !== 5000000) params.set("threshold", String(state.threshold));

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
