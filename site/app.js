/* Sewer Watch dashboard.
   Loads /data/dashboard.json + /data/sync.json + /data/backup.json
   from the SW data sync job
   and renders into the editorial layout, with light/dark theming
   and a scrollable history viewer over the available point series. */

const dashboardUrl = "data/dashboard.json";
const syncUrl = "data/sync.json";
const backupUrl = "data/backup.json";

const POLL_MS = 30000;
const THEME_KEY = "sw.theme";
const RANGE_KEY = "sw.historyRange";

function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback || "";
}

function getPalette() {
  return {
    ink: cssVar("--ink", "#1c2530"),
    inkSoft: cssVar("--ink-soft", "#4d5762"),
    inkMute: cssVar("--ink-mute", "#7a838d"),
    hair: cssVar("--hair", "rgba(28, 37, 48, 0.18)"),
    hairSoft: cssVar("--hair-soft", "rgba(28, 37, 48, 0.09)"),
    pressure: cssVar("--chart-pressure", "#1f3552"),
    pressureFill: cssVar("--chart-pressure-fill", "rgba(31, 53, 82, 0.10)"),
    current: cssVar("--chart-current", "#2c6863"),
    currentFill: cssVar("--chart-current-fill", "rgba(44, 104, 99, 0.12)"),
    bar: cssVar("--steel", "#3d5878"),
    barFill: cssVar("--chart-bar-blue", "rgba(61, 88, 120, 0.55)"),
    rustFill: cssVar("--chart-bar-rust", "rgba(164, 72, 42, 0.55)"),
    amber: cssVar("--amber", "#a37020"),
    amberFill: cssVar("--chart-amber-fill", "rgba(163, 112, 32, 0.16)"),
    rust: cssVar("--rust", "#a4482a"),
    crimson: cssVar("--crimson", "#882f24"),
    sage: cssVar("--sage", "#4f6f4a"),
    teal: cssVar("--teal", "#2c6863"),
    paper: cssVar("--paper", "#f4ede0"),
    tooltipBg: cssVar("--chart-tooltip-bg", "#1c2530"),
    tooltipFg: cssVar("--chart-tooltip-fg", "#f4ede0"),
    tooltipBorder: cssVar("--chart-tooltip-border", "rgba(244,237,224,0.18)"),
  };
}

let PALETTE = null;
const charts = {};
let loadInFlight = false;
let lastPayload = null;
let lastSync = null;
let lastBackup = null;

const fmtTime = new Intl.DateTimeFormat(undefined, {
  hour: "numeric", minute: "2-digit",
});
const fmtDateTime = new Intl.DateTimeFormat(undefined, {
  month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
});
const fmtDate = new Intl.DateTimeFormat(undefined, {
  month: "short", day: "numeric",
});
const fmtClock = new Intl.DateTimeFormat(undefined, {
  weekday: "short", month: "short", day: "numeric",
  hour: "numeric", minute: "2-digit",
});

/* ─── Helpers ────────────────────────────────────────────────── */

function byId(id) { return document.getElementById(id); }

function setText(id, value) {
  const el = byId(id);
  if (el) el.textContent = value;
}

function asNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function titleCase(value) {
  return String(value || "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatPressure(value, places = 3) {
  const n = asNumber(value);
  return n === null ? "—" : `${n.toFixed(places)} inH₂O`;
}
function formatPressureCompact(value) {
  const n = asNumber(value);
  return n === null ? "—" : (n >= 1 ? n.toFixed(2) : n.toFixed(3));
}
function formatCurrent(value) {
  const n = asNumber(value);
  return n === null ? "—" : `${n.toFixed(3)} mA`;
}
function formatSeconds(value) {
  const n = asNumber(value);
  return n === null ? "—" : `${n.toFixed(1)} s`;
}
function formatRatio(value) {
  const n = asNumber(value);
  return n === null ? "—" : `${n.toFixed(2)}×`;
}
function formatPercent(value) {
  const n = asNumber(value);
  if (n === null) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(1)}%`;
}
function formatBytes(value) {
  const n = asNumber(value);
  if (n === null) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = n, idx = 0;
  while (size >= 1024 && idx < units.length - 1) {
    size /= 1024; idx += 1;
  }
  return `${size.toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
}

function formatTimestamp(value, fmt = fmtDateTime) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return fmt.format(d);
}

function secondsSince(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return Math.max(0, (Date.now() - d.getTime()) / 1000);
}

const STALE_AFTER_SECONDS = 5 * 60;
const SEVERE_STALE_AFTER_SECONDS = 30 * 60;

function snapshotAgeSeconds(payload) {
  return secondsSince(payload?.generated_at) ?? secondsSince(payload?.synced_at);
}

function snapshotStaleness(payload) {
  const age = snapshotAgeSeconds(payload);
  if (age === null) return { age: null, stale: false, severe: false };
  return {
    age,
    stale: age > STALE_AFTER_SECONDS,
    severe: age > SEVERE_STALE_AFTER_SECONDS,
  };
}

function freshnessInfo(payload, sync) {
  const age = snapshotAgeSeconds(payload);
  const syncStatus = (sync?.status || "").toLowerCase();
  if (age === null) {
    return { state: "unknown", text: "Connecting…", overlay: null };
  }
  const ageText = formatAge(age).replace(/ ago$/, "");
  if (age > SEVERE_STALE_AFTER_SECONDS) {
    return {
      state: "severe",
      text: `Stale · ${ageText} ago`,
      overlay: `Last data point is ${ageText} ago — Pi sync is offline. Showing the most recent successful snapshot.`,
    };
  }
  if (syncStatus === "error" && age > STALE_AFTER_SECONDS) {
    return { state: "error", text: `Sync error · ${ageText} ago`, overlay: null };
  }
  if (age > STALE_AFTER_SECONDS) {
    return { state: "stale", text: `Stale · ${ageText} ago`, overlay: null };
  }
  return { state: "live", text: `Live · ${ageText} ago`, overlay: null };
}

