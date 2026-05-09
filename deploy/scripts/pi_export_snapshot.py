#!/usr/bin/env python3
"""Export sewer air-pressure history, flush events, and clog-signal analysis as JSON."""

from __future__ import annotations

import json
import math
import sqlite3
import statistics
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


BASE_DIR = Path("/root/sewer-monitor")
CONFIG_PATH = BASE_DIR / "config.json"
DB_PATH = BASE_DIR / "data.db"
ALERT_LOG_PATH = BASE_DIR / "alerts.log"
FAULT_LOG_PATH = BASE_DIR / "faults.log"


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso_utc(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    text = value.strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def load_config() -> dict[str, Any]:
    if not CONFIG_PATH.exists():
        return {}
    return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))


def read_log_tail(path: Path, limit: int = 10) -> list[str]:
    if not path.exists():
        return []
    lines = [line.strip() for line in path.read_text(encoding="utf-8", errors="replace").splitlines()]
    return [line for line in lines if line][-limit:]


def positive_pressure(value: Any) -> float:
    try:
        return max(0.0, float(value))
    except Exception:
        return 0.0


def row_pressure(row: dict[str, Any]) -> float:
    return positive_pressure(row.get("pressure_inh2o"))


def fetch_rows(conn: sqlite3.Connection, since: datetime) -> list[dict[str, Any]]:
    cursor = conn.execute(
        """
        SELECT timestamp, current_ma, pressure_inh2o, depth_in, depth_cm, status
        FROM readings
        WHERE timestamp >= ?
        ORDER BY timestamp ASC
        """,
        (iso_utc(since),),
    )
    rows: list[dict[str, Any]] = []
    for timestamp, current_ma, pressure_inh2o, depth_in, depth_cm, status in cursor.fetchall():
        rows.append(
            {
                "timestamp": timestamp,
                "current_ma": current_ma,
                "pressure_inh2o": pressure_inh2o,
                "pressure_positive_inh2o": positive_pressure(pressure_inh2o),
                "depth_in": depth_in,
                "depth_cm": depth_cm,
                "status": status,
            }
        )
    return rows


def fetch_latest(conn: sqlite3.Connection) -> dict[str, Any] | None:
    row = conn.execute(
        """
        SELECT timestamp, current_ma, pressure_inh2o, depth_in, depth_cm, status
        FROM readings
        ORDER BY timestamp DESC
        LIMIT 1
        """
    ).fetchone()
    if row is None:
        return None
    return {
        "timestamp": row[0],
        "current_ma": row[1],
        "pressure_inh2o": row[2],
        "pressure_positive_inh2o": positive_pressure(row[2]),
        "depth_in": row[3],
        "depth_cm": row[4],
        "status": row[5],
    }


def percentile(values: list[float], pct: float) -> float | None:
    if not values:
        return None
    if len(values) == 1:
        return values[0]
    ordered = sorted(values)
    idx = (len(ordered) - 1) * pct
    lo = math.floor(idx)
    hi = math.ceil(idx)
    if lo == hi:
        return ordered[lo]
    frac = idx - lo
    return ordered[lo] * (1.0 - frac) + ordered[hi] * frac


def linear_pressure_slope_per_hour(rows: list[dict[str, Any]]) -> float | None:
    samples: list[tuple[float, float]] = []
    for row in rows:
        dt = parse_iso(row.get("timestamp"))
        if dt is None:
            continue
        samples.append((dt.timestamp(), row_pressure(row)))

    if len(samples) < 2:
        return None

    mean_x = statistics.fmean(point[0] for point in samples)
    mean_y = statistics.fmean(point[1] for point in samples)
    denom = sum((point[0] - mean_x) ** 2 for point in samples)
    if denom == 0:
        return None
    numer = sum((point[0] - mean_x) * (point[1] - mean_y) for point in samples)
    slope_per_second = numer / denom
    return slope_per_second * 3600.0


