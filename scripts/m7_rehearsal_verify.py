#!/usr/bin/env python3
"""Read-only M7 migration rehearsal audit for a WAL-consistent SQLite copy.

Run "capture" against the isolated rehearsal COPY before starting M7, then
"verify" against that SAME COPY immediately after M7's first startup. Only
the private baseline manifest is created; the database is opened read-only.

No plaintext questions, names, station tokens, or media are written to the
manifest. Each original row is represented only by a SHA-256 fingerprint.
"""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import sys
from typing import Any

FORMAT_VERSION = 1
# Version metadata and OSC diagnostics legitimately change during startup.
# Every other preexisting table, including future or unknown event tables,
# must remain present and contain all its prior records.
STARTUP_MUTABLE_TABLES = frozenset({"app_meta", "operations_state"})
# Newer runtimes may backfill reservations or mint initially missing station
# tokens. Existing records and bearer tokens must still be preserved.
APPEND_ONLY_MIGRATION_TABLES = frozenset({
    "qualification_question_reservations", "station_credentials",
})
REQUIRED_LEGACY_TABLES = frozenset({
    "colleges", "questions", "qualification_rounds", "live_submissions",
})


def quote(identifier: str) -> str:
    return '"' + identifier.replace('"', '""') + '"'


def open_read_only(path: Path) -> sqlite3.Connection:
    if not path.is_file() or path.stat().st_size == 0:
        raise ValueError("Database is missing or empty")
    connection = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=30)
    connection.execute("PRAGMA query_only = ON")
    return connection


def check_database(db: sqlite3.Connection) -> None:
    integrity = db.execute("PRAGMA integrity_check").fetchall()
    if integrity != [("ok",)]:
        raise ValueError("SQLITE_INTEGRITY_FAILED")
    foreign_keys = db.execute("PRAGMA foreign_key_check").fetchall()
    if foreign_keys:
        raise ValueError("SQLITE_FOREIGN_KEYS_FAILED")


def existing_tables(db: sqlite3.Connection) -> set[str]:
    return {
        str(row[0])
        for row in db.execute(
            "SELECT name FROM sqlite_master WHERE type='table' "
            "AND name NOT LIKE 'sqlite_%'"
        )
    }


def fingerprint_row(row: tuple[Any, ...]) -> str:
    typed: list[list[Any]] = []
    for value in row:
        if value is None:
            typed.append(["null"])
        elif isinstance(value, bytes):
            typed.append(["blob", len(value), hashlib.sha256(value).hexdigest()])
        elif isinstance(value, int):
            typed.append(["integer", str(value)])
        elif isinstance(value, float):
            typed.append(["real", value.hex()])
        elif isinstance(value, str):
            typed.append(["text", value])
        else:
            raise ValueError("UNEXPECTED_SQLITE_VALUE_TYPE")
    canonical = json.dumps(
        typed, ensure_ascii=False, separators=(",", ":"), allow_nan=False,
    ).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def table_fingerprint(
    db: sqlite3.Connection, name: str, columns: list[str],
    keep_rows: bool = False,
) -> dict[str, Any]:
    select = ", ".join(quote(column) for column in columns)
    digest_rows = sorted(
        fingerprint_row(tuple(row))
        for row in db.execute(f"SELECT {select} FROM {quote(name)}")
    )
    combined = hashlib.sha256()
    for row_hash in digest_rows:
        combined.update(bytes.fromhex(row_hash))
    result: dict[str, Any] = {
        "columns": columns,
        "rowCount": len(digest_rows),
        "sha256": combined.hexdigest(),
    }
    if keep_rows:
        result["rowHashes"] = digest_rows
    return result


def capture(db: sqlite3.Connection) -> dict[str, Any]:
    tables = existing_tables(db)
    missing = REQUIRED_LEGACY_TABLES - tables
    if missing:
        raise ValueError("NOT_A_UNIQUIZ_DATABASE: missing " + ", ".join(sorted(missing)))
    protected: dict[str, Any] = {}
    for name in sorted(tables - STARTUP_MUTABLE_TABLES):
        columns = [str(row[1]) for row in db.execute(
            f"PRAGMA table_info({quote(name)})"
        )]
        if not columns:
            raise ValueError("TABLE_WITHOUT_COLUMNS: " + name)
        item = table_fingerprint(
            db, name, columns,
            keep_rows=(name in APPEND_ONLY_MIGRATION_TABLES),
        )
        # Previously empty tables may be initialized with default rows by
        # schema upgrades; there are no old rows to lose in that case.
        if item["rowCount"] == 0:
            item["rowHashes"] = []
        protected[name] = item
    return {
        "formatVersion": FORMAT_VERSION,
        "capturedAtUtc": datetime.now(timezone.utc).isoformat(),
        "protectedTables": protected,
    }


