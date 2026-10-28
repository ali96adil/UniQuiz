#!/usr/bin/env python3
"""Prepare a NEW M7 database by adding rehearsal-only workspaces and archives.

Both input SQLite databases are opened read-only; WAL is included through the
SQLite backup API. Never invoke on the original M6 database: use the VERIFIED,
already-migrated v17 offline audit database as --official-migrated.
The output remains OFFLINE and keeps the official legacy workspace active.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import sys

EVENT_TABLES = (
    "colleges", "participants", "qualification_rounds",
    "qualification_round_rules", "qualification_round_question_sets",
    "qualification_round_questions", "qualification_question_reservations",
    "audit_events", "live_submissions", "competition_state",
    "competition_rules", "competition_gameplay_rules", "live_state",
    "audience_settings", "audience_copy", "audience_assets",
    "audience_presentation",
)

def connect_readonly(path: Path) -> sqlite3.Connection:
    if not path.is_file() or path.stat().st_size == 0:
        raise ValueError("INPUT_NOT_A_NONEMPTY_SQLITE_FILE")
    db = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=30)
    db.row_factory = sqlite3.Row
    return db

def check(db: sqlite3.Connection, name: str) -> None:
    if db.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
        raise ValueError(name + "_SQLITE_INTEGRITY_FAILED")
    if db.execute("PRAGMA foreign_key_check").fetchall():
        raise ValueError(name + "_FOREIGN_KEY_VIOLATIONS")
    row = db.execute(
        "SELECT value FROM app_meta WHERE key='schema_version'"
    ).fetchone()
    if row is None or str(row[0]) != "17":
        raise ValueError(name + "_REQUIRES_VERIFIED_SCHEMA_17")

def bank(db: sqlite3.Connection, table: str) -> list[tuple]:
    # Includes row IDs, category IDs, display names, timestamps and all
    # attributes: an equal question count is NOT sufficient for safe transfer.
    return [tuple(row) for row in db.execute(
        "SELECT * FROM " + table + " ORDER BY id"
    )]

def encode(value):
    if isinstance(value, bytes):
        import base64
        return {"__blob": base64.b64encode(value).decode("ascii")}
    return value

def current_snapshot(db: sqlite3.Connection) -> dict:
    return {
        table: [
            {key: encode(row[key]) for key in row.keys()}
            for row in db.execute("SELECT * FROM " + table)
        ]
        for table in EVENT_TABLES
    }

def validate_snapshot(payload: str, question_ids: set[int], label: str) -> None:
    data = json.loads(payload)
    if not isinstance(data, dict) or any(
        not isinstance(data.get(table), list) for table in EVENT_TABLES
    ):
        raise ValueError("INVALID_WORKSPACE_SNAPSHOT: " + label)
    active_rounds = [
        row for row in data["qualification_rounds"]
        if isinstance(row, dict) and row.get("status") == "ACTIVE"
    ]
    if active_rounds:
        raise ValueError("UNFINISHED_ROUND_IN_WORKSPACE: " + label)
    for table in (
        "qualification_round_questions", "qualification_question_reservations",
        "live_submissions",
    ):
        for row in data[table]:
            if not isinstance(row, dict):
                raise ValueError("INVALID_WORKSPACE_ROW: " + label)
            qid = row.get("question_id")
            if qid is not None and qid not in question_ids:
                raise ValueError("MISSING_SHARED_QUESTION_FOR_WORKSPACE: " + label)

def table_fingerprint(db: sqlite3.Connection, table: str) -> str:
    h = hashlib.sha256()
    # ORDER BY rowid is valid for legacy tables in current schema.
    for row in db.execute("SELECT * FROM " + table + " ORDER BY rowid"):
        data = [encode(item) for item in tuple(row)]
        h.update(json.dumps(data, sort_keys=True, ensure_ascii=False,
                            separators=(",", ":")).encode())
        h.update(b"\n")
    return h.hexdigest()

def verify_archive(row: sqlite3.Row) -> None:
    doc = json.loads(row["payload_json"])
    if not isinstance(doc, dict):
        raise ValueError("ARCHIVE_PAYLOAD_INVALID")
    entries = doc.get("snapshot", {}).get("ranking", {}).get("entries")
    if not isinstance(entries, list):
        raise ValueError("ARCHIVE_RANKING_MISSING")
    if len(entries) != row["participant_count"]:
        raise ValueError("ARCHIVE_RANKING_COUNT_MISMATCH")

def reconcile(official: Path, rehearsal: Path, destination: Path) -> dict:
    official, rehearsal, destination = (
        official.expanduser().resolve(), rehearsal.expanduser().resolve(),
        destination.expanduser().resolve()
    )
    if len({official, rehearsal, destination}) != 3:
        raise ValueError("SOURCE_AND_DESTINATION_MUST_DIFFER")
    if destination.exists():
        raise ValueError("DESTINATION_ALREADY_EXISTS")
    if not destination.parent.is_dir():
        raise ValueError("DESTINATION_DIRECTORY_NOT_FOUND")
    if destination.parent in (official.parent, rehearsal.parent):
        raise ValueError("OUTPUT_MUST_BE_IN_SEPARATE_DIRECTORY")

    source = connect_readonly(official)
    review = connect_readonly(rehearsal)
    # Capture WAL-consistent rehearsal state in memory in a single snapshot.
    stable = sqlite3.connect(":memory:")
    stable.row_factory = sqlite3.Row
    output = None
    try:
        check(source, "OFFICIAL_MIGRATED")
        review.backup(stable)
        check(stable, "M7_REHEARSAL")
        for table in ("categories", "questions"):
            if bank(source, table) != bank(stable, table):
                raise ValueError("SHARED_" + table.upper() + "_DIFFER: STOP")
        question_ids = {
            int(row[0]) for row in source.execute("SELECT id FROM questions")
        }
        active_official = source.execute(
            "SELECT value FROM app_meta WHERE key='active_workspace_id'"
        ).fetchone()
        if not active_official or active_official[0] != "legacy":
            raise ValueError("OFFICIAL_MIGRATED_LEGACY_MUST_BE_ACTIVE")
        official_ws = source.execute(
            "SELECT id FROM competition_workspaces"
        ).fetchall()
        if [row[0] for row in official_ws] != ["legacy"]:
            raise ValueError("OFFICIAL_MIGRATED_NOT_CLEAN_SINGLE_LEGACY")
        if source.execute("SELECT COUNT(*) FROM competition_archives").fetchone()[0]:
            raise ValueError("OFFICIAL_MIGRATED_ALREADY_HAS_ARCHIVES")

        rehearsal_active = stable.execute(
            "SELECT value FROM app_meta WHERE key='active_workspace_id'"
        ).fetchone()
        if not rehearsal_active:
            raise ValueError("REHEARSAL_ACTIVE_WORKSPACE_MISSING")
        active_id = rehearsal_active[0]
        workspaces = stable.execute(
            "SELECT * FROM competition_workspaces ORDER BY created_at,id"
        ).fetchall()
        if not any(row["id"] == "legacy" for row in workspaces):
            raise ValueError("REHEARSAL_LEGACY_MISSING")
        if not any(row["id"] == active_id for row in workspaces):
            raise ValueError("REHEARSAL_ACTIVE_WORKSPACE_INVALID")
        if active_id == "legacy":
            raise ValueError("REHEARSAL_LEGACY_ACTIVE: NO_TRANSFER_NEEDED")
        phase = stable.execute("SELECT phase FROM live_state WHERE id=1").fetchone()
        if not phase or phase[0] not in ("IDLE", "ROUND_COMPLETE"):
            raise ValueError("REHEARSAL_HAS_UNFINISHED_LIVE_SESSION")
        if stable.execute(
            "SELECT COUNT(*) FROM qualification_rounds WHERE status='ACTIVE'"
        ).fetchone()[0]:
            raise ValueError("REHEARSAL_HAS_ACTIVE_ROUNDS")
        current = json.dumps(current_snapshot(stable), ensure_ascii=False,
                             separators=(",", ":"))
        archives = stable.execute(
            "SELECT * FROM competition_archives ORDER BY archived_at,id"
        ).fetchall()
        for row in archives:
            verify_archive(row)
        transfer = []
        for row in workspaces:
            if row["id"] == "legacy":
                continue
            payload = current if row["id"] == active_id else row["payload_json"]
            if not isinstance(payload, str):
                raise ValueError("WORKSPACE_PAYLOAD_MISSING")
            validate_snapshot(payload, question_ids, row["id"])
            transfer.append((
                row["id"], row["name"], row["participant_type"],
                payload, row["created_at"], row["updated_at"],
            ))

        output = sqlite3.connect(str(destination))
        output.row_factory = sqlite3.Row
        source.backup(output)
        check(output, "STAGED_BEFORE_TRANSFER")
        # Record the entire official legacy runtime, scoring, bank, and tokens.
        preserve = [r[0] for r in output.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        ) if r[0] not in ("competition_workspaces", "competition_archives")]
        before = {t: table_fingerprint(output, t) for t in preserve}
        output.execute("PRAGMA foreign_keys=ON")
        with output:
            output.executemany("""
              INSERT INTO competition_workspaces
              (id,name,participant_type,payload_json,created_at,updated_at)
              VALUES (?,?,?,?,?,?)
            """, transfer)
            output.executemany("""
              INSERT INTO competition_archives
              (id,title,archived_at,participant_count,round_count,
               question_count,payload_json)
              VALUES (?,?,?,?,?,?,?)
            """, [tuple(row) for row in archives])
        check(output, "STAGED_AFTER_TRANSFER")
        after = {t: table_fingerprint(output, t) for t in preserve}
        if before != after:
            raise ValueError("OFFICIAL_HISTORY_CHANGED_AFTER_TRANSFER")
        if output.execute(
            "SELECT value FROM app_meta WHERE key='active_workspace_id'"
        ).fetchone()[0] != "legacy":
            raise ValueError("OFFICIAL_ACTIVE_LEGACY_CHANGED")
        if output.execute(
            "SELECT COUNT(*) FROM competition_workspaces"
        ).fetchone()[0] != 1 + len(transfer):
            raise ValueError("WORKSPACE_COUNT_MISMATCH")
        if output.execute(
            "SELECT COUNT(*) FROM competition_archives"
        ).fetchone()[0] != len(archives):
            raise ValueError("ARCHIVE_COUNT_MISMATCH")
        result = {"status": "M7_RECONCILIATION_OK",
                  "legacy_workspace_active": True,
                  "imported_workspaces": len(transfer),
                  "imported_archives": len(archives),
                  "preserved_official_tables": len(before),
                  "captured_active_rehearsal": active_id,
                  "output": str(destination)}
        output.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        output.close()
        output = None
        os.chmod(destination, 0o600)
        return result
    except Exception:
        if output is not None:
            output.close()
        if destination.exists():
            destination.unlink()
        for suffix in ("-wal", "-shm"):
            p = Path(str(destination) + suffix)
            if p.exists():
                p.unlink()
        raise
    finally:
        source.close()
        review.close()
        stable.close()

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--official-migrated", type=Path, required=True)
    parser.add_argument("--m7-rehearsal", type=Path, required=True)
    parser.add_argument("--destination", type=Path, required=True)
    args = parser.parse_args()
    try:
        result = reconcile(args.official_migrated, args.m7_rehearsal,
                           args.destination)
    except Exception as exc:
        print("M7_RECONCILIATION_FAILED:", str(exc), file=sys.stderr)
        return 1
    print("M7_RECONCILIATION_OK")
    print("Imported rehearsal workspaces:", result["imported_workspaces"])
    print("Imported historical archives:", result["imported_archives"])
    print("Official legacy preserved and active:", result["legacy_workspace_active"])
    print("Source files were opened read-only; neither was overwritten.")
    print("STAGED_OFFLINE_DATABASE:", result["output"])
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