def bucket_rows(rows: list[dict[str, Any]], bucket_seconds: int) -> list[dict[str, Any]]:
    if not rows:
        return []

    buckets: list[dict[str, Any]] = []
    current_key: int | None = None
    current_rows: list[dict[str, Any]] = []

    def flush(items: list[dict[str, Any]]) -> None:
        if not items:
            return
        pressures = [row_pressure(row) for row in items]
        currents = [float(row["current_ma"]) for row in items if row.get("current_ma") is not None]
        status = "OK"
        if any(row.get("status") == "STALE" for row in items):
            status = "STALE"
        elif any(row.get("status") == "LOOP_BROKEN" for row in items):
            status = "LOOP_BROKEN"
        elif any(row.get("status") == "OVER_RANGE" for row in items):
            status = "OVER_RANGE"
        buckets.append(
            {
                "timestamp": items[-1]["timestamp"],
                "pressure_inh2o": max(pressures) if pressures else None,
                "current_ma": statistics.fmean(currents) if currents else None,
                "status": status,
            }
        )

    for row in rows:
        dt = parse_iso(row.get("timestamp"))
        if dt is None:
            continue
        key = int(dt.timestamp()) // bucket_seconds
        if current_key is None:
            current_key = key
        if key != current_key:
            flush(current_rows)
            current_rows = []
            current_key = key
        current_rows.append(row)

    flush(current_rows)
    return buckets


def peak_reading(rows: list[dict[str, Any]]) -> dict[str, Any] | None:
    peak: dict[str, Any] | None = None
    peak_pressure: float | None = None
    for row in rows:
        value = row_pressure(row)
        if peak_pressure is None or value > peak_pressure:
            peak_pressure = value
            peak = {
                "timestamp": row.get("timestamp"),
                "pressure_inh2o": value,
                "current_ma": row.get("current_ma"),
                "status": row.get("status"),
            }
    return peak


def pressure_to_current(config: dict[str, Any], pressure_inh2o: float | None) -> float | None:
    if pressure_inh2o is None:
        return None
    try:
        zero_current = float(config.get("zero_current_ma") or 0.0)
        span_ma = float(config.get("span_ma") or 8.0)
        sensor_fs = float(config.get("sensor_fs_inh2o") or 10.0)
    except Exception:
        return None
    if sensor_fs <= 0:
        return None
    return zero_current + (float(pressure_inh2o) / sensor_fs) * span_ma


def summarize_window(rows: list[dict[str, Any]], limits: dict[str, Any], sample_hz: float) -> dict[str, Any]:
    pressures = [row_pressure(row) for row in rows]
    currents = [float(row["current_ma"]) for row in rows if row.get("current_ma") is not None]
    faults = [row for row in rows if row.get("status") != "OK"]

    baseline_high = float(limits["pressure_inh2o"]["baseline_high"])
    watch_high = float(limits["pressure_inh2o"]["watch_high"])
    alert_high = float(limits["pressure_inh2o"]["alert_high"])

    above_baseline = sum(1 for value in pressures if value >= baseline_high)
    above_watch = sum(1 for value in pressures if value >= watch_high)
    above_alert = sum(1 for value in pressures if value >= alert_high)

    timestamps = [parse_iso(row.get("timestamp")) for row in rows]
    timestamps = [dt for dt in timestamps if dt is not None]
    coverage_seconds = 0.0
    if len(timestamps) >= 2:
        coverage_seconds = (timestamps[-1] - timestamps[0]).total_seconds()

    return {
        "sample_count": len(rows),
        "coverage_hours": round(coverage_seconds / 3600.0, 2) if coverage_seconds else 0.0,
        "min_pressure_inh2o": min(pressures) if pressures else None,
        "max_pressure_inh2o": max(pressures) if pressures else None,
        "mean_pressure_inh2o": statistics.fmean(pressures) if pressures else None,
        "median_pressure_inh2o": statistics.median(pressures) if pressures else None,
        "p95_pressure_inh2o": percentile(pressures, 0.95),
        "p99_pressure_inh2o": percentile(pressures, 0.99),
        "mean_current_ma": statistics.fmean(currents) if currents else None,
        "fault_count": len(faults),
        "minutes_above_baseline": round(above_baseline / max(sample_hz, 0.001) / 60.0, 2),
        "minutes_above_watch": round(above_watch / max(sample_hz, 0.001) / 60.0, 2),
        "minutes_above_alert": round(above_alert / max(sample_hz, 0.001) / 60.0, 2),
    }


