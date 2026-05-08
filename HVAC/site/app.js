const dashboardUrl = "data/dashboard.json";
const syncUrl = "data/sync.json";
const backupUrl = "data/backup.json";

const charts = {};
let loadInFlight = false;

const fmt = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

const shortDate = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});

const sewerBandsPlugin = {
  id: "sewerBands",
  beforeDatasetsDraw(chart, _args, pluginOptions) {
    const bands = pluginOptions?.bands;
    if (!Array.isArray(bands) || !bands.length) {
      return;
    }

    const { ctx, chartArea, scales } = chart;
    const y = scales?.y;
    if (!ctx || !chartArea || !y) {
      return;
    }

    ctx.save();
    for (const band of bands) {
      const from = Number(band.from);
      const to = Number(band.to);
      if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
        continue;
      }

      const top = y.getPixelForValue(to);
      const bottom = y.getPixelForValue(from);
      const height = bottom - top;
      if (!Number.isFinite(top) || !Number.isFinite(bottom) || height <= 0) {
        continue;
      }

      ctx.fillStyle = band.color;
      ctx.fillRect(chartArea.left, top, chartArea.right - chartArea.left, height);
    }
    ctx.restore();
  },
};

if (window.Chart) {
  Chart.register(sewerBandsPlugin);
}

function byId(id) {
  return document.getElementById(id);
}

function asNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function titleCase(value) {
  return String(value || "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function formatPressure(value) {
  const num = asNumber(value);
  return num === null ? "--" : `${num.toFixed(3)} inH2O`;
}

function formatCurrent(value) {
  const num = asNumber(value);
  return num === null ? "--" : `${num.toFixed(3)} mA`;
}

function formatSeconds(value) {
  const num = asNumber(value);
  return num === null ? "--" : `${num.toFixed(1)} s`;
}

function formatRatio(value) {
  const num = asNumber(value);
  return num === null ? "--" : `${num.toFixed(2)}x`;
}

function formatPercent(value) {
  const num = asNumber(value);
  if (num === null) {
    return "--";
  }
  const sign = num > 0 ? "+" : "";
  return `${sign}${num.toFixed(1)}%`;
}

function formatAbsolutePercent(value) {
  const num = asNumber(value);
  return num === null ? "--" : `${num.toFixed(1)}%`;
}

function formatBytes(value) {
  const num = asNumber(value);
  if (num === null) {
    return "--";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = num;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatAgeSeconds(value) {
  const num = asNumber(value);
  if (num === null) {
    return "--";
  }
  if (num < 60) {
    return `${Math.round(num)} sec`;
  }
  if (num < 3600) {
    return `${Math.round(num / 60)} min`;
  }
  return `${(num / 3600).toFixed(1)} hr`;
}

function formatPressureTick(value) {
  const num = asNumber(value);
  if (num === null) {
    return value;
  }
  return num >= 1 ? num.toFixed(2) : num.toFixed(3);
}

function formatCurrentTick(value) {
  const num = asNumber(value);
  return num === null ? value : num.toFixed(2);
}

function formatTimestamp(value) {
  if (!value) {
    return "--";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  return fmt.format(date);
}

function secondsSince(value) {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return Math.max(0, (Date.now() - date.getTime()) / 1000);
}

function riskColor(level) {
  const colors = {
    low: "#87d37c",
    watch: "#e2b84c",
    elevated: "#d98b45",
    high: "#ff8a5b",
    critical: "#ff4d57",
    unknown: "#a5aeb7",
  };
  return colors[String(level || "").toLowerCase()] || "#d98b45";
}

function formatDateLabel(value) {
  if (!value) {
    return "--";
  }
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  return shortDate.format(date);
}

function formatRange(low, high) {
  const lowNum = asNumber(low);
  const highNum = asNumber(high);
  if (lowNum === null && highNum === null) {
    return "--";
  }
  if (lowNum === null) {
    return `<= ${highNum.toFixed(3)} inH2O`;
  }
  if (highNum === null) {
    return `>= ${lowNum.toFixed(3)} inH2O`;
  }
  return `${lowNum.toFixed(3)} - ${highNum.toFixed(3)} inH2O`;
}

function setText(id, value) {
  const el = byId(id);
  if (el) {
    el.textContent = value;
  }
}

function setStatusClass(el, value, prefix) {
  if (!el) {
    return;
  }
  const values = [
    "quiet",
    "low",
    "watch",
    "elevated",
    "high",
    "critical",
    "ok",
    "warning",
    "error",
    "normal",
    "normal_flush",
    "baseline_shift",
    "unknown",
    "good",
    "usable",
    "limited",
    "poor",
    "rising",
    "falling",
    "stable",
    "insufficient",
  ];
  el.classList.remove(...values.map((item) => `${prefix}-${item}`));
  if (!value) {
    return;
  }
  el.classList.add(`${prefix}-${String(value).toLowerCase()}`);
}

function metricValues(points, key) {
  return points.map((point) => asNumber(point?.[key])).filter((value) => value !== null);
}

function chartMax(values, fallback) {
  return values.length ? Math.max(...values) : fallback;
}

function chartMin(values, fallback) {
  return values.length ? Math.min(...values) : fallback;
}

function roundPressureMax(value) {
  const num = Math.max(0, Number(value) || 0);
  if (num <= 0.25) {
    return Math.ceil(num / 0.025) * 0.025;
  }
  if (num <= 1) {
    return Math.ceil(num / 0.1) * 0.1;
  }
  if (num <= 3) {
    return Math.ceil(num / 0.25) * 0.25;
  }
  return Math.ceil(num / 0.5) * 0.5;
}

function computePressureDomain(points, limits, mode = "pulse") {
  const values = metricValues(points, "pressure_inh2o");
  const pressure = limits?.pressure_inh2o || {};
  const baseline = asNumber(pressure.baseline_high) ?? 0.05;
  const flush = asNumber(pressure.flush_expected_high) ?? 0.35;
  const watch = asNumber(pressure.watch_high) ?? 1.5;
  const elevated = asNumber(pressure.elevated_high) ?? 3.0;
  const observed = chartMax(values, 0);
  const nextThreshold = [baseline, flush, watch, elevated]
    .filter((value) => value > observed * 1.001)
    .sort((a, b) => a - b)[0];

  let rawMax;
  if (mode === "overview") {
    rawMax = Math.max(observed * 1.18, watch * 1.1, flush * 1.5, 1.0);
  } else if (mode === "alarm") {
    rawMax = Math.max(observed * 1.15, elevated * 1.08, watch * 1.12, 1.0);
  } else {
    rawMax = Math.max(observed * 1.22, flush * 1.2, baseline * 5, 0.25);
    if (observed >= watch * 0.8) {
      rawMax = Math.max(rawMax, watch * 1.04);
    }
  }

  if (mode === "pulse" && nextThreshold && nextThreshold <= Math.max(rawMax * 2.0, observed + 0.75)) {
    rawMax = Math.max(rawMax, nextThreshold * 1.04);
  }

  return {
    min: 0,
    max: Math.max(roundPressureMax(rawMax), 0.25),
  };
}

function computeCurrentDomain(points, limits) {
  const values = metricValues(points, "current_ma");
  const current = limits?.current_ma || {};
  const minObserved = chartMin(values, asNumber(current.baseline_high) ?? 12.0);
  const maxObserved = chartMax(values, asNumber(current.elevated_high) ?? 14.5);
  const baseline = asNumber(current.baseline_high) ?? minObserved;
  const elevated = asNumber(current.elevated_high) ?? maxObserved;
  return {
    min: Math.max(0, Math.min(minObserved, baseline) - 0.08),
    max: Math.max(maxObserved, elevated) + 0.12,
  };
}

function buildPressureBands(limits, visibleMax) {
  const pressure = limits?.pressure_inh2o || {};
  const baseline = asNumber(pressure.baseline_high) ?? 0.05;
  const flush = asNumber(pressure.flush_expected_high) ?? 0.35;
  const watch = asNumber(pressure.watch_high) ?? 1.5;
  const elevated = asNumber(pressure.elevated_high) ?? 3.0;
  return [
    { from: 0, to: Math.min(baseline, visibleMax), color: "rgba(184, 235, 111, 0.06)" },
    { from: baseline, to: Math.min(flush, visibleMax), color: "rgba(104, 215, 210, 0.05)" },
    { from: flush, to: Math.min(watch, visibleMax), color: "rgba(243, 154, 84, 0.08)" },
    { from: watch, to: Math.min(elevated, visibleMax), color: "rgba(243, 154, 84, 0.14)" },
    { from: elevated, to: visibleMax, color: "rgba(255, 125, 125, 0.14)" },
  ];
}

function buildCurrentBands(limits, visibleMax) {
  const current = limits?.current_ma || {};
  const baseline = asNumber(current.baseline_high) ?? 12.0;
  const flush = asNumber(current.flush_expected_high) ?? 12.3;
  const watch = asNumber(current.watch_high) ?? 13.0;
  const elevated = asNumber(current.elevated_high) ?? 14.2;
  const low = Math.max(0, baseline - 0.08);
  return [
    { from: low, to: Math.min(baseline, visibleMax), color: "rgba(184, 235, 111, 0.06)" },
    { from: baseline, to: Math.min(flush, visibleMax), color: "rgba(104, 215, 210, 0.05)" },
    { from: flush, to: Math.min(watch, visibleMax), color: "rgba(243, 154, 84, 0.08)" },
    { from: watch, to: Math.min(elevated, visibleMax), color: "rgba(243, 154, 84, 0.14)" },
    { from: elevated, to: visibleMax, color: "rgba(255, 125, 125, 0.14)" },
  ];
}

function buildPressureLimitLineDatasets(labels, limits, visibleMax) {
  const pressure = limits?.pressure_inh2o || {};
  const lineDefs = [
    { label: "Normal flush high", value: pressure.flush_expected_high, color: "#68d7d2", dash: [6, 6] },
    { label: "Watch", value: pressure.watch_high, color: "#ffd166", dash: [10, 6] },
    { label: "Elevated", value: pressure.elevated_high, color: "#f39a54", dash: [10, 6] },
    { label: "Alarm", value: pressure.alert_high, color: "#ff7d7d", dash: [4, 5] },
  ];
  return lineDefs
    .map((line) => {
      const value = asNumber(line.value);
      if (value === null) {
        return null;
      }
      if (asNumber(visibleMax) !== null && value > visibleMax * 1.001) {
        return null;
      }
      return {
        type: "line",
        label: line.label,
        data: labels.map(() => value),
        borderColor: line.color,
        borderWidth: 1.2,
        pointRadius: 0,
        fill: false,
        tension: 0,
        borderDash: line.dash,
      };
    })
    .filter(Boolean);
}

function buildCurrentLimitLineDatasets(labels, limits) {
  const current = limits?.current_ma || {};
  const lineDefs = [
    { label: "Normal flush high", value: current.flush_expected_high, color: "#68d7d2", dash: [6, 6] },
    { label: "Watch", value: current.watch_high, color: "#ffd166", dash: [10, 6] },
    { label: "Elevated", value: current.elevated_high, color: "#f39a54", dash: [10, 6] },
  ];
  return lineDefs
    .map((line) => {
      const value = asNumber(line.value);
      if (value === null) {
        return null;
      }
      return {
        type: "line",
        label: line.label,
        data: labels.map(() => value),
        borderColor: line.color,
        borderWidth: 1.2,
        pointRadius: 0,
        fill: false,
        tension: 0,
        borderDash: line.dash,
      };
    })
    .filter(Boolean);
}

function destroyChart(id) {
  if (charts[id]) {
    charts[id].destroy();
    delete charts[id];
  }
}

function createChart(id, config) {
  destroyChart(id);
  const canvas = byId(id);
  if (!canvas || !window.Chart) {
    return;
  }
  charts[id] = new Chart(canvas, config);
}

function buildTimeChart(labels, datasets, yTitle, min, max, maxTicks, bands = []) {
  return {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        intersect: false,
        mode: "index",
      },
      plugins: {
        legend: {
          labels: { color: "#e8f6f7" },
        },
        sewerBands: { bands },
      },
      scales: {
        x: {
          ticks: { color: "#95afb4", maxTicksLimit: maxTicks ?? 9 },
          grid: { color: "rgba(255,255,255,0.06)" },
        },
        y: {
          ticks: {
            color: "#95afb4",
            callback: formatPressureTick,
          },
          grid: { color: "rgba(255,255,255,0.06)" },
          title: {
            display: true,
            text: yTitle,
            color: "#95afb4",
          },
          min,
          max,
        },
      },
    },
  };
}

function renderPressureWindowChart(id, points, limits, maxTicks, mode = "pulse", badgeId = null) {
  const labels = points.map((point) => formatTimestamp(point.timestamp));
  const domain = computePressureDomain(points, limits, mode);
  const visibleMax = domain.max;
  const datasets = [
    {
      label: "Pressure",
      data: points.map((point) => asNumber(point.pressure_inh2o)),
      tension: 0.22,
      borderColor: "#68d7d2",
      backgroundColor: "rgba(104, 215, 210, 0.15)",
      pointRadius: 0,
      fill: true,
      borderWidth: 2.2,
    },
    ...buildPressureLimitLineDatasets(labels, limits, visibleMax),
  ];

  if (badgeId) {
    setText(badgeId, `0-${formatPressure(visibleMax)}`);
  }

  createChart(
    id,
    buildTimeChart(labels, datasets, "Pressure (inH2O)", domain.min, visibleMax, maxTicks, buildPressureBands(limits, visibleMax))
  );
}

function renderCurrentChart(payload) {
  const points = payload?.history?.pressure_24h || [];
  const limits = payload?.limits || {};
  const domain = computeCurrentDomain(points, limits);
  const labels = points.map((point) => formatTimestamp(point.timestamp));
  const datasets = [
    {
      label: "Loop current",
      data: points.map((point) => asNumber(point.current_ma)),
      tension: 0.2,
      borderColor: "#ffd166",
      backgroundColor: "rgba(255, 209, 102, 0.12)",
      pointRadius: 0,
      fill: true,
      borderWidth: 2.1,
    },
    ...buildCurrentLimitLineDatasets(labels, limits),
  ];

  createChart("currentChart", {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { intersect: false, mode: "index" },
      plugins: {
        legend: {
          labels: { color: "#e8f6f7" },
        },
        sewerBands: {
          bands: buildCurrentBands(limits, domain.max),
        },
      },
      scales: {
        x: {
          ticks: { color: "#95afb4", maxTicksLimit: 8 },
          grid: { color: "rgba(255,255,255,0.06)" },
        },
        y: {
          ticks: {
            color: "#95afb4",
            callback: formatCurrentTick,
          },
          grid: { color: "rgba(255,255,255,0.06)" },
          title: {
            display: true,
            text: "Current (mA)",
            color: "#95afb4",
          },
          min: domain.min,
          max: domain.max,
        },
      },
    },
  });

  setText("currentScale", `${domain.min.toFixed(2)}-${domain.max.toFixed(2)} mA`);
}

function renderDailyPeakChart(payload) {
  const points = payload?.history?.daily_peaks_30d || [];
  const labels = points.map((point) => formatDateLabel(point.day));
  const maxValues = points.map((point) => asNumber(point.max_pressure_inh2o));
  const meanValues = points.map((point) => asNumber(point.mean_pressure_inh2o));

  createChart("dailyPeakChart", {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Daily max pressure",
          data: maxValues,
          backgroundColor: "rgba(243, 154, 84, 0.65)",
          borderColor: "#f39a54",
          borderWidth: 1.2,
          borderRadius: 8,
        },
        {
          type: "line",
          label: "Daily mean pressure",
          data: meanValues,
          tension: 0.2,
          borderColor: "#68d7d2",
          pointRadius: 0,
          borderWidth: 2,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          labels: { color: "#e8f6f7" },
        },
      },
      scales: {
        x: {
          ticks: { color: "#95afb4", maxTicksLimit: 10 },
          grid: { display: false },
        },
        y: {
          ticks: {
            color: "#95afb4",
            callback: formatPressureTick,
          },
          grid: { color: "rgba(255,255,255,0.06)" },
          title: {
            display: true,
            text: "Pressure (inH2O)",
            color: "#95afb4",
          },
          min: 0,
        },
      },
    },
  });
}

