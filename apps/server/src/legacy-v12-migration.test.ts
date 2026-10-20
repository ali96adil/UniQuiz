import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import ExcelJS from "exceljs";
import { openDatabase } from "./database.js";
import { getQualificationRanking } from "./ranking.js";
import { buildResultsWorkbook } from "./results-export.js";

const projectRoot = new URL("../../../", import.meta.url);
const sql = readFileSync(new URL("scripts/fixtures/uniquiz-main-v12-schema.sql", projectRoot), "utf8");
const copyScript = new URL("scripts/m7_rehearsal_copy.py", projectRoot).pathname;
const auditScript = new URL("scripts/m7_rehearsal_verify.py", projectRoot).pathname;

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function runPython(script: string, ...args: string[]): string {
  const command = spawnSync("python3", [script, ...args], { encoding: "utf8", timeout: 20_000 });
  assert.equal(command.error, undefined, String(command.error));
  assert.equal(command.status, 0, command.stderr + "\n" + command.stdout);
  return command.stdout;
}

function seedFrozenV12(path: string): Database.Database {
  const legacy = new Database(path);
  legacy.pragma("journal_mode = WAL");
  legacy.pragma("wal_autocheckpoint = 0");
  legacy.pragma("foreign_keys = ON");
  legacy.exec(sql);
  assert.equal(
    (legacy.prepare("SELECT value FROM app_meta WHERE key='schema_version'")
      .get() as { value: string }).value,
    "12",
    "Fixture MUST reflect the exact pre-M7 main v12 SQL, not new schema",
  );

  legacy.transaction(() => {
    legacy.exec(`
      INSERT INTO app_meta(key,value) VALUES('custom_official_label','historical-2026');
      INSERT INTO colleges(id,name,sort_order) VALUES
        (1,'كلية التربية',1),(2,'كلية القانون',2);
      INSERT INTO participants(college_id) VALUES (1),(2);
      UPDATE competition_state
        SET participants_locked=1,draw_created_at='2026-10-13T10:00:00.000Z';
      INSERT INTO qualification_rounds(
        id,round_order,college_a_id,college_b_id,status
      ) VALUES(1,1,1,2,'COMPLETED');
      INSERT INTO qualification_round_question_sets(round_id,locked_at)
      VALUES(1,'2026-10-13T10:00:00.000Z');
      INSERT INTO categories(id,category_key,name,sort_order) VALUES
        (1,'sports','رياضة',1),(2,'history','تاريخ',2),
        (3,'geography','جغرافيا',3),(4,'arts','فنون',4),
        (5,'culture','ثقافة',5);
      UPDATE audience_settings SET
        event_title='بنك المعلومات — جامعة بابل 2026',
        event_subtitle='برعاية رئيس جامعة بابل',
        footer_text='قسم النشاطات الطلابية',
        updated_at='2026-10-13T08:00:00.000Z';
      INSERT INTO audience_assets(slot,mime_type,bytes,updated_at)
      VALUES('university','image/png',X'89504E470D0A1A0A00FF01','2026-10-13T08:00:00.000Z');
      INSERT INTO station_credentials(station,access_token,created_at)
      VALUES('A','test-only-token-A-2026','2026-10-13T08:00:00.000Z'),
            ('B','test-only-token-B-2026','2026-10-13T08:00:00.000Z');
      UPDATE live_state SET
        phase='ROUND_COMPLETE',round_id=1,question_position=10,
        updated_at='2026-10-13T12:00:00.000Z';
    `);
    const question = legacy.prepare(`
      INSERT INTO questions(
        id,category_id,prompt,option_a,option_b,option_c,option_d,correct_option
      ) VALUES(?,? ,?, 'اختيار أ','اختيار ب','اختيار ج','اختيار د','A')
    `);
    const slot = legacy.prepare(`
      INSERT INTO qualification_round_questions(
        round_id,position,question_id,category_id
      ) VALUES(1,?,?,?)
    `);
    const reserve = legacy.prepare(`
      INSERT INTO qualification_question_reservations(
        question_id,round_id,position,disposition,reserved_at
      ) VALUES(?,1,?,'ALLOCATED','2026-10-13T10:00:00.000Z')
    `);
    const submission = legacy.prepare(`
      INSERT INTO live_submissions(
        round_id,question_position,station,question_id,
        selected_option,submitted_at_epoch_ms,response_time_ms,
        is_correct,score_micros
      ) VALUES(1,?,?,?,?,?,?,?,?)
    `);
    const audit = legacy.prepare(`
      INSERT INTO audit_events(
        event_type,round_id,question_id,position,payload_json,occurred_at
      ) VALUES('QUESTION_REVEALED',1,?,?,?,?)
    `);
    for (let pos = 1; pos <= 10; pos++) {
      const category = Math.ceil(pos / 2);
      question.run(pos, category, `السؤال التاريخي رقم ${pos}`);
      slot.run(pos, pos, category);
      reserve.run(pos, pos);
      submission.run(pos, "A", pos, "A", 1_760_354_400_000 + pos, pos * 250, 1, (26 - pos) * 1_000_000);
      submission.run(pos, "B", pos, pos % 2 ? "B" : "A", 1_760_354_401_000 + pos,
        pos * 400, pos % 2 ? 0 : 1, pos % 2 ? 0 : (26 - pos) * 1_000_000);
      audit.run(pos, pos, JSON.stringify({ position: pos, from: "frozen-v12-fixture" }), "2026-10-13T12:00:00.000Z");
    }
  })();
  assert.deepEqual(legacy.pragma("foreign_key_check"), []);
  assert.deepEqual(legacy.pragma("integrity_check"), [{ integrity_check: "ok" }]);
  return legacy;
}

