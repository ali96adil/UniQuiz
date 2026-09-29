import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

export function openDatabase(databasePath: string) {
  mkdirSync(dirname(databasePath), { recursive: true });

  const db = new Database(databasePath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    INSERT INTO app_meta (key, value)
    VALUES ('schema_version', '1')
    ON CONFLICT(key) DO NOTHING;

    CREATE TABLE IF NOT EXISTS colleges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      short_name TEXT,
      sort_order INTEGER NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS competition_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      participants_locked INTEGER NOT NULL DEFAULT 0
        CHECK (participants_locked IN (0, 1)),
      draw_created_at TEXT,
      selected_round_id INTEGER
    );

    INSERT INTO competition_state (
      id,
      participants_locked,
      draw_created_at,
      selected_round_id
    )
    VALUES (1, 0, NULL, NULL)
    ON CONFLICT(id) DO NOTHING;

    CREATE TABLE IF NOT EXISTS participants (
      college_id INTEGER PRIMARY KEY,
      FOREIGN KEY (college_id) REFERENCES colleges(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS qualification_rounds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      round_order INTEGER NOT NULL UNIQUE,
      college_a_id INTEGER NOT NULL,
      college_b_id INTEGER,
      status TEXT NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'ACTIVE', 'COMPLETED')),
      CHECK (college_b_id IS NULL OR college_b_id <> college_a_id),
      FOREIGN KEY (college_a_id) REFERENCES colleges(id),
      FOREIGN KEY (college_b_id) REFERENCES colleges(id)
    );

    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category_key TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL UNIQUE,
      sort_order INTEGER NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category_id INTEGER NOT NULL,
      prompt TEXT NOT NULL,
      option_a TEXT NOT NULL,
      option_b TEXT NOT NULL,
      option_c TEXT NOT NULL,
      option_d TEXT NOT NULL,
      correct_option TEXT NOT NULL
        CHECK (correct_option IN ('A', 'B', 'C', 'D')),
      source_ref TEXT UNIQUE,
      active INTEGER NOT NULL DEFAULT 1
        CHECK (active IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (category_id) REFERENCES categories(id)
    );

    CREATE INDEX IF NOT EXISTS idx_questions_category_id
      ON questions(category_id);

    CREATE TABLE IF NOT EXISTS qualification_round_question_sets (
      round_id INTEGER PRIMARY KEY,
      locked_at TEXT NOT NULL,
      FOREIGN KEY (round_id)
        REFERENCES qualification_rounds(id)
        ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS qualification_round_questions (
      round_id INTEGER NOT NULL,
      position INTEGER NOT NULL
        CHECK (position BETWEEN 1 AND 10),
      question_id INTEGER NOT NULL UNIQUE,
      category_id INTEGER NOT NULL,
      PRIMARY KEY (round_id, position),
      FOREIGN KEY (round_id)
        REFERENCES qualification_round_question_sets(round_id)
        ON DELETE CASCADE,
      FOREIGN KEY (question_id)
        REFERENCES questions(id),
      FOREIGN KEY (category_id)
        REFERENCES categories(id)
    );

    CREATE INDEX IF NOT EXISTS idx_round_questions_category
      ON qualification_round_questions(round_id, category_id);

    CREATE TABLE IF NOT EXISTS qualification_question_reservations (
      question_id INTEGER PRIMARY KEY,
      round_id INTEGER NOT NULL,
      position INTEGER NOT NULL
        CHECK (position BETWEEN 1 AND 10),
      disposition TEXT NOT NULL
        CHECK (disposition IN ('ALLOCATED', 'VOIDED', 'REPLACEMENT')),
      reserved_at TEXT NOT NULL,
      voided_at TEXT,
      FOREIGN KEY (question_id) REFERENCES questions(id),
      FOREIGN KEY (round_id) REFERENCES qualification_rounds(id)
    );

    INSERT OR IGNORE INTO qualification_question_reservations (
      question_id,
      round_id,
      position,
      disposition,
      reserved_at
    )
    SELECT
      rqq.question_id,
      rqq.round_id,
      rqq.position,
      'ALLOCATED',
      COALESCE(rqs.locked_at, CURRENT_TIMESTAMP)
    FROM qualification_round_questions rqq
    JOIN qualification_round_question_sets rqs
      ON rqs.round_id = rqq.round_id;

    CREATE TABLE IF NOT EXISTS audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      round_id INTEGER,
      question_id INTEGER,
      related_question_id INTEGER,
      position INTEGER,
      reason TEXT,
      payload_json TEXT,
      occurred_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_audit_events_round
      ON audit_events(round_id, occurred_at);

    CREATE TABLE IF NOT EXISTS live_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      phase TEXT NOT NULL DEFAULT 'IDLE',
      round_id INTEGER,
      question_position INTEGER,
      stations_confirmed INTEGER NOT NULL DEFAULT 0
        CHECK (stations_confirmed IN (0, 1)),
      countdown_started_at_epoch_ms INTEGER,
      question_started_at_epoch_ms INTEGER,
      question_closed_at_epoch_ms INTEGER,
      close_reason TEXT,
      updated_at TEXT NOT NULL
    );

    INSERT INTO live_state (
      id,
      phase,
      round_id,
      question_position,
      stations_confirmed,
      updated_at
    )
    VALUES (1, 'IDLE', NULL, NULL, 0, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO NOTHING;

    CREATE TABLE IF NOT EXISTS live_submissions (
      round_id INTEGER NOT NULL,
      question_position INTEGER NOT NULL
        CHECK (question_position BETWEEN 1 AND 10),
      station TEXT NOT NULL
        CHECK (station IN ('A', 'B')),
      question_id INTEGER NOT NULL,
      selected_option TEXT NOT NULL
        CHECK (selected_option IN ('A', 'B', 'C', 'D')),
      submitted_at_epoch_ms INTEGER NOT NULL,
      response_time_ms INTEGER NOT NULL,
      is_correct INTEGER NOT NULL
        CHECK (is_correct IN (0, 1)),
      score_micros INTEGER NOT NULL,
      PRIMARY KEY (round_id, question_position, station),
      FOREIGN KEY (round_id) REFERENCES qualification_rounds(id),
      FOREIGN KEY (question_id) REFERENCES questions(id)
    );

    CREATE INDEX IF NOT EXISTS idx_live_submissions_round_question
      ON live_submissions(round_id, question_position);

    CREATE TABLE IF NOT EXISTS station_credentials (
      station TEXT PRIMARY KEY
        CHECK (station IN ('A', 'B')),
      access_token TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      rotated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS audience_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      event_title TEXT NOT NULL,
      event_subtitle TEXT NOT NULL,
      venue TEXT NOT NULL,
      season TEXT NOT NULL,
      footer_text TEXT NOT NULL,
      round_label TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    INSERT INTO audience_settings (
      id,
      event_title,
      event_subtitle,
      venue,
      season,
      footer_text,
      round_label,
      updated_at
    )
    VALUES (
      1,
      'مسابقة بنك المعلومات',
      'جامعة بابل · قسم النشاطات الطلابية',
      '',
      '',
      'جامعة بابل — قسم النشاطات الطلابية',
      'جولة',
      CURRENT_TIMESTAMP
    )
    ON CONFLICT(id) DO NOTHING;

    CREATE TABLE IF NOT EXISTS audience_assets (
      slot TEXT PRIMARY KEY
        CHECK (slot IN ('university', 'department')),
      mime_type TEXT NOT NULL,
      bytes BLOB NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audience_copy (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audience_presentation (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      active INTEGER NOT NULL DEFAULT 0
        CHECK (active IN (0, 1)),
      kind TEXT NOT NULL DEFAULT 'PLEASE_WAIT'
        CHECK (
          kind IN (
            'BREAK',
            'PLEASE_WAIT',
            'NEXT_ROUND',
            'PREPARE_TEAMS',
            'FINAL_RESULTS_SOON',
            'CUSTOM'
          )
        ),
      title TEXT NOT NULL DEFAULT 'يرجى الانتظار',
      message TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );

    INSERT INTO audience_presentation (
      id,
      active,
      kind,
      title,
      message,
      updated_at
    )
    VALUES (
      1,
      0,
      'PLEASE_WAIT',
      'يرجى الانتظار',
      '',
      CURRENT_TIMESTAMP
    )
    ON CONFLICT(id) DO NOTHING;

    CREATE TABLE IF NOT EXISTS operations_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      osc_test_sent_at TEXT,
      osc_test_confirmed_at TEXT,
      updated_at TEXT NOT NULL
    );

    INSERT INTO operations_state (
      id,
      osc_test_sent_at,
      osc_test_confirmed_at,
      updated_at
    )
    VALUES (1, NULL, NULL, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO NOTHING;

    UPDATE app_meta
    SET value = '12'
    WHERE key = 'schema_version';
  `);

  return db;
}

export type AppDatabase = ReturnType<typeof openDatabase>;
