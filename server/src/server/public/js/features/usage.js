import { requestJson } from "../api.js";
import { escHtml, formatTokens, formatCost } from "../format.js";

const CHART_COLORS = ["#d9772b", "#2f9d85", "#c68a31", "#a06585", "#6b78c7", "#c45c5c", "#5f9f62", "#c56f45"];
let activeUsageTab = "daily";
let activeUsageDays = 7;
let activeUsageMetric = "tokens";
let cachedDailyData = [];

function assignColors(keys) {
  return Object.fromEntries(keys.map((key, index) => [key, CHART_COLORS[index % CHART_COLORS.length]]));
}

function niceScale(max) {
  if (max <= 0) return 0.01;
  const exp = Math.floor(Math.log10(max));
  const base = Math.pow(10, exp);
  const norm = max / base;
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return Number((nice * base).toFixed(10));
}

function renderChart(containerId, legendId, data, groupKey, totalKey, formatFn, isCost) {
  const wrapper = document.getElementById(containerId);
  const legend = document.getElementById(legendId);
  if (!wrapper || !legend) return;
  if (!data?.length) {
    wrapper.innerHTML = "";
    legend.innerHTML = "";
    return;
  }

  const keys = Array.from(new Set(data.flatMap((entry) => Object.keys(entry[groupKey] || {})))).sort();
  const colors = assignColors(keys);
  const maxTotal = data.reduce((max, entry) => Math.max(max, entry[totalKey] || 0), 0);
  const yMax = isCost
    ? niceScale(maxTotal)
    : (maxTotal > 0 ? Math.ceil(maxTotal / 1000) * 1000 : 1000);
  const ySteps = 4;
  wrapper.innerHTML = "";

  const yAxis = document.createElement("div");
  yAxis.className = "chart-y-axis";
  for (let index = 0; index <= ySteps; index++) {
    const label = document.createElement("span");
    label.textContent = formatFn(isCost ? (yMax / ySteps) * (ySteps - index) : Math.round((yMax / ySteps) * (ySteps - index)));
    yAxis.appendChild(label);
  }
  wrapper.appendChild(yAxis);

  const chart = document.createElement("div");
  chart.className = "usage-chart";
  chart.style.flex = "1";
  for (let index = 0; index <= ySteps; index++) {
    const guide = document.createElement("div");
    guide.className = "usage-chart-guide";
    guide.style.bottom = `${(index / ySteps) * 100}%`;
    chart.appendChild(guide);
  }

  const totals = Object.fromEntries(keys.map((key) => [key, 0]));
  for (const entry of data) {
    for (const key of keys) totals[key] += entry[groupKey]?.[key] || 0;
  }
  const renderLegend = (values) => {
    // 只显示有量的模型（hover 当天或全时段合计），值为 0 的不渲染，避免图例出现 0.0 噪声
    const activeKeys = keys.filter((key) => (values?.[key] || 0) > 0);
    const total = activeKeys.reduce((sum, key) => sum + (values?.[key] || 0), 0);
    legend.innerHTML = activeKeys.map((key) => {
      const count = values?.[key] || 0;
      return `<span class="usage-legend-item"><span class="usage-legend-swatch" style="background:${colors[key]}"></span>${escHtml(key)}<span style="margin-left:12px">${formatFn(count)}</span></span>`;
    }).join("") + `<span class="usage-legend-sep"></span><span class="usage-legend-item usage-legend-total"><span class="usage-legend-swatch usage-legend-total-swatch"></span>合计<span style="margin-left:12px">${formatFn(total)}</span></span>`;
  };

  for (const entry of data) {
    const group = document.createElement("div");
    group.className = "usage-chart-bar-group";
    const indicator = document.createElement("div");
    indicator.className = "v-indicator";
    group.appendChild(indicator);
    const values = entry[groupKey] || {};
    for (const key of keys) {
      const value = values[key] || 0;
      if (!value) continue;
      const segment = document.createElement("div");
      segment.className = "usage-chart-bar-segment";
      segment.style.height = `${(value / yMax) * 100}%`;
      segment.style.background = colors[key];
      group.appendChild(segment);
    }
    group.addEventListener("mouseenter", () => renderLegend(values));
    group.addEventListener("mouseleave", () => renderLegend(totals));
    const dateLabel = document.createElement("div");
    dateLabel.className = "usage-chart-bar-label";
    dateLabel.textContent = entry.date.slice(5);
    group.appendChild(dateLabel);
    chart.appendChild(group);
  }
  wrapper.appendChild(chart);
  renderLegend(totals);
}

function padDateRange(apiData, days) {
  const byDate = Object.fromEntries(apiData.map((entry) => [entry.date, entry]));
  const padded = [];
  // 与后端口径一致：按北京时间（UTC+8，无夏令时）分天
  const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
  const today = new Date(Date.now() + BEIJING_OFFSET_MS);
  for (let index = days - 1; index >= 0; index--) {
    const date = new Date(today);
    date.setUTCDate(date.getUTCDate() - index);
    const key = date.toISOString().slice(0, 10);
    padded.push(byDate[key] || { date: key, totalTokens: 0, totalCost: 0, byModel: {}, byProvider: {}, byModelCost: {}, byProviderCost: {} });
  }
  return padded;
}

