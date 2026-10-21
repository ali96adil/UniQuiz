#!/usr/bin/env node
// Upgrade a disposable, realistic M6 SQLite database built from main's actual
// version-12 DDL. Never uses or writes any official university competition DB.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../../apps/server/dist/database.js";
import { getQualificationRanking } from "../../apps/server/dist/ranking.js";
import { activeWorkspaceId } from "../../apps/server/dist/competition-workspaces.js";

const repo = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const file = (name) => join(repo, name);
const root = mkdtempSync(join(tmpdir(), "uniquiz-m7-exact-old-schema-"));
const old = join(root, "pinned-m6-v12.db");
const rehearsal = join(root, "m7-rehearsal.db");
const manifest = join(root, "m6-baseline.json");
const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

function runPython(script, args) {
  const command = spawnSync("python3", [file(script), ...args], {
    cwd: repo, encoding: "utf8", timeout: 30000,
  });
  assert.equal(command.status, 0, `${script} failed: ${command.stderr}\n${command.stdout}`);
  return command.stdout;
}
try {
  assert.match(runPython("scripts/ci/m7-seed-m6-fixture.py", [
    "--schema", file("scripts/fixtures/m6-main-schema.sql"), "--output", old,
  ]), /M6_EXACT_SCHEMA_FIXTURE_OK/);
  const sourceChecksum = hash(old);
  assert.match(runPython("scripts/m7_rehearsal_copy.py", [
    "--source", old, "--destination", rehearsal,
  ]), /REHEARSAL_COPY_OK/);
  assert.match(runPython("scripts/m7_rehearsal_verify.py", [
    "capture", "--database", rehearsal, "--manifest", manifest,
  ]), /M7_BASELINE_CAPTURE_OK/);

  const db = openDatabase(rehearsal);
  try {
    assert.equal(db.prepare(
      "SELECT value FROM app_meta WHERE key='schema_version'",
    ).get().value, "17");
    assert.equal(activeWorkspaceId(db), "legacy");
    assert.equal(db.prepare(
      "SELECT event_title AS title FROM audience_settings WHERE id=1",
    ).get().title, "M6 University Contest 2026");
    assert.equal(db.prepare(
      "SELECT value FROM app_meta WHERE key='historical_event_tag'",
    ).get().value, "preserve-m6-custom-meta");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM questions").get().n, 2);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM live_submissions").get().n, 4);
    assert.equal(db.prepare(
      "SELECT COUNT(*) AS n FROM qualification_question_reservations",
    ).get().n, 2, "Old round allocations must be backfilled");

    for (const table of [
      "qualification_round_questions",
      "qualification_question_reservations",
      "live_submissions",
    ]) {
      const sql = db.prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
      ).get(table).sql;
      assert.match(sql, /CHECK\s*\(\s*(?:question_)?position\s*>=\s*1\s*\)/i,
        `Question position range was not widened: ${table}`);
      assert.doesNotMatch(sql, /BETWEEN\s+1\s+AND\s+10/i, `Old max-10 restriction: ${table}`);
    }

    const categoryColumns = db.pragma("table_info(categories)").map((column) => column.name);
    assert.ok(categoryColumns.includes("display_name"), "Missing M7 public display label column");
    const ranking = getQualificationRanking(db);
    assert.equal(ranking.entries.length, 2);
    const [a, b] = ranking.entries;
    assert.equal(a.college.name, "M6 Historical College A");
    assert.equal(b.college.name, "M6 Historical College B");
    assert.equal(a.scorePoints, 24.6);
    assert.equal(b.scorePoints, 24.2);
    assert.equal(a.correctAnswers, 1);
    assert.equal(b.correctAnswers, 1);
    assert.equal(a.wrongAnswers, 1);
    assert.equal(b.wrongAnswers, 1);
    assert.equal(a.revealedQuestions, 2);
    assert.equal(b.revealedQuestions, 2);
    assert.deepEqual(db.pragma("foreign_key_check"), []);
    assert.deepEqual(db.pragma("integrity_check"), [{ integrity_check: "ok" }]);
  } finally {
    db.close();
  }

  const backups = readdirSync(join(root, "migration-backups"))
    .filter((name) => name.endsWith(".sqlite3"));
  assert.equal(backups.length, 1, "Pre-upgrade physical backup was not created");
  assert.ok(statSync(join(root, "migration-backups", backups[0])).size > 0);
  assert.match(runPython("scripts/m7_rehearsal_verify.py", [
    "verify", "--database", rehearsal, "--manifest", manifest,
  ]), /M7_REHEARSAL_VERIFY_OK/);
  assert.equal(hash(old), sourceChecksum, "CI source M6 DB was mutated by upgrade");
  console.log("M7_EXACT_M6_SCHEMA_UPGRADE_OK");
} finally {
  rmSync(root, { recursive: true, force: true });
}
