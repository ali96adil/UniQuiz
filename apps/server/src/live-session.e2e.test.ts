import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { Server as SocketIOServer } from "socket.io";
import type { ShowControlOutput } from "./osc-output.js";
import { openDatabase } from "./database.js";
import { LiveSessionManager } from "./live-session.js";

function seedRound() {
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

    INSERT INTO qualification_round_question_sets (
      round_id,
      locked_at
    )
    VALUES (1, CURRENT_TIMESTAMP);
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
    VALUES (?, ?, 'A', 'B', 'C', 'D', ?)
  `);

  const insertRoundQuestion = db.prepare(`
    INSERT INTO qualification_round_questions (
      round_id,
      position,
      question_id,
      category_id
    )
    VALUES (1, ?, ?, ?)
  `);

  for (let position = 1; position <= 10; position += 1) {
    const categoryId = ((position - 1) % 5) + 1;
    const correctOption = position % 2 === 0 ? "B" : "A";
    const result = insertQuestion.run(
      categoryId,
      `Question ${position}`,
      correctOption,
    );

    insertRoundQuestion.run(
      position,
      Number(result.lastInsertRowid),
      categoryId,
    );
  }

  return db;
}

test("complete paired round runs 10 operator-paced questions end-to-end", async () => {
  const db = seedRound();
  const app = Fastify();
  const io = new SocketIOServer(app.server);

  const oscEvents: Array<{
    address: string;
    args: readonly (string | number)[];
  }> = [];

  const showControl: ShowControlOutput = {
    send(address, args = []) {
      oscEvents.push({ address, args });
    },
  };

  const manager = new LiveSessionManager(
    db,
    io,
    1,
    45_000,
    showControl,
    () => true,
    5,
  );

  manager.prepareRound(1);
  assert.equal(manager.getSnapshot().phase, "ROUND_READY");

  manager.confirmStations();
  assert.equal(manager.getSnapshot().stationsConfirmed, true);

  manager.startRound();
  assert.equal(manager.getSnapshot().phase, "ROUND_ACTIVE");

  for (let position = 1; position <= 10; position += 1) {
    const ready = manager.prepareNextQuestion();
    assert.equal(ready.phase, "QUESTION_READY");
    assert.equal(ready.question?.position, position);
    assert.equal(ready.question?.prompt, null);

    const countdown = manager.startQuestion();
    assert.equal(countdown.phase, "QUESTION_COUNTDOWN");
    assert.equal(countdown.question?.prompt, null);

    await new Promise((resolve) => setTimeout(resolve, 5));

    const active = manager.getSnapshot();
    assert.equal(active.phase, "QUESTION_ACTIVE");
    assert.equal(active.question?.position, position);
    assert.ok(active.question?.prompt);
    assert.equal(active.question?.correctOption, null);

    manager.submitAnswer(
      "team-a",
      position % 2 === 0 ? "B" : "A",
    );

    assert.equal(
      manager.getSnapshot().phase,
      "QUESTION_ACTIVE",
    );

    manager.submitAnswer("team-b", "C");

    const closed = manager.getSnapshot();
    assert.equal(closed.phase, "QUESTION_CLOSED");
    assert.equal(closed.closeReason, "ALL_TEAMS_ANSWERED");

    assert.equal(closed.question?.correctOption, null);

    await new Promise((resolve) => setTimeout(resolve, 10));

    const reveal = manager.getSnapshot();
    assert.equal(reveal.phase, "QUESTION_REVEAL");
    assert.ok(reveal.question?.correctOption);
  }

  const completed = manager.completeRound();
  assert.equal(completed.phase, "ROUND_COMPLETE");
  assert.equal(completed.hasPendingRound, false);
  assert.equal(completed.qualificationComplete, true);

  assert.throws(
    () => manager.prepareRound(),
    /QUALIFICATION_COMPLETE/,
  );

  const round = db.prepare(`
    SELECT status
    FROM qualification_rounds
    WHERE id = 1
  `).get() as { status: string };

  assert.equal(round.status, "COMPLETED");

  const submissions = db.prepare(`
    SELECT
      COUNT(*) AS count,
      COUNT(DISTINCT question_position) AS questions
    FROM live_submissions
    WHERE round_id = 1
  `).get() as { count: number; questions: number };

  assert.equal(submissions.count, 20);
  assert.equal(submissions.questions, 10);

  const correctA = db.prepare(`
    SELECT COUNT(*) AS count
    FROM live_submissions
    WHERE round_id = 1
      AND station = 'A'
      AND is_correct = 1
  `).get() as { count: number };

  assert.equal(correctA.count, 10);

  const audit = db.prepare(`
    SELECT COUNT(*) AS count
    FROM audit_events
    WHERE round_id = 1
  `).get() as { count: number };

  assert.ok(audit.count >= 42);

  assert.ok(
    oscEvents.some((event) => event.address === "/uniquiz/round/start"),
  );
  assert.equal(
    oscEvents.filter(
      (event) => event.address === "/uniquiz/question/start",
    ).length,
    10,
  );
  assert.equal(
    oscEvents.filter(
      (event) => event.address === "/uniquiz/question/answered",
    ).length,
    10,
  );
  assert.equal(
    oscEvents.filter(
      (event) => event.address === "/uniquiz/question/reveal",
    ).length,
    10,
  );
  assert.equal(
    oscEvents.filter(
      (event) => event.address === "/uniquiz/round/complete",
    ).length,
    1,
  );

  io.close();
  await app.close();
  db.close();
});

test("required station readiness blocks confirmation", () => {
  const db = seedRound();
  const app = Fastify();
  const io = new SocketIOServer(app.server);

  const manager = new LiveSessionManager(
    db,
    io,
    1,
    45_000,
    undefined,
    (role) => role === "team-a",
  );

  manager.prepareRound(1);

  assert.throws(
    () => manager.confirmStations(),
    /TEAM_B_NOT_READY/,
  );

  io.close();
  void app.close();
  db.close();
});

test("throwing show-control output cannot stop official live flow", async () => {
  const db = seedRound();
  const app = Fastify();
  const io = new SocketIOServer(app.server);

  const brokenShowControl: ShowControlOutput = {
    send() {
      throw new Error("OSC receiver unavailable");
    },
  };

  const manager = new LiveSessionManager(
    db,
    io,
    1,
    45_000,
    brokenShowControl,
    () => true,
  );

  assert.doesNotThrow(() => {
    manager.prepareRound(1);
    manager.confirmStations();
    manager.startRound();
    manager.prepareNextQuestion();
    manager.startQuestion();
  });

  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.equal(
    manager.getSnapshot().phase,
    "QUESTION_ACTIVE",
  );

  assert.doesNotThrow(() => {
    manager.submitAnswer("team-a", "A");
    manager.submitAnswer("team-b", "B");
  });

  assert.equal(
    manager.getSnapshot().phase,
    "QUESTION_CLOSED",
  );

  io.close();
  await app.close();
  db.close();
});
