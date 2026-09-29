import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import { openDatabase } from "./database.js";
import { buildResultsWorkbook } from "./results-export.js";

test("results workbook contains ranking, submissions and audit", async () => {
  const db = openDatabase(":memory:");

  db.exec(`
    INSERT INTO colleges (name, sort_order) VALUES
      ('College A', 1),
      ('College B', 2);
    INSERT INTO participants (college_id) VALUES (1), (2);
    INSERT INTO qualification_rounds (
      round_order, college_a_id, college_b_id, status
    ) VALUES (1, 1, 2, 'ACTIVE');
    INSERT INTO categories (category_key, name, sort_order)
    VALUES ('general', 'General', 1);
    INSERT INTO questions (
      category_id, prompt, option_a, option_b, option_c, option_d, correct_option
    ) VALUES (1, 'Question', 'A', 'B', 'C', 'D', 'A');
    INSERT INTO live_submissions (
      round_id, question_position, station, question_id,
      selected_option, submitted_at_epoch_ms, response_time_ms,
      is_correct, score_micros
    ) VALUES
      (1, 1, 'A', 1, 'A', 1000, 1000, 1, 25000000),
      (1, 1, 'B', 1, 'B', 2000, 2000, 0, 0);
    INSERT INTO audit_events (
      event_type, round_id, question_id, position, occurred_at
    ) VALUES
      ('QUESTION_REVEALED', 1, 1, 1, '2026-09-29T00:00:00.000Z');
  `);

  const buffer = await buildResultsWorkbook(db);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as any);

  const ranking = workbook.getWorksheet("Ranking");
  const rounds = workbook.getWorksheet("Rounds");
  const submissions = workbook.getWorksheet("Submissions");
  const audit = workbook.getWorksheet("Audit");

  assert.ok(ranking);
  assert.ok(rounds);
  assert.ok(submissions);
  assert.ok(audit);

  assert.equal(ranking.getRow(2).getCell(2).text, "College A");
  assert.equal(ranking.getRow(2).getCell(4).value, 25);
  assert.equal(rounds.getRow(2).getCell(5).value, 25);
  assert.equal(submissions.rowCount, 3);
  assert.equal(submissions.getRow(2).getCell(13).text, "yes");
  assert.equal(audit.getRow(2).getCell(2).text, "QUESTION_REVEALED");

  db.close();
});