function renderFlushPeakChart(payload) {
  const flushes = [...(payload?.flush_analysis?.recent || [])].slice(0, 8).reverse();
  const labels = flushes.map((flush) => formatTimestamp(flush.peak_timestamp));
  const values = flushes.map((flush) => asNumber(flush.peak_pressure_inh2o));
  const limits = payload?.limits || {};
  const domain = computePressureDomain(
    flushes.map((flush) => ({ pressure_inh2o: flush.peak_pressure_inh2o })),
    limits,
    "pulse"
  );
  const visibleMax = Math.max(domain.max, roundPressureMax(chartMax(values.filter((value) => value !== null), 0) * 1.15));
  setText("flushPeakScale", `0-${formatPressure(visibleMax)}`);

  createChart("flushPeakChart", {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Flush peak pressure",
          data: values,
          backgroundColor: "rgba(104, 215, 210, 0.65)",
          borderColor: "#68d7d2",
          borderWidth: 1.2,
          borderRadius: 8,
        },
        ...buildPressureLimitLineDatasets(labels, limits, visibleMax),
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          labels: { color: "#e8f6f7" },
        },
        sewerBands: {
          bands: buildPressureBands(limits, visibleMax),
        },
      },
      scales: {
        x: {
          ticks: { color: "#95afb4", maxTicksLimit: 8 },
          grid: { display: false },
        },
        y: {
          ticks: {
            color: "#95afb4",
            callback: formatPressureTick,
          },
          grid: { color: "rgba(255,255,255,0.06)" },
          title: {
            display: true,
            text: "Peak pressure (inH2O)",
            color: "#95afb4",
          },
          min: 0,
          max: visibleMax,
        },
      },
    },
  });
}

