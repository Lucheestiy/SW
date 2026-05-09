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
const FLUSH_LOG_LIMIT = 100;

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

function timeMs(value) {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

function flushWindow(flush) {
  const peak = timeMs(flush?.peak_timestamp);
  const duration = asNumber(flush?.duration_seconds);
  if (peak === null || !(duration > 0)) return null;
  const end = timeMs(flush?.end_timestamp) ?? peak;
  const start = timeMs(flush?.start_timestamp) ?? (end - duration * 1000);
  if (start === null || !Number.isFinite(end) || end <= start) return null;
  return { start, end, peak, duration };
}

function pickAllFlushes(payload) {
  const fa = payload?.flush_analysis || {};
  if (Array.isArray(fa.events_24h) && fa.events_24h.length) return fa.events_24h;
  return Array.isArray(fa.recent) ? fa.recent : [];
}

function flushEventKey(flush) {
  return `${flush?.peak_timestamp || ""}|${flush?.peak_pressure_inh2o ?? ""}`;
}

function pickFlushLogEvents(payload) {
  const fa = payload?.flush_analysis || {};
  const sources = [
    Array.isArray(fa.recent) ? fa.recent : [],
    Array.isArray(fa.events_24h) ? fa.events_24h : [],
    Array.isArray(fa.events_history_7d) ? fa.events_history_7d : [],
  ];
  const seen = new Set();
  const events = [];
  for (const source of sources) {
    for (const flush of source) {
      const peakT = timeMs(flush?.peak_timestamp);
      if (peakT === null) continue;
      const key = flushEventKey(flush);
      if (seen.has(key)) continue;
      seen.add(key);
      events.push({ ...flush, $peakTimeMs: peakT });
    }
  }
  return events
    .sort((a, b) => b.$peakTimeMs - a.$peakTimeMs)
    .slice(0, FLUSH_LOG_LIMIT);
}

function flushAtTime(flushes, timestamp) {
  const t = timeMs(timestamp);
  if (t === null || !Array.isArray(flushes)) return null;
  return flushes.find((flush) => {
    const win = flushWindow(flush);
    return win && t >= win.start && t <= win.end;
  }) || null;
}

function fractionalTimeIndex(times, target) {
  if (!Array.isArray(times) || !times.length || !Number.isFinite(target)) return -1;
  let firstIdx = -1;
  let lastIdx = -1;
  for (let i = 0; i < times.length; i += 1) {
    if (Number.isFinite(times[i])) {
      if (firstIdx === -1) firstIdx = i;
      lastIdx = i;
    }
  }
  if (firstIdx === -1) return -1;
  if (target <= times[firstIdx]) return firstIdx;
  if (target >= times[lastIdx]) return lastIdx;
  for (let i = firstIdx; i < lastIdx; i += 1) {
    const t0 = times[i];
    const t1 = times[i + 1];
    if (!Number.isFinite(t0) || !Number.isFinite(t1)) continue;
    if (target >= t0 && target <= t1) {
      const span = t1 - t0;
      if (span <= 0) return i;
      return i + (target - t0) / span;
    }
  }
  return lastIdx;
}

function categoryPixelAt(scale, fIdx, total) {
  if (!scale || !Number.isFinite(fIdx)) return NaN;
  const i0 = Math.max(0, Math.floor(fIdx));
  const i1 = Math.min(total - 1, Math.ceil(fIdx));
  const px0 = scale.getPixelForValue(i0);
  if (!Number.isFinite(px0)) return NaN;
  if (i0 === i1) return px0;
  const px1 = scale.getPixelForValue(i1);
  if (!Number.isFinite(px1)) return px0;
  return px0 + (px1 - px0) * (fIdx - i0);
}

const flushPulseMarkers = {
  id: "flushPulseMarkers",
  afterInit(chart, _args, opts) {
    if (!chart || !chart.canvas) return;
    if (!opts && !chart.options?.plugins?.flushPulseMarkers) return;
    chart.$pulseHover = false;
    attachFlushHover(chart.canvas);
  },
  // Cancel the line tooltip's draw whenever the cursor is over a pulse
  // marker. Returning false here is the documented way to suppress the
  // tooltip frame for a single render — preferable to filter-based hiding,
  // which leaves an empty padded box visible alongside the pulse popup.
  beforeTooltipDraw(chart) {
    if (chart && chart.$pulseHover) return false;
  },
  afterDatasetsDraw(chart, _args, opts) {
    chart.$flushHits = [];
    const flushes = Array.isArray(chart.$flushes) ? chart.$flushes : opts?.flushes;
    const points = Array.isArray(chart.$sourcePoints) ? chart.$sourcePoints : opts?.points;
    if (!Array.isArray(flushes) || !flushes.length || !Array.isArray(points) || !points.length) return;
    const { ctx, chartArea, scales } = chart;
    const x = scales?.x;
    const y = scales?.y;
    if (!ctx || !chartArea || !x || !y) return;

    const times = points.map((p) => timeMs(p?.timestamp));
    const validTimes = times.filter((t) => Number.isFinite(t));
    if (!validTimes.length) return;
    const firstTime = validTimes[0];
    const lastTime = validTimes[validTimes.length - 1];

    // Flush rail: each detected event gets its own capsule glyph, separate
    // from the pressure trace. This is intentionally not just a point marker:
    // close pulses must still read as individual flush events.
    const glyphMinWidth = 14;
    const glyphMaxWidth = glyphMinWidth;
    const glyphHeight = 7;
    const glyphGap = 4;
    const glyphHalo = 2.5;
    const hitPad = 6;
    const minHSep = glyphMinWidth + glyphGap + hitPad * 2;
    const laneStep = glyphHeight + glyphHalo * 2 + 3;
    const accent = opts.color || PALETTE.rust || PALETTE.amber || PALETTE.ink;
    const connector = opts.connectorColor || "rgba(164, 72, 42, 0.34)";
    const halo = PALETTE.paper || "#fff";

    const leftBound = chartArea.left + glyphMaxWidth / 2 + 2;
    const rightBound = chartArea.right - glyphMaxWidth / 2 - 2;
    const railBaseY = chartArea.top + glyphHeight / 2 + glyphHalo + 3;
    const maxHeadY = chartArea.bottom - glyphHeight / 2 - glyphHalo - 1;
    const maxLanes = Math.max(
      4,
      Math.min(12, Math.floor((chartArea.bottom - railBaseY) / laneStep) + 1)
    );

    const visible = [];
    for (const flush of flushes) {
      const peakT = timeMs(flush?.peak_timestamp);
      if (peakT === null) continue;
      if (peakT < firstTime - 1000 || peakT > lastTime + 1000) continue;
      const peakPressure = asNumber(flush?.peak_pressure_inh2o);
      if (peakPressure === null) continue;
      let cxRaw;
      if (x.type === "linear" || x.options?.type === "linear") {
        cxRaw = x.getPixelForValue(peakT);
      } else {
        const fIdx = fractionalTimeIndex(times, peakT);
        if (fIdx < 0) continue;
        cxRaw = categoryPixelAt(x, fIdx, points.length);
      }
      if (!Number.isFinite(cxRaw)) continue;
      const peakX = Math.max(leftBound, Math.min(rightBound, cxRaw));
      const cyRaw = y.getPixelForValue(peakPressure);
      if (!Number.isFinite(cyRaw)) continue;
      const peakY = Math.max(chartArea.top + 2, Math.min(chartArea.bottom - 2, cyRaw));
      visible.push({
        flush,
        peakT,
        cxOrig: peakX,
        cx: peakX,
        peakX,
        peakY,
        glyphWidth: glyphMinWidth,
        headY: railBaseY,
        lane: 0,
      });
    }
    visible.sort((a, b) => a.peakT - b.peakT);

    // Lay out pin columns symmetrically around each cluster's centroid so
    // edge clusters slide inward instead of piling against the chart edge,
    // and so the spread never accumulates only in one direction.
    spreadPinsHorizontally(visible, minHSep, leftBound, rightBound);

    // Where the cluster is still denser than the chart can hold, stagger
    // beads onto alternate rail lanes. With horizontal sep < minHSep, the
    // lane assignment guarantees adjacent beads land on different lanes, so
    // the halos can't overlap into a single blob.
    assignPinLanes(visible, minHSep, maxLanes);

    for (const it of visible) {
      it.headY = Math.min(maxHeadY, railBaseY + it.lane * laneStep);
    }

    ctx.save();
    for (const it of visible) {
      // Light connector points from the rail bead toward the real pressure
      // peak without becoming another dark pressure spike.
      const connectorTop = it.headY + glyphHeight / 2 + glyphHalo + 1;
      const connectorEndY = Math.max(connectorTop + 4, it.peakY - 2);
      if (connectorEndY > connectorTop) {
        ctx.strokeStyle = connector;
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.moveTo(it.cx, connectorTop);
        if (Math.abs(it.cx - it.peakX) > 1) {
          const elbowY = Math.min(connectorEndY, connectorTop + 8);
          ctx.lineTo(it.cx, elbowY);
          ctx.lineTo(it.peakX, connectorEndY);
        } else {
          ctx.lineTo(it.peakX, connectorEndY);
        }
        ctx.stroke();
        ctx.setLineDash([]);
      }

      const gx = it.cx - it.glyphWidth / 2;
      const gy = it.headY - glyphHeight / 2;

      // Capsule: paper halo, rust fill, thin paper stroke for crispness.
      ctx.fillStyle = halo;
      fillRoundRect(ctx, gx - glyphHalo, gy - glyphHalo, it.glyphWidth + glyphHalo * 2, glyphHeight + glyphHalo * 2, (glyphHeight + glyphHalo * 2) / 2);

      ctx.fillStyle = accent;
      fillRoundRect(ctx, gx, gy, it.glyphWidth, glyphHeight, glyphHeight / 2);

      ctx.lineWidth = 1;
      ctx.strokeStyle = halo;
      strokeRoundRect(ctx, gx, gy, it.glyphWidth, glyphHeight, glyphHeight / 2);

      // Hit zone follows the capsule, not the pressure line. With multi-lane
      // stagger two capsules can share a column; the hit-test code breaks
      // ties on 2D distance to the glyph center, so the closest event wins.
      chart.$flushHits.push({
        x: it.cx,
        y: it.headY,
        bounds: {
          left: gx - hitPad,
          right: gx + it.glyphWidth + hitPad,
          top: gy - hitPad,
          bottom: gy + glyphHeight + hitPad,
        },
        flush: it.flush,
      });
    }
    ctx.restore();
  },
};

function roundedRectPath(ctx, x, y, w, h, r) {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function fillRoundRect(ctx, x, y, w, h, r) {
  roundedRectPath(ctx, x, y, w, h, r);
  ctx.fill();
}

function strokeRoundRect(ctx, x, y, w, h, r) {
  roundedRectPath(ctx, x, y, w, h, r);
  ctx.stroke();
}

function spreadPinsHorizontally(items, minSep, leftBound, rightBound) {
  if (!items.length) return;
  const available = Math.max(0, rightBound - leftBound);

  // Group pins whose original positions sit within minSep of the previous
  // pin. Each cluster is laid out symmetrically around its centroid so the
  // spread never just shoves pins off the right edge — that pile-up is what
  // made dense and edge clusters merge in the first place.
  const clusters = [];
  let cur = [items[0]];
  for (let i = 1; i < items.length; i += 1) {
    const it = items[i];
    if (it.cxOrig - cur[cur.length - 1].cxOrig < minSep) {
      cur.push(it);
    } else {
      clusters.push(cur);
      cur = [it];
    }
  }
  clusters.push(cur);

  for (const cluster of clusters) {
    const n = cluster.length;
    if (n === 1) {
      cluster[0].cx = Math.max(leftBound, Math.min(rightBound, cluster[0].cxOrig));
      continue;
    }
    const desired = (n - 1) * minSep;
    const centroid = cluster.reduce((s, it) => s + it.cxOrig, 0) / n;
    if (desired >= available) {
      // Cluster is denser than the chart can hold; spread evenly across the
      // full width and let lane assignment lift overlapping beads.
      const step = available / (n - 1);
      cluster.forEach((it, i) => { it.cx = leftBound + i * step; });
    } else {
      let left = centroid - desired / 2;
      left = Math.max(leftBound, Math.min(rightBound - desired, left));
      cluster.forEach((it, i) => { it.cx = left + i * minSep; });
    }
  }

  // If the full item set cannot physically fit minSep apart, do not run the
  // relaxation pass. It would chase an impossible constraint and push some
  // markers out of bounds; lane staggering is the fallback for this case.
  if ((items.length - 1) * minSep > available) {
    for (const it of items) it.cx = Math.max(leftBound, Math.min(rightBound, it.cx));
    return;
  }

  // Final relaxation: neighbouring clusters laid out near each other can
  // still violate minSep where their tails meet. Walk forward then backward,
  // clamping at bounds; converges within two iterations in practice.
  for (let iter = 0; iter < 2; iter += 1) {
    let dirty = false;
    for (let i = 1; i < items.length; i += 1) {
      const prev = items[i - 1];
      const it = items[i];
      const want = prev.cx + minSep;
      if (it.cx < want) { it.cx = want; dirty = true; }
    }
    if (items[items.length - 1].cx > rightBound) {
      items[items.length - 1].cx = rightBound;
      dirty = true;
    }
    for (let i = items.length - 2; i >= 0; i -= 1) {
      const next = items[i + 1];
      const it = items[i];
      const want = next.cx - minSep;
      if (it.cx > want) { it.cx = want; dirty = true; }
    }
    if (items[0].cx < leftBound) {
      items[0].cx = leftBound;
      dirty = true;
    }
    if (!dirty) break;
  }
}

function assignPinLanes(items, minSep, maxLanes) {
  for (let i = 0; i < items.length; i += 1) {
    const it = items[i];
    const recent = [];
    const used = new Set();
    for (let j = i - 1; j >= 0; j -= 1) {
      const other = items[j];
      if (it.cx - other.cx >= minSep) break;
      recent.push(other.lane);
      used.add(other.lane);
    }
    let lane = 0;
    while (used.has(lane) && lane < maxLanes - 1) lane += 1;
    if (used.has(lane)) {
      // If every lane is occupied inside minSep, complete separation is not
      // mathematically possible. Pick the lane whose nearest same-lane bead
      // is farthest away so the unavoidable overlap is distributed, not
      // stacked on the final lane.
      let bestLane = 0;
      let bestGap = -Infinity;
      for (let candidate = 0; candidate < maxLanes; candidate += 1) {
        const sameLaneGaps = [];
        for (let j = i - 1; j >= 0; j -= 1) {
          const other = items[j];
          if (it.cx - other.cx >= minSep) break;
          if (other.lane === candidate) sameLaneGaps.push(it.cx - other.cx);
        }
        const nearestGap = sameLaneGaps.length ? Math.min(...sameLaneGaps) : Infinity;
        if (nearestGap > bestGap) {
          bestGap = nearestGap;
          bestLane = candidate;
        }
      }
      lane = bestLane;
    }
    it.lane = lane;
  }
}

function ensureFlushHoverTip(canvas) {
  if (!canvas || !canvas.parentElement) return null;
  let tip = canvas.parentElement.querySelector(":scope > .flush-hover-tip");
  if (tip) return tip;
  tip = document.createElement("div");
  tip.className = "flush-hover-tip";
  tip.setAttribute("role", "tooltip");
  tip.setAttribute("aria-hidden", "true");
  tip.style.display = "none";
  canvas.parentElement.appendChild(tip);
  return tip;
}

function attachFlushHover(canvas) {
  if (!canvas || canvas.dataset.flushHoverBound === "true") return;
  canvas.dataset.flushHoverBound = "true";

  const findHit = (clientX, clientY) => {
    const chart = window.Chart && Chart.getChart ? Chart.getChart(canvas) : null;
    if (!chart) return null;
    const hits = chart.$flushHits || [];
    if (!hits.length) return null;
    const rect = canvas.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    // Each pin owns a tall, narrow column. Use rectangular bounds so the
    // hit zone follows the visible shape, then break ties by distance to
    // the bead head. That keeps vertically staggered clusters addressable
    // even when two pins share nearly the same x coordinate.
    let nearest = null;
    let nearestDistSq = Infinity;
    for (const hit of hits) {
      const b = hit.bounds;
      if (!b) continue;
      if (px < b.left || px > b.right) continue;
      if (py < b.top || py > b.bottom) continue;
      const dx = Math.abs(px - hit.x);
      const dy = Math.abs(py - hit.y);
      const distSq = dx * dx + dy * dy;
      if (distSq < nearestDistSq) {
        nearest = hit;
        nearestDistSq = distSq;
      }
    }
    return nearest;
  };

  const getChart = () =>
    (window.Chart && Chart.getChart) ? Chart.getChart(canvas) : null;

  const setPulseHover = (state) => {
    const chart = getChart();
    if (!chart) return;
    const next = !!state;
    if (chart.$pulseHover === next) return;
    chart.$pulseHover = next;
    // Force the line tooltip to re-evaluate immediately so it can't linger
    // over the pulse popup for a frame after the cursor lands on a marker.
    if (next && chart.tooltip && typeof chart.tooltip.setActiveElements === "function") {
      try { chart.tooltip.setActiveElements([], { x: 0, y: 0 }); } catch (_) {}
    }
  };

  const showHit = (clientX, clientY) => {
    const tip = ensureFlushHoverTip(canvas);
    if (!tip) return;
    const hit = findHit(clientX, clientY);
    if (!hit) {
      tip.style.display = "none";
      tip.setAttribute("aria-hidden", "true");
      setPulseHover(false);
      return;
    }
    setPulseHover(true);
    const peakTime = formatTimestamp(hit.flush.peak_timestamp, fmtTime);
    const peakPress = formatPressureCompact(hit.flush.peak_pressure_inh2o);
    const dur = asNumber(hit.flush.duration_seconds);
    const rec = asNumber(hit.flush.recovery_seconds);
    const lines = [];
    lines.push(dur === null ? "Pulse width — s" : `Pulse width ${dur.toFixed(1)} s`);
    const head = peakPress === "—" ? peakTime : `${peakTime} · peak ${peakPress} inH₂O`;
    lines.push(head);
    if (rec !== null) lines.push(`Recovery ${rec.toFixed(1)} s · settles to baseline`);
    tip.textContent = lines.join("\n");
    tip.style.display = "";
    tip.setAttribute("aria-hidden", "false");
    const parent = canvas.parentElement;
    if (!parent) return;
    const tipW = tip.offsetWidth;
    const tipH = tip.offsetHeight;
    const cx = canvas.offsetLeft + hit.x;
    const cy = canvas.offsetTop + hit.y;
    let left = cx - tipW / 2;
    const maxLeft = parent.clientWidth - tipW - 4;
    if (Number.isFinite(maxLeft) && maxLeft > 4) {
      left = Math.max(4, Math.min(maxLeft, left));
    } else {
      left = Math.max(4, left);
    }
    let top = cy - tipH - 8;
    if (top < 4) top = cy + 14;
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  };

  const hide = () => {
    setPulseHover(false);
    const tip = ensureFlushHoverTip(canvas);
    if (!tip) return;
    tip.style.display = "none";
    tip.setAttribute("aria-hidden", "true");
  };

  // Capture phase so our hover state is updated before Chart.js's own
  // (bubble-phase) handlers run their tooltip resolution. This lets the
  // tooltip filter see $pulseHover === true on the same event tick.
  canvas.addEventListener("mousemove", (event) => showHit(event.clientX, event.clientY), true);
  canvas.addEventListener("mouseleave", hide, true);
  canvas.addEventListener("touchstart", (event) => {
    const t = event.touches?.[0];
    if (t) showHit(t.clientX, t.clientY);
  }, { passive: true, capture: true });
  canvas.addEventListener("touchend", () => {
    setTimeout(hide, 1800);
  }, true);
}

if (window.Chart) Chart.register(sewerBandsPlugin, flushPulseMarkers);

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
  const markerData = config.flushPulseMarkersData || null;
  if (markerData) delete config.flushPulseMarkersData;
  charts[id] = new Chart(canvas, config);
  if (markerData && charts[id]) {
    charts[id].$flushes = Array.isArray(markerData.flushes) ? markerData.flushes : [];
    charts[id].$sourcePoints = Array.isArray(markerData.points) ? markerData.points : [];
    charts[id].update("none");
  }
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
    // Suppress the line tooltip when the cursor is over a pulse marker so the
    // bespoke pulse popup is the single source of truth for that interaction.
    filter(item) {
      return !(item && item.chart && item.chart.$pulseHover);
    },
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
      footer(items) {
        if (!items?.length) return "";
        const item = items[0];
        const flushes = item.chart?.$flushes;
        if (!Array.isArray(flushes) || !flushes.length) return "";
        const labels = item.chart?.$sourcePoints || [];
        const source = labels[item.dataIndex];
        const flush = flushAtTime(flushes, source?.timestamp);
        if (!flush) return "";
        const win = flushWindow(flush);
        const bits = [`Pulse width ${formatSeconds(flush.duration_seconds)}`];
        if (win) {
          bits.push(`Start  ${fmtTime.format(new Date(win.start))}`);
          bits.push(`Finish ${fmtTime.format(new Date(win.end))}`);
        }
        return bits;
      },
    },
  };
}

