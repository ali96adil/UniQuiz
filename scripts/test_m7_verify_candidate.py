import sqlite3
import tempfile
from pathlib import Path
import unittest

from m7_reconcile_official import reconcile
from m7_verify_candidate import verify
from test_m7_reconcile_official import create_db

class CandidateIndependentVerificationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.official = root / "official.db"
        self.rehearsal = root / "rehearsal.db"
        candidate_dir = root / "candidate"
        candidate_dir.mkdir()
        self.candidate = candidate_dir / "candidate.db"
        create_db(self.official)
        create_db(self.rehearsal, is_rehearsal=True)
        reconcile(self.official, self.rehearsal, self.candidate)

    def tearDown(self):
        self.temp.cleanup()

    def test_valid_candidate_matches_both_immutable_sources(self):
        summary = verify(self.official, self.rehearsal, self.candidate)
        self.assertEqual(summary["workspaces"], 3)
        self.assertEqual(summary["imported_workspaces"], 2)
        self.assertEqual(summary["archives"], 1)

    def test_tampered_official_history_is_rejected(self):
        db = sqlite3.connect(self.candidate)
        db.execute("UPDATE colleges SET note=? WHERE id=1", (b"changed",))
        db.commit()
        db.close()
        with self.assertRaisesRegex(ValueError, "OFFICIAL_TABLE_CHANGED"):
            verify(self.official, self.rehearsal, self.candidate)

    def test_missing_archive_is_rejected(self):
        db = sqlite3.connect(self.candidate)
        db.execute("DELETE FROM competition_archives")
        db.commit()
        db.close()
        with self.assertRaisesRegex(ValueError, "ARCHIVED_HISTORY_CHANGED"):
            verify(self.official, self.rehearsal, self.candidate)

    def test_stale_active_rehearsal_snapshot_is_rejected(self):
        db = sqlite3.connect(self.candidate)
        db.execute("UPDATE competition_workspaces SET payload_json='{}' WHERE id='new-team'")
        db.commit()
        db.close()
        with self.assertRaisesRegex(ValueError, "WORKSPACE_SNAPSHOT_MISMATCH"):
            verify(self.official, self.rehearsal, self.candidate)

    def test_wrong_legacy_active_selection_is_rejected(self):
        db = sqlite3.connect(self.candidate)
        db.execute("UPDATE app_meta SET value='new-team' WHERE key='active_workspace_id'")
        db.commit()
        db.close()
        with self.assertRaisesRegex(ValueError, "OFFICIAL_TABLE_CHANGED"):
            verify(self.official, self.rehearsal, self.candidate)

if __name__ == "__main__":
    unittest.main()
