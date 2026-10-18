import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { Server as SocketIOServer } from "socket.io";
import { openDatabase } from "./database.js";
import { getCompetitionRules } from "./competition-rules.js";
import { getQuestionAllocationSummary, registerQuestionBankRoutes } from "./question-bank.js";

test("M7: 12 questions from one internal category, with no repeats across rounds", async () => {
  const db = openDatabase(":memory:");
  const app = Fastify();
  const io = new SocketIOServer(app.server);
  try {
    db.exec(`
      INSERT INTO colleges (name, sort_order) VALUES ('فريق A', 1), ('فريق B', 2);
      INSERT INTO qualification_rounds (round_order, college_a_id, college_b_id)
      VALUES (1, 1, 2), (2, 1, 2);
      INSERT INTO categories (category_key, name, display_name, sort_order)
      VALUES ('sports_specialist', 'رياضة تخصصية', 'رياضة', 1);
    `);
    const insert = db.prepare(`
      INSERT INTO questions (category_id, prompt, option_a, option_b, option_c, option_d, correct_option)
      VALUES (1, ?, 'A', 'B', 'C', 'D', 'A')
    `);
    for (let i = 1; i <= 24; i++) insert.run("رياضة رقم " + i);
    registerQuestionBankRoutes(app, db, io);
    await app.ready();

    const setRules = await app.inject({
      method: "PUT",
      url: "/api/competition/rules",
      payload: { categories: [{ categoryKey: "sports_specialist", questions: 12 }] },
    });
    assert.equal(setRules.statusCode, 200, setRules.body);
    assert.equal(getCompetitionRules(db).questionsPerRound, 12);
    const before = getQuestionAllocationSummary(db);
    assert.equal(before.categories[0].quotaPerRound, 12);
    assert.equal(before.categories[0].requiredQuestions, 24);

    const response = await app.inject({
      method: "POST",
      url: "/api/question-bank/allocate",
      payload: { confirm: "ALLOCATE_QUESTIONS" },
    });
    assert.equal(response.statusCode, 200, response.body);
    const allocated = getQuestionAllocationSummary(db);
    assert.equal(allocated.questionsPerRound, 12);
    assert.equal(allocated.ready, true);
    assert.ok(allocated.rounds.every((round) => round.questionCount === 12));

    const rows = db.prepare("SELECT position, question_id AS questionId FROM qualification_round_questions").all()
      as Array<{ position: number; questionId: number }>;
    assert.equal(rows.length, 24);
    assert.equal(new Set(rows.map((r) => r.questionId)).size, 24);
    assert.ok(rows.some((r) => r.position === 12));

    const change = await app.inject({
      method: "PUT",
      url: "/api/competition/rules",
      payload: { categories: [{ categoryKey: "sports_specialist", questions: 10 }] },
    });
    assert.equal(change.statusCode, 409, change.body);
    assert.equal(getCompetitionRules(db).questionsPerRound, 12);
  } finally {
    io.close();
    await app.close();
    db.close();
  }
});

test("M7: legacy 1..10 SQLite constraints widen transactionally without losing results", () => {
  const dir = mkdtempSync(join(tmpdir(), "uniquiz-m7-schema-"));
  const path = join(dir, "legacy.db");
  try {
    const db = openDatabase(path);
    db.pragma("foreign_keys = OFF");
    for (const table of [
      "qualification_round_questions",
      "qualification_question_reservations",
      "live_submissions",
    ]) {
      const row = db.prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
      ).get(table) as { sql: string };
      db.exec("DROP TABLE " + table);
      const legacy = row.sql.replace(
        /CHECK\s*\(\s*(question_position|position)\s*>=\s*1\s*\)/g,
        (_, col: string) => "CHECK (" + col + " BETWEEN 1 AND 10)",
      );
      db.exec(legacy);
    }
    db.pragma("foreign_keys = ON");
    db.exec(`
      INSERT INTO colleges (name, sort_order) VALUES ('Team', 1);
      INSERT INTO qualification_rounds (round_order, college_a_id) VALUES (1, 1);
      INSERT INTO categories (category_key, name, sort_order) VALUES ('sports', 'Sports', 1);
      INSERT INTO questions (category_id, prompt, option_a, option_b, option_c, option_d, correct_option)
      VALUES (1, 'Old question', 'A', 'B', 'C', 'D', 'A');
      INSERT INTO qualification_round_question_sets (round_id, locked_at) VALUES (1, CURRENT_TIMESTAMP);
      INSERT INTO qualification_round_questions (round_id, position, question_id, category_id) VALUES (1, 10, 1, 1);
      INSERT INTO qualification_question_reservations
        (question_id, round_id, position, disposition, reserved_at)
      VALUES (1, 1, 10, 'ALLOCATED', CURRENT_TIMESTAMP);
      INSERT INTO live_submissions
        (round_id, question_position, station, question_id, selected_option,
         submitted_at_epoch_ms, response_time_ms, is_correct, score_micros)
      VALUES (1, 10, 'A', 1, 'A', 1000, 100, 1, 2000000);
    `);
    db.close();

    const upgraded = openDatabase(path);
    try {
      const old = upgraded.prepare("SELECT question_id AS questionId FROM qualification_round_questions WHERE position=10")
        .get() as { questionId: number };
      assert.equal(old.questionId, 1);
      assert.equal((upgraded.prepare("SELECT score_micros AS score FROM live_submissions").get() as {score:number}).score, 2_000_000);
      upgraded.prepare("INSERT INTO questions (category_id, prompt, option_a, option_b, option_c, option_d, correct_option) VALUES (1,'New question','A','B','C','D','A')").run();
      upgraded.prepare("INSERT INTO qualification_round_questions (round_id,position,question_id,category_id) VALUES (1,12,2,1)").run();
      upgraded.prepare("INSERT INTO qualification_question_reservations (question_id,round_id,position,disposition,reserved_at) VALUES (2,1,12,'ALLOCATED',CURRENT_TIMESTAMP)").run();
      upgraded.prepare("INSERT INTO live_submissions (round_id,question_position,station,question_id,selected_option,submitted_at_epoch_ms,response_time_ms,is_correct,score_micros) VALUES (1,12,'A',2,'A',2000,100,1,2000000)").run();
      assert.deepEqual(upgraded.pragma("foreign_key_check"), []);
    } finally { upgraded.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