function isSameLocalDay(a, b) {
  if (!a || !b) return false;
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

function formatAge(seconds) {
  const n = asNumber(seconds);
  if (n === null) return "—";
  if (n < 60) return `${Math.round(n)} sec ago`;
  if (n < 3600) return `${Math.round(n / 60)} min ago`;
  if (n < 86400) return `${(n / 3600).toFixed(1)} hr ago`;
  return `${(n / 86400).toFixed(1)} days ago`;
}

function formatRange(low, high) {
  const lo = asNumber(low);
  const hi = asNumber(high);
  if (lo === null && hi === null) return "—";
  if (lo === null) return `≤ ${hi.toFixed(3)} inH₂O`;
  if (hi === null) return `≥ ${lo.toFixed(3)} inH₂O`;
  return `${lo.toFixed(3)} – ${hi.toFixed(3)} inH₂O`;
}

function formatDateLabel(value) {
  if (!value) return "—";
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return String(value);
  return fmtDate.format(d);
}

function setStatusClass(el, value, prefix) {
  if (!el) return;
  const candidates = [
    "quiet","low","watch","elevated","high","critical","ok","warning",
    "error","normal","normal_flush","baseline_shift","unknown","good","usable",
    "limited","poor","rising","falling","stable","insufficient","alarm","stale",
  ];
  el.classList.remove(...candidates.map((c) => `${prefix}-${c}`));
  if (value) el.classList.add(`${prefix}-${String(value).toLowerCase()}`);
}

function metricValues(points, key) {
  return points
    .map((p) => asNumber(p?.[key]))
    .filter((v) => v !== null);
}

function chartMax(values, fallback) {
  return values.length ? Math.max(...values) : fallback;
}
function chartMin(values, fallback) {
  return values.length ? Math.min(...values) : fallback;
}

function roundPressureMax(value) {
  const n = Math.max(0, Number(value) || 0);
  if (n <= 0.25) return Math.ceil(n / 0.025) * 0.025;
  if (n <= 1)    return Math.ceil(n / 0.1) * 0.1;
  if (n <= 3)    return Math.ceil(n / 0.25) * 0.25;
  return Math.ceil(n / 0.5) * 0.5;
}

function computePressureDomain(points, limits, mode = "pulse") {
  const values = metricValues(points, "pressure_inh2o");
  const p = limits?.pressure_inh2o || {};
  const baseline = asNumber(p.baseline_high) ?? 0.05;
  const flush = asNumber(p.flush_expected_high) ?? 0.35;
  const watch = asNumber(p.watch_high) ?? 1.5;
  const elevated = asNumber(p.elevated_high) ?? 3.0;
  const observed = chartMax(values, 0);
  const next = [baseline, flush, watch, elevated]
    .filter((v) => v > observed * 1.001)
    .sort((a, b) => a - b)[0];

  let raw;
  if (mode === "overview") {
    raw = Math.max(observed * 1.18, watch * 1.1, flush * 1.5, 1.0);
  } else if (mode === "alarm") {
    raw = Math.max(observed * 1.15, elevated * 1.08, watch * 1.12, 1.0);
  } else {
    raw = Math.max(observed * 1.22, flush * 1.2, baseline * 5, 0.25);
    if (observed >= watch * 0.8) raw = Math.max(raw, watch * 1.04);
  }
  if (mode === "pulse" && next && next <= Math.max(raw * 2.0, observed + 0.75)) {
    raw = Math.max(raw, next * 1.04);
  }
  return { min: 0, max: Math.max(roundPressureMax(raw), 0.25) };
}

function computeCurrentDomain(points, limits) {
  const values = metricValues(points, "current_ma");
  const c = limits?.current_ma || {};
  const minObs = chartMin(values, asNumber(c.baseline_high) ?? 12.0);
  const maxObs = chartMax(values, asNumber(c.elevated_high) ?? 14.5);
  const baseline = asNumber(c.baseline_high) ?? minObs;
  const elevated = asNumber(c.elevated_high) ?? maxObs;
  return {
    min: Math.max(0, Math.min(minObs, baseline) - 0.08),
    max: Math.max(maxObs, elevated) + 0.12,
  };
}

/* ─── Threshold lines & shaded bands plugin ─────────────────── */

const sewerBandsPlugin = {
  id: "sewerBands",
  beforeDatasetsDraw(chart, _args, opts) {
    const bands = opts?.bands;
    if (!Array.isArray(bands) || !bands.length) return;
    const { ctx, chartArea, scales } = chart;
    const y = scales?.y;
    if (!ctx || !chartArea || !y) return;
    ctx.save();
    for (const band of bands) {
      const from = Number(band.from);
      const to = Number(band.to);
      if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) continue;
      const top = y.getPixelForValue(to);
      const bottom = y.getPixelForValue(from);
      const h = bottom - top;
      if (!Number.isFinite(top) || !Number.isFinite(bottom) || h <= 0) continue;
      ctx.fillStyle = band.color;
      ctx.fillRect(chartArea.left, top, chartArea.right - chartArea.left, h);
    }
    ctx.restore();
  },
};

if (window.Chart) Chart.register(sewerBandsPlugin);

function buildPressureBands(limits, visibleMax) {
  const p = limits?.pressure_inh2o || {};
  const baseline = asNumber(p.baseline_high) ?? 0.05;
  const flush = asNumber(p.flush_expected_high) ?? 0.35;
  const watch = asNumber(p.watch_high) ?? 1.5;
  const elevated = asNumber(p.elevated_high) ?? 3.0;
  return [
    { from: 0,        to: Math.min(baseline, visibleMax), color: "rgba(79, 111, 74, 0.05)" },
    { from: baseline, to: Math.min(flush, visibleMax),    color: "rgba(44, 104, 99, 0.05)" },
    { from: flush,    to: Math.min(watch, visibleMax),    color: "rgba(163, 112, 32, 0.07)" },
    { from: watch,    to: Math.min(elevated, visibleMax), color: "rgba(164, 72, 42, 0.10)" },
    { from: elevated, to: visibleMax,                     color: "rgba(136, 47, 36, 0.13)" },
  ];
}

function buildCurrentBands(limits, visibleMax) {
  const c = limits?.current_ma || {};
  const baseline = asNumber(c.baseline_high) ?? 12.0;
  const flush = asNumber(c.flush_expected_high) ?? 12.3;
  const watch = asNumber(c.watch_high) ?? 13.0;
  const elevated = asNumber(c.elevated_high) ?? 14.2;
  const lo = Math.max(0, baseline - 0.08);
  return [
    { from: lo,       to: Math.min(baseline, visibleMax), color: "rgba(79, 111, 74, 0.05)" },
    { from: baseline, to: Math.min(flush, visibleMax),    color: "rgba(44, 104, 99, 0.05)" },
    { from: flush,    to: Math.min(watch, visibleMax),    color: "rgba(163, 112, 32, 0.07)" },
    { from: watch,    to: Math.min(elevated, visibleMax), color: "rgba(164, 72, 42, 0.10)" },
    { from: elevated, to: visibleMax,                     color: "rgba(136, 47, 36, 0.13)" },
  ];
}

function buildPressureLimitDatasets(labels, limits, visibleMax) {
  const p = limits?.pressure_inh2o || {};
  const defs = [
    { label: "Normal flush high", value: p.flush_expected_high, color: PALETTE.teal,    dash: [6, 6] },
    { label: "Watch",             value: p.watch_high,          color: PALETTE.amber,   dash: [10, 6] },
    { label: "Elevated",          value: p.elevated_high,       color: PALETTE.rust,    dash: [10, 6] },
    { label: "Alarm",             value: p.alert_high,          color: PALETTE.crimson, dash: [4, 5] },
  ];
  return defs
    .map((line) => {
      const v = asNumber(line.value);
      if (v === null) return null;
      if (asNumber(visibleMax) !== null && v > visibleMax * 1.001) return null;
      return {
        type: "line",
        label: line.label,
        data: labels.map(() => v),
        borderColor: line.color,
        borderWidth: 1,
        pointRadius: 0,
        fill: false,
        tension: 0,
        borderDash: line.dash,
      };
    })
    .filter(Boolean);
}