function renderFlushTimingChart(payload) {
  const flushes = [...(payload?.flush_analysis?.recent || [])].slice(0, 8).reverse();
  const labels = flushes.map((flush) => formatTimestamp(flush.peak_timestamp));

  createChart("flushTimingChart", {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Pulse width",
          data: flushes.map((flush) => asNumber(flush.duration_seconds)),
          backgroundColor: "rgba(243, 154, 84, 0.65)",
          borderColor: "#f39a54",
          borderWidth: 1.2,
          borderRadius: 8,
        },
        {
          type: "line",
          label: "Recovery",
          data: flushes.map((flush) => asNumber(flush.recovery_seconds)),
          tension: 0.2,
          borderColor: "#ffd166",
          backgroundColor: "rgba(255, 209, 102, 0.12)",
          pointRadius: 3,
          pointBackgroundColor: "#ffd166",
          borderWidth: 2,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          labels: { color: "#e8f6f7" },
        },
      },
      scales: {
        x: {
          ticks: { color: "#95afb4", maxTicksLimit: 8 },
          grid: { display: false },
        },
        y: {
          ticks: {
            color: "#95afb4",
            callback(value) {
              const num = asNumber(value);
              return num === null ? value : num.toFixed(0);
            },
          },
          grid: { color: "rgba(255,255,255,0.06)" },
          title: {
            display: true,
            text: "Seconds",
            color: "#95afb4",
          },
          min: 0,
        },
      },
    },
  });
}

