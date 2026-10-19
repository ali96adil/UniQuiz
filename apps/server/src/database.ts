import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import Database from "better-sqlite3";

const CURRENT_SCHEMA_VERSION = 16;

/**
 * M7 migrations affect table checks and add competition/workspace metadata.
 * A WAL-aware, consistent, physical snapshot is mandatory *before* the first
 * schema change on any existing database. If it fails we do not run migrations.
 * VACUUM INTO is synchronous and includes committed WAL content; never copy
 * only the .sqlite3 file while WAL is active.
 */
function backupBeforeMigration(db: Database.Database, databasePath: string): void {
  if (databasePath === ":memory:") return;
  const metaExists = db.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'app_meta'
  `).get();
  const installedVersion = metaExists
    ? (db.prepare("SELECT value FROM app_meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined)?.value
    : undefined;
  if (installedVersion !== undefined && Number(installedVersion) >= CURRENT_SCHEMA_VERSION) {
    return;
  }

  const sourceIntegrity = db.pragma("integrity_check") as Array<{ integrity_check: string }>;
  if (sourceIntegrity.length !== 1 || sourceIntegrity[0]?.integrity_check !== "ok") {
    throw new Error("M7_PREUPGRADE_SOURCE_INTEGRITY_FAILED");
  }

  const directory = join(dirname(databasePath), "migration-backups");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const safeName = basename(databasePath).replace(/[^a-zA-Z0-9._-]/g, "_");
  const backupPath = join(
    directory,
    safeName + "-before-m7-v" + CURRENT_SCHEMA_VERSION +
      "-" + new Date().toISOString().replace(/[:.]/g, "-") +
      "-" + randomUUID() + ".sqlite3",
  );

  // The SQLite engine writes a transactional copy, including live WAL pages.
  db.prepare("VACUUM INTO ?").run(backupPath);
  chmodSync(backupPath, 0o600);
  const backup = new Database(backupPath, { readonly: true, fileMustExist: true });
  try {
    const integrity = backup.pragma("integrity_check") as Array<{ integrity_check: string }>;
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
      throw new Error("M7_PREUPGRADE_BACKUP_INTEGRITY_FAILED");
    }
    const backedVersion = metaExists
      ? (backup.prepare("SELECT value FROM app_meta WHERE key = 'schema_version'")
        .get() as { value: string } | undefined)?.value
      : undefined;
    if (backedVersion !== installedVersion) {
      throw new Error("M7_PREUPGRADE_BACKUP_VERSION_MISMATCH");
    }
  } finally {
    backup.close();
  }
}

export function openDatabase(databasePath: string) {
  mkdirSync(dirname(databasePath), { recursive: true });
  const existingFile = databasePath !== ":memory:" &&
    existsSync(databasePath) && statSync(databasePath).size > 0;

  const db = new Database(databasePath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // Stop startup rather than mutating an existing DB without a verified copy.
  if (existingFile) {
    try {
      backupBeforeMigration(db, databasePath);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  try {
    db.transaction(() => {
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

    -- An optional distribution for a particular draw round. If absent,
    -- that round inherits the current competition-wide category quotas.
    CREATE TABLE IF NOT EXISTS qualification_round_rules (
      round_id INTEGER PRIMARY KEY,
      distribution_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (round_id) REFERENCES qualification_rounds(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category_key TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL UNIQUE,
      display_name TEXT,
      sort_order INTEGER NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS competition_rules (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      distribution_json TEXT
    );
    INSERT INTO competition_rules (id, distribution_json)
    VALUES (1, NULL)
    ON CONFLICT(id) DO NOTHING;

    -- Defaults reproduce the October 2026 competition: 25 seconds,
    -- 25 points at start and lose one point after each elapsed second.
    CREATE TABLE IF NOT EXISTS competition_gameplay_rules (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      duration_seconds INTEGER NOT NULL DEFAULT 25
        CHECK (duration_seconds BETWEEN 5 AND 300),
      scoring_mode TEXT NOT NULL DEFAULT 'time_decay'
        CHECK (scoring_mode IN ('time_decay', 'fixed')),
      correct_points INTEGER NOT NULL DEFAULT 25
        CHECK (correct_points BETWEEN 1 AND 1000),
      points_lost_per_second INTEGER NOT NULL DEFAULT 1
        CHECK (points_lost_per_second BETWEEN 0 AND 100)
    );
    INSERT INTO competition_gameplay_rules (
      id, duration_seconds, scoring_mode, correct_points, points_lost_per_second
    ) VALUES (1,25,'time_decay',25,1) ON CONFLICT(id) DO NOTHING;

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
        CHECK (position >= 1),
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
        CHECK (position >= 1),
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
        CHECK (question_position >= 1),
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

    -- Only the selected workspace is materialized in the legacy singleton tables.
    -- Inactive workspaces keep transactionally captured copies of event-scoped rows.
    -- The global categories/questions library and station access tokens are shared.
    CREATE TABLE IF NOT EXISTS competition_workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      participant_type TEXT NOT NULL DEFAULT 'college'
        CHECK (participant_type IN ('college', 'department', 'class', 'team')),
      payload_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    INSERT INTO competition_workspaces
      (id, name, participant_type, payload_json, created_at, updated_at)
    SELECT
      'legacy',
      event_title,
      'college',
      NULL,
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    FROM audience_settings
    WHERE id = 1
    ON CONFLICT(id) DO NOTHING;

    INSERT INTO app_meta (key, value)
    VALUES ('active_workspace_id', 'legacy')
    ON CONFLICT(key) DO NOTHING;

    -- Immutable records of completed or in-progress competition snapshots.
    -- Archive rows are never touched by reset/import operations.
    CREATE TABLE IF NOT EXISTS competition_archives (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      archived_at TEXT NOT NULL,
      participant_count INTEGER NOT NULL,
      round_count INTEGER NOT NULL,
      question_count INTEGER NOT NULL,
      payload_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_competition_archives_date
      ON competition_archives(archived_at DESC);

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

  `);

  // SQLite CREATE TABLE IF NOT EXISTS does not add columns to older databases.
  // Keep the internal name stable and let the presenter use display_name.
  const categoryColumns = db.pragma("table_info(categories)") as Array<{ name: string }>;
  if (!categoryColumns.some((column) => column.name === "display_name")) {
    db.exec("ALTER TABLE categories ADD COLUMN display_name TEXT");
  }

  // Migrate old 1..10 constraints transactionally. The original constraints,
  // primary keys, foreign keys, data and indexes are preserved.
  const widenedTables = [
    { name: "qualification_round_questions", index:
      "CREATE INDEX idx_round_questions_category ON qualification_round_questions(round_id, category_id)" },
    { name: "qualification_question_reservations", index: null },
    { name: "live_submissions", index:
      "CREATE INDEX idx_live_submissions_round_question ON live_submissions(round_id, question_position)" },
  ];
  const originals = widenedTables.map((table) => {
    const row = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(table.name) as { sql: string };
    return { ...table, sql: row.sql };
  }).filter((table) => /CHECK\s*\(\s*(?:question_)?position\s+BETWEEN\s+1\s+AND\s+10\s*\)/i.test(table.sql));

  if (originals.length > 0) {
    db.transaction(() => {
      for (const table of originals) {
        const upgraded = table.sql
          .replace(
            /^(CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?)(?:"[^"]+"|\w+)/i,
            (_, prefix: string) => prefix + table.name + "_m7",
          )
          .replace(
            /CHECK\s*\(\s*(question_position|position)\s+BETWEEN\s+1\s+AND\s+10\s*\)/gi,
            (_, column: string) => "CHECK (" + column + " >= 1)",
          );
        if (upgraded === table.sql || !upgraded.includes(table.name + "_m7")) {
          throw new Error("M7_POSITION_MIGRATION_SCHEMA_UNEXPECTED: " + table.name);
        }
        db.exec(upgraded);
        db.exec("INSERT INTO " + table.name + "_m7 SELECT * FROM " + table.name);
        db.exec("DROP TABLE " + table.name);
        db.exec("ALTER TABLE " + table.name + "_m7 RENAME TO " + table.name);
        if (table.index) db.exec(table.index);
      }
      const invalid = db.pragma("foreign_key_check") as unknown[];
      if (invalid.length > 0) throw new Error("M7_POSITION_MIGRATION_FK_ERROR");
    })();
  }

  db.prepare("UPDATE app_meta SET value = '16' WHERE key = 'schema_version'").run();
    })();
  } catch (error) {
    // DDL, data changes and schema_version all roll back as one operation.
    db.close();
    throw error;
  }
  return db;
}

export type AppDatabase = ReturnType<typeof openDatabase>;
