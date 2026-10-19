#!/usr/bin/env python3
"""Create a WAL-consistent, isolated copy for UniQuiz M7 migration rehearsal.

This script NEVER calls the UniQuiz application or changes the source DB.
Supply BOTH source and destination paths explicitly. No network is used.
"""
from __future__ import annotations

import argparse
import hashlib
import os
from pathlib import Path
import sqlite3
import sys


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True, help="Current official UniQuiz SQLite database")
    parser.add_argument("--destination", type=Path, required=True, help="New local rehearsal-only SQLite copy")
    args = parser.parse_args()

    source = args.source.expanduser().resolve()
    destination = args.destination.expanduser().resolve()
    if source == destination:
        parser.error("Destination MUST be different from the official database path.")
    if not source.is_file() or source.stat().st_size == 0:
        parser.error("Official source DB does not exist or is empty.")
    if destination.exists():
        parser.error("Destination already exists; refusing to overwrite any file.")
    if not destination.parent.is_dir():
        parser.error("Create a separate rehearsal directory first.")

    # No source writes: sqlite backup API copies the logical state, including
    # committed transactions in the WAL, not merely the raw database file.
    old_mask = os.umask(0o077)
    src: sqlite3.Connection | None = None
    dst: sqlite3.Connection | None = None
    try:
        src = sqlite3.connect(source.as_uri() + "?mode=ro", uri=True, timeout=30)
        dst = sqlite3.connect(str(destination), timeout=30)
        src.backup(dst)
        checks = dst.execute("PRAGMA integrity_check").fetchall()
        if checks != [("ok",)]:
            raise RuntimeError("Backup integrity_check failed: " + repr(checks[:3]))
        mismatch = dst.execute("PRAGMA foreign_key_check").fetchall()
        if mismatch:
            raise RuntimeError("Backup contains foreign-key violations; do not rehearse: " + repr(mismatch[:3]))
        dst.commit()
        dst.close()
        dst = None
        os.chmod(destination, 0o600)
        digest = hashlib.sha256()
        with destination.open("rb") as stream:
            for part in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(part)
        print("REHEARSAL_COPY_OK")
        print("Destination:", destination)
        print("Size bytes:", destination.stat().st_size)
        print("SHA256:", digest.hexdigest())
        print("The official source database was opened read-only.")
        return 0
    except Exception as exc:
        print("REHEARSAL_COPY_FAILED:", exc, file=sys.stderr)
        if dst is not None:
            dst.close()
            dst = None
        if destination.exists():
            destination.unlink()
        return 1
    finally:
        if src is not None:
            src.close()
        if dst is not None:
            dst.close()
        os.umask(old_mask)


if __name__ == "__main__":
    raise SystemExit(main())