function renderDrivers(drivers = []) {
  const root = byId("driversList");
  if (!root) {
    return;
  }
  root.innerHTML = "";
  if (!drivers.length) {
    root.innerHTML = `<div class="stack-item"><strong>Waiting for flush history</strong><p>No clog-signal driver values yet.</p></div>`;
    return;
  }
  for (const item of drivers) {
    const div = document.createElement("div");
    div.className = "stack-item";
    div.innerHTML = `<strong>${item.label}</strong><p>${item.value} ${item.unit}</p>`;
    root.appendChild(div);
  }
}

function renderEvents(payload) {
  const root = byId("eventsList");
  if (!root) {
    return;
  }
  const alerts = payload?.events?.alerts || [];
  const faults = payload?.events?.faults || [];
  const lines = [...faults.slice(-4), ...alerts.slice(-4)].slice(-6).reverse();
  root.innerHTML = "";
  if (!lines.length) {
    root.innerHTML = `<div class="stack-item"><strong>No recent alerts</strong><p>Neither faults nor pressure alerts have been recorded yet.</p></div>`;
    return;
  }
  for (const line of lines) {
    const div = document.createElement("div");
    div.className = "stack-item";
    div.innerHTML = `<strong>${line.includes("ALERT") ? "Alert" : "Monitor event"}</strong><p>${line}</p>`;
    root.appendChild(div);
  }
}

function renderLimits(payload) {
  const root = byId("limitsList");
  if (!root) {
    return;
  }
  const ranges = payload?.limits?.operating_ranges || [];
  root.innerHTML = "";
  if (!ranges.length) {
    root.innerHTML = `<div class="limit-card"><strong>No ranges yet</strong><p>Pressure threshold bands are unavailable.</p></div>`;
    return;
  }
  for (const range of ranges) {
    const div = document.createElement("div");
    div.className = "limit-card";
    div.innerHTML = `
      <strong>${range.label}</strong>
      <p>${range.description}</p>
      <span class="limit-range">${formatRange(range.low, range.high)}</span>
    `;
    root.appendChild(div);
  }
}

function renderWindowStats(payload) {
  const root = byId("windowStatsList");
  if (!root) {
    return;
  }

  const entries = [
    { label: "15 Minutes", stats: payload?.stats_15m },
    { label: "1 Hour", stats: payload?.stats_1h },
    { label: "6 Hours", stats: payload?.stats_6h },
    { label: "24 Hours", stats: payload?.stats_24h },
  ];

  root.innerHTML = "";
  for (const entry of entries) {
    const stats = entry.stats || {};
    const div = document.createElement("div");
    div.className = "stack-item";
    div.innerHTML = `
      <strong>${entry.label}</strong>
      <p>Peak ${formatPressure(stats.max_pressure_inh2o)} | P95 ${formatPressure(stats.p95_pressure_inh2o)}</p>
      <p>Coverage ${stats.coverage_hours ?? 0} hr | Faults ${stats.fault_count ?? 0}</p>
      <p>Above baseline ${stats.minutes_above_baseline ?? 0} min | Above watch ${stats.minutes_above_watch ?? 0} min</p>
    `;
    root.appendChild(div);
  }
}

