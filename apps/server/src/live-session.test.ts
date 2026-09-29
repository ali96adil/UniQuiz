import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { Server as SocketIOServer } from "socket.io";
import { openDatabase } from "./database.js";
import { LiveSessionManager } from "./live-session.js";

function seedLiveRound() {
  const db = openDatabase(":memory:");

  db.exec(`
    INSERT INTO colleges (name, sort_order) VALUES
      ('Team College A', 1),
      ('Team College B', 2);

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

  let questionId = 0;
  for (let position = 1; position <= 10; position += 1) {
    const categoryId = ((position - 1) % 5) + 1;
    const correctOption = position === 1 ? "B" : "A";
    const result = insertQuestion.run(
      categoryId,
      `Question ${position}`,
      correctOption,
    );
    questionId = Number(result.lastInsertRowid);
    insertRoundQuestion.run(
      position,
      questionId,
      categoryId,
    );
  }

  return db;
}

test("team answers lock once and paired round closes after both submit", async () => {
  const db = seedLiveRound();
  const app = Fastify();
  const io = new SocketIOServer(app.server);
  const manager = new LiveSessionManager(db, io, 1, 30_000);

  manager.prepareRound(1);
  manager.confirmStations();
  manager.startRound();
  manager.prepareNextQuestion();
  manager.startQuestion();

  await new Promise((resolve) => setTimeout(resolve, 5));

  const first = manager.submitAnswer("team-a", "B");
  assert.equal(first.station, "A");
  assert.equal(manager.getSnapshot().phase, "QUESTION_ACTIVE");

  assert.throws(
    () => manager.submitAnswer("team-a", "A"),
    /ANSWER_ALREADY_LOCKED/,
  );

  const second = manager.submitAnswer("team-b", "C");
  assert.equal(second.station, "B");

  const snapshot = manager.getSnapshot();
  assert.equal(snapshot.phase, "QUESTION_CLOSED");
  assert.equal(snapshot.closeReason, "ALL_TEAMS_ANSWERED");
  assert.equal(snapshot.answerStatus.teamAReceived, true);
  assert.equal(snapshot.answerStatus.teamBReceived, true);

  const submissions = db.prepare(`
    SELECT
      station,
      selected_option AS selectedOption,
      is_correct AS isCorrect,
      score_micros AS scoreMicros
    FROM live_submissions
    ORDER BY station
  `).all() as Array<{
    station: string;
    selectedOption: string;
    isCorrect: number;
    scoreMicros: number;
  }>;

  assert.equal(submissions.length, 2);
  assert.equal(submissions[0]?.station, "A");
  assert.equal(submissions[0]?.selectedOption, "B");
  assert.equal(submissions[0]?.isCorrect, 1);
  assert.ok((submissions[0]?.scoreMicros ?? 0) > 0);
  assert.equal(submissions[1]?.station, "B");
  assert.equal(submissions[1]?.isCorrect, 0);
  assert.equal(submissions[1]?.scoreMicros, 0);

  const recovered = manager.getTeamSubmissionState("team-a");
  assert.equal(recovered?.locked, true);
  assert.equal(recovered?.selectedOption, "B");

  io.close();
  await app.close();
  db.close();
});

test("solo round requires only Team A and closes on its answer", async () => {
  const db = seedLiveRound();
  db.prepare(`
    UPDATE qualification_rounds
    SET college_b_id = NULL
    WHERE id = 1
  `).run();

  const app = Fastify();
  const io = new SocketIOServer(app.server);
  const manager = new LiveSessionManager(db, io, 1, 30_000);

  manager.prepareRound(1);
  manager.confirmStations();
  manager.startRound();
  manager.prepareNextQuestion();
  manager.startQuestion();

  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.throws(
    () => manager.submitAnswer("team-b", "A"),
    /TEAM_B_NOT_USED_IN_SOLO_ROUND/,
  );

  manager.submitAnswer("team-a", "A");

  const snapshot = manager.getSnapshot();
  assert.equal(snapshot.phase, "QUESTION_CLOSED");
  assert.equal(snapshot.closeReason, "SOLO_ANSWERED");
  assert.equal(snapshot.answerStatus.teamARequired, true);
  assert.equal(snapshot.answerStatus.teamBRequired, false);

  io.close();
  await app.close();
  db.close();
});


test("start round rechecks station readiness after confirmation", () => {
  const db = seedLiveRound();
  const app = Fastify();
  const io = new SocketIOServer(app.server);

  let teamAConnected = true;
  let teamBConnected = true;

  const manager = new LiveSessionManager(
    db,
    io,
    1,
    30_000,
    undefined,
    (role) =>
      role === "team-a"
        ? teamAConnected
        : teamBConnected,
  );

  manager.prepareRound(1);
  manager.confirmStations();
  assert.equal(manager.getSnapshot().stationsConfirmed, true);

  teamBConnected = false;

  assert.throws(
    () => manager.startRound(),
    /TEAM_B_NOT_READY/,
  );

  const snapshot = manager.getSnapshot();
  assert.equal(snapshot.phase, "ROUND_READY");
  assert.equal(snapshot.stationsConfirmed, false);
  assert.equal(snapshot.stationReadiness.teamAConnected, true);
  assert.equal(snapshot.stationReadiness.teamBConnected, false);

  teamBConnected = true;
  manager.confirmStations();
  manager.startRound();

  assert.equal(manager.getSnapshot().phase, "ROUND_ACTIVE");

  io.close();
  void app.close();
  db.close();
});


test("automatically reveals only after all required teams answer", async () => {
  const db = seedLiveRound();
  const app = Fastify();
  const io = new SocketIOServer(app.server);

  const events: string[] = [];
  const manager = new LiveSessionManager(
    db,
    io,
    1,
    30_000,
    {
      send(address) {
        events.push(address);
      },
    },
    () => true,
    10,
  );

  manager.prepareRound(1);
  manager.confirmStations();
  manager.startRound();
  manager.prepareNextQuestion();
  manager.startQuestion();

  await new Promise((resolve) => setTimeout(resolve, 5));

  manager.submitAnswer("team-a", "B");

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(manager.getSnapshot().phase, "QUESTION_ACTIVE");
  assert.equal(
    events.includes("/uniquiz/question/reveal"),
    false,
  );

  manager.submitAnswer("team-b", "C");
  assert.equal(manager.getSnapshot().phase, "QUESTION_CLOSED");

  const answeredIndex = events.lastIndexOf(
    "/uniquiz/question/answered",
  );
  assert.ok(answeredIndex >= 0);

  await new Promise((resolve) => setTimeout(resolve, 20));

  const revealed = manager.getSnapshot();
  assert.equal(revealed.phase, "QUESTION_REVEAL");
  assert.equal(revealed.question?.correctOption, "B");

  const revealIndex = events.lastIndexOf(
    "/uniquiz/question/reveal",
  );
  assert.ok(revealIndex > answeredIndex);

  io.close();
  await app.close();
  db.close();
});


test("reveal results stay hidden until reveal", async () => {
  const db = seedLiveRound();
  const app = Fastify();
  const io = new SocketIOServer(app.server);
  const manager = new LiveSessionManager(
    db,
    io,
    1,
    30_000,
    undefined,
    () => true,
    1000,
  );

  manager.prepareRound(1);
  manager.confirmStations();
  manager.startRound();
  manager.prepareNextQuestion();
  manager.startQuestion();

  await new Promise((resolve) => setTimeout(resolve, 5));

  manager.submitAnswer("team-a", "B");
  let snapshot = manager.getSnapshot();
  assert.equal(snapshot.phase, "QUESTION_ACTIVE");
  assert.equal(snapshot.revealResults, null);

  manager.submitAnswer("team-b", "C");
  snapshot = manager.getSnapshot();
  assert.equal(snapshot.phase, "QUESTION_CLOSED");
  assert.equal(snapshot.revealResults, null);

  manager.revealQuestion();
  snapshot = manager.getSnapshot();

  assert.equal(snapshot.phase, "QUESTION_REVEAL");
  assert.equal(snapshot.revealResults?.teamA.answered, true);
  assert.equal(snapshot.revealResults?.teamA.selectedOption, "B");
  assert.equal(snapshot.revealResults?.teamA.isCorrect, true);
  assert.ok((snapshot.revealResults?.teamA.scorePoints ?? 0) > 0);

  assert.equal(snapshot.revealResults?.teamB?.answered, true);
  assert.equal(snapshot.revealResults?.teamB?.selectedOption, "C");
  assert.equal(snapshot.revealResults?.teamB?.isCorrect, false);
  assert.equal(snapshot.revealResults?.teamB?.scorePoints, 0);

  io.close();
  await app.close();
  db.close();
});
