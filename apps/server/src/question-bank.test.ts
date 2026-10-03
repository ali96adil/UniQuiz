import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { Server as SocketIOServer } from "socket.io";
import { openDatabase } from "./database.js";
import { registerQuestionBankRoutes } from "./question-bank.js";

test("allocate -> void/replace -> audit -> reset preserves invariants", async () => {
  const db = openDatabase(":memory:");

  db.exec(`
    INSERT INTO colleges (name, sort_order) VALUES
      ('College A', 1),
      ('College B', 2);

    INSERT INTO qualification_rounds (
      round_order,
      college_a_id,
      college_b_id,
      status
    )
    VALUES (1, 1, 2, 'PENDING');

    INSERT INTO categories (category_key, name, sort_order) VALUES
      ('c1', 'Category 1', 1),
      ('c2', 'Category 2', 2),
      ('c3', 'Category 3', 3),
      ('c4', 'Category 4', 4),
      ('c5', 'Category 5', 5);
  `);

  const insertQuestion = db.prepare(`
    INSERT INTO questions (
      category_id,
      prompt,
      option_a,
      option_b,
      option_c,
      option_d,
      correct_option
    )
    VALUES (?, ?, 'A', 'B', 'C', 'D', 'A')
  `);

  for (let categoryId = 1; categoryId <= 5; categoryId += 1) {
    for (let index = 1; index <= 3; index += 1) {
      insertQuestion.run(
        categoryId,
        `Category ${categoryId} Question ${index}`,
      );
    }
  }

  const app = Fastify();
  const io = new SocketIOServer(app.server);
  registerQuestionBankRoutes(app, db, io);
  await app.ready();

  const allocate = await app.inject({
    method: "POST",
    url: "/api/question-bank/allocate",
    payload: {
      confirm: "ALLOCATE_QUESTIONS",
    },
  });

  assert.equal(allocate.statusCode, 200);

  const allocatedRows = db.prepare(`
    SELECT
      round_id AS roundId,
      position,
      question_id AS questionId,
      category_id AS categoryId
    FROM qualification_round_questions
    ORDER BY position
  `).all() as Array<{
    roundId: number;
    position: number;
    questionId: number;
    categoryId: number;
  }>;

  assert.equal(allocatedRows.length, 10);
  assert.equal(new Set(allocatedRows.map((row) => row.questionId)).size, 10);

  const categoryCounts = new Map<number, number>();
  for (const row of allocatedRows) {
    categoryCounts.set(
      row.categoryId,
      (categoryCounts.get(row.categoryId) ?? 0) + 1,
    );
  }
  assert.deepEqual(
    [...categoryCounts.values()].sort((a, b) => a - b),
    [2, 2, 2, 2, 2],
  );

  const original = allocatedRows[0];
  assert.ok(original);

  db.prepare(`
    INSERT INTO live_submissions (
      round_id,
      question_position,
      station,
      question_id,
      selected_option,
      submitted_at_epoch_ms,
      response_time_ms,
      is_correct,
      score_micros
    )
    VALUES (?, ?, 'A', ?, 'A', 1000, 1000, 1, 25000000)
  `).run(
    original.roundId,
    original.position,
    original.questionId,
  );

  const voidResponse = await app.inject({
    method: "POST",
    url: "/api/question-bank/void-replace",
    payload: {
      roundId: original.roundId,
      position: original.position,
      reason: "Technical issue during presentation",
      confirm: "VOID_AND_REPLACE",
    },
  });

  assert.equal(voidResponse.statusCode, 200);
  const replacementPayload = voidResponse.json() as {
    replacementQuestionId: number;
    voidedQuestionId: number;
  };

  assert.equal(replacementPayload.voidedQuestionId, original.questionId);
  assert.notEqual(
    replacementPayload.replacementQuestionId,
    original.questionId,
  );

  const replacement = db.prepare(`
    SELECT
      question_id AS questionId,
      category_id AS categoryId
    FROM qualification_round_questions
    WHERE round_id = ?
      AND position = ?
  `).get(original.roundId, original.position) as {
    questionId: number;
    categoryId: number;
  };

  assert.equal(
    replacement.questionId,
    replacementPayload.replacementQuestionId,
  );
  assert.equal(replacement.categoryId, original.categoryId);

  const oldReservation = db.prepare(`
    SELECT disposition
    FROM qualification_question_reservations
    WHERE question_id = ?
  `).get(original.questionId) as { disposition: string };

  const newReservation = db.prepare(`
    SELECT disposition
    FROM qualification_question_reservations
    WHERE question_id = ?
  `).get(replacement.questionId) as { disposition: string };

  assert.equal(oldReservation.disposition, "VOIDED");
  assert.equal(newReservation.disposition, "REPLACEMENT");

  const audit = db.prepare(`
    SELECT
      event_type AS eventType,
      question_id AS questionId,
      related_question_id AS relatedQuestionId,
      reason
    FROM audit_events
    WHERE event_type = 'QUESTION_VOID_REPLACED'
  `).get() as {
    eventType: string;
    questionId: number;
    relatedQuestionId: number;
    reason: string;
  };

  assert.equal(audit.eventType, "QUESTION_VOID_REPLACED");
  assert.equal(audit.questionId, original.questionId);
  assert.equal(audit.relatedQuestionId, replacement.questionId);
  assert.equal(audit.reason, "Technical issue during presentation");

  const remainingSubmissionCount = db.prepare(`
    SELECT COUNT(*) AS count
    FROM live_submissions
    WHERE round_id = ?
      AND question_position = ?
  `).get(
    original.roundId,
    original.position,
  ) as { count: number };

  assert.equal(remainingSubmissionCount.count, 0);

  const reset = await app.inject({
    method: "POST",
    url: "/api/question-bank/allocation/reset",
    payload: {
      confirm: "RESET_QUESTION_SETS",
    },
  });

  assert.equal(reset.statusCode, 200);

  const reservationCount = db.prepare(`
    SELECT COUNT(*) AS count
    FROM qualification_question_reservations
  `).get() as { count: number };

  const setCount = db.prepare(`
    SELECT COUNT(*) AS count
    FROM qualification_round_question_sets
  `).get() as { count: number };

  assert.equal(reservationCount.count, 0);
  assert.equal(setCount.count, 0);

  // Audit history must not prevent replacing the question bank later.
  assert.doesNotThrow(() => {
    db.prepare("DELETE FROM questions").run();
  });

  io.close();
  await app.close();
  db.close();
});