function renderQuality(payload) {
  const root = byId("qualityList");
  if (!root) {
    return;
  }
  const quality = payload?.data_quality || {};
  const trend = payload?.flush_analysis?.trend || {};
  const level = quality.level || "unknown";
  const trendLevel = trend.level || "insufficient";

  setText("qualityState", titleCase(level));
  setStatusClass(byId("qualityState"), level, "status");

  root.innerHTML = "";
  const items = [
    {
      title: quality.message || "No data quality status yet.",
      body: `Sample age ${formatAgeSeconds(quality.sample_age_seconds)} | 15m density ${formatAbsolutePercent((quality.sample_density_15m ?? 0) * 100)}`,
    },
    {
      title: `Flush trend: ${titleCase(trendLevel)}`,
      body: trend.message || "Needs more flush events for a trend.",
      status: trendLevel,
    },
    {
      title: "Trend deltas",
      body: `Peak ${formatPercent(trend.peak_delta_percent)} | Recovery ${formatPercent(trend.recovery_delta_percent)} | Pulse ${formatPercent(trend.duration_delta_percent)}`,
    },
  ];

  for (const item of items) {
    const div = document.createElement("div");
    div.className = "stack-item";
    div.innerHTML = `<strong>${item.title}</strong><p>${item.body}</p>`;
    if (item.status) {
      setStatusClass(div, item.status, "status");
    }
    root.appendChild(div);
  }

  const issues = quality.issues || [];
  if (issues.length) {
    const div = document.createElement("div");
    div.className = "stack-item";
    div.innerHTML = `<strong>Notes</strong><p>${issues.slice(0, 3).join(" ")}</p>`;
    root.appendChild(div);
  }
}

function renderBackup(backup = {}) {
  const root = byId("backupList");
  if (!root) {
    return;
  }
  const status = backup.status || "unknown";
  const local = backup.local || {};
  const remote = backup.remote || {};
  const backupAge = secondsSince(backup.generated_at);
  const stale = backupAge !== null && backupAge > 36 * 3600;

  setText("backupState", stale ? "Stale" : titleCase(status));
  setStatusClass(byId("backupState"), status === "ok" && !stale ? "good" : "poor", "status");

  root.innerHTML = "";
  if (status !== "ok" || stale) {
    root.innerHTML = `<div class="stack-item"><strong>Backup problem</strong><p>${backup.error || "Backup status is unavailable."}</p></div>`;
    if (stale) {
      root.innerHTML = `<div class="stack-item"><strong>Backup stale</strong><p>Last successful backup is ${formatAgeSeconds(backupAge)} old.</p></div>`;
    }
    return;
  }

  const items = [
    {
      title: `Last backup ${formatTimestamp(backup.generated_at)}`,
      body: `Retention ${backup.retention_days ?? "--"} days | Root ${backup.backup_root || "--"}`,
    },
    {
      title: "Copied data",
      body: `Raw logs ${formatBytes(local.raw_bytes)} | SQLite snapshot ${formatBytes(local.sqlite_latest_bytes)} | Total ${formatBytes(local.total_bytes)}`,
    },
    {
      title: "Source history",
      body: `${remote.readings ?? 0} readings | ${formatTimestamp(remote.first_timestamp)} to ${formatTimestamp(remote.last_timestamp)}`,
    },
  ];

  for (const item of items) {
    const div = document.createElement("div");
    div.className = "stack-item";
    div.innerHTML = `<strong>${item.title}</strong><p>${item.body}</p>`;
    root.appendChild(div);
  }
}

function renderFlushEvents(payload) {
  const root = byId("flushEventsList");
  if (!root) {
    return;
  }
  const flushes = payload?.flush_analysis?.recent || [];
  root.innerHTML = "";
  if (!flushes.length) {
    root.innerHTML = `<div class="stack-item"><strong>No flush events yet</strong><p>Flush a toilet to capture a baseline pressure pulse for comparison.</p></div>`;
    return;
  }

  for (const flush of flushes.slice(0, 6)) {
    const div = document.createElement("div");
    div.className = "stack-item";
    div.innerHTML = `
      <strong>${formatPressure(flush.peak_pressure_inh2o)} peak</strong>
      <p>${formatTimestamp(flush.peak_timestamp)}</p>
      <p>Pulse ${formatSeconds(flush.duration_seconds)} | Recovery ${formatSeconds(flush.recovery_seconds)}</p>
    `;
    root.appendChild(div);
  }
}

