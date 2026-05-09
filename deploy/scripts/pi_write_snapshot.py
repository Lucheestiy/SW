#!/usr/bin/env python3
"""Write the dashboard snapshot JSON to a local public file atomically."""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

from export_snapshot import build_payload


OUTPUT_DIR = Path("/root/sewer-monitor/public")
OUTPUT_PATH = OUTPUT_DIR / "dashboard.json"


def write_json_atomic(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as handle:
        tmp_path = Path(handle.name)
        json.dump(payload, handle, ensure_ascii=True, indent=2)
        handle.write("\n")
    os.chmod(tmp_path, 0o644)
    os.replace(tmp_path, path)


def main() -> int:
    write_json_atomic(OUTPUT_PATH, build_payload())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