function buildCurrentLimitDatasets(labels, limits) {
  const c = limits?.current_ma || {};
  const defs = [
    { label: "Normal flush high", value: c.flush_expected_high, color: PALETTE.teal,  dash: [6, 6] },
    { label: "Watch",             value: c.watch_high,          color: PALETTE.amber, dash: [10, 6] },
    { label: "Elevated",          value: c.elevated_high,       color: PALETTE.rust,  dash: [10, 6] },
  ];
  return defs
    .map((line) => {
      const v = asNumber(line.value);
      if (v === null) return null;
      return {
        type: "line",
        label: line.label,
        data: labels.map(() => v),
        borderColor: line.color,
        borderWidth: 1,
        pointRadius: 0,
        fill: false,
        tension: 0,
        borderDash: line.dash,
      };
    })
    .filter(Boolean);
}

/* ─── Chart factories ───────────────────────────────────────── */

function destroyChart(id) {
  const chart = charts[id];
  if (chart) {
    chart.destroy();
    delete charts[id];
  }

  const canvas = byId(id);
  const registered =
    canvas && window.Chart && typeof window.Chart.getChart === "function"
      ? window.Chart.getChart(canvas)
      : null;
  if (registered && registered !== chart) {
    registered.destroy();
  }
}

function createChart(id, config) {
  const canvas = byId(id);
  if (!canvas || !window.Chart) return;
  destroyChart(id);
  charts[id] = new Chart(canvas, config);
}

function baseScales(yTitle, min, max, maxTicks, formatter) {
  return {
    x: {
      ticks: { color: PALETTE.inkMute, maxTicksLimit: maxTicks ?? 8, font: { size: 11 } },
      grid: { color: PALETTE.hairSoft, drawTicks: false },
      border: { color: PALETTE.hair },
    },
    y: {
      ticks: {
        color: PALETTE.inkMute,
        font: { size: 11 },
        callback: formatter || ((v) => v),
      },
      grid: { color: PALETTE.hairSoft },
      border: { color: PALETTE.hair },
      title: { display: true, text: yTitle, color: PALETTE.inkSoft, font: { size: 11 } },
      min, max,
    },
  };
}

function baseInteraction() {
  return {
    intersect: false,
    mode: "index",
  };
}

function baseLegend() {
  return {
    display: false,
  };
}

function baseTooltip(unit) {
  return {
    backgroundColor: PALETTE.tooltipBg,
    titleColor: PALETTE.tooltipFg,
    bodyColor: PALETTE.tooltipFg,
    borderColor: PALETTE.tooltipBorder,
    borderWidth: 1,
    cornerRadius: 2,
    padding: 8,
    titleFont: { family: "ui-monospace,Menlo,Consolas,monospace", size: 11 },
    bodyFont: { family: "ui-monospace,Menlo,Consolas,monospace", size: 12 },
    callbacks: {
      label(ctx) {
        const v = ctx.parsed?.y;
        if (v == null) return ctx.dataset.label || "";
        const n = asNumber(v);
        const formatted = unit === "inH2O"
          ? `${n.toFixed(3)} inH₂O`
          : unit === "mA"
            ? `${n.toFixed(3)} mA`
            : unit === "s"
              ? `${n.toFixed(1)} s`
              : String(v);
        return `${ctx.dataset.label}: ${formatted}`;
      },
    },
  };
}

function buildPressureChart(labels, datasets, yTitle, min, max, maxTicks, bands) {
  return {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: baseInteraction(),
      plugins: {
        legend: baseLegend(),
        tooltip: baseTooltip("inH2O"),
        sewerBands: { bands },
      },
      scales: baseScales(yTitle, min, max, maxTicks, (v) => {
        const n = asNumber(v);
        if (n === null) return v;
        return n >= 1 ? n.toFixed(2) : n.toFixed(3);
      }),
    },
  };
}

function renderPressureWindowChart(id, points, limits, maxTicks, mode = "pulse", scaleId = null) {
  const labels = points.map((p) => formatTimestamp(p.timestamp, fmtTime));
  const domain = computePressureDomain(points, limits, mode);
  const visible = domain.max;
  const datasets = [
    {
      label: "Pressure",
      data: points.map((p) => asNumber(p.pressure_inh2o)),
      borderColor: PALETTE.pressure,
      backgroundColor: PALETTE.pressureFill,
      borderWidth: 1.6,
      tension: 0.2,
      pointRadius: 0,
      fill: true,
    },
    ...buildPressureLimitDatasets(labels, limits, visible),
  ];
  if (scaleId) {
    setText(scaleId, `0 – ${formatPressureCompact(visible)} inH₂O`);
  }
  createChart(
    id,
    buildPressureChart(labels, datasets, "Pressure (inH₂O)", domain.min, visible, maxTicks, buildPressureBands(limits, visible))
  );
}

function renderCurrentChart(payload) {
  const points = payload?.history?.pressure_24h || [];
  const limits = payload?.limits || {};
  const domain = computeCurrentDomain(points, limits);
  const labels = points.map((p) => formatTimestamp(p.timestamp, fmtTime));
  const datasets = [
    {
      label: "Loop current",
      data: points.map((p) => asNumber(p.current_ma)),
      borderColor: PALETTE.current,
      backgroundColor: PALETTE.currentFill,
      borderWidth: 1.6,
      tension: 0.2,
      pointRadius: 0,
      fill: true,
    },
    ...buildCurrentLimitDatasets(labels, limits),
  ];
  createChart("currentChart", {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: baseInteraction(),
      plugins: {
        legend: baseLegend(),
        tooltip: baseTooltip("mA"),
        sewerBands: { bands: buildCurrentBands(limits, domain.max) },
      },
      scales: baseScales("Current (mA)", domain.min, domain.max, 8, (v) => {
        const n = asNumber(v);
        return n === null ? v : n.toFixed(2);
      }),
    },
  });
}

function renderDailyPeakChart(payload) {
  const points = payload?.history?.daily_peaks_30d || [];
  const labels = points.map((p) => formatDateLabel(p.day));
  const maxValues = points.map((p) => asNumber(p.max_pressure_inh2o));
  const meanValues = points.map((p) => asNumber(p.mean_pressure_inh2o));
  createChart("dailyPeakChart", {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Daily peak",
          data: maxValues,
          backgroundColor: PALETTE.rustFill,
          borderColor: PALETTE.rust,
          borderWidth: 1,
          borderRadius: 1,
          borderSkipped: false,
        },
        {
          type: "line",
          label: "Daily mean",
          data: meanValues,
          tension: 0.18,
          borderColor: PALETTE.teal,
          borderWidth: 1.6,
          pointRadius: 0,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: baseInteraction(),
      plugins: {
        legend: {
          display: true,
          align: "end",
          labels: {
            color: PALETTE.inkSoft, boxWidth: 12, boxHeight: 8, font: { size: 11 },
          },
        },
        tooltip: baseTooltip("inH2O"),
      },
      scales: {
        x: {
          ticks: { color: PALETTE.inkMute, maxTicksLimit: 10, font: { size: 11 } },
          grid: { display: false },
          border: { color: PALETTE.hair },
        },
        y: {
          ticks: {
            color: PALETTE.inkMute,
            font: { size: 11 },
            callback: (v) => {
              const n = asNumber(v);
              return n === null ? v : (n >= 1 ? n.toFixed(2) : n.toFixed(3));
            },
          },
          grid: { color: PALETTE.hairSoft },
          border: { color: PALETTE.hair },
          title: { display: true, text: "Pressure (inH₂O)", color: PALETTE.inkSoft, font: { size: 11 } },
          min: 0,
        },
      },
    },
  });
}

