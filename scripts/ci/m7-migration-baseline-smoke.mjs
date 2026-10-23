#!/usr/bin/env node
// Synthetic CI end-to-end check: actual Node M7 startup migration plus
// WAL-safe read-only Python capture/verify on a distinct rehearsal DB.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../../apps/server/dist/database.js";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const copier = join(repoRoot, "scripts", "m7_rehearsal_copy.py");
const verifier = join(repoRoot, "scripts", "m7_rehearsal_verify.py");
const root = mkdtempSync(join(tmpdir(), "uniquiz-m7-real-migration-"));
const original = join(root, "synthetic-old.db");
const rehearsal = join(root, "rehearsal.db");
const manifest = join(root, "before-m7.json");
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

function python(script, args, expected = 0) {
  const proc = spawnSync("python3", [script, ...args], {
    cwd: repoRoot, encoding: "utf8", timeout: 30_000,
  });
  assert.equal(
    proc.status, expected,
    `Unexpected Python exit ${proc.status}, expected ${expected}\n${proc.stdout}\n${proc.stderr}`,
  );
  return proc.stdout + proc.stderr;
}

try {
  let db = openDatabase(original);
  try {
    db.exec(`
      INSERT INTO colleges(name,sort_order) VALUES('Synthetic College 2026',1);
      INSERT INTO participants(college_id) VALUES(1);
      INSERT INTO qualification_rounds(round_order,college_a_id,status)
        VALUES(1,1,'COMPLETED');
      INSERT INTO categories(category_key,name,display_name,sort_order)
        VALUES('sports','Synthetic Sports','رياضة',1);
      INSERT INTO questions(category_id,prompt,option_a,option_b,option_c,option_d,correct_option)
        VALUES(1,'Synthetic historic question','One','Two','Three','Four','B');
      INSERT INTO qualification_round_question_sets(round_id,locked_at)
        VALUES(1,CURRENT_TIMESTAMP);
      INSERT INTO qualification_round_questions(round_id,position,question_id,category_id)
        VALUES(1,1,1,1);
      INSERT INTO live_submissions(
        round_id,question_position,station,question_id,selected_option,
        submitted_at_epoch_ms,response_time_ms,is_correct,score_micros)
        VALUES(1,1,'A',1,'B',1000,400,1,24600000);
      INSERT INTO audit_events(event_type,round_id,question_id,position,occurred_at)
        VALUES('QUESTION_REVEALED',1,1,1,CURRENT_TIMESTAMP);
      UPDATE live_state SET phase='ROUND_COMPLETE',round_id=1,question_position=1;
      UPDATE audience_settings SET event_title='Synthetic University 2026';
      INSERT INTO app_meta(key,value) VALUES('custom_festival_config','private-2026');
      UPDATE app_meta SET value='15' WHERE key='schema_version';
    `);
    db.prepare(
      "INSERT INTO audience_assets(slot,mime_type,bytes,updated_at) VALUES('university','image/png',?,CURRENT_TIMESTAMP)",
    ).run(Buffer.from([0x89,0x50,0x4e,0x47,0,255,76,79,71,79]));

    // Reconstruct one genuine M6-style constraint so startup must widen
    // CHECK(question_position BETWEEN 1 AND 10) to >= 1. The original
    // historical answer is preserved across the table rebuild.
    const table = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='live_submissions'",
    ).get().sql;
    assert.match(table, /CHECK\s*\(\s*question_position\s*>=\s*1\s*\)/i);
    const oldDDL = table
      .replace(/^(CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?)(?:\w+)/i,
        (_, prefix) => prefix + "live_submissions_legacy_ci")
      .replace(/CHECK\s*\(\s*question_position\s*>=\s*1\s*\)/i,
        "CHECK (question_position BETWEEN 1 AND 10)");
    assert.match(oldDDL, /live_submissions_legacy_ci/);
    db.transaction(() => {
      db.exec("DROP INDEX IF EXISTS idx_live_submissions_round_question");
      db.exec(oldDDL);
      db.exec("INSERT INTO live_submissions_legacy_ci SELECT * FROM live_submissions");
      db.exec("DROP TABLE live_submissions");
      db.exec("ALTER TABLE live_submissions_legacy_ci RENAME TO live_submissions");
      db.exec("CREATE INDEX idx_live_submissions_round_question ON live_submissions(round_id, question_position)");
    })();
    assert.match(
      db.prepare("SELECT sql FROM sqlite_master WHERE name='live_submissions'").get().sql,
      /question_position\s+BETWEEN\s+1\s+AND\s+10/i,
    );
    assert.deepEqual(db.pragma("foreign_key_check"), []);
  } finally {
    db.close();
  }

  const originalChecksum = sha256(original);
  assert.match(
    python(copier, ["--source",original,"--destination",rehearsal]),
    /REHEARSAL_COPY_OK/,
  );
  assert.match(
    python(verifier, ["capture","--database",rehearsal,"--manifest",manifest]),
    /M7_BASELINE_CAPTURE_OK/,
  );
  // The preexisting installation is an intentionally synthetic v15 version
  // marker plus the historical 1..10 constraint on the submissions table.
  // This exercises the real backup/startup table-rebuild migration; it does
  // not reconstruct every historical M6 DDL or replace actual Mac rehearsal.
  db = openDatabase(rehearsal);
  try {
    assert.equal(
      db.prepare("SELECT value FROM app_meta WHERE key='schema_version'").get().value,
      "16",
    );
    assert.equal(
      db.prepare("SELECT score_micros FROM live_submissions").get().score_micros,
      24600000,
    );
    const migratedDDL = db.prepare(
      "SELECT sql FROM sqlite_master WHERE name='live_submissions'",
    ).get().sql;
    assert.match(migratedDDL, /CHECK\s*\(\s*question_position\s*>=\s*1\s*\)/i,
      "M7 must lift the 10-question restriction without losing old answers");
    assert.doesNotMatch(migratedDDL, /question_position\s+BETWEEN\s+1\s+AND\s+10/i);
    assert.deepEqual(db.pragma("foreign_key_check"), []);
  } finally {
    db.close();
  }

  const migrationDir = join(root, "migration-backups");
  const backups = readdirSync(migrationDir).filter((file) => file.endsWith(".sqlite3"));
  assert.equal(backups.length, 1, "M7 must leave a physical pre-upgrade backup");
  assert.ok(statSync(join(migrationDir, backups[0])).size > 0);
  assert.match(
    python(verifier, ["verify","--database",rehearsal,"--manifest",manifest]),
    /M7_REHEARSAL_VERIFY_OK/,
  );
  assert.equal(sha256(original), originalChecksum,
    "The synthetic official source database must remain unchanged.");

  // Deliberate mutation must fail after actual M7 initialization too.
  db = openDatabase(rehearsal);
  try {
    db.prepare("UPDATE live_submissions SET score_micros=0 WHERE round_id=1").run();
  } finally {
    db.close();
  }
  const tampered = spawnSync("python3", [
    verifier,"verify","--database",rehearsal,"--manifest",manifest,
  ], { cwd:repoRoot,encoding:"utf8",timeout:30_000 });
  assert.notEqual(tampered.status, 0, "Tampered historical score passed verification");
  assert.match(tampered.stderr, /DATA_CHANGED: live_submissions/);
  assert.equal(sha256(original), originalChecksum);
  console.log("M7_REAL_MIGRATION_BASELINE_SMOKE_OK");
} finally {
  rmSync(root, { recursive: true, force: true });
}
