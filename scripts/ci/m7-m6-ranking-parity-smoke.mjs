#!/usr/bin/env node
// The authoritative M6 ranking SQL runs on the *old* schema before any
// migration. Compare with M7's actual ranking implementation AFTER upgrading
// a WAL-consistent COPY. All files are synthetic and disposable.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { openDatabase } from "../../apps/server/dist/database.js";
import { getQualificationRanking } from "../../apps/server/dist/ranking.js";
import { buildResultsWorkbook } from "../../apps/server/dist/results-export.js";

const repo = resolve(fileURLToPath(new URL("../..", import.meta.url)));
// ExcelJS is a server dependency, resolved from the server's own package.
const requireServer = createRequire(
  fileURLToPath(new URL("../../apps/server/package.json", import.meta.url)),
);
const ExcelJS = requireServer("exceljs");
const sourcePath = (p) => join(repo, p);
const root = mkdtempSync(join(tmpdir(), "uniquiz-m7-m6-ranking-parity-"));
const oldDB = join(root, "m6-parity-original.db");
const copy = join(root, "m7-parity-rehearsal.db");
const manifest = join(root, "before.json");
const fileSha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

function py(script, args) {
  const result = spawnSync("python3", [sourcePath(script), ...args], {
    encoding: "utf8", cwd: repo, timeout: 30_000,
  });
  assert.equal(result.status, 0,
    `Python ${script} failed: ${result.stderr}\n${result.stdout}`);
  return result.stdout.trim();
}

try {
  py("scripts/ci/m7-seed-m6-fixture.py", [
    "--schema", sourcePath("scripts/fixtures/m6-main-schema.sql"),
    "--output", oldDB,
  ]);
  assert.match(py("scripts/ci/m7-m6-ranking-reference.py", [
    "extend", "--database", oldDB,
  ]), /M6_PARITY_EDGE_CASES_CREATED/);
  const expected = JSON.parse(py("scripts/ci/m7-m6-ranking-reference.py", [
    "capture", "--database", oldDB,
    "--query", sourcePath("scripts/fixtures/m6-main-ranking.sql"),
  ])).entries;
  assert.equal(expected.length, 6);
  assert.deepEqual(expected.map((entry) => entry.college.id), [1,2,4,3,5,6],
    "Fixture must test both unequal scores, tied score + faster time and pending teams");
  assert.deepEqual(expected.map((entry) => entry.scorePoints), [24.6,24.2,24,24,0,0]);
  assert.equal(expected[2].totalResponseTimeMs, 2000);
  assert.equal(expected[3].totalResponseTimeMs, 26600,
    "M6 unanswered revealed question must consume 25,000 ms by default");
  assert.equal(expected[4].status, "NOT_STARTED");
  assert.equal(expected[5].rank, null);

  const historicalChecksum = fileSha(oldDB);
  assert.match(py("scripts/m7_rehearsal_copy.py", [
    "--source", oldDB, "--destination", copy,
  ]), /REHEARSAL_COPY_OK/);
  assert.match(py("scripts/m7_rehearsal_verify.py", [
    "capture", "--database", copy, "--manifest", manifest,
  ]), /M7_BASELINE_CAPTURE_OK/);

  let db = openDatabase(copy);
  try {
    const current = getQualificationRanking(db);
    assert.deepEqual(current.entries, expected,
      "M7 changed historical M6 score, tie-break, timeout, ranking or answers");

    // The Excel export must display the same historical scores and time
    // tiebreak ordering. Row hashes alone cannot protect rendering bugs.
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await buildResultsWorkbook(db));
    const rankingSheet = workbook.getWorksheet("Ranking");
    const summarySheet = workbook.getWorksheet("Summary");
    assert.ok(rankingSheet && summarySheet);
    assert.equal(summarySheet.getRow(7).getCell(2).value, 25);
    assert.equal(summarySheet.getRow(12).getCell(2).value, "college");
    assert.equal(rankingSheet.rowCount, expected.length + 1);
    for (const [index, entry] of expected.entries()) {
      const row = rankingSheet.getRow(index + 2);
      assert.equal(row.getCell(1).value, entry.rank ?? "");
      assert.equal(row.getCell(2).value, entry.college.name);
      assert.equal(row.getCell(3).value, entry.status);
      assert.equal(row.getCell(4).value,
        entry.status === "NOT_STARTED" ? "" : entry.scorePoints);
      assert.equal(row.getCell(5).value,
        entry.status === "NOT_STARTED" ? "" : entry.totalResponseTimeMs);
      assert.equal(row.getCell(6).value, entry.correctAnswers);
      assert.equal(row.getCell(7).value, entry.wrongAnswers);
      assert.equal(row.getCell(8).value, entry.revealedQuestions);
    }
    const roundSheet = workbook.getWorksheet("Rounds");
    assert.ok(roundSheet);
    assert.deepEqual(
      [roundSheet.getRow(2).getCell(5).value,roundSheet.getRow(2).getCell(6).value],
      [24.6,24.2],
      "The historic round export must match M6 official scores",
    );
    assert.equal(db.prepare(
      "SELECT value FROM app_meta WHERE key='schema_version'",
    ).get().value,"16");
    assert.deepEqual(db.pragma("foreign_key_check"),[]);
  } finally {
    db.close();
  }
  assert.match(py("scripts/m7_rehearsal_verify.py", [
    "verify", "--database", copy, "--manifest", manifest,
  ]),/M7_REHEARSAL_VERIFY_OK/);
  assert.equal(readdirSync(join(root, "migration-backups"))
    .filter((name)=>name.endsWith(".sqlite3")).length, 1);
  assert.equal(fileSha(oldDB), historicalChecksum,
    "M7 changed the original synthetic M6 data");

  // A second process reload should produce the identical historical ranking.
  db = openDatabase(copy);
  try {
    assert.deepEqual(getQualificationRanking(db).entries, expected);
  } finally {
    db.close();
  }
  console.log("M7_M6_RANKING_PARITY_OK");
} finally {
  rmSync(root, { recursive: true, force: true });
}
