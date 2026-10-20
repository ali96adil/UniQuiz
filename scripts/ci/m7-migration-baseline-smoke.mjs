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
  // marker over a valid snapshot of today's table definitions. This exercises
  // the real backup/startup migration, not reconstruction of every old DDL.
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