def build_limits(
    config: dict[str, Any],
    rows_24h: list[dict[str, Any]],
    alert_pressure_inh2o: float,
) -> dict[str, Any]:
    pressures = [row_pressure(row) for row in rows_24h]
    pulse_pressures = [value for value in pressures if value >= 0.02]

    baseline_high = min(alert_pressure_inh2o * 0.08, max(0.05, percentile(pressures, 0.95) or 0.05))
    observed_flush = percentile(pulse_pressures, 0.9) if pulse_pressures else None
    flush_expected_high = max(0.35, min(alert_pressure_inh2o * 0.2, observed_flush or alert_pressure_inh2o * 0.12))
    if flush_expected_high <= baseline_high:
        flush_expected_high = baseline_high + 0.2

    watch_high = min(max(flush_expected_high * 1.75, 1.5), max(1.5, alert_pressure_inh2o * 0.35))
    if watch_high <= flush_expected_high:
        watch_high = flush_expected_high + 0.35

    elevated_high = min(max(watch_high * 1.5, 3.0), max(3.0, alert_pressure_inh2o * 0.7))
    if elevated_high <= watch_high:
        elevated_high = watch_high + 0.75
    elevated_high = min(elevated_high, alert_pressure_inh2o * 0.85)

    pressure_limits = {
        "baseline_high": round(baseline_high, 3),
        "flush_expected_high": round(flush_expected_high, 3),
        "watch_high": round(watch_high, 3),
        "elevated_high": round(elevated_high, 3),
        "alert_high": round(alert_pressure_inh2o, 3),
    }

    current_limits = {
        "loop_broken_low": 3.5,
        "baseline_high": pressure_to_current(config, pressure_limits["baseline_high"]),
        "flush_expected_high": pressure_to_current(config, pressure_limits["flush_expected_high"]),
        "watch_high": pressure_to_current(config, pressure_limits["watch_high"]),
        "elevated_high": pressure_to_current(config, pressure_limits["elevated_high"]),
        "alert_high": pressure_to_current(config, pressure_limits["alert_high"]),
        "over_range_high": 20.5,
    }

    operating_ranges = [
        {
            "key": "quiet_pipe",
            "label": "Quiet pipe",
            "low": 0.0,
            "high": pressure_limits["baseline_high"],
            "description": "Normal steady air pressure with no meaningful flush pulse.",
        },
        {
            "key": "normal_flush",
            "label": "Normal flush pulse",
            "low": pressure_limits["baseline_high"],
            "high": pressure_limits["flush_expected_high"],
            "description": "Short pressure pulse expected from routine toilet flushes or fixture use.",
        },
        {
            "key": "watch",
            "label": "Watch pulse",
            "low": pressure_limits["flush_expected_high"],
            "high": pressure_limits["watch_high"],
            "description": "Stronger pulse than usual. Worth comparing with recent normal flushes.",
        },
        {
            "key": "elevated",
            "label": "Elevated pulse",
            "low": pressure_limits["watch_high"],
            "high": pressure_limits["elevated_high"],
            "description": "Pressure is building higher than a normal flush and may indicate growing restriction.",
        },
        {
            "key": "critical",
            "label": "Alarm pulse",
            "low": pressure_limits["elevated_high"],
            "high": pressure_limits["alert_high"],
            "description": "Pressure is close to the configured clog alarm threshold.",
        },
    ]

    return {
        "pressure_inh2o": pressure_limits,
        "current_ma": current_limits,
        "operating_ranges": operating_ranges,
    }


def classify_pressure_level(pressure_inh2o: float | None, limits: dict[str, Any]) -> str:
    if pressure_inh2o is None:
        return "unknown"
    pressure_limits = limits["pressure_inh2o"]
    value = float(pressure_inh2o)
    if value >= float(pressure_limits["alert_high"]):
        return "critical"
    if value >= float(pressure_limits["elevated_high"]):
        return "elevated"
    if value >= float(pressure_limits["watch_high"]):
        return "watch"
    if value >= float(pressure_limits["flush_expected_high"]):
        return "normal_flush"
    if value >= float(pressure_limits["baseline_high"]):
        return "baseline_shift"
    return "quiet"