async function loadUsageDaily(days) {
  const empty = document.getElementById("usage-daily-empty");
  const modelArea = document.getElementById("usage-chart-model-area");
  const providerArea = document.getElementById("usage-chart-provider-area");
  showEmptyLoading(empty);
  modelArea.style.display = "none";
  providerArea.style.display = "none";
  const { data } = await requestJson(`/api/usage/daily?days=${days}`);
  cachedDailyData = padDateRange(Array.isArray(data) ? data : [], days);
  empty.style.display = "none";
  modelArea.style.display = "block";
  providerArea.style.display = "block";
  renderUsageDailyCharts();
}

function renderUsageDailyCharts() {
  const isCost = activeUsageMetric === "cost";
  const groupKey = isCost ? "byModelCost" : "byModel";
  const providerGroupKey = isCost ? "byProviderCost" : "byProvider";
  const totalKey = isCost ? "totalCost" : "totalTokens";
  const formatFn = isCost ? formatCost : formatTokens;
  renderChart("usage-chart-model", "usage-legend-model", cachedDailyData, groupKey, totalKey, formatFn, isCost);
  renderChart("usage-chart-provider", "usage-legend-provider", cachedDailyData, providerGroupKey, totalKey, formatFn, isCost);
}

function showEmptyLoading(el) {
  if (!el) return;
  el.style.display = "block";
  el.innerHTML = '<div class="empty-state-icon"><i data-lucide="loader-circle"></i></div><p class="empty-state-title">加载中...</p>';
  window.lucide?.createIcons();
}

function showEmptyNoData(el, title, copy) {
  if (!el) return;
  el.style.display = "block";
  el.innerHTML = `<div class="empty-state-icon"><i data-lucide="bar-chart-3"></i></div><p class="empty-state-title">${title}</p><p class="empty-state-copy">${copy}</p>`;
  window.lucide?.createIcons();
}

async function loadUsageTotal() {
  const empty = document.getElementById("usage-empty");
  const table = document.getElementById("usage-table");
  const body = document.getElementById("usage-table-body");
  const foot = document.getElementById("usage-table-foot");
  showEmptyLoading(empty);
  table.style.display = "none";
  body.innerHTML = "";
  foot.innerHTML = "";
  const { data: rows } = await requestJson("/api/usage/stats");
  if (!Array.isArray(rows) || rows.length === 0) {
    showEmptyNoData(empty, "暂无数据", "发送消息后即可查看 Token 统计");
    return;
  }
  rows.sort((a, b) => `${a.provider}${a.model}`.localeCompare(`${b.provider}${b.model}`));
  // 缓存输入口径与费用计算一致：cachedRead + cachedWrite，均为 inputTokens 的子集
  const splitInput = (row) => {
    const cached = (Number(row.cachedReadTokens) || 0) + (Number(row.cachedWriteTokens) || 0);
    return { cached, uncached: (Number(row.inputTokens) || 0) - cached };
  };
  const totals = rows.reduce((summary, row) => {
    const { cached, uncached } = splitInput(row);
    summary.cachedInput += cached;
    summary.uncachedInput += uncached;
    summary.billingOutputTokens += Number(row.billingOutputTokens ?? row.outputTokens) || 0;
    summary.cost += Number(row.cost) || 0;
    return summary;
  }, { cachedInput: 0, uncachedInput: 0, billingOutputTokens: 0, cost: 0 });
  body.innerHTML = rows.map((row) => {
    const { cached, uncached } = splitInput(row);
    return `
    <tr>
      <td>${escHtml(row.model || "")}</td>
      <td>${escHtml(row.provider || "")}</td>
      <td>${formatTokens(cached)}</td>
      <td>${formatTokens(uncached)}</td>
      <td>${formatTokens(row.billingOutputTokens ?? row.outputTokens)}</td>
      <td>${formatCost(row.cost)}</td>
    </tr>
  `;
  }).join("");
  foot.innerHTML = `
    <tr>
      <th scope="row" colspan="2">总计</th>
      <td>${formatTokens(totals.cachedInput)}</td>
      <td>${formatTokens(totals.uncachedInput)}</td>
      <td>${formatTokens(totals.billingOutputTokens)}</td>
      <td>${formatCost(totals.cost)}</td>
    </tr>
  `;
  empty.style.display = "none";
  table.style.display = "table";
}

export function switchUsageTab(tab) {
  activeUsageTab = tab;
  document.querySelectorAll(".usage-tab").forEach((element) => element.classList.toggle("active", element.dataset.tab === tab));
  document.getElementById("usage-daily-tab").style.display = tab === "daily" ? "block" : "none";
  document.getElementById("usage-total-tab").style.display = tab === "total" ? "block" : "none";
  if (tab === "daily") void loadUsageDaily(activeUsageDays);
  else void loadUsageTotal();
}

export function toggleUsageMetric(metric) {
  activeUsageMetric = metric;
  document.querySelectorAll(".usage-metric-toggle").forEach((el) => el.classList.toggle("active", el.dataset.metric === metric));
  if (activeUsageTab === "daily") renderUsageDailyCharts();
}

export async function openUsageModal() {
  document.getElementById("usage-modal").classList.add("open");
  try { await requestJson("/api/usage/flush", { method: "POST" }); } catch {}
  switchUsageTab(activeUsageTab);
}

export function closeUsageModal() {
  document.getElementById("usage-modal").classList.remove("open");
}

export function setUsageDays(days) {
  activeUsageDays = days;
  if (activeUsageTab === "daily") void loadUsageDaily(days);
}