function renderFlushTimingChart(payload) {
  const flushes = [...(payload?.flush_analysis?.recent || [])].slice(0, 8).reverse();
  const labels = flushes.map((f) => formatTimestamp(f.peak_timestamp, fmtTime));
  createChart("flushTimingChart", {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Pulse hold",
          data: flushes.map((f) => asNumber(f.duration_seconds)),
          backgroundColor: PALETTE.barFill,
          borderColor: PALETTE.bar,
          borderWidth: 1,
          borderRadius: 1,
        },
        {
          type: "line",
          label: "Recovery",
          data: flushes.map((f) => asNumber(f.recovery_seconds)),
          borderColor: PALETTE.amber,
          backgroundColor: PALETTE.amberFill,
          borderWidth: 1.6,
          tension: 0.18,
          pointRadius: 3,
          pointBackgroundColor: PALETTE.amber,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: baseInteraction(),
      plugins: {
        legend: {
          display: true,
          align: "end",
          labels: {
            color: PALETTE.inkSoft, boxWidth: 12, boxHeight: 8, font: { size: 11 },
          },
        },
        tooltip: baseTooltip("s"),
      },
      scales: {
        x: {
          ticks: { color: PALETTE.inkMute, maxTicksLimit: 8, font: { size: 11 } },
          grid: { display: false },
          border: { color: PALETTE.hair },
        },
        y: {
          ticks: {
            color: PALETTE.inkMute,
            font: { size: 11 },
            callback: (v) => {
              const n = asNumber(v);
              return n === null ? v : n.toFixed(0);
            },
          },
          grid: { color: PALETTE.hairSoft },
          border: { color: PALETTE.hair },
          title: { display: true, text: "Seconds", color: PALETTE.inkSoft, font: { size: 11 } },
          min: 0,
        },
      },
    },
  });
}

/* ─── Section renderers ─────────────────────────────────────── */

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

function verdictHeadline(level, riskLevel) {
  const map = {
    quiet: "The sewer pipe is quiet.",
    normal_flush: "Pipe is mid-flush; pulse looks normal.",
    baseline_shift: "Sewer-line baseline pressure is shifting.",
    watch: "A pulse stronger than usual is on watch.",
    elevated: "Pressure pulse is elevated.",
    critical: "Pressure alarm tripped — investigate.",
  };
  if (map[level]) return map[level];
  if (riskLevel === "high" || riskLevel === "critical") {
    return "Clog signal is climbing.";
  }
  if (riskLevel === "elevated") {
    return "Recent flushes are running heavier than typical.";
  }
  if (riskLevel === "watch") {
    return "Recent flushes are slightly off typical.";
  }
  if (riskLevel === "low") {
    return "Recent flushes match the typical baseline.";
  }
  return "Waiting for fresh monitor data.";
}

function verdictDetail(payload, level, riskLevel) {
  const note =
    payload?.prediction?.notes?.[0] ||
    payload?.flush_analysis?.notes?.[0] ||
    payload?.alarm_state?.message ||
    "Pressure monitor data is loading.";
  return note;
}

function renderVerdict(payload, sync) {
  const latest = payload?.latest || {};
  const recentPeak = payload?.recent_peak || {};
  const stats15 = payload?.stats_15m || {};
  const flushAnalysis = payload?.flush_analysis || {};
  const lastEvent = flushAnalysis?.last_event || null;
  const alarmState = payload?.alarm_state || {};
  const prediction = payload?.prediction || {};
  const dq = payload?.data_quality || {};

  const pressureLevel = (alarmState.pressure_level || "unknown").toLowerCase();
  const riskLevel = (prediction.risk_level || flushAnalysis.clog_signal_level || "unknown").toLowerCase();
  const staleness = snapshotStaleness(payload);
  const syncStatus = (sync?.status || "").toLowerCase();

  // ── Verdict block ──
  const verdictBlock = byId("verdictBlock");
  if (verdictBlock) {
    verdictBlock.dataset.level = pressureLevel;
    verdictBlock.dataset.stale = staleness.severe ? "severe" : (staleness.stale ? "true" : "false");
  }

  if (staleness.severe) {
    setText("verdictTag", `Stale · last known: ${pressureStateLabel(pressureLevel)}`);
    setText("verdictHeadline", "Pressure feed has gone stale.");
    setText(
      "verdictDetail",
      `Last snapshot is ${formatAge(staleness.age)}. The Pi exporter or sync job is offline — values below are the last‑known state, not live.`
    );
  } else {
    setText("verdictTag", `${pressureStateLabel(pressureLevel)} · ${titleCase(riskLevel)} clog signal`);
    setText("verdictHeadline", verdictHeadline(pressureLevel, riskLevel));
    setText("verdictDetail", verdictDetail(payload, pressureLevel, riskLevel));
  }

  const score = asNumber(prediction.risk_score);
  setText("scoreValue", score === null ? "—" : `${Math.round(score)}/100`);
  setText("confidenceValue", titleCase(prediction.confidence || flushAnalysis.confidence || "low"));
  setText("flushCountValue", String(flushAnalysis.count_24h ?? 0));

  // ── Readouts ──
  const sampleAge = secondsSince(latest.timestamp);
  const sampleStale = sampleAge !== null && sampleAge > STALE_AFTER_SECONDS;
  const ageSuffix = sampleStale ? ` · ${formatAge(sampleAge)}` : "";

  setText("readPressure", formatPressureCompact(latest.pressure_positive_inh2o ?? latest.pressure_inh2o));
  setText(
    "readPressureFoot",
    sampleStale
      ? `Last reading · ${formatTimestamp(latest.timestamp, fmtTime)}${ageSuffix}`
      : `${pressureStateLabel(pressureLevel)} · ${formatTimestamp(latest.timestamp, fmtTime)}`
  );

  setText("readCurrent", asNumber(latest.current_ma) === null ? "—" : asNumber(latest.current_ma).toFixed(3));
  const currentFoot = asNumber(latest.current_ma) === null
    ? "Loop offline"
    : `mA · loop ${(latest.status || "").toLowerCase()}${ageSuffix}`;
  setText("readCurrentFoot", currentFoot);

  setText("readFlush", formatPressureCompact(lastEvent?.peak_pressure_inh2o ?? recentPeak.pressure_inh2o));
  if (lastEvent?.peak_timestamp) {
    setText("readFlushFoot", `${formatTimestamp(lastEvent.peak_timestamp, fmtTime)} · ${formatRatio(flushAnalysis.peak_ratio_vs_typical)} of typical`);
  } else {
    setText("readFlushFoot", "No flush captured yet");
  }

  setText("readRecovery", asNumber(lastEvent?.recovery_seconds) === null
    ? "—"
    : asNumber(lastEvent.recovery_seconds).toFixed(1));
  setText("readRecoveryFoot", asNumber(lastEvent?.recovery_seconds) === null
    ? "—"
    : `s · typ. ${formatSeconds(flushAnalysis.typical_recovery_seconds)}`);

  // ── Masthead meta ──
  setText("generatedClock", formatTimestamp(payload?.generated_at, fmtClock));

  const sampleEl = byId("lastSample");
  const sampleDate = latest.timestamp ? new Date(latest.timestamp) : null;
  let sampleText = "—";
  if (sampleDate && !Number.isNaN(sampleDate.getTime())) {
    const today = new Date();
    if (sampleStale) {
      sampleText = `${formatTimestamp(latest.timestamp, fmtTime)} · ${formatAge(sampleAge)}`;
    } else if (!isSameLocalDay(sampleDate, today)) {
      sampleText = formatTimestamp(latest.timestamp, fmtDateTime);
    } else {
      sampleText = formatTimestamp(latest.timestamp, fmtTime);
    }
  }
  setText("lastSample", sampleText);
  setStatusClass(
    sampleEl,
    staleness.severe ? "error" : (staleness.stale ? "stale" : "ok"),
    "status"
  );

  let syncText, syncTone;
  if (syncStatus === "error" && sync?.last_attempt_at) {
    syncText = `failed ${formatAge(secondsSince(sync.last_attempt_at))}`;
    syncTone = "error";
  } else if (sync?.last_success_at) {
    const successAge = secondsSince(sync.last_success_at);
    syncText = formatAge(successAge);
    syncTone = successAge !== null && successAge > STALE_AFTER_SECONDS ? "stale" : "ok";
  } else if (sync?.last_attempt_at) {
    syncText = `attempt ${formatAge(secondsSince(sync.last_attempt_at))}`;
    syncTone = "warning";
  } else {
    syncText = "idle";
    syncTone = "unknown";
  }
  setText("lastSync", syncText);
  setStatusClass(byId("lastSync"), syncTone, "status");

  const sensorState = staleness.severe ? "stale" : (latest.status || "unknown").toLowerCase();
  setText("sensorStatus", staleness.severe ? "STALE" : (latest.status || "—").toUpperCase());
  setStatusClass(byId("sensorStatus"), sensorState, "status");

}