def build_alarm_state(latest: dict[str, Any] | None, limits: dict[str, Any]) -> dict[str, Any]:
    if not latest:
        return {
            "pressure_level": "unknown",
            "sensor_level": "unknown",
            "message": "No readings have been captured yet.",
        }

    latest_status = str(latest.get("status") or "UNKNOWN")
    latest_pressure = latest.get("pressure_positive_inh2o")
    pressure_level = classify_pressure_level(latest_pressure, limits)

    if latest_status == "OK":
        sensor_level = "normal"
    elif latest_status == "STALE":
        sensor_level = "warning"
    else:
        sensor_level = "critical"

    messages = {
        "quiet": "Sewer-pipe air pressure is back at quiet baseline.",
        "baseline_shift": "A small pressure bump is present but still below normal flush range.",
        "normal_flush": "Recent pressure is within the expected flush-pulse range.",
        "watch": "Pressure pulse is stronger than normal and worth watching.",
        "elevated": "Pressure pulse is elevated and suggests more resistance in the line.",
        "critical": "Configured pressure alarm threshold has been reached.",
        "unknown": "Alarm state could not be determined.",
    }
    return {
        "pressure_level": pressure_level,
        "sensor_level": sensor_level,
        "message": messages.get(pressure_level, messages["unknown"]),
    }


def detect_flush_events(
    rows: list[dict[str, Any]],
    trigger_pressure_inh2o: float,
    merge_gap_seconds: int = 20,
) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    active: dict[str, Any] | None = None
    previous_dt: datetime | None = None
    previous_pressure = 0.0

    def close_active() -> None:
        nonlocal active
        if not active:
            return
        start_dt = active["start_dt"]
        end_dt = active["end_dt"]
        peak_dt = active["peak_dt"]
        events.append(
            {
                "start_timestamp": active["start_timestamp"],
                "end_timestamp": active["end_timestamp"],
                "peak_timestamp": active["peak_timestamp"],
                "peak_pressure_inh2o": round(active["peak_pressure_inh2o"], 4),
                "peak_current_ma": round(active["peak_current_ma"], 4) if active["peak_current_ma"] is not None else None,
                "samples": active["samples"],
                "duration_seconds": round((end_dt - start_dt).total_seconds(), 1),
                "recovery_seconds": round((end_dt - peak_dt).total_seconds(), 1),
                "area_pressure_inh2o_seconds": round(active["area_pressure_inh2o_seconds"], 4),
                "mean_pressure_inh2o": round(
                    active["area_pressure_inh2o_seconds"] / max((end_dt - start_dt).total_seconds(), 1.0),
                    4,
                ),
            }
        )
        active = None

    for row in rows:
        dt = parse_iso(row.get("timestamp"))
        pressure = row_pressure(row)
        current_ma = row.get("current_ma")
        current_value = float(current_ma) if current_ma is not None else None
        if dt is None:
            continue

        if active and previous_dt and (dt - previous_dt).total_seconds() > merge_gap_seconds:
            close_active()

        if active and previous_dt:
            dt_seconds = max((dt - previous_dt).total_seconds(), 0.0)
            active["area_pressure_inh2o_seconds"] += ((previous_pressure + pressure) / 2.0) * dt_seconds

        if pressure >= trigger_pressure_inh2o:
            if active is None:
                active = {
                    "start_dt": dt,
                    "end_dt": dt,
                    "peak_dt": dt,
                    "start_timestamp": row["timestamp"],
                    "end_timestamp": row["timestamp"],
                    "peak_timestamp": row["timestamp"],
                    "peak_pressure_inh2o": pressure,
                    "peak_current_ma": current_value,
                    "samples": 0,
                    "area_pressure_inh2o_seconds": 0.0,
                }
            active["end_dt"] = dt
            active["end_timestamp"] = row["timestamp"]
            active["samples"] += 1
            if pressure >= active["peak_pressure_inh2o"]:
                active["peak_pressure_inh2o"] = pressure
                active["peak_timestamp"] = row["timestamp"]
                active["peak_dt"] = dt
                active["peak_current_ma"] = current_value
        else:
            close_active()

        previous_dt = dt
        previous_pressure = pressure

    close_active()
    return events


