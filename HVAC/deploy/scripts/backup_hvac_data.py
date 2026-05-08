#!/usr/bin/env python3
"""Back up sewer monitor history from the Raspberry Pi with a two-year retention window."""

from __future__ import annotations

import fcntl
import json
import os
import re
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


SSH_TARGET = os.environ.get("HVAC_BACKUP_SSH_TARGET", "hvac-pi")
REMOTE_BASE = os.environ.get("HVAC_BACKUP_REMOTE_BASE", "/root/sewer-monitor")
REMOTE_PYTHON = os.environ.get("HVAC_BACKUP_REMOTE_PYTHON", f"{REMOTE_BASE}/venv/bin/python")
BACKUP_ROOT = Path(os.environ.get("HVAC_BACKUP_ROOT", "/root/backups/hvac-sewer"))
RETENTION_DAYS = int(os.environ.get("HVAC_BACKUP_RETENTION_DAYS", "731"))
LOCK_PATH = Path(os.environ.get("HVAC_BACKUP_LOCK", "/run/hvac-data-backup.lock"))
MANIFEST_PATH = BACKUP_ROOT / "manifest.json"
PUBLIC_STATUS_PATH = Path(os.environ.get("HVAC_BACKUP_PUBLIC_STATUS", "/var/www/hvac.lucheestiy.com/data/backup.json"))
OFFSITE_TARGET = os.environ.get("HVAC_BACKUP_OFFSITE_TARGET", "inyp-vps")
OFFSITE_ROOT = os.environ.get("HVAC_BACKUP_OFFSITE_ROOT", "/root/backups/hvac-sewer")


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso_utc(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def run(cmd: list[str], timeout: int = 180, stdin: str | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        cmd,
        input=stdin,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        check=False,
    )


def require_ok(result: subprocess.CompletedProcess[str], label: str) -> None:
    if result.returncode == 0:
        return
    stderr = (result.stderr or "").strip()
    stdout = (result.stdout or "").strip()
    detail = stderr or stdout or f"exit code {result.returncode}"
    raise RuntimeError(f"{label} failed: {detail}")


def make_remote_sqlite_snapshot() -> None:
    code = f"""
import os
import sqlite3
from pathlib import Path

base = Path({REMOTE_BASE!r})
src_path = base / "data.db"
snap_dir = base / "backups" / "latest"
snap_dir.mkdir(parents=True, exist_ok=True)
tmp_path = snap_dir / "data.db.tmp"
dst_path = snap_dir / "data.db"
if tmp_path.exists():
    tmp_path.unlink()
src = sqlite3.connect(src_path)
dst = sqlite3.connect(tmp_path)
try:
    src.backup(dst)
finally:
    dst.close()
    src.close()
os.replace(tmp_path, dst_path)
"""
    result = run(["ssh", SSH_TARGET, REMOTE_PYTHON, "-"], timeout=120, stdin=code)
    require_ok(result, "remote sqlite snapshot")


def rsync_from_pi(remote_path: str, local_path: Path, delete: bool = False) -> None:
    local_path.parent.mkdir(parents=True, exist_ok=True)
    cmd = ["rsync", "-a", "--partial", "--timeout=60"]
    if delete:
        cmd.append("--delete")
    cmd.extend([f"{SSH_TARGET}:{remote_path}", str(local_path)])
    result = run(cmd, timeout=300)
    require_ok(result, f"rsync {remote_path}")


def rsync_to_offsite() -> dict[str, Any]:
    if not OFFSITE_TARGET or OFFSITE_TARGET.lower() in {"none", "disabled", "false"}:
        return {
            "status": "disabled",
            "target": None,
            "root": None,
        }

    mkdir_result = run(["ssh", OFFSITE_TARGET, "mkdir", "-p", OFFSITE_ROOT], timeout=60)
    require_ok(mkdir_result, "offsite mkdir")

    result = run(
        [
            "rsync",
            "-a",
            "--delete",
            "--partial",
            "--timeout=60",
            f"{BACKUP_ROOT}/",
            f"{OFFSITE_TARGET}:{OFFSITE_ROOT}/",
        ],
        timeout=600,
    )
    require_ok(result, "offsite rsync")
    return {
        "status": "ok",
        "target": OFFSITE_TARGET,
        "root": OFFSITE_ROOT,
    }


def copy_manifest_to_offsite(offsite: dict[str, Any]) -> None:
    if offsite.get("status") != "ok":
        return
    result = run(
        ["rsync", "-a", "--timeout=60", str(MANIFEST_PATH), f"{OFFSITE_TARGET}:{OFFSITE_ROOT}/manifest.json"],
        timeout=120,
    )
    require_ok(result, "offsite manifest")


def remote_stats() -> dict[str, Any]:
    code = f"""
import json
import os
import sqlite3
from pathlib import Path

base = Path({REMOTE_BASE!r})
db_path = base / "data.db"
payload = {{
    "db_bytes": db_path.stat().st_size if db_path.exists() else 0,
    "logs_bytes": sum(p.stat().st_size for p in (base / "logs").glob("*.csv")) if (base / "logs").exists() else 0,
    "readings": 0,
    "first_timestamp": None,
    "last_timestamp": None,
}}
if db_path.exists():
    conn = sqlite3.connect(db_path)
    try:
        row = conn.execute("SELECT COUNT(*), MIN(timestamp), MAX(timestamp) FROM readings").fetchone()
        payload["readings"] = row[0]
        payload["first_timestamp"] = row[1]
        payload["last_timestamp"] = row[2]
    finally:
        conn.close()
print(json.dumps(payload))
"""
    result = run(["ssh", SSH_TARGET, REMOTE_PYTHON, "-"], timeout=60, stdin=code)
    require_ok(result, "remote stats")
    return json.loads(result.stdout)


def prune_old_local_logs(now: datetime) -> list[str]:
    logs_dir = BACKUP_ROOT / "raw" / "logs"
    cutoff = (now - timedelta(days=RETENTION_DAYS)).date()
    removed: list[str] = []
    if not logs_dir.exists():
        return removed

    pattern = re.compile(r"^(\d{4}-\d{2}-\d{2})\.csv$")
    for path in logs_dir.glob("*.csv"):
        match = pattern.match(path.name)
        if not match:
            continue
        try:
            day = datetime.strptime(match.group(1), "%Y-%m-%d").date()
        except ValueError:
            continue
        if day < cutoff:
            path.unlink()
            removed.append(path.name)
    return removed


def directory_size(path: Path) -> int:
    if not path.exists():
        return 0
    return sum(item.stat().st_size for item in path.rglob("*") if item.is_file())


def write_json_atomic(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as handle:
        tmp_path = Path(handle.name)
        json.dump(payload, handle, ensure_ascii=True, indent=2)
        handle.write("\n")
    os.chmod(tmp_path, 0o644)
    os.replace(tmp_path, path)


def backup_once() -> dict[str, Any]:
    now = utc_now()
    BACKUP_ROOT.mkdir(parents=True, exist_ok=True)

    make_remote_sqlite_snapshot()
    rsync_from_pi(f"{REMOTE_BASE}/logs/", BACKUP_ROOT / "raw" / "logs/")
    for name in ["config.json", "alerts.log", "faults.log"]:
        rsync_from_pi(f"{REMOTE_BASE}/{name}", BACKUP_ROOT / "raw" / name)
    rsync_from_pi(f"{REMOTE_BASE}/backups/latest/data.db", BACKUP_ROOT / "sqlite" / "latest" / "data.db")

    stats = remote_stats()
    removed_logs = prune_old_local_logs(now)
    manifest = {
        "status": "ok",
        "generated_at": iso_utc(now),
        "ssh_target": SSH_TARGET,
        "remote_base": REMOTE_BASE,
        "backup_root": str(BACKUP_ROOT),
        "retention_days": RETENTION_DAYS,
        "retention_until": iso_utc(now - timedelta(days=RETENTION_DAYS)),
        "strategy": {
            "raw_logs": "daily CSV logs retained locally for the retention window",
            "sqlite": "latest consistent SQLite snapshot retained for fast restore",
            "offsite": "local backup tree mirrored to the configured offsite target",
        },
        "offsite": {
            "status": "pending",
            "target": OFFSITE_TARGET,
            "root": OFFSITE_ROOT,
        },
        "remote": stats,
        "local": {
            "raw_bytes": directory_size(BACKUP_ROOT / "raw"),
            "sqlite_latest_bytes": (BACKUP_ROOT / "sqlite" / "latest" / "data.db").stat().st_size,
            "total_bytes": directory_size(BACKUP_ROOT),
        },
        "pruned_logs": removed_logs,
    }
    write_json_atomic(MANIFEST_PATH, manifest)
    manifest["offsite"] = rsync_to_offsite()
    write_json_atomic(MANIFEST_PATH, manifest)
    copy_manifest_to_offsite(manifest["offsite"])
    write_json_atomic(PUBLIC_STATUS_PATH, manifest)
    return manifest


def main() -> int:
    LOCK_PATH.parent.mkdir(parents=True, exist_ok=True)
    with LOCK_PATH.open("w", encoding="utf-8") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print("hvac backup already running", file=sys.stderr)
            return 75

        try:
            manifest = backup_once()
        except Exception as exc:
            failed = {
                "status": "error",
                "generated_at": iso_utc(utc_now()),
                "backup_root": str(BACKUP_ROOT),
                "retention_days": RETENTION_DAYS,
                "error": str(exc),
            }
            write_json_atomic(MANIFEST_PATH, failed)
            write_json_atomic(PUBLIC_STATUS_PATH, failed)
            print(json.dumps(failed, indent=2), file=sys.stderr)
            return 1

    print(json.dumps(manifest, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