function renderFreshness(payload, sync) {
  const info = freshnessInfo(payload, sync);
  const pill = byId("freshnessPill");
  if (pill) {
    pill.dataset.state = info.state;
    pill.textContent = info.text;
  }
  const card = document.querySelector(".trace-card");
  if (card) {
    if (info.state === "severe") {
      card.dataset.stale = "severe";
    } else if (info.state === "stale" || info.state === "error") {
      card.dataset.stale = "true";
    } else {
      card.dataset.stale = "false";
    }
  }
  const overlay = byId("staleOverlay");
  const msg = byId("staleOverlayMsg");
  if (overlay && msg) {
    if (info.overlay) {
      msg.textContent = info.overlay;
      overlay.hidden = false;
    } else {
      overlay.hidden = true;
    }
  }
}

function renderPressureLegend(payload, range) {
  const legend = byId("pressureLegend");
  if (!legend) return;
  legend.innerHTML = "";
  if (range.kind !== "line") {
    legend.style.display = "none";
    return;
  }
  legend.style.display = "";
  const lim = payload?.limits?.pressure_inh2o || {};
  const items = [
    { color: PALETTE.pressure, label: "Pressure", solid: true },
    { color: PALETTE.teal,    label: `Normal flush ≤ ${formatPressureCompact(lim.flush_expected_high)}` },
    { color: PALETTE.amber,   label: `Watch ≤ ${formatPressureCompact(lim.watch_high)}` },
    { color: PALETTE.rust,    label: `Elevated ≤ ${formatPressureCompact(lim.elevated_high)}` },
    { color: PALETTE.crimson, label: `Alarm at ${formatPressureCompact(lim.alert_high)}` },
  ];
  for (const it of items) {
    const li = document.createElement("li");
    li.style.color = it.color;
    const swatch = document.createElement("span");
    swatch.className = it.solid ? "swatch swatch-solid" : "swatch";
    const text = document.createElement("span");
    text.style.color = PALETTE.inkSoft;
    text.textContent = it.label;
    li.appendChild(swatch);
    li.appendChild(text);
    legend.appendChild(li);
  }
}

function renderFlushTable(payload) {
  const tbody = byId("flushTableBody");
  if (!tbody) return;
  const flushes = payload?.flush_analysis?.recent || [];
  const typicalPeak = asNumber(payload?.flush_analysis?.typical_peak_pressure_inh2o);
  if (!flushes.length) {
    tbody.innerHTML =
      `<tr><td colspan="5" class="empty">No flush events yet — flush a fixture to seed a baseline pulse.</td></tr>`;
    return;
  }
  const limits = payload?.limits?.pressure_inh2o || {};
  const watchHigh = asNumber(limits.watch_high);
  const elevatedHigh = asNumber(limits.elevated_high);
  const alarmHigh = asNumber(limits.alert_high);
  const rows = flushes.slice(0, 8).map((f) => {
    const peak = asNumber(f.peak_pressure_inh2o);
    let cls = "";
    if (peak !== null) {
      if (alarmHigh !== null && peak >= alarmHigh) cls = "cell-crit";
      else if (elevatedHigh !== null && peak >= elevatedHigh) cls = "cell-elev";
      else if (watchHigh !== null && peak >= watchHigh) cls = "cell-watch";
      else cls = "cell-quiet";
    }
    const ratio = typicalPeak && peak !== null && typicalPeak > 0
      ? (peak / typicalPeak)
      : null;
    return `
      <tr>
        <td>${formatTimestamp(f.peak_timestamp, fmtDateTime)}</td>
        <td class="num ${cls}">${peak === null ? "—" : peak.toFixed(3)}</td>
        <td class="num">${asNumber(f.duration_seconds) === null ? "—" : asNumber(f.duration_seconds).toFixed(1)}</td>
        <td class="num">${asNumber(f.recovery_seconds) === null ? "—" : asNumber(f.recovery_seconds).toFixed(1)}</td>
        <td class="num">${ratio === null ? "—" : `${ratio.toFixed(2)}×`}</td>
      </tr>
    `;
  });
  tbody.innerHTML = rows.join("");
}

function renderWindowStats(payload) {
  const tbody = byId("windowStatsBody");
  if (!tbody) return;
  const entries = [
    { label: "15 min", stats: payload?.stats_15m },
    { label: "1 hour", stats: payload?.stats_1h },
    { label: "6 hour", stats: payload?.stats_6h },
    { label: "24 hour", stats: payload?.stats_24h },
  ];
  tbody.innerHTML = entries.map(({ label, stats }) => {
    const s = stats || {};
    return `
      <tr>
        <td>${label}</td>
        <td class="num">${asNumber(s.max_pressure_inh2o) === null ? "—" : asNumber(s.max_pressure_inh2o).toFixed(3)}</td>
        <td class="num">${asNumber(s.p95_pressure_inh2o) === null ? "—" : asNumber(s.p95_pressure_inh2o).toFixed(3)}</td>
        <td class="num">${s.minutes_above_baseline ?? 0} min</td>
        <td class="num">${s.minutes_above_watch ?? 0} min</td>
        <td class="num">${s.coverage_hours ?? 0} hr</td>
        <td class="num">${s.fault_count ?? 0}</td>
      </tr>
    `;
  }).join("");
}

