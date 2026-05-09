#!/usr/bin/env python3
"""Copy the sewer monitor dashboard snapshot from the Raspberry Pi into the SW webroot."""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


WEBROOT = Path("/var/www/sw.lucheestiy.com")
DATA_DIR = WEBROOT / "data"
DASHBOARD_PATH = DATA_DIR / "dashboard.json"
SYNC_PATH = DATA_DIR / "sync.json"
SSH_TARGET = "sewer-pi"
REMOTE_SNAPSHOT = f"{SSH_TARGET}:/root/sewer-monitor/public/dashboard.json"
REMOTE_SNAPSHOT_PATH = "/root/sewer-monitor/public/dashboard.json"
RSYNC_SSH = (
    "ssh -T -o BatchMode=yes -o ConnectTimeout=8 -o ConnectionAttempts=1 "
    "-o ServerAliveInterval=5 -o ServerAliveCountMax=1"
)


def rsync_command(destination: Path) -> list[str]:
    return [
        "rsync",
        "-t",
        "--timeout=15",
        "-e",
        RSYNC_SSH,
        REMOTE_SNAPSHOT,
        str(destination),
    ]


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def write_json_atomic(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as handle:
        tmp_path = Path(handle.name)
        json.dump(payload, handle, ensure_ascii=True, indent=2)
        handle.write("\n")
    os.chmod(tmp_path, 0o644)
    os.replace(tmp_path, path)


def sync_status_payload(status: str, **extra: Any) -> dict[str, Any]:
    payload = {
        "status": status,
        "target": SSH_TARGET,
        "source": {
            "transport": "rsync",
            "path": REMOTE_SNAPSHOT_PATH,
        },
        "last_attempt_at": utc_now_iso(),
    }
    payload.update(extra)
    return payload


def main() -> int:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp_path: Path | None = None

    def remove_tmp() -> None:
        if tmp_path is not None:
            tmp_path.unlink(missing_ok=True)

    try:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=DATA_DIR, delete=False) as handle:
            tmp_path = Path(handle.name)
        result = subprocess.run(
            rsync_command(tmp_path),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
            check=False,
        )
    except Exception as exc:
        remove_tmp()
        write_json_atomic(SYNC_PATH, sync_status_payload("error", error=str(exc)))
        return 1

    if result.returncode != 0:
        remove_tmp()
        write_json_atomic(
            SYNC_PATH,
            sync_status_payload(
                "error",
                return_code=result.returncode,
                stderr=(result.stderr or "").strip(),
            ),
        )
        return result.returncode

    try:
        payload = json.loads(tmp_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        write_json_atomic(
            SYNC_PATH,
            sync_status_payload(
                "error",
                error=f"invalid JSON: {exc}",
                stderr=(result.stderr or "").strip(),
            ),
        )
        return 1
    finally:
        remove_tmp()

    payload["public_host"] = "sw.lucheestiy.com"
    payload["synced_at"] = utc_now_iso()
    write_json_atomic(DASHBOARD_PATH, payload)
    write_json_atomic(
        SYNC_PATH,
        sync_status_payload(
            "ok",
            last_success_at=utc_now_iso(),
            source_generated_at=payload.get("generated_at"),
            sample_timestamp=(payload.get("latest") or {}).get("timestamp"),
        ),
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