function pressureStateLabel(value) {
  const labels = {
    quiet: "Quiet",
    baseline_shift: "Baseline shift",
    normal_flush: "Normal flush",
    watch: "Watch",
    elevated: "Elevated",
    critical: "Alarm",
    unknown: "Unknown",
  };
  return labels[value] || titleCase(value || "unknown");
}

function renderSummary(payload, sync) {
  const latest = payload?.latest || {};
  const recentPeak = payload?.recent_peak || {};
  const stats15 = payload?.stats_15m || {};
  const stats24h = payload?.stats_24h || {};
  const prediction = payload?.prediction || {};
  const flushAnalysis = payload?.flush_analysis || {};
  const lastEvent = flushAnalysis?.last_event || null;
  const alarmState = payload?.alarm_state || {};
  const dataQuality = payload?.data_quality || {};
  const riskScore = asNumber(prediction.risk_score);
  const riskLevel = prediction.risk_level || flushAnalysis.clog_signal_level || "unknown";
  const lastSample = latest.timestamp ? `Last sample ${formatTimestamp(latest.timestamp)}` : "No samples yet";
  const lastSync = sync?.last_success_at
    ? `Last sync ${formatTimestamp(sync.last_success_at)}`
    : sync?.last_attempt_at
      ? `Last attempt ${formatTimestamp(sync.last_attempt_at)}`
      : "Sync idle";
  const note =
    prediction?.notes?.[0] ||
    flushAnalysis?.notes?.[0] ||
    alarmState?.message ||
    "Pressure monitor data available.";

  setText("lastSample", lastSample);
  setText("lastSync", lastSync);
  setText("riskScore", riskScore === null ? "--" : String(riskScore));
  setText("riskLevel", titleCase(riskLevel));
  setText("riskNote", note);
  setText("confidenceLine", `Confidence: ${prediction.confidence || flushAnalysis.confidence || "low"}`);

  setText("currentPressure", formatPressure(latest.pressure_positive_inh2o ?? latest.pressure_inh2o));
  setText("currentPressureSub", `${pressureStateLabel(alarmState.pressure_level)} | Loop ${formatCurrent(latest.current_ma)}`);
  setText("peak15Pressure", formatPressure(stats15.max_pressure_inh2o ?? recentPeak.pressure_inh2o));
  setText(
    "peak15PressureSub",
    recentPeak.timestamp ? `Peak at ${formatTimestamp(recentPeak.timestamp)}` : `${stats15.sample_count ?? 0} samples in 15m`
  );
  setText("lastFlushPeak", formatPressure(lastEvent?.peak_pressure_inh2o));
  setText(
    "lastFlushPeakSub",
    lastEvent?.peak_timestamp ? `Latest flush ${formatTimestamp(lastEvent.peak_timestamp)}` : `${flushAnalysis.count_24h ?? 0} flushes in 24h`
  );
  setText("lastFlushHold", formatSeconds(lastEvent?.duration_seconds));
  setText(
    "lastFlushHoldSub",
    `Typical ${formatSeconds(flushAnalysis.typical_duration_seconds)}`
  );
  setText("lastRecovery", formatSeconds(lastEvent?.recovery_seconds));
  setText(
    "lastRecoverySub",
    `Typical ${formatSeconds(flushAnalysis.typical_recovery_seconds)}`
  );
  setText("typicalPeak", formatPressure(flushAnalysis.typical_peak_pressure_inh2o));
  setText("typicalPeakSub", `${titleCase(prediction.confidence || flushAnalysis.confidence || "low")} confidence baseline`);
  setText("peakRatio", formatRatio(flushAnalysis.peak_ratio_vs_typical));
  setText("peakRatioSub", "1.00x means typical flush peak");
  setText("recoveryRatio", formatRatio(flushAnalysis.recovery_ratio_vs_typical));
  setText("recoveryRatioSub", "1.00x means typical release time");
  setText("flushCount24h", String(flushAnalysis.count_24h ?? 0));
  setText("flushCount24hSub", `24h max ${formatPressure(stats24h.max_pressure_inh2o)}`);
  setText("alarmState", pressureStateLabel(alarmState.pressure_level));
  setText("alarmStateSub", alarmState.message || "No pressure state available");
  setText("sensorStatus", latest.status || "--");
  setText("sampleCount", String(stats24h.sample_count ?? "--"));
  setText("sampleCountSub", `${stats24h.coverage_hours ?? 0}h of history`);

  setText("monitorHost", payload.monitor_host || "--");
  setText("databasePath", payload?.paths?.database || "--");
  setText("alertPressure", formatPressure(payload?.config?.alert_pressure_inh2o ?? payload?.config?.alert_depth_in));
  setText("triggerPressure", formatPressure(payload?.limits?.pressure_inh2o?.baseline_high));
  setText("coverageHours", `${stats24h.coverage_hours ?? 0} hr`);
  setText("syncState", sync?.status || "unknown");
  setText("sampleRate", `${payload?.config?.sample_hz ?? "--"} Hz`);
  setText("analysisModel", titleCase(payload?.analysis_model || "pressure_pulse"));

  const ring = byId("riskRing");
  if (ring) {
    ring.style.setProperty("--score", String(riskScore ?? 0));
    ring.style.setProperty("--risk-color", riskColor(riskLevel));
  }

  setStatusClass(byId("riskLevel"), riskLevel, "status");
  setStatusClass(byId("alarmState"), alarmState.pressure_level || "unknown", "status");
  setStatusClass(
    byId("lastSample"),
    asNumber(dataQuality.sample_age_seconds) === null
      ? "unknown"
      : dataQuality.sample_age_seconds <= (dataQuality.fresh_sample_seconds ?? 30)
        ? "good"
        : dataQuality.sample_age_seconds <= (dataQuality.stale_sample_seconds ?? 120)
          ? "warning"
          : "error",
    "status"
  );
  const syncAge = secondsSince(sync?.last_success_at);
  setStatusClass(
    byId("lastSync"),
    syncAge === null ? "unknown" : syncAge <= 45 ? "good" : syncAge <= 180 ? "warning" : "error",
    "status"
  );

  const sensorEl = byId("sensorStatus");
  sensorEl?.classList.remove("status-ok", "status-warning", "status-error");
  if ((latest.status || "").toUpperCase() === "OK") {
    sensorEl?.classList.add("status-ok");
  } else if ((latest.status || "").toUpperCase() === "STALE") {
    sensorEl?.classList.add("status-warning");
  } else {
    sensorEl?.classList.add("status-error");
  }
}