function renderBands(payload) {
  const root = byId("bandList");
  if (!root) return;
  const ranges = payload?.limits?.operating_ranges || [];
  if (!ranges.length) {
    root.innerHTML = `<li><span class="band-name">No ranges yet</span><p class="band-desc">Pressure threshold bands are not available.</p></li>`;
    return;
  }
  root.innerHTML = ranges.map((r) => `
    <li data-key="${r.key || ""}">
      <div>
        <span class="band-name">${r.label || titleCase(r.key)}</span>
        <p class="band-desc">${r.description || ""}</p>
      </div>
      <span class="band-range num">${formatRange(r.low, r.high)}</span>
    </li>
  `).join("");
}

function renderQuality(payload) {
  const card = byId("healthData");
  const quality = payload?.data_quality || {};
  const trend = payload?.flush_analysis?.trend || {};
  const level = (quality.level || "unknown").toLowerCase();
  const staleness = snapshotStaleness(payload);

  // Override to "stale" when the snapshot itself is old — the embedded
  // sample_age_seconds is computed by the Pi exporter and will read 0
  // even when the sync job hasn't pushed a new snapshot in hours.
  const effectiveLevel = staleness.stale ? "stale" : level;
  if (card) card.dataset.state = effectiveLevel;

  if (staleness.stale) {
    setText("qualityHeadline", "Stale");
    setText(
      "qualityBody",
      `Snapshot is ${formatAge(staleness.age)} — the Pi exporter or sync job hasn't delivered a fresh sample. Values shown reflect the last successful export.`
    );
  } else {
    setText("qualityHeadline", titleCase(level));
    setText("qualityBody", quality.message || "No data quality status yet.");
  }

  const detail = byId("qualityDetail");
  if (detail) {
    // Prefer the actual snapshot age when stale; otherwise show the
    // exporter's reported sample age.
    const sampleAgeDisplay = staleness.stale
      ? formatAge(staleness.age)
      : formatAge(quality.sample_age_seconds);
    const items = [
      ["Sample age", sampleAgeDisplay],
      ["15m density", asNumber(quality.sample_density_15m) === null
        ? "—"
        : `${(quality.sample_density_15m * 100).toFixed(1)}%`],
      ["Trend", titleCase(trend.level || "insufficient")],
      ["Peak Δ", formatPercent(trend.peak_delta_percent)],
      ["Recovery Δ", formatPercent(trend.recovery_delta_percent)],
      ["Pulse Δ", formatPercent(trend.duration_delta_percent)],
    ];
    detail.innerHTML = items.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");
  }
}

function renderBackup(backup) {
  const card = byId("healthBackup");
  const status = (backup?.status || "unknown").toLowerCase();
  const stale = (() => {
    const age = secondsSince(backup?.generated_at);
    return age !== null && age > 36 * 3600;
  })();
  const state = stale ? "stale" : status;
  if (card) card.dataset.state = state;

  setText("backupHeadline", stale ? "Stale" : titleCase(status));
  if (status !== "ok" || stale) {
    setText("backupBody", stale
      ? `Last successful backup is ${formatAge(secondsSince(backup?.generated_at))}.`
      : (backup?.error || "Backup status is unavailable."));
    const detail = byId("backupDetail");
    if (detail) detail.innerHTML = "";
    return;
  }
  const local = backup.local || {};
  const remote = backup.remote || {};
  setText("backupBody", `Daily backup OK · retained ${backup.retention_days ?? "—"} days · offsite ${backup.offsite?.status || "—"}.`);
  const detail = byId("backupDetail");
  if (detail) {
    const items = [
      ["Backup at", formatTimestamp(backup.generated_at, fmtDateTime)],
      ["Raw logs", formatBytes(local.raw_bytes)],
      ["SQLite snap", formatBytes(local.sqlite_latest_bytes)],
      ["Total size", formatBytes(local.total_bytes)],
      ["Readings", String(remote.readings ?? 0)],
      ["First", formatTimestamp(remote.first_timestamp, fmtDateTime)],
    ];
    detail.innerHTML = items.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");
  }
}

function renderDrivers(payload) {
  const root = byId("driverList");
  if (!root) return;
  const drivers = payload?.prediction?.drivers || payload?.flush_analysis?.drivers || [];
  if (!drivers.length) {
    root.innerHTML = `<dt>Status</dt><dd>Waiting for flush history</dd>`;
    return;
  }
  root.innerHTML = drivers.map((d) => `
    <dt>${d.label}</dt>
    <dd>${d.value} <span style="color: var(--ink-mute); font-family: var(--sans); margin-left: 4px;">${d.unit || ""}</span></dd>
  `).join("");
}

function renderEvents(payload) {
  const root = byId("eventList");
  if (!root) return;
  const alerts = payload?.events?.alerts || [];
  const faults = payload?.events?.faults || [];
  const items = [];
  for (const line of alerts.slice(-4).reverse()) items.push({ kind: "alert", text: line });
  for (const line of faults.slice(-4).reverse()) items.push({ kind: "fault", text: line });
  if (!items.length) {
    root.innerHTML = `<li class="empty">No alerts or faults reported.</li>`;
    return;
  }
  root.innerHTML = items.slice(0, 8).map((it) => `
    <li data-kind="${it.kind}">
      <span class="event-key">${it.kind}</span>
      <span class="event-msg">${escapeHtml(it.text)}</span>
    </li>
  `).join("");
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  }[c]));
}

function renderSystem(payload, sync) {
  const stats24h = payload?.stats_24h || {};
  const config = payload?.config || {};
  setText("sysHost", payload?.monitor_host || "—");
  setText("sysDb", payload?.paths?.database || "—");
  setText("sysAlert", formatPressure(config.alert_pressure_inh2o ?? config.alert_depth_in));
  setText("sysTrigger", formatPressure(payload?.limits?.pressure_inh2o?.baseline_high));
  setText("sysRate", `${config.sample_hz ?? "—"} Hz`);
  setText("sysCoverage", `${stats24h.coverage_hours ?? 0} hr`);
  const syncStatus = (sync?.status || "unknown").toLowerCase();
  setText("sysSync", titleCase(syncStatus));
  setStatusClass(byId("sysSync"), syncStatus, "status");
  setText("sysModel", titleCase(payload?.analysis_model || "pressure_pulse"));
  setText("sourceHost", payload?.monitor_host || "monitor");
  setText("generatedAtFoot", formatTimestamp(payload?.generated_at, fmtClock));
}

/* ─── History viewer ────────────────────────────────────────── */

const HISTORY_RANGES = [
  { id: "5m",  label: "5 min",    source: "pressure_15m_tail_5m", kind: "line", scale: "pulse",    pxPerPoint: 26, fit: false, density: "Raw samples" },
  { id: "1h",  label: "1 hour",   source: "pressure_1h",          kind: "line", scale: "pulse",    pxPerPoint: 11, fit: false, density: "Raw samples" },
  { id: "24h", label: "24 hours", source: "pressure_24h",         kind: "line", scale: "overview", pxPerPoint: 9,  fit: true,  density: "Downsampled trace" },
  { id: "7d",  label: "7 days",   source: "daily_peaks_7d",       kind: "bar",  scale: "daily",    pxPerPoint: 92, fit: true,  density: "Daily peak + mean" },
  { id: "30d", label: "30 days",  source: "daily_peaks_30d",      kind: "bar",  scale: "daily",    pxPerPoint: 38, fit: true,  density: "Daily peak + mean" },
];

