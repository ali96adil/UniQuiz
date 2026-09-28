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

    UPDATE app_meta
    SET value = '3'
    WHERE key = 'schema_version';
  `);

  return db;
}

export type AppDatabase = ReturnType<typeof openDatabase>;
