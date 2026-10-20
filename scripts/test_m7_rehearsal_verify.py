"""Regression tests for read-only M7 historical-row migration verification."""
from __future__ import annotations

import hashlib
import json
import pathlib
import sqlite3
import subprocess
import sys
import tempfile
import unittest

SCRIPT = pathlib.Path(__file__).with_name("m7_rehearsal_verify.py")


def execute(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        check=False, capture_output=True, text=True,
    )


def old_fixture(path: pathlib.Path) -> sqlite3.Connection:
    db = sqlite3.connect(path)
    db.execute("PRAGMA journal_mode = WAL")
    db.executescript("""
        CREATE TABLE colleges(
            id INTEGER PRIMARY KEY, name TEXT UNIQUE, sort_order INTEGER);
        CREATE TABLE questions(
            id INTEGER PRIMARY KEY, category_id INTEGER, prompt TEXT,
            correct_option TEXT);
        CREATE TABLE qualification_rounds(
            id INTEGER PRIMARY KEY, round_order INTEGER,
            college_a_id INTEGER, status TEXT);
        CREATE TABLE live_submissions(
            round_id INTEGER, station TEXT, question_position INTEGER,
            score_micros INTEGER, response_time_ms INTEGER);
        CREATE TABLE audit_events(
            id INTEGER PRIMARY KEY, event_type TEXT, payload_json TEXT);
        CREATE TABLE audience_assets(
            slot TEXT PRIMARY KEY, mime_type TEXT, bytes BLOB);
        CREATE TABLE qualification_question_reservations(
            question_id INTEGER, position INTEGER, disposition TEXT);
        CREATE TABLE station_credentials(
            station TEXT PRIMARY KEY, access_token TEXT);
        CREATE TABLE custom_historical_festival(
            name TEXT, completed INTEGER);
        CREATE TABLE app_meta(key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE operations_state(id INTEGER PRIMARY KEY, updated_at TEXT);
        INSERT INTO app_meta VALUES('schema_version','15');
        INSERT INTO colleges VALUES(1,'كلية التربية',1);
        INSERT INTO qualification_rounds VALUES(1,1,1,'COMPLETED');
        INSERT INTO questions VALUES(9,4,'ما عاصمة العراق؟','B');
        INSERT INTO live_submissions VALUES(1,'A',1,24000000,925);
        INSERT INTO audit_events VALUES(1,'QUESTION_REVEALED','{"round":1}');
        INSERT INTO audience_assets VALUES('university','image/png',X'89504E470000FF');
        INSERT INTO qualification_question_reservations VALUES(9,1,'ALLOCATED');
        INSERT INTO station_credentials VALUES('A','long-private-old-station-token');
        INSERT INTO custom_historical_festival VALUES('مهرجان بابل',1);
        INSERT INTO operations_state VALUES(1,'old-timestamp');
    """)
    db.commit()
    return db


def migrate_fixture(db: sqlite3.Connection) -> None:
    db.executescript("""
        ALTER TABLE questions ADD COLUMN display_name TEXT;
        CREATE TABLE competition_workspaces(
            id TEXT PRIMARY KEY, name TEXT, payload_json TEXT);
        INSERT INTO competition_workspaces VALUES('legacy','Historical','{}');
        UPDATE app_meta SET value='16' WHERE key='schema_version';
        INSERT INTO app_meta VALUES('active_workspace_id','legacy');
        UPDATE operations_state SET updated_at='fresh-boot-time';
        INSERT INTO qualification_question_reservations
            VALUES(10,2,'ALLOCATED');
        INSERT INTO station_credentials VALUES('B','other-boot-station-token');
    """)
    db.commit()