test("M7 upgrades real main v12 SQLite schema and preserves historic data through actual read-only copier and fingerprints", async () => {
  const dir = mkdtempSync(join(tmpdir(), "uniquiz-m7-frozen-v12-"));
  const originalPath = join(dir, "official-v12.db");
  const rehearsalPath = join(dir, "rehearsal-v16.db");
  const baselinePath = join(dir, "private-baseline.json");
  const original = seedFrozenV12(originalPath);
  try {
    const oldRestriction = (original.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='live_submissions'",
    ).get() as { sql: string }).sql;
    assert.match(oldRestriction, /BETWEEN 1 AND 10/);
    assert.equal((original.prepare(
      "SELECT COUNT(*) AS count FROM live_submissions",
    ).get() as { count: number }).count, 20);

    const originalWal = originalPath + "-wal";
    assert.equal(existsSync(originalWal), true);
    assert.ok(statSync(originalWal).size > 0, "must copy actual WAL commits");
    const sourceFingerprint = sha256(originalPath);
    const walFingerprint = sha256(originalWal);

    assert.match(runPython(copyScript, "--source", originalPath, "--destination", rehearsalPath),
      /REHEARSAL_COPY_OK/);
    assert.match(runPython(auditScript, "capture", "--database", rehearsalPath,
      "--manifest", baselinePath), /M7_BASELINE_CAPTURE_OK/);

    const rehearsal = openDatabase(rehearsalPath); // Real v12 -> v16 M7 migration.
    try {
      assert.deepEqual(rehearsal.pragma("foreign_key_check"), []);
      assert.deepEqual(rehearsal.pragma("integrity_check"), [{ integrity_check: "ok" }]);
      assert.equal((rehearsal.prepare(
        "SELECT value FROM app_meta WHERE key='schema_version'",
      ).get() as { value: string }).value, "16");
      assert.equal((rehearsal.prepare(
        "SELECT value FROM app_meta WHERE key='active_workspace_id'",
      ).get() as { value: string }).value, "legacy");
      const migrated = rehearsal.prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
      );
      for (const table of [
        "qualification_round_questions", "qualification_question_reservations", "live_submissions",
      ]) {
        const definition = (migrated.get(table) as { sql: string }).sql;
        assert.doesNotMatch(definition, /BETWEEN 1 AND 10/);
        assert.match(definition, />= 1/);
      }
      assert.equal((rehearsal.prepare(
        "SELECT COUNT(*) AS count FROM live_submissions",
      ).get() as { count: number }).count, 20);
      assert.equal((rehearsal.prepare(
        "SELECT COUNT(*) AS count FROM qualification_round_questions",
      ).get() as { count: number }).count, 10);
      assert.equal((rehearsal.prepare(
        "SELECT value FROM app_meta WHERE key='custom_official_label'",
      ).get() as { value: string }).value, "historical-2026");
      assert.equal((rehearsal.prepare(
        "SELECT event_title AS title FROM audience_settings",
      ).get() as { title: string }).title, "بنك المعلومات — جامعة بابل 2026");
      assert.deepEqual(
        (rehearsal.prepare("SELECT bytes FROM audience_assets WHERE slot='university'")
          .get() as { bytes: Buffer }).bytes,
        Buffer.from("89504e470d0a1a0a00ff01", "hex"),
      );
      assert.equal((rehearsal.prepare(
        "SELECT access_token AS token FROM station_credentials WHERE station='A'",
      ).get() as { token: string }).token, "test-only-token-A-2026");
      const ranking = getQualificationRanking(rehearsal);
      assert.equal(ranking.entries.length, 2);
      assert.deepEqual(
        ranking.entries.map((entry) => ({
          name: entry.college.name,
          scorePoints: entry.scorePoints,
          correctAnswers: entry.correctAnswers,
          wrongAnswers: entry.wrongAnswers,
          totalResponseTimeMs: entry.totalResponseTimeMs,
          revealedQuestions: entry.revealedQuestions,
        })),
        [
          {
            name: "كلية التربية",
            scorePoints: 205,
            correctAnswers: 10,
            wrongAnswers: 0,
            totalResponseTimeMs: 13_750,
            revealedQuestions: 10,
          },
          {
            name: "كلية القانون",
            scorePoints: 100,
            correctAnswers: 5,
            wrongAnswers: 5,
            totalResponseTimeMs: 22_000,
            revealedQuestions: 10,
          },
        ],
        "M7 must preserve exact historical scores, counts and tiebreak timings",
      );

      // Verify the actual XLSX report users will download after migration,
      // not just underlying SQLite rows. Historical 25s/25-point wording,
      // participants, rank, points, timings and question totals must remain.
      const report = new ExcelJS.Workbook();
      await report.xlsx.load(await buildResultsWorkbook(rehearsal) as any);
      const summary = report.getWorksheet("Summary")!;
      const exportedRanking = report.getWorksheet("Ranking")!;
      const exportedRounds = report.getWorksheet("Rounds")!;
      assert.equal(summary.getRow(2).getCell(2).value,
        "بنك المعلومات — جامعة بابل 2026");
      assert.equal(summary.getRow(7).getCell(2).value, 25);
      assert.equal(summary.getRow(8).getCell(2).value, 25);
      assert.equal(summary.getRow(12).getCell(2).value, "college");
      assert.equal(exportedRanking.getRow(2).getCell(2).value, "كلية التربية");
      assert.equal(exportedRanking.getRow(2).getCell(4).value, 205);
      assert.equal(exportedRanking.getRow(2).getCell(5).value, 13_750);
      assert.equal(exportedRanking.getRow(3).getCell(2).value, "كلية القانون");
      assert.equal(exportedRanking.getRow(3).getCell(4).value, 100);
      assert.equal(exportedRanking.getRow(3).getCell(5).value, 22_000);
      assert.equal(exportedRounds.getRow(2).getCell(5).value, 205);
      assert.equal(exportedRounds.getRow(2).getCell(6).value, 100);
      assert.equal(exportedRounds.getRow(2).getCell(7).value, 10);
      assert.equal(exportedRounds.getRow(2).getCell(8).value, 10);
    } finally {
      rehearsal.close();
    }

    assert.match(runPython(auditScript, "verify", "--database", rehearsalPath,
      "--manifest", baselinePath), /M7_REHEARSAL_VERIFY_OK/);
    // Only AFTER proving the historical baseline is unchanged may the
    // rehearsal DB be edited to validate that v12's 10-slot constraints have
    // actually been widened (including all three legacy position tables).
    const expanded = openDatabase(rehearsalPath);
    try {
      expanded.transaction(() => {
        expanded.prepare(`
          INSERT INTO qualification_rounds(
            round_order,college_a_id,college_b_id,status
          ) VALUES(2,1,2,'PENDING')
        `).run();
        const round = (expanded.prepare(
          "SELECT id FROM qualification_rounds WHERE round_order=2",
        ).get() as {id:number}).id;
        expanded.prepare(
          "INSERT INTO qualification_round_question_sets(round_id,locked_at) VALUES(?,CURRENT_TIMESTAMP)",
        ).run(round);
        const question = expanded.prepare(`
          INSERT INTO questions(
            category_id,prompt,option_a,option_b,option_c,option_d,correct_option
          ) VALUES(1,'Question 11 after migration','A','B','C','D','A')
        `).run();
        const id = Number(question.lastInsertRowid);
        expanded.prepare(`
          INSERT INTO qualification_round_questions(round_id,position,question_id,category_id)
          VALUES(?,11,?,1)
        `).run(round,id);
        expanded.prepare(`
          INSERT INTO qualification_question_reservations(
            question_id,round_id,position,disposition,reserved_at
          ) VALUES(?,?,11,'ALLOCATED',CURRENT_TIMESTAMP)
        `).run(id,round);
        expanded.prepare(`
          INSERT INTO live_submissions(
            round_id,question_position,station,question_id,selected_option,
            submitted_at_epoch_ms,response_time_ms,is_correct,score_micros
          ) VALUES(?,11,'A',?,'A',1760354400011,100,1,25000000)
        `).run(round,id);
      })();
      assert.deepEqual(expanded.pragma("foreign_key_check"), []);
      assert.equal((expanded.prepare(`
        SELECT COUNT(*) AS count FROM qualification_round_questions
        WHERE position=11
      `).get() as {count:number}).count,1);
      assert.equal((expanded.prepare(`
        SELECT COUNT(*) AS count FROM qualification_question_reservations
        WHERE position=11
      `).get() as {count:number}).count,1);
      assert.equal((expanded.prepare(`
        SELECT COUNT(*) AS count FROM live_submissions
        WHERE question_position=11
      `).get() as {count:number}).count,1);
      // M7's newly created round must not rewrite the scores saved for the
      // historically completed first round.
      assert.equal((expanded.prepare(`
        SELECT SUM(score_micros) AS points FROM live_submissions
        WHERE round_id=1 AND station='A'
      `).get() as {points:number}).points,205_000_000);
    } finally {expanded.close();}

    const backups = readdirSync(join(dir, "migration-backups")).filter(
      (name) => name.endsWith(".sqlite3"),
    );
    assert.equal(backups.length, 1, "exactly one pre-M7 migration backup is expected");
    const beforeMigration = new Database(join(dir, "migration-backups", backups[0]!), {
      readonly: true, fileMustExist: true,
    });
    try {
      assert.equal((beforeMigration.prepare(
        "SELECT value FROM app_meta WHERE key='schema_version'",
      ).get() as { value: string }).value, "12");
      assert.equal((beforeMigration.prepare(
        "SELECT COUNT(*) AS count FROM live_submissions",
      ).get() as { count: number }).count, 20);
      assert.deepEqual(beforeMigration.pragma("integrity_check"), [{ integrity_check: "ok" }]);
    } finally { beforeMigration.close(); }

    // The originally seeded v12 database and its uncheckpointed WAL were
    // never opened writable by the migration or rehearsal tools.
    assert.equal(sha256(originalPath), sourceFingerprint);
    assert.equal(sha256(originalWal), walFingerprint);
    assert.equal((original.prepare(
      "SELECT value FROM app_meta WHERE key='schema_version'",
    ).get() as { value: string }).value, "12");
  } finally {
    original.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