let activeRangeId = null;

function readSavedRange() {
  try {
    const saved = localStorage.getItem(RANGE_KEY);
    return HISTORY_RANGES.find((r) => r.id === saved) ? saved : null;
  } catch (_) { return null; }
}
function writeSavedRange(id) {
  try { localStorage.setItem(RANGE_KEY, id); } catch (_) {}
}

function rangeButtons() {
  const root = byId("historyControls");
  return root ? Array.from(root.querySelectorAll(".history-range")) : [];
}

function selectRangeButton(rangeId) {
  for (const btn of rangeButtons()) {
    const isActive = btn.dataset.range === rangeId;
    btn.setAttribute("aria-selected", String(isActive));
    btn.tabIndex = isActive ? 0 : -1;
  }
}

function focusRangeButton(rangeId) {
  const btn = rangeButtons().find((b) => b.dataset.range === rangeId);
  if (btn) btn.focus();
}

function pickHistoryPoints(payload, range) {
  const history = payload?.history || {};
  if (range.source === "pressure_15m_tail_5m") {
    const all = history.pressure_15m || [];
    if (!all.length) return [];
    const lastT = new Date(all[all.length - 1].timestamp).getTime();
    if (!Number.isFinite(lastT)) return all.slice(-60);
    const cutoff = lastT - 5 * 60 * 1000;
    return all.filter((p) => {
      const t = new Date(p.timestamp).getTime();
      return Number.isFinite(t) && t >= cutoff;
    });
  }
  return history[range.source] || [];
}

function spanLabel(range, points) {
  if (!points.length) return "no data";
  if (range.kind === "bar") {
    const first = points[0]?.day;
    const last = points[points.length - 1]?.day;
    if (!first || !last) return `${points.length} day${points.length === 1 ? "" : "s"}`;
    if (first === last) return formatDateLabel(first);
    return `${formatDateLabel(first)} → ${formatDateLabel(last)}`;
  }
  const first = new Date(points[0]?.timestamp).getTime();
  const last = new Date(points[points.length - 1]?.timestamp).getTime();
  if (!Number.isFinite(first) || !Number.isFinite(last)) return `${points.length} points`;
  const minutes = (last - first) / 60000;
  if (minutes < 1) return `${Math.round((last - first) / 1000)} sec span`;
  if (minutes < 90) return `${minutes.toFixed(1)} min span`;
  const hours = minutes / 60;
  if (hours < 36) return `${hours.toFixed(1)} hr span`;
  return `${(hours / 24).toFixed(1)} day span`;
}

function extremeLabel(range, points) {
  if (!points.length) return "—";
  if (range.kind === "bar") {
    const peaks = points
      .map((p) => ({ v: asNumber(p.max_pressure_inh2o), day: p.day }))
      .filter((p) => p.v !== null);
    if (!peaks.length) return "—";
    const top = peaks.reduce((a, b) => (b.v > a.v ? b : a));
    return `peak ${formatPressureCompact(top.v)} on ${formatDateLabel(top.day)}`;
  }
  const samples = points
    .map((p) => ({ v: asNumber(p.pressure_inh2o), t: p.timestamp }))
    .filter((p) => p.v !== null);
  if (!samples.length) return "—";
  const top = samples.reduce((a, b) => (b.v > a.v ? b : a));
  return `peak ${formatPressureCompact(top.v)} at ${formatTimestamp(top.t, fmtTime)}`;
}

function renderHistoryViewer(payload) {
  const range = HISTORY_RANGES.find((r) => r.id === activeRangeId) || HISTORY_RANGES[2];
  const points = pickHistoryPoints(payload, range);
  const limits = payload?.limits || {};

  setText("historyDensity", `${range.label} · ${range.density}`);
  setText("historySpan", spanLabel(range, points));
  setText("historyExtreme", extremeLabel(range, points));
  renderPressureLegend(payload, range);

  const scroll = byId("historyScroll");
  const track = byId("historyTrack");
  if (!track || !scroll) return;

  const viewport = scroll.clientWidth || 600;
  const padding = 24;
  let desired;
  if (range.fit) {
    desired = viewport;
  } else {
    const minTrack = Math.max(viewport, 100);
    desired = Math.max(minTrack, points.length * range.pxPerPoint + padding);
  }
  track.style.width = `${desired}px`;

  const prevScroll = scroll.scrollLeft;
  const wasAtEnd = prevScroll + scroll.clientWidth >= scroll.scrollWidth - 4;

  destroyChart("historyChart");

  if (!points.length) {
    requestAnimationFrame(() => {
      track.style.width = "100%";
    });
    return;
  }

  if (range.kind === "line") {
    renderHistoryLineChart(points, limits, range);
  } else {
    renderHistoryBarChart(points, range);
  }

  requestAnimationFrame(() => {
    if (range.fit) {
      scroll.scrollLeft = 0;
    } else if (wasAtEnd) {
      scroll.scrollLeft = scroll.scrollWidth;
    } else {
      scroll.scrollLeft = prevScroll;
    }
  });
}

function renderHistoryLineChart(points, limits, range) {
  const labels = points.map((p) => formatTimestamp(p.timestamp, fmtTime));
  const domain = computePressureDomain(points, limits, range.scale);
  const visible = domain.max;
  const dense = points.length > 240;
  const datasets = [
    {
      label: "Pressure",
      data: points.map((p) => asNumber(p.pressure_inh2o)),
      borderColor: PALETTE.pressure,
      backgroundColor: PALETTE.pressureFill,
      borderWidth: 1.6,
      tension: 0.2,
      pointRadius: dense ? 0 : (points.length > 80 ? 0 : 2),
      pointHoverRadius: 4,
      fill: true,
    },
    ...buildPressureLimitDatasets(labels, limits, visible),
  ];
  const cfg = buildPressureChart(
    labels,
    datasets,
    "Pressure (inH₂O)",
    domain.min,
    visible,
    Math.max(6, Math.min(14, Math.round(points.length / 16))),
    buildPressureBands(limits, visible),
  );
  cfg.options.animation = false;
  createChart("historyChart", cfg);
}