async function loadData() {
  const cacheBust = `ts=${Date.now()}`;
  const [dashboardRes, syncRes, backupRes] = await Promise.all([
    fetch(`${dashboardUrl}?${cacheBust}`),
    fetch(`${syncUrl}?${cacheBust}`),
    fetch(`${backupUrl}?${cacheBust}`),
  ]);

  if (!dashboardRes.ok) {
    throw new Error(`dashboard fetch failed: ${dashboardRes.status}`);
  }

  const payload = await dashboardRes.json();
  const sync = syncRes.ok ? await syncRes.json() : {};
  const backup = backupRes.ok ? await backupRes.json() : {};
  return { payload, sync, backup };
}

async function main() {
  if (loadInFlight) {
    return;
  }
  loadInFlight = true;
  try {
    const { payload, sync, backup } = await loadData();
    renderSummary(payload, sync);
    renderDrivers(payload?.prediction?.drivers || payload?.flush_analysis?.drivers || []);
    renderEvents(payload);
    renderLimits(payload);
    renderWindowStats(payload);
    renderQuality(payload);
    renderBackup(backup);
    renderFlushEvents(payload);
    renderPressureWindowChart("recentChart", payload?.history?.pressure_15m || [], payload?.limits || {}, 10, "pulse", "recentScale");
    renderPressureWindowChart("hourChart", payload?.history?.pressure_1h || [], payload?.limits || {}, 8, "pulse", "hourScale");
    renderPressureWindowChart("sixHourChart", payload?.history?.pressure_6h || [], payload?.limits || {}, 8, "overview", "sixHourScale");
    renderPressureWindowChart("pressureChart", payload?.history?.pressure_24h || [], payload?.limits || {}, 8, "overview", "pressureScale");
    renderCurrentChart(payload);
    renderDailyPeakChart(payload);
    renderFlushPeakChart(payload);
    renderFlushTimingChart(payload);
  } catch (error) {
    console.error(error);
    setText("riskNote", "Dashboard data could not be loaded.");
    setText("lastSync", "Sync error");
    const message = error instanceof Error ? error.message : String(error);
    const roots = ["driversList", "eventsList", "limitsList", "windowStatsList", "qualityList", "backupList", "flushEventsList"];
    for (const id of roots) {
      const root = byId(id);
      if (root) {
        root.innerHTML = `<div class="stack-item"><strong>Load error</strong><p>${message}</p></div>`;
      }
    }
  } finally {
    loadInFlight = false;
  }
}

main();
setInterval(main, 15000);
