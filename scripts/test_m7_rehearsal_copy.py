"""Standard-library tests for the read-only rehearsal copier (CI and Mac)."""
from __future__ import annotations

import pathlib
import sqlite3
import subprocess
import sys
import tempfile
import unittest


SCRIPT = pathlib.Path(__file__).with_name("m7_rehearsal_copy.py")


class RehearsalCopyTests(unittest.TestCase):
    def test_includes_live_wal_and_never_overwrites_destination(self) -> None:
        with tempfile.TemporaryDirectory(prefix="uniquiz-m7-copy-test-") as root:
            source = pathlib.Path(root) / "official.sqlite3"
            destination = pathlib.Path(root) / "rehearsal.sqlite3"
            live = sqlite3.connect(source)
            try:
                live.execute("PRAGMA journal_mode=WAL")
                live.execute("CREATE TABLE original_scores (id INTEGER PRIMARY KEY, points INTEGER)")
                live.execute("INSERT INTO original_scores (points) VALUES (245)")
                live.commit()

                copy = subprocess.run([
                    sys.executable, str(SCRIPT),
                    "--source", str(source),
                    "--destination", str(destination),
                ], capture_output=True, text=True, check=False)
                self.assertEqual(copy.returncode, 0, copy.stderr)
                self.assertIn("REHEARSAL_COPY_OK", copy.stdout)
                with sqlite3.connect(destination) as saved:
                    self.assertEqual(saved.execute(
                        "SELECT points FROM original_scores"
                    ).fetchone(), (245,))
                    self.assertEqual(
                        saved.execute("PRAGMA integrity_check").fetchall(),
                        [("ok",)],
                    )

                # Newer official changes must not be mixed into the copied
                # rehearsal database, and a rerun must refuse overwriting.
                live.execute("INSERT INTO original_scores(points) VALUES(300)")
                live.commit()
                again = subprocess.run([
                    sys.executable, str(SCRIPT),
                    "--source", str(source),
                    "--destination", str(destination),
                ], capture_output=True, text=True, check=False)
                self.assertNotEqual(again.returncode, 0)
                with sqlite3.connect(destination) as saved:
                    self.assertEqual(saved.execute(
                        "SELECT COUNT(*) FROM original_scores"
                    ).fetchone(), (1,))
            finally:
                live.close()

    def test_refuses_copying_database_onto_itself(self) -> None:
        with tempfile.TemporaryDirectory(prefix="uniquiz-m7-selfcopy-") as root:
            source = pathlib.Path(root) / "source.sqlite3"
            with sqlite3.connect(source) as db:
                db.execute("CREATE TABLE test(id INTEGER PRIMARY KEY)")
            rejected = subprocess.run([
                sys.executable, str(SCRIPT),
                "--source", str(source),
                "--destination", str(source),
            ], capture_output=True, text=True, check=False)
            self.assertNotEqual(rejected.returncode, 0)
            with sqlite3.connect(source) as db:
                self.assertIsNotNone(db.execute(
                    "SELECT 1 FROM sqlite_master WHERE name='test'"
                ).fetchone())


if __name__ == "__main__":
    unittest.main()