function renderHistoryBarChart(points, _range) {
  const labels = points.map((p) => formatDateLabel(p.day));
  const peaks = points.map((p) => asNumber(p.max_pressure_inh2o));
  const means = points.map((p) => asNumber(p.mean_pressure_inh2o));
  createChart("historyChart", {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Daily peak",
          data: peaks,
          backgroundColor: PALETTE.rustFill,
          borderColor: PALETTE.rust,
          borderWidth: 1,
          borderRadius: 1,
          borderSkipped: false,
          maxBarThickness: 36,
        },
        {
          type: "line",
          label: "Daily mean",
          data: means,
          tension: 0.18,
          borderColor: PALETTE.teal,
          borderWidth: 1.6,
          pointRadius: 2,
          pointBackgroundColor: PALETTE.teal,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: baseInteraction(),
      plugins: {
        legend: {
          display: true,
          align: "end",
          labels: { color: PALETTE.inkSoft, boxWidth: 12, boxHeight: 8, font: { size: 11 } },
        },
        tooltip: baseTooltip("inH2O"),
      },
      scales: {
        x: {
          ticks: { color: PALETTE.inkMute, maxTicksLimit: Math.max(6, Math.min(30, points.length)), font: { size: 11 } },
          grid: { display: false },
          border: { color: PALETTE.hair },
        },
        y: {
          ticks: {
            color: PALETTE.inkMute,
            font: { size: 11 },
            callback: (v) => {
              const n = asNumber(v);
              return n === null ? v : (n >= 1 ? n.toFixed(2) : n.toFixed(3));
            },
          },
          grid: { color: PALETTE.hairSoft },
          border: { color: PALETTE.hair },
          title: { display: true, text: "Pressure (inH₂O)", color: PALETTE.inkSoft, font: { size: 11 } },
          min: 0,
        },
      },
    },
  });
}

function setActiveRange(rangeId, opts = {}) {
  const range = HISTORY_RANGES.find((r) => r.id === rangeId);
  if (!range) return;
  activeRangeId = range.id;
  selectRangeButton(activeRangeId);
  if (opts.persist !== false) writeSavedRange(activeRangeId);
  if (lastPayload) renderHistoryViewer(lastPayload);
  if (opts.focusButton) focusRangeButton(activeRangeId);
}

function bindHistoryControls() {
  const buttons = rangeButtons();
  if (!buttons.length) return;

  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      setActiveRange(btn.dataset.range);
    });
    btn.addEventListener("keydown", (e) => {
      const idx = buttons.indexOf(btn);
      let next = null;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        next = buttons[(idx + 1) % buttons.length];
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        next = buttons[(idx - 1 + buttons.length) % buttons.length];
      } else if (e.key === "Home") {
        next = buttons[0];
      } else if (e.key === "End") {
        next = buttons[buttons.length - 1];
      }
      if (next) {
        e.preventDefault();
        setActiveRange(next.dataset.range, { focusButton: true });
      }
    });
  });

  const scroll = byId("historyScroll");
  if (scroll) {
    scroll.addEventListener("keydown", (e) => {
      const step = Math.max(60, Math.round(scroll.clientWidth * 0.5));
      if (e.key === "ArrowRight") {
        e.preventDefault();
        scroll.scrollBy({ left: step, behavior: "smooth" });
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        scroll.scrollBy({ left: -step, behavior: "smooth" });
      } else if (e.key === "Home") {
        e.preventDefault();
        scroll.scrollTo({ left: 0, behavior: "smooth" });
      } else if (e.key === "End") {
        e.preventDefault();
        scroll.scrollTo({ left: scroll.scrollWidth, behavior: "smooth" });
      }
    });
  }
}

/* ─── Theme ─────────────────────────────────────────────────── */

const ICON_SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4l1.4-1.4M17 7l1.4-1.4"/></svg>';
const ICON_MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';

function readSavedTheme() {
  try { return localStorage.getItem(THEME_KEY); } catch (_) { return null; }
}
function writeSavedTheme(value) {
  try { localStorage.setItem(THEME_KEY, value); } catch (_) {}
}

function effectiveTheme() {
  const saved = readSavedTheme();
  if (saved === "light" || saved === "dark") return saved;
  if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) return "dark";
  return "light";
}

function updateThemeToggle(theme) {
  const btn = byId("themeToggle");
  if (!btn) return;
  const isDark = theme === "dark";
  btn.setAttribute("aria-pressed", String(isDark));
  btn.setAttribute(
    "aria-label",
    isDark ? "Switch to light theme" : "Switch to dark theme"
  );
  const icon = btn.querySelector(".theme-icon");
  const label = btn.querySelector(".theme-label");
  if (icon) icon.innerHTML = isDark ? ICON_SUN : ICON_MOON;
  if (label) label.textContent = isDark ? "Light" : "Dark";
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  PALETTE = getPalette();
  updateThemeToggle(theme);
  if (lastPayload) renderAll(lastPayload, lastSync, lastBackup);
}

function setupTheme() {
  const initial = effectiveTheme();
  applyTheme(initial);
  if (window.matchMedia) {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    if (mq.addEventListener) {
      mq.addEventListener("change", () => {
        if (!readSavedTheme()) {
          applyTheme(mq.matches ? "dark" : "light");
        }
      });
    }
  }
  const btn = byId("themeToggle");
  if (btn) {
    btn.addEventListener("click", () => {
      const current = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
      const next = current === "dark" ? "light" : "dark";
      writeSavedTheme(next);
      applyTheme(next);
    });
  }
}

/* ─── Render & loop ─────────────────────────────────────────── */

function renderAll(payload, sync, backup) {
  if (!PALETTE) PALETTE = getPalette();

  renderVerdict(payload, sync);
  renderFreshness(payload, sync);
  renderFlushTable(payload);
  renderWindowStats(payload);
  renderBands(payload);
  renderQuality(payload);
  renderBackup(backup);
  renderDrivers(payload);
  renderEvents(payload);
  renderSystem(payload, sync);

  renderPressureWindowChart(
    "recentChart",   payload?.history?.pressure_15m || [], payload?.limits || {}, 8, "pulse"
  );
  renderPressureWindowChart(
    "hourChart",     payload?.history?.pressure_1h  || [], payload?.limits || {}, 8, "pulse"
  );
  renderPressureWindowChart(
    "sixHourChart",  payload?.history?.pressure_6h  || [], payload?.limits || {}, 8, "overview"
  );

  renderCurrentChart(payload);
  renderDailyPeakChart(payload);
  renderFlushTimingChart(payload);

  renderHistoryViewer(payload);
}

async function loadData() {
  const cache = `ts=${Date.now()}`;
  const [d, s, b] = await Promise.all([
    fetch(`${dashboardUrl}?${cache}`),
    fetch(`${syncUrl}?${cache}`),
    fetch(`${backupUrl}?${cache}`),
  ]);
  if (!d.ok) throw new Error(`dashboard fetch failed: ${d.status}`);
  return {
    payload: await d.json(),
    sync: s.ok ? await s.json() : {},
    backup: b.ok ? await b.json() : {},
  };
}

async function tick() {
  if (loadInFlight) return;
  loadInFlight = true;
  try {
    const { payload, sync, backup } = await loadData();
    lastPayload = payload;
    lastSync = sync;
    lastBackup = backup;
    renderAll(payload, sync, backup);
  } catch (error) {
    console.error(error);
    const verdict = byId("verdictBlock");
    if (verdict) verdict.dataset.level = "error";
    setText("verdictTag", "Load error");
    setText("verdictHeadline", "Dashboard data could not be loaded.");
    setText("verdictDetail",
      "The Sewer Watch sync job either has not run yet or the data files are missing. Check the SW data sync timer.");
    setText("lastSync", "error");
  } finally {
    loadInFlight = false;
  }
}

function bootstrap() {
  PALETTE = getPalette();
  activeRangeId = readSavedRange() || "24h";
  selectRangeButton(activeRangeId);
  setupTheme();
  bindHistoryControls();
  tick();
  setInterval(tick, POLL_MS);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootstrap);
} else {
  bootstrap();
}