def build_flush_summary(
    events_24h: list[dict[str, Any]],
    limits: dict[str, Any],
    coverage_hours: float,
) -> dict[str, Any]:
    recent = sorted(events_24h, key=lambda item: item["peak_timestamp"], reverse=True)
    top = sorted(events_24h, key=lambda item: item["peak_pressure_inh2o"], reverse=True)
    count = len(events_24h)

    if not recent:
        return {
            "count_24h": 0,
            "recent": [],
            "top_24h": [],
            "last_event": None,
            "comparison": {},
            "trend": build_flush_trend(events_24h),
            "typical_peak_pressure_inh2o": None,
            "typical_duration_seconds": None,
            "typical_recovery_seconds": None,
            "peak_ratio_vs_typical": None,
            "recovery_ratio_vs_typical": None,
            "duration_ratio_vs_typical": None,
            "clog_signal_score": None,
            "clog_signal_level": "unknown",
            "confidence": "low",
            "drivers": [],
            "notes": ["No flush pulse was detected in the last 24 hours. Flush a toilet to build a comparison pulse."],
        }

    last_event = recent[0]
    reference_events = recent[1:6]
    pressure_limits = limits["pressure_inh2o"]

    if len(reference_events) >= 2:
        typical_peak = statistics.median([float(item["peak_pressure_inh2o"]) for item in reference_events])
        typical_duration = statistics.median([float(item["duration_seconds"]) for item in reference_events])
        typical_recovery = statistics.median([float(item["recovery_seconds"]) for item in reference_events])
        confidence = "high" if count >= 5 and coverage_hours >= 6 else "medium"
        notes = ["Clog signal is comparing the latest flush pulse against recent flush behavior."]
    else:
        typical_peak = float(pressure_limits["flush_expected_high"])
        typical_duration = 4.0
        typical_recovery = 4.0
        confidence = "low" if count < 2 or coverage_hours < 2 else "medium"
        notes = ["There are not enough flush events yet, so the signal is using conservative default pulse timing."]

    peak_ratio = float(last_event["peak_pressure_inh2o"]) / max(typical_peak, 0.001)
    duration_ratio = float(last_event["duration_seconds"]) / max(typical_duration, 0.5)
    recovery_ratio = float(last_event["recovery_seconds"]) / max(typical_recovery, 0.5)

    peak_component = clamp(
        (float(last_event["peak_pressure_inh2o"]) - float(pressure_limits["flush_expected_high"]))
        / max(float(pressure_limits["watch_high"]) - float(pressure_limits["flush_expected_high"]), 0.1),
        0.0,
        1.0,
    )
    hold_component = clamp((float(last_event["recovery_seconds"]) - typical_recovery) / max(typical_recovery, 2.0), 0.0, 2.0) / 2.0
    duration_component = clamp((float(last_event["duration_seconds"]) - typical_duration) / max(typical_duration, 2.0), 0.0, 2.0) / 2.0
    ratio_component = clamp(max(peak_ratio - 1.0, 0.0), 0.0, 1.5) / 1.5
    recovery_ratio_component = clamp(max(recovery_ratio - 1.0, 0.0), 0.0, 2.0) / 2.0

    score = round(
        100.0
        * (
            0.25 * peak_component
            + 0.25 * hold_component
            + 0.15 * duration_component
            + 0.15 * ratio_component
            + 0.20 * recovery_ratio_component
        )
    )

    if score >= 75:
        level = "critical"
    elif score >= 55:
        level = "high"
    elif score >= 35:
        level = "elevated"
    elif score >= 18:
        level = "watch"
    else:
        level = "low"

    if peak_ratio > 1.25:
        notes.append("The latest flush pulse peaked higher than the recent typical flush.")
    if recovery_ratio > 1.5:
        notes.append("The latest flush pressure stayed elevated longer than the recent typical flush.")
    if duration_ratio > 1.5:
        notes.append("The latest flush pulse lasted longer than the recent typical flush.")
    if score < 18 and len(notes) == 1:
        notes.append("Latest flush pressure pulse looks close to recent normal behavior.")

    drivers = [
        {"label": "Last flush peak", "value": round(float(last_event["peak_pressure_inh2o"]), 3), "unit": "inH2O"},
        {"label": "Last flush hold", "value": round(float(last_event["duration_seconds"]), 1), "unit": "s"},
        {"label": "Last recovery", "value": round(float(last_event["recovery_seconds"]), 1), "unit": "s"},
        {"label": "Peak vs typical", "value": round(peak_ratio, 2), "unit": "x"},
        {"label": "Recovery vs typical", "value": round(recovery_ratio, 2), "unit": "x"},
    ]

    comparison = {
        "peak": {
            "latest": round(float(last_event["peak_pressure_inh2o"]), 3),
            "typical": round(typical_peak, 3),
            "ratio": round(peak_ratio, 2),
            "percent_delta": round((peak_ratio - 1.0) * 100.0, 1),
            "unit": "inH2O",
        },
        "duration": {
            "latest": round(float(last_event["duration_seconds"]), 1),
            "typical": round(typical_duration, 1),
            "ratio": round(duration_ratio, 2),
            "percent_delta": round((duration_ratio - 1.0) * 100.0, 1),
            "unit": "s",
        },
        "recovery": {
            "latest": round(float(last_event["recovery_seconds"]), 1),
            "typical": round(typical_recovery, 1),
            "ratio": round(recovery_ratio, 2),
            "percent_delta": round((recovery_ratio - 1.0) * 100.0, 1),
            "unit": "s",
        },
    }

    return {
        "count_24h": count,
        "recent": recent[:8],
        "top_24h": top[:8],
        "last_event": last_event,
        "comparison": comparison,
        "trend": build_flush_trend(events_24h),
        "typical_peak_pressure_inh2o": round(typical_peak, 3),
        "typical_duration_seconds": round(typical_duration, 1),
        "typical_recovery_seconds": round(typical_recovery, 1),
        "peak_ratio_vs_typical": round(peak_ratio, 2),
        "recovery_ratio_vs_typical": round(recovery_ratio, 2),
        "duration_ratio_vs_typical": round(duration_ratio, 2),
        "clog_signal_score": score,
        "clog_signal_level": level,
        "confidence": confidence,
        "drivers": drivers,
        "notes": notes,
    }


