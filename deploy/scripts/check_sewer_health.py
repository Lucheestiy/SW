#!/usr/bin/env python3
"""Check published sewer dashboard freshness and write a public health summary."""

from __future__ import annotations

import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.error import URLError
from urllib.request import Request, urlopen


DATA_DIR = Path("/var/www/sw.lucheestiy.com/data")
DASHBOARD_PATH = DATA_DIR / "dashboard.json"
SYNC_PATH = DATA_DIR / "sync.json"
BACKUP_PATH = DATA_DIR / "backup.json"
HEALTH_PATH = DATA_DIR / "health.json"
SERVICE_FAILURE_PATH = DATA_DIR / "service-failure.json"
PUBLIC_URL = "https://sw.lucheestiy.com/"

SYNC_MAX_AGE_SECONDS = 10 * 60
SAMPLE_MAX_AGE_SECONDS = 10 * 60
BACKUP_MAX_AGE_SECONDS = 36 * 60 * 60
HTTP_TIMEOUT_SECONDS = 8


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso_utc(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def parse_iso(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)
    except ValueError:
        return None


def age_seconds(now: datetime, value: Any) -> float | None:
    parsed = parse_iso(value)
    if parsed is None:
        return None
    return max(0.0, (now - parsed).total_seconds())


def read_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)
    if not isinstance(payload, dict):
        raise ValueError(f"{path} did not contain a JSON object")
    return payload


def write_json_atomic(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as handle:
        tmp_path = Path(handle.name)
        json.dump(payload, handle, ensure_ascii=True, indent=2)
        handle.write("\n")
    os.chmod(tmp_path, 0o644)
    os.replace(tmp_path, path)


def clear_service_failure_if_recovered(ok: bool) -> dict[str, Any] | None:
    if not ok or not SERVICE_FAILURE_PATH.exists():
        return None
    try:
        payload = read_json(SERVICE_FAILURE_PATH)
    except Exception as exc:
        payload = {"status": "unknown", "error": str(exc)}
    SERVICE_FAILURE_PATH.unlink(missing_ok=True)
    return payload


def check_max_age(name: str, now: datetime, timestamp: Any, max_age: int) -> dict[str, Any]:
    age = age_seconds(now, timestamp)
    ok = age is not None and age <= max_age
    return {
        "name": name,
        "ok": ok,
        "timestamp": timestamp,
        "age_seconds": round(age, 1) if age is not None else None,
        "max_age_seconds": max_age,
    }


def check_public_http() -> dict[str, Any]:
    request = Request(PUBLIC_URL, method="HEAD")
    try:
        with urlopen(request, timeout=HTTP_TIMEOUT_SECONDS) as response:
            status_code = response.status
    except (OSError, URLError) as exc:
        return {
            "name": "public_http",
            "ok": False,
            "url": PUBLIC_URL,
            "error": str(exc),
        }
    return {
        "name": "public_http",
        "ok": 200 <= status_code < 400,
        "url": PUBLIC_URL,
        "status_code": status_code,
    }


def main() -> int:
    now = utc_now()
    checks: list[dict[str, Any]] = []
    files: dict[str, Any] = {}

    try:
        dashboard = read_json(DASHBOARD_PATH)
        files["dashboard_json"] = {"ok": True, "path": str(DASHBOARD_PATH)}
    except Exception as exc:
        dashboard = {}
        files["dashboard_json"] = {"ok": False, "path": str(DASHBOARD_PATH), "error": str(exc)}

    try:
        sync = read_json(SYNC_PATH)
        files["sync_json"] = {"ok": True, "path": str(SYNC_PATH)}
    except Exception as exc:
        sync = {}
        files["sync_json"] = {"ok": False, "path": str(SYNC_PATH), "error": str(exc)}

    try:
        backup = read_json(BACKUP_PATH)
        files["backup_json"] = {"ok": True, "path": str(BACKUP_PATH)}
    except Exception as exc:
        backup = {}
        files["backup_json"] = {"ok": False, "path": str(BACKUP_PATH), "error": str(exc)}

    checks.append(
        {
            "name": "sync_status",
            "ok": sync.get("status") == "ok",
            "status": sync.get("status"),
        }
    )
    checks.append(check_max_age("sync_last_success", now, sync.get("last_success_at"), SYNC_MAX_AGE_SECONDS))
    checks.append(check_max_age("sync_source_generated", now, sync.get("source_generated_at"), SYNC_MAX_AGE_SECONDS))
    checks.append(
        check_max_age(
            "dashboard_latest_sample",
            now,
            (dashboard.get("latest") or {}).get("timestamp"),
            SAMPLE_MAX_AGE_SECONDS,
        )
    )
    checks.append(
        {
            "name": "backup_status",
            "ok": backup.get("status") == "ok",
            "status": backup.get("status"),
        }
    )
    checks.append(check_max_age("backup_generated", now, backup.get("generated_at"), BACKUP_MAX_AGE_SECONDS))
    checks.append(check_public_http())

    ok = all(item.get("ok") for item in files.values()) and all(item.get("ok") for item in checks)
    cleared_service_failure = clear_service_failure_if_recovered(ok)
    payload = {
        "status": "ok" if ok else "error",
        "generated_at": iso_utc(now),
        "thresholds": {
            "sync_max_age_seconds": SYNC_MAX_AGE_SECONDS,
            "sample_max_age_seconds": SAMPLE_MAX_AGE_SECONDS,
            "backup_max_age_seconds": BACKUP_MAX_AGE_SECONDS,
        },
        "files": files,
        "checks": checks,
    }
    if cleared_service_failure is not None:
        payload["cleared_service_failure"] = cleared_service_failure
    write_json_atomic(HEALTH_PATH, payload)
    print(json.dumps(payload, indent=2))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
