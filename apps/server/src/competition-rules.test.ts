import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { Server as SocketIOServer } from "socket.io";
import { openDatabase } from "./database.js";
import { getCompetitionRules, getRoundRules } from "./competition-rules.js";
import { LiveSessionManager } from "./live-session.js";
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

    const rows = db.prepare("SELECT position, question_id AS questionId FROM qualification_round_questions").all() as Array<{ position: number; questionId: number }>;
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

test("M7.4 supports 5, 15 and 20 questions in separate rounds with no repeats", async () => {
  const db = openDatabase(":memory:");
  const app = Fastify();
  const io = new SocketIOServer(app.server);
  try {
    db.exec(`
      INSERT INTO colleges (name, sort_order) VALUES ('A',1),('B',2);
      INSERT INTO qualification_rounds(round_order,college_a_id,college_b_id)
        VALUES(1,1,2),(2,1,2),(3,1,2);
      INSERT INTO categories(category_key,name,display_name,sort_order)
        VALUES('sports','Sports Specialist','رياضة',1),('geo','Geography','جغرافيا',2);
      UPDATE competition_rules
        SET distribution_json='[{"categoryKey":"sports","questions":20}]' WHERE id=1;
    `);
    const insert = db.prepare(`
      INSERT INTO questions(category_id,prompt,option_a,option_b,option_c,option_d,correct_option)
      VALUES(?,?,'A','B','C','D','A')
    `);
    for (let i = 0; i < 37; i++) insert.run(1,"Sport #"+i);
    for (let i = 0; i < 3; i++) insert.run(2,"Geo #"+i);
    registerQuestionBankRoutes(app,db,io);
    await app.ready();
    const put = (id: number, categories: Array<{categoryKey:string;questions:number}>) =>
      app.inject({ method:"PUT",url:`/api/competition/rounds/${id}/rules`,payload:{categories}});
    assert.equal((await put(1,[{categoryKey:"sports",questions:5}])).statusCode,200);
    assert.equal((await put(2,[{categoryKey:"sports",questions:12},{categoryKey:"geo",questions:3}])).statusCode,200);
    assert.equal(getRoundRules(db,1).questionsPerRound,5);
    assert.equal(getRoundRules(db,2).questionsPerRound,15);
    assert.equal(getRoundRules(db,3).questionsPerRound,20);
    const before = getQuestionAllocationSummary(db);
    assert.deepEqual(before.rounds.map((r) => r.plannedQuestionCount),[5,15,20]);
    assert.equal(before.categories.find((category) => category.key==="sports")?.requiredQuestions,37);
    assert.equal(before.categories.find((category) => category.key==="geo")?.requiredQuestions,3);

    const response = await app.inject({
      method:"POST",url:"/api/question-bank/allocate",
      payload:{confirm:"ALLOCATE_QUESTIONS"},
    });
    assert.equal(response.statusCode,200,response.body);
    const after = getQuestionAllocationSummary(db);
    assert.equal(after.ready,true);
    assert.deepEqual(after.rounds.map((r) => r.questionCount),[5,15,20]);
    assert.deepEqual(after.rounds[1]?.categoryCounts,{sports:12,geo:3});
    const rows = db.prepare("SELECT question_id AS questionId FROM qualification_round_questions").all() as Array<{questionId:number}>;
    assert.equal(rows.length,40);
    assert.equal(new Set(rows.map((r) => r.questionId)).size,40);

    const blocked = await put(1,[{categoryKey:"sports",questions:6}]);
    assert.equal(blocked.statusCode,409);
    const manager = new LiveSessionManager(db,io);
    try {
      const prepared = manager.prepareRound(1);
      assert.equal(prepared.questionsPerRound,5);
      assert.equal(prepared.round?.order,1);
    } finally { manager.dispose(); }
  } finally {
    io.close();
    await app.close();
    db.close();
  }
});

test("M7.4 rejects unsafe per-round plans and allows restoring default", async () => {
  const db = openDatabase(":memory:");
  const app = Fastify();
  const io = new SocketIOServer(app.server);
  try {
    db.exec(`
      INSERT INTO colleges(name,sort_order) VALUES('A',1);
      INSERT INTO qualification_rounds(round_order,college_a_id) VALUES(1,1);
      INSERT INTO categories(category_key,name,sort_order) VALUES('sports','Sports',1);
      UPDATE competition_rules SET distribution_json='[{"categoryKey":"sports","questions":9}]';
    `);
    registerQuestionBankRoutes(app,db,io);
    await app.ready();
    const put = (categories: unknown) => app.inject({
      method:"PUT",url:"/api/competition/rounds/1/rules",payload:{categories},
    });
    assert.equal((await put([{categoryKey:"sports",questions:101}])).statusCode,400);
    assert.equal((await put([{categoryKey:"sports",questions:10},{categoryKey:"sports",questions:2}])).statusCode,400);
    assert.equal((await put([{categoryKey:"missing",questions:2}])).statusCode,400);
    assert.equal((await put([{categoryKey:"sports",questions:1}])).statusCode,200);
    assert.equal(getRoundRules(db,1).questionsPerRound,1);
    assert.equal((await app.inject({method:"DELETE",url:"/api/competition/rounds/1/rules"})).statusCode,200);
    assert.equal(getRoundRules(db,1).questionsPerRound,9);
  } finally {
    io.close();
    await app.close();
    db.close();
  }
});
