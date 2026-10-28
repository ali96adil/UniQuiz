import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

from m7_reconcile_official import EVENT_TABLES, reconcile

def create_db(path, is_rehearsal=False, changed_bank=False):
    db = sqlite3.connect(path)
    db.executescript("""
      CREATE TABLE app_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      INSERT INTO app_meta VALUES('schema_version','17'),('active_workspace_id','legacy');
      CREATE TABLE categories(id INTEGER PRIMARY KEY,category_key TEXT,name TEXT);
      INSERT INTO categories VALUES(1,'sports','رياضة');
      CREATE TABLE questions(id INTEGER PRIMARY KEY,category_id INTEGER,prompt TEXT);
      INSERT INTO questions VALUES(10,1,'السؤال القديم');
      CREATE TABLE competition_workspaces(
        id TEXT PRIMARY KEY,name TEXT,participant_type TEXT,
        payload_json TEXT,created_at TEXT,updated_at TEXT
      );
      INSERT INTO competition_workspaces VALUES
        ('legacy','مسابقة بنك المعلومات','college',NULL,'2026','2026');
      CREATE TABLE competition_archives(id TEXT PRIMARY KEY,title TEXT,
        archived_at TEXT,participant_count INTEGER,round_count INTEGER,
        question_count INTEGER,payload_json TEXT);
    """)
    for table in EVENT_TABLES:
        if table == "live_state":
            db.execute("CREATE TABLE live_state(id INTEGER PRIMARY KEY,phase TEXT)")
            db.execute("INSERT INTO live_state VALUES(1,'IDLE')")
        elif table == "qualification_rounds":
            db.execute("CREATE TABLE qualification_rounds(id INTEGER PRIMARY KEY,status TEXT)")
        else:
            db.execute(f"CREATE TABLE {table}(id INTEGER PRIMARY KEY, note BLOB)")
    db.execute("INSERT INTO colleges VALUES(1,?)",(b"historical 2026",))
    if is_rehearsal:
        db.execute("UPDATE app_meta SET value='new-team' WHERE key='active_workspace_id'")
        db.execute("DELETE FROM colleges")
        db.execute("INSERT INTO colleges VALUES(2,?)",(b"new tournament",))
        stale = {t: [] for t in EVENT_TABLES}
        stale["colleges"] = [{"id": 99, "note": "STALE"}]
        db.execute("INSERT INTO competition_workspaces VALUES(?,?,?,?,?,?)",(
            "new-team","٤٤","team",json.dumps(stale),"2026","2026"))
        db.execute("INSERT INTO competition_workspaces VALUES(?,?,?,?,?,?)",(
            "another","رياضة","department",json.dumps(stale),"2026","2026"))
        data={"snapshot":{"ranking":{"entries":[{"rank":1}]}}}
        db.execute("INSERT INTO competition_archives VALUES(?,?,?,?,?,?,?)",(
            "archive-2026","بنك المعلومات ٢٠٢٦","2026",1,1,1,json.dumps(data)))
    if changed_bank:
        db.execute("UPDATE questions SET prompt='CHANGED'")
    db.commit()
    db.close()

class ReconcileTests(unittest.TestCase):
    def test_preserve_legacy_and_capture_active_materialized_state(self):
        with tempfile.TemporaryDirectory() as p:
            root=Path(p)
            a,b=root/"official.db",root/"rehearsal.db"
            out_dir=root/"new"
            out_dir.mkdir()
            out=out_dir/"candidate.db"
            create_db(a)
            create_db(b,True)
            result=reconcile(a,b,out)
            self.assertEqual(result["imported_workspaces"],2)
            self.assertEqual(result["imported_archives"],1)
            db=sqlite3.connect(out)
            self.assertEqual(db.execute("PRAGMA integrity_check").fetchone()[0],"ok")
            self.assertEqual(db.execute("SELECT value FROM app_meta WHERE key='active_workspace_id'").fetchone()[0],"legacy")
            self.assertEqual(db.execute("SELECT note FROM colleges").fetchone()[0],b"historical 2026")
            payload=json.loads(db.execute("SELECT payload_json FROM competition_workspaces WHERE id='new-team'").fetchone()[0])
            self.assertEqual(payload["colleges"][0]["id"],2)
            self.assertEqual(payload["colleges"][0]["note"]["__blob"],"bmV3IHRvdXJuYW1lbnQ=")
            self.assertEqual(db.execute("SELECT COUNT(*) FROM competition_workspaces").fetchone()[0],3)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM competition_archives").fetchone()[0],1)
            db.close()
            self.assertEqual(sqlite3.connect(a).execute("SELECT COUNT(*) FROM competition_workspaces").fetchone()[0],1)
            self.assertEqual(sqlite3.connect(b).execute("SELECT COUNT(*) FROM competition_workspaces").fetchone()[0],3)

    def test_bank_conflict_fails_without_writing_output(self):
        with tempfile.TemporaryDirectory() as p:
            root=Path(p)
            a,b=root/"official.db",root/"rehearsal.db"
            out_dir=root/"new"
            out_dir.mkdir()
            out=out_dir/"candidate.db"
            create_db(a)
            create_db(b,True,changed_bank=True)
            with self.assertRaisesRegex(ValueError, "SHARED_QUESTIONS_DIFFER"):
                reconcile(a,b,out)
            self.assertFalse(out.exists())

    def test_refuse_overwrite(self):
        with tempfile.TemporaryDirectory() as p:
            root=Path(p)
            a,b=root/"official.db",root/"rehearsal.db"
            out_dir=root/"new"
            out_dir.mkdir()
            out=out_dir/"candidate.db"
            create_db(a)
            create_db(b,True)
            out.write_bytes(b"never overwrite")
            with self.assertRaisesRegex(ValueError, "DESTINATION_ALREADY_EXISTS"):
                reconcile(a,b,out)
            self.assertEqual(out.read_bytes(), b"never overwrite")

if __name__ == "__main__":
    unittest.main()
