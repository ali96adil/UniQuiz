#!/usr/bin/env python3
"""Seed a disposable M6/v12 competition using the *exact* pinned main schema.

CI fixture only: explicitly refuses existing files and paths resembling the
official UniQuiz database. Do not use it with any real tournament files.
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import sqlite3


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--schema", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    destination = args.output.expanduser().resolve()
    if destination.exists() or not destination.parent.is_dir():
        parser.error("Disposable output must not exist, and parent directory must exist")
    if destination.name in {"uniquiz.db", "uniquiz-rehearsal.db"}:
        parser.error("Refusing names used by real UniQuiz runtime")
    schema = args.schema.expanduser().resolve()
    if not schema.is_file():
        parser.error("Pinned main schema fixture does not exist")
    old_mask = os.umask(0o077)
    try:
        connection = sqlite3.connect(destination)
        try:
            connection.execute("PRAGMA foreign_keys=ON")
            connection.execute("PRAGMA journal_mode=WAL")
            connection.executescript(schema.read_text(encoding="utf-8"))
            connection.executescript("""
              INSERT INTO colleges(id,name,short_name,sort_order) VALUES
                (1,'M6 Historical College A','A',1),
                (2,'M6 Historical College B','B',2);
              INSERT INTO participants(college_id) VALUES (1),(2);
              INSERT INTO qualification_rounds(
                id,round_order,college_a_id,college_b_id,status
              ) VALUES (1,1,1,2,'COMPLETED');
              INSERT INTO categories(id,category_key,name,sort_order) VALUES
                (1,'sports','M6 Sports',1),
                (2,'geography','M6 Geography',2);
              INSERT INTO questions(
                id,category_id,prompt,option_a,option_b,option_c,option_d,
                correct_option,source_ref
              ) VALUES
                (1,1,'Legacy question sports','One','Two','Three','Four','A','m6-test-q1'),
                (2,2,'Legacy question geography','Five','Six','Seven','Eight','B','m6-test-q2');
              INSERT INTO qualification_round_question_sets(
                round_id,locked_at
              ) VALUES (1,'2026-10-12T14:00:00');
              INSERT INTO qualification_round_questions(
                round_id,position,question_id,category_id
              ) VALUES (1,1,1,1),(1,2,2,2);
              INSERT INTO live_submissions(
                round_id,question_position,station,question_id,selected_option,
                submitted_at_epoch_ms,response_time_ms,is_correct,score_micros
              ) VALUES
                (1,1,'A',1,'A',1000000,400,1,24600000),
                (1,1,'B',1,'C',1000200,600,0,0),
                (1,2,'A',2,'C',1002000,700,0,0),
                (1,2,'B',2,'B',1002100,800,1,24200000);
              INSERT INTO audit_events(
                event_type,round_id,question_id,position,occurred_at
              ) VALUES
                ('QUESTION_REVEALED',1,1,1,'2026-10-12T14:00:01'),
                ('QUESTION_REVEALED',1,2,2,'2026-10-12T14:00:02');
              UPDATE live_state SET phase='ROUND_COMPLETE',round_id=1,
                question_position=2,updated_at='2026-10-12T14:02:00';
              UPDATE audience_settings SET
                event_title='M6 University Contest 2026',
                event_subtitle='Student Activities',
                updated_at='2026-10-12T14:02:00';
              INSERT INTO station_credentials(station,access_token,created_at) VALUES
                ('A','m6-synthetic-credential-A-00000000000','2026-10-12T09:00:00'),
                ('B','m6-synthetic-credential-B-00000000000','2026-10-12T09:00:00');
              INSERT INTO app_meta(key,value) VALUES
                ('historical_event_tag','preserve-m6-custom-meta');
            """)
            connection.execute(
                """INSERT INTO audience_assets(slot,mime_type,bytes,updated_at)
                VALUES('university','image/png',?,'2026-10-12T09:00:00')""",
                (bytes([137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 1]),),
            )
            connection.execute("PRAGMA foreign_key_check")
            violations = connection.execute("PRAGMA foreign_key_check").fetchall()
            if violations:
                raise RuntimeError("Generated M6 fixture has foreign-key violations: " + repr(violations))
            assert connection.execute(
                "SELECT value FROM app_meta WHERE key='schema_version'"
            ).fetchone() == ("12",)
            for table in (
                "qualification_round_questions",
                "qualification_question_reservations",
                "live_submissions",
            ):
                definition = connection.execute(
                    "SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
                    (table,),
                ).fetchone()[0]
                assert "BETWEEN 1 AND 10" in definition, table
            connection.commit()
            assert connection.execute("PRAGMA integrity_check").fetchall() == [("ok",)]
            print("M6_EXACT_SCHEMA_FIXTURE_OK")
        finally:
            connection.close()
    finally:
        os.umask(old_mask)


if __name__ == "__main__":
    main()
