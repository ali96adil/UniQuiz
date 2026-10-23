#!/usr/bin/env python3
"""Synthetic M6 ranking reference and tie/timeout fixture; never real data.

The rankings come from the exact SQL pinned from main's M6 ranking.ts, not
a reimplementation of scoring in M7. The only JS interpolation fixed in the
pinned SQL is the historical 25,000 ms timeout.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sqlite3


def extend_synthetic_fixture(db: sqlite3.Connection) -> None:
    version = db.execute(
        "SELECT value FROM app_meta WHERE key='schema_version'"
    ).fetchone()
    if version != ("12",):
        raise ValueError("This test only modifies the isolated synthetic M6/v12 database")
    db.executescript("""
      INSERT INTO colleges(id,name,short_name,sort_order) VALUES
        (3,'M6 Tied College C','C',3),
        (4,'M6 Tied College D','D',4),
        (5,'M6 Pending College E','E',5),
        (6,'M6 Pending College F','F',6);
      INSERT INTO participants(college_id) VALUES(3),(4),(5),(6);
      INSERT INTO qualification_rounds(
        id,round_order,college_a_id,college_b_id,status
      ) VALUES
        (2,2,3,4,'COMPLETED'),
        (3,3,5,6,'PENDING');
      INSERT INTO questions(
        id,category_id,prompt,option_a,option_b,option_c,option_d,
        correct_option,source_ref
      ) VALUES
        (3,1,'M6 tie-break question','A','B','C','D','A','m6-test-q3'),
        (4,2,'M6 timeout question','A','B','C','D','B','m6-test-q4');
      INSERT INTO qualification_round_question_sets(round_id,locked_at)
        VALUES(2,'2026-10-12T15:00:00');
      INSERT INTO qualification_round_questions(round_id,position,question_id,category_id)
        VALUES(2,1,3,1),(2,2,4,2);
      INSERT INTO live_submissions(
        round_id,question_position,station,question_id,selected_option,
        submitted_at_epoch_ms,response_time_ms,is_correct,score_micros
      ) VALUES
        (2,1,'A',3,'A',1010000,1600,1,24000000),
        (2,1,'B',3,'A',1010001,1200,1,24000000),
        (2,2,'B',4,'C',1011000,800,0,0);
      INSERT INTO audit_events(event_type,round_id,question_id,position,occurred_at)
        VALUES
          ('QUESTION_REVEALED',2,3,1,'2026-10-12T15:00:01'),
          ('QUESTION_REVEALED',2,4,2,'2026-10-12T15:00:02');
    """)
    if db.execute("PRAGMA foreign_key_check").fetchall():
        raise ValueError("Synthetic M6 tie-break fixture introduced foreign-key errors")
    db.commit()


def read_old_ranking(db: sqlite3.Connection, query: str) -> dict:
    db.row_factory = sqlite3.Row
    rows = [dict(row) for row in db.execute(query).fetchall()]
    started = [r for r in rows if r["roundStatus"] != "PENDING"]
    started.sort(key=lambda r: (
        -r["scoreMicros"], r["totalResponseTimeMs"], r["sortOrder"]
    ))
    pending = [r for r in rows if r["roundStatus"] == "PENDING"]
    pending.sort(key=lambda r: r["sortOrder"])
    entries = []
    for index, row in enumerate(started):
        entries.append({
            "college": {
                "id": row["collegeId"], "name": row["name"],
                "shortName": row["shortName"], "sortOrder": row["sortOrder"],
            },
            "status": "COMPLETED" if row["roundStatus"] == "COMPLETED" else "PLAYING",
            "rank": index + 1,
            "scorePoints": row["scoreMicros"] / 1_000_000,
            "revealedQuestions": row["revealedQuestions"],
            "totalResponseTimeMs": row["totalResponseTimeMs"],
            "correctAnswers": row["correctAnswers"],
            "wrongAnswers": row["wrongAnswers"],
        })
    for row in pending:
        entries.append({
            "college": {
                "id": row["collegeId"], "name": row["name"],
                "shortName": row["shortName"], "sortOrder": row["sortOrder"],
            },
            "status": "NOT_STARTED",
            "rank": None,
            "scorePoints": 0,
            "revealedQuestions": 0,
            "totalResponseTimeMs": 0,
            "correctAnswers": 0,
            "wrongAnswers": 0,
        })
    return {"entries": entries}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("extend", "capture"))
    parser.add_argument("--database", type=Path, required=True)
    parser.add_argument("--query", type=Path)
    args = parser.parse_args()
    path = args.database.expanduser().resolve()
    # Fail closed if accidentally passed a normal app database filename.
    if path.name in {"uniquiz.db", "uniquiz-rehearsal.db"}:
        parser.error("Refusing an official or default UniQuiz database filename")
    if not path.is_file():
        parser.error("Disposable synthetic M6 database must already exist")
    if args.command == "extend":
        with sqlite3.connect(path) as db:
            db.execute("PRAGMA foreign_keys=ON")
            extend_synthetic_fixture(db)
        print("M6_PARITY_EDGE_CASES_CREATED")
    else:
        if args.query is None or not args.query.is_file():
            parser.error("--query is required for capture")
        with sqlite3.connect(path.as_uri() + "?mode=ro", uri=True) as db:
            db.execute("PRAGMA query_only=ON")
            result = read_old_ranking(db, args.query.read_text(encoding="utf-8"))
        print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