def percent_delta(newer: float | None, older: float | None) -> float | None:
    if newer is None or older is None or abs(older) < 0.001:
        return None
    return ((newer - older) / older) * 100.0


def build_flush_trend(events_24h: list[dict[str, Any]]) -> dict[str, Any]:
    chronological = sorted(events_24h, key=lambda item: item["peak_timestamp"])
    count = len(chronological)
    if count < 4:
        return {
            "level": "insufficient",
            "message": "Needs at least four flush pulses for a directional trend.",
            "event_count": count,
            "peak_delta_percent": None,
            "recovery_delta_percent": None,
            "duration_delta_percent": None,
        }

    half = max(2, count // 2)
    older = chronological[:half]
    newer = chronological[-half:]

    older_peak = statistics.median(float(item["peak_pressure_inh2o"]) for item in older)
    newer_peak = statistics.median(float(item["peak_pressure_inh2o"]) for item in newer)
    older_recovery = statistics.median(float(item["recovery_seconds"]) for item in older)
    newer_recovery = statistics.median(float(item["recovery_seconds"]) for item in newer)
    older_duration = statistics.median(float(item["duration_seconds"]) for item in older)
    newer_duration = statistics.median(float(item["duration_seconds"]) for item in newer)

    peak_delta = percent_delta(newer_peak, older_peak)
    recovery_delta = percent_delta(newer_recovery, older_recovery)
    duration_delta = percent_delta(newer_duration, older_duration)

    rising_signals = sum(
        1
        for value, threshold in [
            (peak_delta, 15.0),
            (recovery_delta, 25.0),
            (duration_delta, 25.0),
        ]
        if value is not None and value >= threshold
    )
    falling_signals = sum(
        1
        for value, threshold in [
            (peak_delta, -15.0),
            (recovery_delta, -25.0),
            (duration_delta, -25.0),
        ]
        if value is not None and value <= threshold
    )

    if rising_signals >= 2 or (peak_delta is not None and recovery_delta is not None and peak_delta >= 15 and recovery_delta >= 15):
        level = "rising"
        message = "Recent flushes are building more pressure or releasing slower than earlier flushes."
    elif falling_signals >= 2:
        level = "falling"
        message = "Recent flushes are easier than earlier flushes."
    else:
        level = "stable"
        message = "Recent flush pressure and recovery are close to earlier flushes."

    return {
        "level": level,
        "message": message,
        "event_count": count,
        "older_event_count": len(older),
        "newer_event_count": len(newer),
        "older_median_peak_pressure_inh2o": round(older_peak, 3),
        "newer_median_peak_pressure_inh2o": round(newer_peak, 3),
        "older_median_recovery_seconds": round(older_recovery, 1),
        "newer_median_recovery_seconds": round(newer_recovery, 1),
        "older_median_duration_seconds": round(older_duration, 1),
        "newer_median_duration_seconds": round(newer_duration, 1),
        "peak_delta_percent": round(peak_delta, 1) if peak_delta is not None else None,
        "recovery_delta_percent": round(recovery_delta, 1) if recovery_delta is not None else None,
        "duration_delta_percent": round(duration_delta, 1) if duration_delta is not None else None,
    }


def build_data_quality(
    latest: dict[str, Any] | None,
    stats_15m: dict[str, Any],
    stats_24h: dict[str, Any],
    flush_analysis: dict[str, Any],
    sample_hz: float,
    now: datetime,
) -> dict[str, Any]:
    latest_dt = parse_iso(latest.get("timestamp")) if latest else None
    sample_age_seconds = (now - latest_dt).total_seconds() if latest_dt else None
    expected_15m = max(sample_hz, 0.001) * 15.0 * 60.0
    density_15m = float(stats_15m.get("sample_count") or 0) / expected_15m
    density_15m = clamp(density_15m, 0.0, 1.0)
    coverage_hours = float(stats_24h.get("coverage_hours") or 0.0)
    fault_count = int(stats_24h.get("fault_count") or 0)
    flush_count = int(flush_analysis.get("count_24h") or 0)

    issues: list[str] = []
    if sample_age_seconds is None:
        issues.append("No latest sample timestamp.")
    elif sample_age_seconds > 120:
        issues.append("Latest sample is stale.")
    if density_15m < 0.75:
        issues.append("Recent sample density is low.")
    if fault_count:
        issues.append(f"{fault_count} sensor fault samples in the 24h window.")
    if flush_count < 3:
        issues.append("Flush comparison confidence is limited.")

    fresh_seconds = max(15.0, 5.0 / max(sample_hz, 0.001))
    stale_seconds = max(60.0, fresh_seconds * 4.0)

    if sample_age_seconds is not None and sample_age_seconds <= fresh_seconds and density_15m >= 0.9 and fault_count == 0:
        sensor_level = "good"
    elif sample_age_seconds is not None and sample_age_seconds <= stale_seconds and density_15m >= 0.75:
        sensor_level = "watch"
    else:
        sensor_level = "poor"

    if flush_count >= 5 and coverage_hours >= 6:
        analysis_level = "good"
    elif flush_count >= 2 and coverage_hours >= 2:
        analysis_level = "usable"
    else:
        analysis_level = "limited"

    if sensor_level == "good" and analysis_level in {"good", "usable"}:
        level = "good"
        message = "Monitor data is current and usable for flush comparison."
    elif sensor_level == "poor":
        level = "poor"
        message = "Monitor data quality is low; check sampling before trusting the score."
    else:
        level = "limited"
        message = "Monitor data is usable, but more flush history will improve confidence."

    return {
        "level": level,
        "sensor_level": sensor_level,
        "analysis_level": analysis_level,
        "message": message,
        "sample_age_seconds": round(sample_age_seconds, 1) if sample_age_seconds is not None else None,
        "fresh_sample_seconds": round(fresh_seconds, 1),
        "stale_sample_seconds": round(stale_seconds, 1),
        "sample_density_15m": round(density_15m, 3),
        "coverage_hours_24h": round(coverage_hours, 2),
        "flush_count_24h": flush_count,
        "fault_count_24h": fault_count,
        "issues": issues,
    }


def daily_peaks(conn: sqlite3.Connection, days: int) -> list[dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT substr(timestamp, 1, 10) AS day,
               COUNT(*) AS samples,
               MAX(depth_in) AS max_depth_in,
               AVG(depth_in) AS mean_depth_in,
               MAX(current_ma) AS max_current_ma,
               MAX(pressure_inh2o) AS max_pressure_inh2o,
               AVG(CASE WHEN pressure_inh2o > 0 THEN pressure_inh2o ELSE 0 END) AS mean_pressure_inh2o
        FROM readings
        WHERE timestamp >= ?
        GROUP BY day
        ORDER BY day ASC
        """,
        (iso_utc(utc_now() - timedelta(days=days)),),
    ).fetchall()
    return [
        {
            "day": row[0],
            "samples": row[1],
            "max_pressure_inh2o": positive_pressure(row[5]),
            "mean_pressure_inh2o": row[6] or 0.0,
            "max_current_ma": row[4],
        }
        for row in rows
    ]


def build_payload() -> dict[str, Any]:
    config = load_config()
    sample_hz = float(config.get("sample_hz") or 1.0)
    alert_pressure_inh2o = float(config.get("alert_pressure_inh2o") or config.get("alert_depth_in") or 7.0)
    config.setdefault("alert_pressure_inh2o", alert_pressure_inh2o)

    payload: dict[str, Any] = {
        "generated_at": iso_utc(utc_now()),
        "analysis_model": "pressure_pulse_v2",
        "units": {
            "pressure": "inH2O",
            "current": "mA",
            "duration": "s",
        },
        "monitor_host": "sewer-pi",
        "paths": {
            "config": str(CONFIG_PATH),
            "database": str(DB_PATH),
        },
        "config": config,
        "latest": None,
        "recent_peak": None,
        "alarm_state": {},
        "limits": {},
        "stats_15m": {},
        "stats_1h": {},
        "stats_6h": {},
        "stats_24h": {},
        "prediction": {},
        "flush_analysis": {},
        "data_quality": {},
        "history": {
            "pressure_15m": [],
            "pressure_1h": [],
            "pressure_6h": [],
            "pressure_24h": [],
            "daily_peaks_7d": [],
            "daily_peaks_30d": [],
        },
        "events": {
            "alerts": read_log_tail(ALERT_LOG_PATH),
            "faults": read_log_tail(FAULT_LOG_PATH),
        },
    }

    if not DB_PATH.exists():
        payload["prediction"] = {
            "risk_score": None,
            "risk_level": "unknown",
            "confidence": "low",
            "drivers": [],
            "notes": ["The monitor database does not exist yet."],
        }
        payload["flush_analysis"] = payload["prediction"]
        payload["data_quality"] = {
            "level": "poor",
            "sensor_level": "poor",
            "analysis_level": "limited",
            "message": "The monitor database does not exist yet.",
            "issues": ["No monitor database."],
        }
        return payload

    conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    try:
        now = utc_now()
        latest = fetch_latest(conn)
        rows_15m = fetch_rows(conn, now - timedelta(minutes=15))
        rows_1h = fetch_rows(conn, now - timedelta(hours=1))
        rows_6h = fetch_rows(conn, now - timedelta(hours=6))
        rows_24h = fetch_rows(conn, now - timedelta(hours=24))

        limits = build_limits(config, rows_24h, alert_pressure_inh2o)
        stats_15m = summarize_window(rows_15m, limits, sample_hz)
        stats_1h = summarize_window(rows_1h, limits, sample_hz)
        stats_6h = summarize_window(rows_6h, limits, sample_hz)
        stats_24h = summarize_window(rows_24h, limits, sample_hz)

        flush_events_24h = detect_flush_events(rows_24h, float(limits["pressure_inh2o"]["baseline_high"]))
        flush_analysis = build_flush_summary(flush_events_24h, limits, float(stats_24h["coverage_hours"] or 0.0))
        data_quality = build_data_quality(latest, stats_15m, stats_24h, flush_analysis, sample_hz, now)

        payload["latest"] = latest
        payload["recent_peak"] = peak_reading(rows_15m)
        payload["limits"] = limits
        payload["alarm_state"] = build_alarm_state(latest, limits)
        payload["stats_15m"] = stats_15m
        payload["stats_1h"] = stats_1h
        payload["stats_6h"] = stats_6h
        payload["stats_24h"] = stats_24h
        payload["flush_analysis"] = flush_analysis
        payload["data_quality"] = data_quality
        payload["prediction"] = {
            "risk_score": flush_analysis.get("clog_signal_score"),
            "risk_level": flush_analysis.get("clog_signal_level"),
            "confidence": flush_analysis.get("confidence"),
            "drivers": flush_analysis.get("drivers", []),
            "notes": flush_analysis.get("notes", []),
        }
        payload["history"]["pressure_15m"] = bucket_rows(rows_15m, 5)
        payload["history"]["pressure_1h"] = bucket_rows(rows_1h, 15)
        payload["history"]["pressure_6h"] = bucket_rows(rows_6h, 60)
        payload["history"]["pressure_24h"] = bucket_rows(rows_24h, 300)
        payload["history"]["daily_peaks_7d"] = daily_peaks(conn, 7)
        payload["history"]["daily_peaks_30d"] = daily_peaks(conn, 30)
    finally:
        conn.close()

    return payload


def main() -> int:
    print(json.dumps(build_payload(), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