class HistoricalMigrationAuditTests(unittest.TestCase):
    def test_read_only_baseline_survives_wal_and_safe_m7_schema_additions(self) -> None:
        with tempfile.TemporaryDirectory(prefix="uniquiz-m7-verify-good-") as root:
            database = pathlib.Path(root) / "private-rehearsal.db"
            manifest = pathlib.Path(root) / "baseline.json"
            db = old_fixture(database)
            try:
                before = hashlib.sha256(database.read_bytes()).hexdigest()
                baseline = execute("capture", "--database", str(database),
                                   "--manifest", str(manifest))
                self.assertEqual(baseline.returncode, 0, baseline.stderr)
                self.assertIn("M7_BASELINE_CAPTURE_OK", baseline.stdout)
                self.assertEqual(
                    hashlib.sha256(database.read_bytes()).hexdigest(), before,
                    "read-only capture must never mutate the original DB file",
                )
                saved = json.loads(manifest.read_text())
                self.assertGreaterEqual(len(saved["protectedTables"]), 9)
                self.assertEqual(saved["protectedTables"]["live_submissions"]["rowCount"], 1)
                self.assertNotIn("كلية التربية", manifest.read_text())
                self.assertNotIn("مهرجان بابل", manifest.read_text())
                self.assertNotIn("long-private-old-station-token", manifest.read_text())

                migrate_fixture(db)
                result = execute("verify", "--database", str(database),
                                 "--manifest", str(manifest))
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("M7_REHEARSAL_VERIFY_OK", result.stdout)
                self.assertIn("APPENDED_MIGRATION_ROWS: station_credentials (+1)", result.stdout)
                self.assertIn(
                    "APPENDED_MIGRATION_ROWS: qualification_question_reservations (+1)",
                    result.stdout,
                )
                self.assertEqual(
                    db.execute("SELECT score_micros FROM live_submissions").fetchone()[0],
                    24000000,
                )
            finally:
                db.close()

    def test_score_media_and_unknown_table_changes_fail_closed(self) -> None:
        for kind in ("score", "blob", "custom"):
            with self.subTest(kind=kind):
                with tempfile.TemporaryDirectory(prefix="uniquiz-m7-tamper-") as root:
                    dbpath = pathlib.Path(root) / "rehearsal.db"
                    baseline_path = pathlib.Path(root) / "baseline.json"
                    db = old_fixture(dbpath)
                    try:
                        self.assertEqual(execute(
                            "capture", "--database", str(dbpath),
                            "--manifest", str(baseline_path),
                        ).returncode, 0)
                        migrate_fixture(db)
                        if kind == "score":
                            db.execute("UPDATE live_submissions SET score_micros=0")
                            expected = "live_submissions"
                        elif kind == "blob":
                            db.execute(
                                "UPDATE audience_assets SET bytes=?",
                                (b"modified-image",),
                            )
                            expected = "audience_assets"
                        else:
                            db.execute("DELETE FROM custom_historical_festival")
                            expected = "custom_historical_festival"
                        db.commit()
                        verified = execute(
                            "verify", "--database", str(dbpath),
                            "--manifest", str(baseline_path),
                        )
                        self.assertNotEqual(verified.returncode, 0)
                        self.assertIn(expected, verified.stderr)
                        self.assertIn("M7_REHEARSAL_VERIFY_FAILED", verified.stderr)
                    finally:
                        db.close()

    def test_missing_legacy_table_or_column_fails(self) -> None:
        with tempfile.TemporaryDirectory(prefix="uniquiz-m7-columns-") as root:
            dbpath = pathlib.Path(root) / "rehearsal.db"
            baseline_path = pathlib.Path(root) / "baseline.json"
            db = old_fixture(dbpath)
            try:
                self.assertEqual(execute(
                    "capture", "--database", str(dbpath),
                    "--manifest", str(baseline_path),
                ).returncode, 0)
                migrate_fixture(db)
                db.execute("ALTER TABLE questions DROP COLUMN prompt")
                db.execute("DROP TABLE custom_historical_festival")
                db.commit()
                verified = execute(
                    "verify", "--database", str(dbpath),
                    "--manifest", str(baseline_path),
                )
                self.assertNotEqual(verified.returncode, 0)
                self.assertIn("REMOVED_OR_RENAMED_COLUMNS: questions", verified.stderr)
                self.assertIn("MISSING_TABLE: custom_historical_festival", verified.stderr)
            finally:
                db.close()

    def test_missing_m7_metadata_and_reused_baseline_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory(prefix="uniquiz-m7-nooverwrite-") as root:
            dbpath = pathlib.Path(root) / "rehearsal.db"
            baseline_path = pathlib.Path(root) / "baseline.json"
            db = old_fixture(dbpath)
            try:
                first = execute("capture", "--database", str(dbpath),
                                "--manifest", str(baseline_path))
                self.assertEqual(first.returncode, 0, first.stderr)
                saved_hash = hashlib.sha256(baseline_path.read_bytes()).hexdigest()
                second = execute("capture", "--database", str(dbpath),
                                 "--manifest", str(baseline_path))
                self.assertNotEqual(second.returncode, 0)
                self.assertEqual(
                    hashlib.sha256(baseline_path.read_bytes()).hexdigest(), saved_hash,
                )
                bad_verify = execute("verify", "--database", str(dbpath),
                                     "--manifest", str(baseline_path))
                self.assertNotEqual(bad_verify.returncode, 0)
                self.assertIn("M7_METADATA_NOT_INSTALLED", bad_verify.stderr)
                self.assertNotEqual(execute(
                    "capture", "--database", str(dbpath),
                    "--manifest", str(dbpath),
                ).returncode, 0)
            finally:
                db.close()

    def test_non_uniquiz_database_is_not_accepted(self) -> None:
        with tempfile.TemporaryDirectory(prefix="uniquiz-m7-notdb-") as root:
            dbpath = pathlib.Path(root) / "other.db"
            manifest = pathlib.Path(root) / "baseline.json"
            with sqlite3.connect(dbpath) as db:
                db.execute("CREATE TABLE notes(message TEXT)")
                db.execute("INSERT INTO notes VALUES ('not a competition')")
            result = execute("capture", "--database", str(dbpath),
                             "--manifest", str(manifest))
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("NOT_A_UNIQUIZ_DATABASE", result.stderr)
            self.assertFalse(manifest.exists())


if __name__ == "__main__":
    unittest.main()
