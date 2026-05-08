const dashboardUrl = "data/dashboard.json";
const syncUrl = "data/sync.json";

const charts = {};

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

function computePressureVisibleMax(points, limits) {
  const values = metricValues(points, "pressure_inh2o");
  const pressure = limits?.pressure_inh2o || {};
  const flush = asNumber(pressure.flush_expected_high) ?? 0.35;
  const watch = asNumber(pressure.watch_high) ?? 1.5;
  const observed = chartMax(values, 0);
  return Math.max(flush * 2.5, watch * 1.12, observed * 1.18, 0.8);
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

function buildPressureLimitLineDatasets(labels, limits) {
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
          ticks: { color: "#95afb4" },
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

function renderPressureWindowChart(id, points, limits, maxTicks) {
  const labels = points.map((point) => formatTimestamp(point.timestamp));
  const visibleMax = computePressureVisibleMax(points, limits);
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
    ...buildPressureLimitLineDatasets(labels, limits),
  ];

  createChart(
    id,
    buildTimeChart(labels, datasets, "Pressure (inH2O)", 0, visibleMax, maxTicks, buildPressureBands(limits, visibleMax))
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
          ticks: { color: "#95afb4" },
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
          ticks: { color: "#95afb4" },
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
  const visibleMax = Math.max(
    computePressureVisibleMax(flushes.map((flush) => ({ pressure_inh2o: flush.peak_pressure_inh2o })), limits),
    chartMax(values.filter((value) => value !== null), 0) * 1.15
  );

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
        ...buildPressureLimitLineDatasets(labels, limits),
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
          ticks: { color: "#95afb4" },
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
          ticks: { color: "#95afb4" },
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
  setText("currentPressureSub", `Loop ${formatCurrent(latest.current_ma)}`);
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
  setText("sensorStatusSub", `Sensor ${titleCase(alarmState.sensor_level || "unknown")}`);
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
  }

  setStatusClass(byId("riskLevel"), riskLevel, "status");
  setStatusClass(byId("alarmState"), alarmState.pressure_level || "unknown", "status");

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
  const [dashboardRes, syncRes] = await Promise.all([
    fetch(`${dashboardUrl}?${cacheBust}`),
    fetch(`${syncUrl}?${cacheBust}`),
  ]);

  if (!dashboardRes.ok) {
    throw new Error(`dashboard fetch failed: ${dashboardRes.status}`);
  }

  const payload = await dashboardRes.json();
  const sync = syncRes.ok ? await syncRes.json() : {};
  return { payload, sync };
}

async function main() {
  try {
    const { payload, sync } = await loadData();
    renderSummary(payload, sync);
    renderDrivers(payload?.prediction?.drivers || payload?.flush_analysis?.drivers || []);
    renderEvents(payload);
    renderLimits(payload);
    renderWindowStats(payload);
    renderFlushEvents(payload);
    renderPressureWindowChart("recentChart", payload?.history?.pressure_15m || [], payload?.limits || {}, 10);
    renderPressureWindowChart("hourChart", payload?.history?.pressure_1h || [], payload?.limits || {}, 8);
    renderPressureWindowChart("sixHourChart", payload?.history?.pressure_6h || [], payload?.limits || {}, 8);
    renderPressureWindowChart("pressureChart", payload?.history?.pressure_24h || [], payload?.limits || {}, 8);
    renderCurrentChart(payload);
    renderDailyPeakChart(payload);
    renderFlushPeakChart(payload);
    renderFlushTimingChart(payload);
  } catch (error) {
    console.error(error);
    setText("riskNote", "Dashboard data could not be loaded.");
    setText("lastSync", "Sync error");
    const message = error instanceof Error ? error.message : String(error);
    const roots = ["driversList", "eventsList", "limitsList", "windowStatsList", "flushEventsList"];
    for (const id of roots) {
      const root = byId(id);
      if (root) {
        root.innerHTML = `<div class="stack-item"><strong>Load error</strong><p>${message}</p></div>`;
      }
    }
  }
}

main();
setInterval(main, 15000);