def verify(db: sqlite3.Connection, manifest: dict[str, Any]) -> tuple[list[str], list[str]]:
    if manifest.get("formatVersion") != FORMAT_VERSION:
        raise ValueError("UNSUPPORTED_BASELINE_FORMAT")
    protected = manifest.get("protectedTables")
    if not isinstance(protected, dict) or not protected:
        raise ValueError("INVALID_BASELINE_MANIFEST")
    current_tables = existing_tables(db)
    errors: list[str] = []
    notes: list[str] = []
    for name, initial in sorted(protected.items()):
        if name not in current_tables:
            errors.append(f"MISSING_TABLE: {name}")
            continue
        old_columns = initial.get("columns")
        if not isinstance(old_columns, list) or not old_columns:
            errors.append(f"INVALID_BASELINE_COLUMNS: {name}")
            continue
        current_columns = {
            str(row[1]) for row in db.execute(f"PRAGMA table_info({quote(name)})")
        }
        if not set(old_columns).issubset(current_columns):
            errors.append(f"REMOVED_OR_RENAMED_COLUMNS: {name}")
            continue
        is_append = "rowHashes" in initial
        current = table_fingerprint(db, name, old_columns, keep_rows=is_append)
        if is_append:
            before = Counter(initial["rowHashes"])
            after = Counter(current["rowHashes"])
            missing_rows = before - after
            if missing_rows:
                errors.append(f"LOST_OR_MODIFIED_ROWS: {name} ({sum(missing_rows.values())})")
            else:
                added = current["rowCount"] - initial["rowCount"]
                if added:
                    notes.append(f"APPENDED_MIGRATION_ROWS: {name} (+{added})")
        elif (initial.get("rowCount"), initial.get("sha256")) != (
            current["rowCount"], current["sha256"],
        ):
            errors.append(f"DATA_CHANGED: {name} (expected {initial.get('rowCount')} rows, "
                          f"found {current['rowCount']})")

    # A fully started M7 runtime must have schema metadata and the preserved
    # legacy workspace. This check must never initialize those tables itself.
    if {"app_meta", "competition_workspaces"}.issubset(current_tables):
        version = db.execute(
            "SELECT value FROM app_meta WHERE key='schema_version'"
        ).fetchone()
        active = db.execute(
            "SELECT value FROM app_meta WHERE key='active_workspace_id'"
        ).fetchone()
        workspace = db.execute(
            "SELECT 1 FROM competition_workspaces WHERE id='legacy'"
        ).fetchone()
        if not version or not version[0].isdigit() or int(version[0]) < 16:
            errors.append("M7_SCHEMA_VERSION_NOT_INSTALLED")
        if not active or not workspace:
            errors.append("LEGACY_WORKSPACE_NOT_INITIALIZED")
    else:
        errors.append("M7_METADATA_NOT_INSTALLED")
    return errors, notes


def write_manifest_exclusive(path: Path, manifest: dict[str, Any]) -> None:
    payload = (json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2)
               + "\n").encode("utf-8")
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
    except BaseException:
        path.unlink(missing_ok=True)
        raise


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("capture", "verify"))
    parser.add_argument("--database", required=True, type=Path)
    parser.add_argument("--manifest", required=True, type=Path)
    args = parser.parse_args()

    database_path = args.database.expanduser().resolve()
    manifest_path = args.manifest.expanduser().resolve()
    if database_path == manifest_path:
        parser.error("The baseline manifest must not overwrite the database")
    if args.command == "capture" and manifest_path.exists():
        parser.error("Baseline manifest exists; refusing to overwrite it")
    if not manifest_path.parent.is_dir():
        parser.error("Create the private manifest directory first")

    try:
        with open_read_only(database_path) as db:
            db.execute("BEGIN")
            check_database(db)
            if args.command == "capture":
                baseline = capture(db)
                write_manifest_exclusive(manifest_path, baseline)
                print("M7_BASELINE_CAPTURE_OK")
                print("Protected tables:", len(baseline["protectedTables"]))
                print("Manifest (private):", manifest_path)
            else:
                with manifest_path.open("r", encoding="utf-8") as file:
                    baseline = json.load(file)
                errors, notes = verify(db, baseline)
                for note in notes:
                    print(note)
                if errors:
                    for error in errors:
                        print(error, file=sys.stderr)
                    print("M7_REHEARSAL_VERIFY_FAILED", file=sys.stderr)
                    return 1
                print("M7_REHEARSAL_VERIFY_OK")
                print("Preserved original tables:", len(baseline["protectedTables"]))
            db.execute("ROLLBACK")
        return 0
    except (OSError, sqlite3.Error, ValueError, TypeError, KeyError) as error:
        print("M7_REHEARSAL_AUDIT_FAILED:", error, file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
