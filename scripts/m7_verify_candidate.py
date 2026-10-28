#!/usr/bin/env python3
"""Independent read-only check of an offline UniQuiz M7 staged candidate.

All three inputs must be v17 SQLite databases. The candidate must preserve
every original official table (other than workspace/archive additions) while
containing all rehearsal-only workspaces and archives, including an accurately
captured active rehearsal workspace. This command NEVER modifies inputs.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sqlite3
import sys

from m7_reconcile_official import (
    bank, check, connect_readonly, current_snapshot, table_fingerprint,
)

def rows(db: sqlite3.Connection, sql: str):
    return [tuple(r) for r in db.execute(sql).fetchall()]

def verify(official: Path, rehearsal: Path, candidate: Path) -> dict:
    paths = [path.expanduser().resolve() for path in
             (official, rehearsal, candidate)]
    if len(set(paths)) != 3:
        raise ValueError("VERIFICATION_INPUTS_MUST_BE_DISTINCT")
    original, staged = None, None
    original = connect_readonly(paths[0])
    review = connect_readonly(paths[1])
    result = connect_readonly(paths[2])
    snapshot = sqlite3.connect(":memory:")
    snapshot.row_factory = sqlite3.Row
    try:
        # The WAL-aware SQLite backup API reads the rehearsal atomically.
        # This in-memory snapshot is read-only at the application level.
        review.backup(snapshot)
        for name, db in (("OFFICIAL_MIGRATED", original),
                         ("REHEARSAL", snapshot), ("CANDIDATE", result)):
            check(db, name)
        for table in ("questions", "categories"):
            if bank(original, table) != bank(result, table) or \
               bank(snapshot, table) != bank(result, table):
                raise ValueError("BANK_MISMATCH: " + table)

        original_tables = [r[0] for r in original.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        )]
        result_tables = {r[0] for r in result.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        )}
        if set(original_tables) != result_tables:
            raise ValueError("CANDIDATE_TABLE_SET_MISMATCH")
        preserved = [t for t in original_tables
                     if t not in ("competition_workspaces", "competition_archives")]
        for table in preserved:
            if table_fingerprint(original, table) != \
               table_fingerprint(result, table):
                raise ValueError("OFFICIAL_TABLE_CHANGED: " + table)

        orig_ws = rows(original, "SELECT * FROM competition_workspaces ORDER BY id")
        if len(orig_ws) != 1 or orig_ws[0][0] != "legacy":
            raise ValueError("OFFICIAL_BASELINE_NOT_SINGLE_LEGACY")
        active = snapshot.execute(
            "SELECT value FROM app_meta WHERE key='active_workspace_id'"
        ).fetchone()
        if not active or active[0] == "legacy":
            raise ValueError("REHEARSAL_ACTIVE_WORKSPACE_UNEXPECTED")
        rehearsal_ws = snapshot.execute(
            "SELECT * FROM competition_workspaces ORDER BY id"
        ).fetchall()
        imported = {r["id"]: r for r in rehearsal_ws if r["id"] != "legacy"}
        candidate_ws = {r["id"]: r for r in result.execute(
            "SELECT * FROM competition_workspaces"
        ).fetchall()}
        if set(candidate_ws) != {"legacy", *imported}:
            raise ValueError("WORKSPACE_IDS_MISMATCH")
        if tuple(candidate_ws["legacy"]) != orig_ws[0]:
            raise ValueError("OFFICIAL_LEGACY_WORKSPACE_CHANGED")
        for name, row in imported.items():
            candidate_row = candidate_ws[name]
            for column in ("id", "name", "participant_type",
                           "created_at", "updated_at"):
                if candidate_row[column] != row[column]:
                    raise ValueError("WORKSPACE_METADATA_CHANGED: " + name)
            stored = json.loads(candidate_row["payload_json"])
            expected = (current_snapshot(snapshot)
                        if name == active[0]
                        else json.loads(row["payload_json"]))
            if stored != expected:
                raise ValueError("WORKSPACE_SNAPSHOT_MISMATCH: " + name)

        archived_sql = "SELECT * FROM competition_archives ORDER BY id"
        archives = rows(snapshot, archived_sql)
        if rows(result, archived_sql) != archives:
            raise ValueError("ARCHIVED_HISTORY_CHANGED")
        if rows(original, archived_sql):
            raise ValueError("UNEXPECTED_ARCHIVES_IN_OFFICIAL_BASELINE")
        if result.execute(
            "SELECT value FROM app_meta WHERE key='active_workspace_id'"
        ).fetchone()[0] != "legacy":
            raise ValueError("OFFICIAL_LEGACY_NOT_ACTIVE")
        return {
            "workspaces": len(candidate_ws),
            "imported_workspaces": len(imported),
            "archives": len(archives),
            "preserved_official_tables": len(preserved),
            "original_rounds": original.execute(
                "SELECT COUNT(*) FROM qualification_rounds").fetchone()[0],
            "candidate_rounds": result.execute(
                "SELECT COUNT(*) FROM qualification_rounds").fetchone()[0],
            "original_submissions": original.execute(
                "SELECT COUNT(*) FROM live_submissions").fetchone()[0],
            "candidate_submissions": result.execute(
                "SELECT COUNT(*) FROM live_submissions").fetchone()[0],
        }
    finally:
        original.close()
        review.close()
        result.close()
        snapshot.close()

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--official-migrated", required=True, type=Path)
    parser.add_argument("--m7-rehearsal", required=True, type=Path)
    parser.add_argument("--candidate", required=True, type=Path)
    args = parser.parse_args()
    try:
        summary = verify(args.official_migrated, args.m7_rehearsal,
                         args.candidate)
    except Exception as exc:
        print("M7_CANDIDATE_INDEPENDENT_CHECK_FAILED:", str(exc),
              file=sys.stderr)
        return 1
    print("M7_CANDIDATE_INDEPENDENT_CHECK_OK")
    for key, value in summary.items():
        print(f"{key}: {value}")
    print("All inputs opened read-only; no runtime or OSC started.")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