function buildPressureChart(labels, datasets, yTitle, min, max, maxTicks, bands, pulseMarkers = null) {
  const cfg = {
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
        flushPulseMarkers: pulseMarkers ? { enabled: true } : false,
      },
      scales: baseScales(yTitle, min, max, maxTicks, (v) => {
        const n = asNumber(v);
        if (n === null) return v;
        return n >= 1 ? n.toFixed(2) : n.toFixed(3);
      }),
    },
  };
  if (pulseMarkers) cfg.flushPulseMarkersData = pulseMarkers;
  return cfg;
}

function renderPressureWindowChart(id, points, limits, maxTicks, mode = "pulse", scaleId = null, flushes = []) {
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
    buildPressureChart(
      labels,
      datasets,
      "Pressure (inH₂O)",
      domain.min,
      visible,
      maxTicks,
      buildPressureBands(limits, visible),
      { flushes, points }
    )
  );
  if (charts[id]) {
    charts[id].$flushes = flushes;
    charts[id].$sourcePoints = points;
  }
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
          label: "Pulse width (s)",
          data: flushes.map((f) => asNumber(f.duration_seconds)),
          backgroundColor: PALETTE.barFill,
          borderColor: PALETTE.bar,
          borderWidth: 1,
          borderRadius: 1,
        },
        {
          type: "line",
          label: "Recovery (s)",
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
  const flushes = pickFlushLogEvents(payload);
  const typicalPeak = asNumber(payload?.flush_analysis?.typical_peak_pressure_inh2o);
  setText(
    "flushLogHeading",
    flushes.length >= FLUSH_LOG_LIMIT
      ? `Latest ${FLUSH_LOG_LIMIT} flush events`
      : flushes.length
        ? `Latest ${flushes.length} flush event${flushes.length === 1 ? "" : "s"}`
        : "Latest flush events"
  );
  if (!flushes.length) {
    tbody.innerHTML =
      `<tr><td colspan="5" class="empty">No flush events yet — flush a fixture to seed a baseline pulse.</td></tr>`;
    return;
  }
  const limits = payload?.limits?.pressure_inh2o || {};
  const watchHigh = asNumber(limits.watch_high);
  const elevatedHigh = asNumber(limits.elevated_high);
  const alarmHigh = asNumber(limits.alert_high);
  const rows = flushes.map((f) => {
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
        <td class="num">${asNumber(f.duration_seconds) === null ? "—" : `${asNumber(f.duration_seconds).toFixed(1)}<span class="unit">s</span>`}</td>
        <td class="num">${asNumber(f.recovery_seconds) === null ? "—" : `${asNumber(f.recovery_seconds).toFixed(1)}<span class="unit">s</span>`}</td>
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
      ["Width Δ", formatPercent(trend.duration_delta_percent)],
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

const DAY_MS = 24 * 60 * 60 * 1000;
// Keep canvas backing stores below common browser dimension limits while
// preserving at least 1 device pixel per CSS pixel. Dropping below 1x makes
// axis text and tick labels visibly soft.
const MAX_HISTORY_CANVAS_BACKING_PX = 30000;

const HISTORY_RANGES = [
  { id: "5m",  label: "5 min",    source: "pressure_15m_tail_5m", kind: "line", scale: "pulse",    pxPerPoint: 26, fit: false, density: "Raw samples",      windowable: true,  stepLabel: "5 min" },
  { id: "1h",  label: "1 hour",   source: "pressure_1h",          kind: "line", scale: "pulse",    pxPerPoint: 11, fit: false, density: "Raw samples",      windowable: true,  stepLabel: "1 hour" },
  { id: "24h", label: "24 hours", source: "pressure_24h",         kind: "line", scale: "overview", pxPerPoint: 0.25, fit: false, density: "Raw samples",      windowable: true,  stepLabel: "24 h" },
  { id: "7d",  label: "7 days",   source: "daily_peaks_7d",       kind: "bar",  scale: "daily",    pxPerPoint: 92, fit: true,  density: "Daily peak + mean",windowable: true,  stepLabel: "7 d" },
  { id: "30d", label: "30 days",  source: "daily_peaks_30d",      kind: "bar",  scale: "daily",    pxPerPoint: 38, fit: true,  density: "Daily peak + mean",windowable: false, stepLabel: "30 d" },
];

const FIVE_MIN_MS = 5 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

let activeRangeId = null;
let windowOffset = 0;
let lastRenderedRangeId = null;
let lastRenderedWindowOffset = null;

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

function maxOffsetFor(payload, range) {
  if (!range || !range.windowable) return 0;
  const history = payload?.history || {};
  if (range.id === "5m") {
    // Prefer raw 24h coverage so short pulse widths stay seconds-accurate.
    const deepest = (history.pressure_24h && history.pressure_24h.length)
      ? history.pressure_24h
      : ((history.pressure_6h && history.pressure_6h.length) ? history.pressure_6h : (history.pressure_1h || []));
    if (!deepest.length) return 0;
    const first = new Date(deepest[0].timestamp).getTime();
    const anchor = windowAnchorMs(payload, range);
    if (!Number.isFinite(first) || !Number.isFinite(anchor)) return 0;
    return Math.max(0, Math.floor((anchor - first) / FIVE_MIN_MS) - 1);
  }
  if (range.id === "1h") {
    // Keep hourly navigation on the finest available source; sparse 7-day
    // buckets make second-long pulses look minute-wide.
    const deepest = (history.pressure_24h && history.pressure_24h.length)
      ? history.pressure_24h
      : ((history.pressure_6h && history.pressure_6h.length) ? history.pressure_6h : (history.pressure_1h || history.pressure_history_7d || []));
    if (!deepest.length) return 0;
    const first = new Date(deepest[0].timestamp).getTime();
    const anchor = windowAnchorMs(payload, range);
    if (!Number.isFinite(first) || !Number.isFinite(anchor)) return 0;
    return Math.max(0, Math.floor((anchor - first) / HOUR_MS) - 1);
  }
  if (range.id === "24h") {
    const all = history.pressure_history_7d || [];
    if (all.length < 2) return 0;
    const first = new Date(all[0].timestamp).getTime();
    const last = new Date(all[all.length - 1].timestamp).getTime();
    if (!Number.isFinite(first) || !Number.isFinite(last)) return 0;
    return Math.max(0, Math.floor((last - first) / DAY_MS));
  }
  if (range.id === "7d") {
    const all = history.daily_peaks_30d || [];
    if (all.length < 8) return 0;
    return Math.max(0, Math.floor(all.length / 7) - 1);
  }
  return 0;
}

function windowAnchorMs(payload, range) {
  const history = payload?.history || {};
  if (range.id === "5m") {
    const all = history.pressure_15m || [];
    if (all.length) {
      const t = new Date(all[all.length - 1].timestamp).getTime();
      if (Number.isFinite(t)) return t;
    }
  }
  if (range.id === "1h") {
    const all = history.pressure_1h || [];
    if (all.length) {
      const t = new Date(all[all.length - 1].timestamp).getTime();
      if (Number.isFinite(t)) return t;
    }
  }
  if (range.id === "24h") {
    const all = history.pressure_history_7d || history.pressure_24h || [];
    if (all.length) {
      const t = new Date(all[all.length - 1].timestamp).getTime();
      if (Number.isFinite(t)) return t;
    }
  }
  const latest = payload?.latest?.timestamp;
  if (latest) {
    const t = new Date(latest).getTime();
    if (Number.isFinite(t)) return t;
  }
  return Date.now();
}

function windowBoundsMs(payload, range, offset) {
  if (range.id === "5m") {
    const anchor = windowAnchorMs(payload, range);
    const end = anchor - offset * FIVE_MIN_MS;
    return { start: end - FIVE_MIN_MS, end };
  }
  if (range.id === "1h") {
    const anchor = windowAnchorMs(payload, range);
    const end = anchor - offset * HOUR_MS;
    return { start: end - HOUR_MS, end };
  }
  if (range.id === "24h") {
    const anchor = windowAnchorMs(payload, range);
    const end = anchor - offset * DAY_MS;
    return { start: end - DAY_MS, end };
  }
  return null;
}

function pickFromTimeSources(sources, bounds) {
  // Sources should be passed highest-resolution first. Pick the highest-res
  // source whose first sample reaches back to the window start; if none reach
  // that far, fall back to the deepest non-empty source so the chart at least
  // shows whatever is available.
  const SLACK_MS = 60_000;
  let fallback = null;
  for (const src of sources) {
    if (!Array.isArray(src) || !src.length) continue;
    const first = new Date(src[0].timestamp).getTime();
    if (Number.isFinite(first) && first <= bounds.start + SLACK_MS) {
      const picked = src.filter((p) => {
        const t = new Date(p.timestamp).getTime();
        return Number.isFinite(t) && t > bounds.start && t <= bounds.end;
      });
      if (picked.length) return picked;
    }
    fallback = src;
  }
  if (!fallback) return [];
  return fallback.filter((p) => {
    const t = new Date(p.timestamp).getTime();
    return Number.isFinite(t) && t > bounds.start && t <= bounds.end;
  });
}

function pickHistoryPoints(payload, range, offset = 0) {
  const history = payload?.history || {};
  if (range.id === "5m") {
    const bounds = windowBoundsMs(payload, range, offset);
    if (!bounds) return [];
    return pickFromTimeSources(
      [history.pressure_24h, history.pressure_15m, history.pressure_1h, history.pressure_6h, history.pressure_history_7d],
      bounds,
    );
  }
  if (range.id === "1h") {
    const bounds = windowBoundsMs(payload, range, offset);
    if (!bounds) return [];
    return pickFromTimeSources(
      [history.pressure_24h, history.pressure_1h, history.pressure_6h, history.pressure_history_7d],
      bounds,
    );
  }
  if (range.id === "30d") return history.daily_peaks_30d || [];

  if (range.id === "24h") {
    if (offset === 0) {
      const fine = history.pressure_24h;
      if (Array.isArray(fine) && fine.length) return fine;
    }
    const all = history.pressure_history_7d || [];
    if (!all.length) return offset === 0 ? (history.pressure_24h || []) : [];
    const bounds = windowBoundsMs(payload, range, offset);
    if (!bounds) return [];
    return all.filter((p) => {
      const t = new Date(p.timestamp).getTime();
      return Number.isFinite(t) && t > bounds.start && t <= bounds.end;
    });
  }

  if (range.id === "7d") {
    const all = history.daily_peaks_30d || [];
    if (offset === 0 && Array.isArray(history.daily_peaks_7d) && history.daily_peaks_7d.length) {
      return history.daily_peaks_7d;
    }
    if (!all.length) return [];
    const totalLen = all.length;
    const endIdx = totalLen - offset * 7;
    const startIdx = endIdx - 7;
    if (endIdx <= 0) return [];
    return all.slice(Math.max(0, startIdx), endIdx);
  }
  return history[range.source] || [];
}

function pickFlushesInWindow(payload, startMs, endMs) {
  const fa = payload?.flush_analysis || {};
  const sources = [
    Array.isArray(fa.events_24h) ? fa.events_24h : [],
    Array.isArray(fa.events_history_7d) ? fa.events_history_7d : [],
  ];
  const seen = new Set();
  const result = [];
  for (const src of sources) {
    for (const ev of src) {
      const peakT = new Date(ev.peak_timestamp).getTime();
      if (!Number.isFinite(peakT)) continue;
      if (peakT < startMs || peakT > endMs) continue;
      const key = `${ev.peak_timestamp}|${ev.peak_pressure_inh2o}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(ev);
    }
  }
  return result;
}

function updateWindowControls(payload, range) {
  const earlier = byId("windowEarlier");
  const later = byId("windowLater");
  const now = byId("windowNow");
  const nowLabel = byId("windowNowLabel");
  const windowPill = byId("historyWindow");
  if (!earlier || !later || !now) return;
  const max = maxOffsetFor(payload, range);
  const canShift = range.windowable && max > 0;
  const earlierDisabled = !canShift || windowOffset >= max;
  const laterDisabled = !canShift || windowOffset <= 0;
  const nowDisabled = !canShift || windowOffset === 0;

  earlier.setAttribute("aria-disabled", String(earlierDisabled));
  earlier.disabled = earlierDisabled;
  later.setAttribute("aria-disabled", String(laterDisabled));
  later.disabled = laterDisabled;
  now.setAttribute("aria-disabled", String(nowDisabled));
  now.disabled = nowDisabled;
  now.dataset.state = windowOffset === 0 ? "latest" : "shifted";

  const stepText = range.stepLabel || range.label || "step";
  const earlierText = earlier.querySelector(".window-step-text");
  const laterText = later.querySelector(".window-step-text");
  const earlierSuffix = earlier.querySelector(".window-step-suffix");
  const laterSuffix = later.querySelector(".window-step-suffix");
  if (earlierText) earlierText.textContent = "Earlier";
  if (laterText) laterText.textContent = "Later";
  if (earlierSuffix) earlierSuffix.textContent = stepText;
  if (laterSuffix) laterSuffix.textContent = stepText;

  let nowText;
  if (!range.windowable) {
    nowText = "Live only";
  } else if (windowOffset === 0) {
    nowText = "Latest";
  } else {
    nowText = "Jump to latest";
  }
  if (nowLabel) nowLabel.textContent = nowText;

  // Tooltip explanations for non-windowable ranges.
  if (!range.windowable) {
    const reason = range.id === "30d"
      ? "30-day view already covers the full history."
      : "Older raw samples are not retained at this resolution.";
    earlier.title = reason;
    later.title = reason;
    now.title = reason;
  } else {
    earlier.title = earlierDisabled
      ? "No earlier data available."
      : `Show the previous ${stepText} window`;
    later.title = laterDisabled
      ? "Already at the latest window."
      : `Show the next ${stepText} window`;
    now.title = nowDisabled ? "Already at the latest window." : "Jump back to the latest window";
  }

  if (windowPill) {
    if (range.windowable && windowOffset > 0) {
      windowPill.hidden = false;
      windowPill.dataset.state = "shifted";
      const points = pickHistoryPoints(payload, range, windowOffset);
      windowPill.textContent = describeWindow(range, points, windowOffset);
    } else {
      windowPill.hidden = true;
      windowPill.removeAttribute("data-state");
    }
  }
}

function describeWindow(range, points, offset) {
  if (!points || !points.length) {
    return offset === 0 ? "Latest window · no data" : "Earlier window · no data";
  }
  if (range.kind === "bar") {
    const first = points[0]?.day;
    const last = points[points.length - 1]?.day;
    const prefix = offset === 0 ? "Latest" : `−${offset * 7} d`;
    if (!first || !last) return prefix;
    if (first === last) return `${prefix} · ${formatDateLabel(first)}`;
    return `${prefix} · ${formatDateLabel(first)} → ${formatDateLabel(last)}`;
  }
  let prefix;
  if (offset === 0) {
    prefix = "Latest";
  } else if (range.id === "5m") {
    prefix = `−${offset * 5} min`;
  } else if (range.id === "1h") {
    prefix = `−${offset} h`;
  } else {
    prefix = `−${offset} d`;
  }
  const startT = new Date(points[0]?.timestamp).getTime();
  const endT = new Date(points[points.length - 1]?.timestamp).getTime();
  if (!Number.isFinite(startT) || !Number.isFinite(endT)) return prefix;
  return `${prefix} · ${formatTimestamp(points[0].timestamp, fmtDateTime)} → ${formatTimestamp(points[points.length - 1].timestamp, fmtDateTime)}`;
}

function setWindowOffset(nextOffset) {
  const range = HISTORY_RANGES.find((r) => r.id === activeRangeId);
  if (!range) return;
  const max = lastPayload ? maxOffsetFor(lastPayload, range) : 0;
  const clamped = Math.max(0, Math.min(max, Math.floor(nextOffset)));
  if (clamped === windowOffset) return;
  windowOffset = clamped;
  if (lastPayload) renderHistoryViewer(lastPayload);
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
  // Clamp offset against current data — older payloads or range switches may
  // have left it pointing past the end.
  const max = maxOffsetFor(payload, range);
  if (windowOffset > max) windowOffset = max;
  if (!range.windowable) windowOffset = 0;

  const points = pickHistoryPoints(payload, range, windowOffset);
  const limits = payload?.limits || {};
  let flushes;
  if (range.windowable && windowOffset > 0 && range.kind === "line") {
    const bounds = windowBoundsMs(payload, range, windowOffset);
    flushes = bounds ? pickFlushesInWindow(payload, bounds.start, bounds.end) : [];
  } else if (range.kind === "line" && points.length) {
    const startT = new Date(points[0].timestamp).getTime();
    const endT = new Date(points[points.length - 1].timestamp).getTime();
    if (Number.isFinite(startT) && Number.isFinite(endT)) {
      flushes = pickFlushesInWindow(payload, startT, endT);
    } else {
      flushes = pickAllFlushes(payload);
    }
  } else {
    flushes = pickAllFlushes(payload);
  }

  updateWindowControls(payload, range);

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
    const deviceDpr = Math.max(1, window.devicePixelRatio || 1);
    const maxCssWidth = Math.max(
      minTrack,
      Math.floor(MAX_HISTORY_CANVAS_BACKING_PX / deviceDpr)
    );
    const naturalWidth = points.length * range.pxPerPoint + padding;
    desired = Math.max(minTrack, Math.min(maxCssWidth, naturalWidth));
  }
  track.style.width = `${desired}px`;

  const prevScroll = scroll.scrollLeft;
  const wasAtEnd = prevScroll + scroll.clientWidth >= scroll.scrollWidth - 4;
  const windowChanged =
    lastRenderedRangeId !== range.id ||
    lastRenderedWindowOffset !== windowOffset;

  destroyChart("historyChart");

  if (!points.length) {
    renderHistoryWrapChart(points, limits, range);
    requestAnimationFrame(() => {
      track.style.width = "100%";
    });
    return;
  }

  if (range.kind === "line") {
    renderHistoryLineChart(points, limits, range, flushes);
  } else {
    renderHistoryBarChart(points, range);
  }
  renderHistoryWrapChart(points, limits, range);

  requestAnimationFrame(() => {
    if (range.fit) {
      scroll.scrollLeft = 0;
    } else if (wasAtEnd || (windowOffset === 0 && windowChanged)) {
      scroll.scrollLeft = scroll.scrollWidth;
    } else {
      scroll.scrollLeft = prevScroll;
    }
    lastRenderedRangeId = range.id;
    lastRenderedWindowOffset = windowOffset;
  });
}

function wrappedHistoryLaneMs(range, spanMs) {
  if (range.id === "5m") return FIVE_MIN_MS;
  if (range.id === "1h") return HOUR_MS;
  if (range.id === "24h") return 2 * HOUR_MS;
  return Math.max(spanMs, 1);
}

function wrappedHistoryTickMs(laneMs) {
  if (laneMs <= FIVE_MIN_MS) return 60 * 1000;
  if (laneMs <= HOUR_MS) return 10 * 60 * 1000;
  return 30 * 60 * 1000;
}

function renderHistoryWrapChart(points, limits, range) {
  const frame = byId("historyWrapFrame");
  const canvas = byId("historyWrapChart");
  if (!frame || !canvas) return;

  if (range.kind !== "line" || !Array.isArray(points) || !points.length) {
    frame.hidden = true;
    const ctx = canvas.getContext("2d");
    if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }

  const samples = points
    .map((point) => ({
      t: timeMs(point?.timestamp),
      p: asNumber(point?.pressure_inh2o),
    }))
    .filter((point) => Number.isFinite(point.t) && point.p !== null)
    .sort((a, b) => a.t - b.t);

  if (!samples.length) {
    frame.hidden = true;
    return;
  }

  frame.hidden = false;

  const firstT = samples[0].t;
  const lastT = samples[samples.length - 1].t;
  const spanMs = Math.max(1, lastT - firstT);
  const laneMs = wrappedHistoryLaneMs(range, spanMs);
  const laneStart0 = range.id === "24h"
    ? Math.floor(firstT / laneMs) * laneMs
    : firstT;
  const laneCount = Math.max(1, Math.floor((lastT - laneStart0) / laneMs) + 1);

  const cssWidth = Math.max(
    260,
    Math.floor(canvas.clientWidth || frame.clientWidth || frame.getBoundingClientRect().width || 600)
  );
  const left = cssWidth < 520 ? 74 : 94;
  const right = 8;
  const topPad = 8;
  const bottomPad = 10;
  const laneGap = 6;
  const laneH = range.id === "24h"
    ? (cssWidth < 520 ? 58 : 64)
    : Math.max(120, Math.min(180, Math.floor(cssWidth * 0.24)));
  const height = topPad + laneCount * laneH + Math.max(0, laneCount - 1) * laneGap + bottomPad;
  const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));

  canvas.style.height = `${height}px`;
  canvas.width = Math.floor(cssWidth * dpr);
  canvas.height = Math.floor(height * dpr);

  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, height);

  const domain = computePressureDomain(points, limits, range.scale);
  const minYValue = domain.min;
  const maxYValue = domain.max;
  const valueSpan = Math.max(0.001, maxYValue - minYValue);
  const plotW = Math.max(80, cssWidth - left - right);
  const plotTopPad = range.id === "24h" ? 15 : 20;
  const plotBottomPad = 11;
  const tickMs = wrappedHistoryTickMs(laneMs);
  const lanes = Array.from({ length: laneCount }, () => []);

  for (const sample of samples) {
    const idx = Math.floor((sample.t - laneStart0) / laneMs);
    if (idx >= 0 && idx < laneCount) lanes[idx].push(sample);
  }

  const monoFont = cssVar("--mono", "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace");
  const axisFont = `700 12px ${monoFont}`;
  const timeFont = `600 11px ${monoFont}`;
  const pressureLabel = (value) => {
    const n = asNumber(value);
    if (n === null) return "";
    return n >= 1 ? n.toFixed(1) : n.toFixed(2);
  };
  const crisp = (value) => Math.round(value) + 0.5;
  ctx.textBaseline = "middle";

  for (let lane = 0; lane < laneCount; lane += 1) {
    const laneTop = topPad + lane * (laneH + laneGap);
    const laneBottom = laneTop + laneH;
    const plotTop = laneTop + plotTopPad;
    const plotBottom = laneBottom - plotBottomPad;
    const plotH = Math.max(12, plotBottom - plotTop);
    const laneStart = laneStart0 + lane * laneMs;
    const laneEnd = laneStart + laneMs;
    const laneSamples = lanes[lane];

    const xFor = (t) => left + ((t - laneStart) / laneMs) * plotW;
    const yFor = (value) => {
      const p = Math.max(minYValue, Math.min(maxYValue, value));
      return plotBottom - ((p - minYValue) / valueSpan) * plotH;
    };

    const xLeft = crisp(left);
    const xRight = crisp(left + plotW);
    const yTop = crisp(plotTop);
    const yBottom = crisp(plotBottom);

    ctx.strokeStyle = PALETTE.hairSoft;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(xLeft, yTop);
    ctx.lineTo(xLeft, yBottom);
    ctx.moveTo(xLeft, yTop);
    ctx.lineTo(xRight, yTop);
    ctx.moveTo(xLeft, yBottom);
    ctx.lineTo(xRight, yBottom);
    ctx.stroke();

    const firstTick = Math.ceil(laneStart / tickMs) * tickMs;
    ctx.beginPath();
    for (let t = firstTick; t < laneEnd; t += tickMs) {
      const x = crisp(xFor(t));
      ctx.moveTo(x, yTop);
      ctx.lineTo(x, yBottom);
    }
    ctx.stroke();

    ctx.fillStyle = PALETTE.ink;
    ctx.font = axisFont;
    ctx.textAlign = "right";
    ctx.fillText(pressureLabel(maxYValue), Math.round(left - 10), Math.round(plotTop + 7));
    ctx.fillText("0", Math.round(left - 10), Math.round(plotBottom - 6));
    ctx.font = timeFont;
    ctx.fillStyle = PALETTE.inkSoft;
    ctx.textAlign = "left";
    ctx.fillText(fmtTime.format(new Date(laneStart)), Math.round(left + 8), Math.round(laneTop + 9));

    if (!laneSamples.length) continue;

    const columns = new Map();
    for (const sample of laneSamples) {
      const col = Math.round(xFor(sample.t));
      const existing = columns.get(col);
      if (existing) {
        existing.min = Math.min(existing.min, sample.p);
        existing.max = Math.max(existing.max, sample.p);
      } else {
        columns.set(col, { min: sample.p, max: sample.p });
      }
    }

    ctx.save();
    ctx.strokeStyle = PALETTE.pressure;
    ctx.lineWidth = 1;
    ctx.beginPath();
    let started = false;
    let prevT = null;
    const gapLimit = range.id === "24h"
      ? 20 * 60 * 1000
      : (range.id === "1h" ? 3 * 60 * 1000 : 20 * 1000);
    for (const sample of laneSamples) {
      const x = xFor(sample.t);
      const y = yFor(sample.p);
      if (!started || (prevT !== null && sample.t - prevT > gapLimit)) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
      prevT = sample.t;
    }
    ctx.stroke();

    ctx.globalAlpha = 0.72;
    ctx.beginPath();
    for (const [col, ext] of columns) {
      if (Math.abs(ext.max - ext.min) < 0.002) continue;
      const x = col + 0.5;
      ctx.moveTo(x, yFor(ext.min));
      ctx.lineTo(x, yFor(ext.max));
    }
    ctx.stroke();
    ctx.restore();
  }
}

function renderHistoryLineChart(points, limits, range, flushes = []) {
  const labels = points.map((p) => formatTimestamp(p.timestamp, fmtTime));
  const domain = computePressureDomain(points, limits, range.scale);
  const visible = domain.max;
  const dense = points.length > 240;
  const pressureData = points.map((p) => asNumber(p.pressure_inh2o));
  const datasets = [
    {
      label: "Pressure",
      data: pressureData,
      borderColor: PALETTE.pressure,
      backgroundColor: PALETTE.pressureFill,
      borderWidth: 1.6,
      // Raw-sample density: bezier smoothing visually merges close pulses
      // because the spline pulls adjacent peaks horizontally; force linear
      // segments so each sample is reachable on the rendered line.
      tension: 0,
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
    null,
  );
  cfg.options.animation = false;
  const trackWidth = byId("historyTrack")?.clientWidth || 0;
  if (trackWidth > 0) {
    const deviceDpr = Math.max(1, window.devicePixelRatio || 1);
    const maxDprForWidth = Math.max(1, MAX_HISTORY_CANVAS_BACKING_PX / trackWidth);
    const renderDpr = Math.min(deviceDpr, maxDprForWidth);
    if (renderDpr < deviceDpr) {
      cfg.options.devicePixelRatio = renderDpr;
    }
  }
  createChart("historyChart", cfg);
  if (charts.historyChart) {
    charts.historyChart.$sourcePoints = points;
    charts.historyChart.$flushes = flushes;
  }
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
  const changed = activeRangeId !== range.id;
  activeRangeId = range.id;
  // Range size is the user's choice of zoom; switching it should always
  // reset the time window to "latest" so they don't end up looking at an
  // older slice unintentionally.
  if (changed) windowOffset = 0;
  selectRangeButton(activeRangeId);
  if (changed && opts.persist !== false) writeSavedRange(activeRangeId);
  if (lastPayload) renderHistoryViewer(lastPayload);
  if (opts.focusButton) focusRangeButton(activeRangeId);
}

function bindHistoryControls() {
  const buttons = rangeButtons();
  if (!buttons.length) return;

  if (!activeRangeId) {
    activeRangeId = readSavedRange() || HISTORY_RANGES[2].id;
  }
  selectRangeButton(activeRangeId);

  const earlierBtn = byId("windowEarlier");
  const laterBtn = byId("windowLater");
  const nowBtn = byId("windowNow");
  if (earlierBtn) {
    earlierBtn.addEventListener("click", (e) => {
      e.preventDefault();
      if (earlierBtn.disabled) return;
      setWindowOffset(windowOffset + 1);
    });
  }
  if (laterBtn) {
    laterBtn.addEventListener("click", (e) => {
      e.preventDefault();
      if (laterBtn.disabled) return;
      setWindowOffset(windowOffset - 1);
    });
  }
  if (nowBtn) {
    nowBtn.addEventListener("click", (e) => {
      e.preventDefault();
      if (nowBtn.disabled) return;
      setWindowOffset(0);
    });
  }

  buttons.forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      if (btn.dataset.range) setActiveRange(btn.dataset.range, { focusButton: true });
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

function bindResizeRefresh() {
  let timer = null;
  window.addEventListener("resize", () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      if (lastPayload) renderHistoryViewer(lastPayload);
    }, 120);
  });
}

/* ─── Render & loop ─────────────────────────────────────────── */

function renderAll(payload, sync, backup) {
  if (!PALETTE) PALETTE = getPalette();
  const flushes = pickAllFlushes(payload);

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
  bindResizeRefresh();
  tick();
  setInterval(tick, POLL_MS);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootstrap);
} else {
  bootstrap();
}
