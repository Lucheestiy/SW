#!/usr/bin/env python3
"""Record systemd service failures for the SW dashboard."""

from __future__ import annotations

import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


STATUS_PATH = Path("/var/www/sw.lucheestiy.com/data/service-failure.json")
LOG_PATH = Path("/var/log/sw-service-failures.log")


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


def main() -> int:
    import sys

    failed_unit = sys.argv[1] if len(sys.argv) > 1 else "unknown"
    payload = {
        "status": "error",
        "failed_unit": failed_unit,
        "recorded_at": utc_now_iso(),
        "note": "A SW systemd unit entered the failed state. Check journalctl for the failed unit.",
    }
    write_json_atomic(STATUS_PATH, payload)
    with LOG_PATH.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, sort_keys=True) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
