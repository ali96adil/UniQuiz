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


test("round totals include only revealed question scores", async () => {
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
  manager.submitAnswer("team-b", "C");

  let snapshot = manager.getSnapshot();
  assert.equal(snapshot.roundTotals?.teamA, 0);
  assert.equal(snapshot.roundTotals?.teamB, 0);

  manager.revealQuestion();
  snapshot = manager.getSnapshot();

  assert.ok((snapshot.roundTotals?.teamA ?? 0) > 0);
  assert.equal(snapshot.roundTotals?.teamB, 0);

  io.close();
  await app.close();
  db.close();
});


test("restart during countdown returns the same question to ready", () => {
  const db = seedLiveRound();
  db.prepare(`
    UPDATE qualification_rounds
    SET status = 'ACTIVE'
    WHERE id = 1
  `).run();

  db.prepare(`
    UPDATE live_state
    SET
      phase = 'QUESTION_COUNTDOWN',
      round_id = 1,
      question_position = 1,
      stations_confirmed = 1,
      countdown_started_at_epoch_ms = ?,
      question_started_at_epoch_ms = NULL,
      question_closed_at_epoch_ms = NULL,
      close_reason = NULL,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = 1
  `).run(Date.now() - 1000);

  const app = Fastify();
  const io = new SocketIOServer(app.server);
  const manager = new LiveSessionManager(
    db,
    io,
    3000,
    30_000,
  );

  const snapshot = manager.getSnapshot();
  assert.equal(snapshot.phase, "QUESTION_READY");
  assert.equal(snapshot.question?.position, 1);
  assert.equal(snapshot.countdownStartedAtEpochMs, null);

  const audit = db.prepare(`
    SELECT reason, payload_json AS payloadJson
    FROM audit_events
    WHERE event_type = 'LIVE_RECOVERY'
    ORDER BY id DESC
    LIMIT 1
  `).get() as {
    reason: string;
    payloadJson: string;
  };

  assert.equal(
    audit.reason,
    "SERVER_RESTART_DURING_COUNTDOWN",
  );
  assert.match(audit.payloadJson, /REQUIRE_NEW_START/);

  io.close();
  void app.close();
  db.close();
});

test("restart during active question fail-closes and requires void replacement", () => {
  const db = seedLiveRound();
  db.prepare(`
    UPDATE qualification_rounds
    SET status = 'ACTIVE'
    WHERE id = 1
  `).run();

  db.prepare(`
    UPDATE live_state
    SET
      phase = 'QUESTION_ACTIVE',
      round_id = 1,
      question_position = 1,
      stations_confirmed = 1,
      countdown_started_at_epoch_ms = ?,
      question_started_at_epoch_ms = ?,
      question_closed_at_epoch_ms = NULL,
      close_reason = NULL,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = 1
  `).run(
    Date.now() - 4000,
    Date.now() - 1000,
  );

  const events: string[] = [];
  const app = Fastify();
  const io = new SocketIOServer(app.server);
  const manager = new LiveSessionManager(
    db,
    io,
    3000,
    30_000,
    {
      send(address) {
        events.push(address);
      },
    },
  );

  const snapshot = manager.getSnapshot();
  assert.equal(snapshot.phase, "QUESTION_CLOSED");
  assert.equal(
    snapshot.closeReason,
    "SERVER_RESTART_RECOVERY",
  );
  assert.throws(
    () => manager.revealQuestion(),
    /RECOVERY_QUESTION_REQUIRES_VOID/,
  );
  assert.equal(
    events.includes(
      "/uniquiz/question/recovery_required",
    ),
    true,
  );

  const audit = db.prepare(`
    SELECT reason, payload_json AS payloadJson
    FROM audit_events
    WHERE event_type = 'LIVE_RECOVERY'
    ORDER BY id DESC
    LIMIT 1
  `).get() as {
    reason: string;
    payloadJson: string;
  };

  assert.equal(
    audit.reason,
    "SERVER_RESTART_DURING_ACTIVE_QUESTION",
  );
  assert.match(
    audit.payloadJson,
    /VOID_REPLACEMENT_REQUIRED/,
  );

  io.close();
  void app.close();
  db.close();
});


test("replacement resets the current slot to question ready", () => {
  const db = seedLiveRound();
  db.prepare(`
    UPDATE qualification_rounds
    SET status = 'ACTIVE'
    WHERE id = 1
  `).run();

  db.prepare(`
    UPDATE live_state
    SET
      phase = 'QUESTION_CLOSED',
      round_id = 1,
      question_position = 1,
      stations_confirmed = 1,
      countdown_started_at_epoch_ms = NULL,
      question_started_at_epoch_ms = ?,
      question_closed_at_epoch_ms = ?,
      close_reason = 'SERVER_RESTART_RECOVERY',
      updated_at = CURRENT_TIMESTAMP
    WHERE id = 1
  `).run(Date.now() - 1000, Date.now());

  const app = Fastify();
  const io = new SocketIOServer(app.server);
  const manager = new LiveSessionManager(
    db,
    io,
    3000,
    30_000,
  );

  assert.equal(
    manager.getSnapshot().closeReason,
    "SERVER_RESTART_RECOVERY",
  );

  const reset = manager.onQuestionReplaced(1, 1);
  assert.equal(reset?.phase, "QUESTION_READY");
  assert.equal(reset?.question?.position, 1);
  assert.equal(reset?.closeReason, null);
  assert.equal(reset?.questionStartedAtEpochMs, null);

  const audit = db.prepare(`
    SELECT event_type AS eventType
    FROM audit_events
    WHERE event_type = 'QUESTION_REPLACEMENT_READY'
    ORDER BY id DESC
    LIMIT 1
  `).get() as { eventType: string };

  assert.equal(
    audit.eventType,
    "QUESTION_REPLACEMENT_READY",
  );

  io.close();
  void app.close();
  db.close();
});


test("station readiness override is audited and allows emergency start", () => {
  const db = seedLiveRound();
  const app = Fastify();
  const io = new SocketIOServer(app.server);

  const manager = new LiveSessionManager(
    db,
    io,
    1,
    30_000,
    undefined,
    (role) => role === "team-a",
  );

  manager.prepareRound(1);

  assert.throws(
    () => manager.confirmStations(),
    /TEAM_B_NOT_READY/,
  );

  const overridden = manager.overrideStationReadiness(
    "Team B browser failed immediately before round start",
  );
  assert.equal(overridden.stationsConfirmed, true);

  const started = manager.startRound();
  assert.equal(started.phase, "ROUND_ACTIVE");

  const events = db.prepare(`
    SELECT event_type AS eventType, reason
    FROM audit_events
    WHERE event_type IN (
      'STATION_READINESS_OVERRIDE',
      'ROUND_STARTED_WITH_READINESS_OVERRIDE'
    )
    ORDER BY id
  `).all() as Array<{
    eventType: string;
    reason: string | null;
  }>;

  assert.deepEqual(
    events.map((entry) => entry.eventType),
    [
      "STATION_READINESS_OVERRIDE",
      "ROUND_STARTED_WITH_READINESS_OVERRIDE",
    ],
  );
  assert.match(
    events[0]?.reason ?? "",
    /Team B browser failed/,
  );

  io.close();
  void app.close();
  db.close();
});

test("emergency hold during countdown returns question to ready", () => {
  const db = seedLiveRound();
  const app = Fastify();
  const io = new SocketIOServer(app.server);
  const manager = new LiveSessionManager(
    db,
    io,
    5000,
    30_000,
  );

  manager.prepareRound(1);
  manager.confirmStations();
  manager.startRound();
  manager.prepareNextQuestion();
  manager.startQuestion();

  const held = manager.emergencyHold(
    "Audience projector issue before question reveal",
  );

  assert.equal(held.phase, "QUESTION_READY");
  assert.equal(held.question?.position, 1);
  assert.equal(held.countdownStartedAtEpochMs, null);

  const audit = db.prepare(`
    SELECT reason, payload_json AS payloadJson
    FROM audit_events
    WHERE event_type = 'EMERGENCY_HOLD'
    ORDER BY id DESC
    LIMIT 1
  `).get() as {
    reason: string;
    payloadJson: string;
  };

  assert.match(audit.reason, /projector issue/);
  assert.match(audit.payloadJson, /RETURN_TO_QUESTION_READY/);

  io.close();
  void app.close();
  db.close();
});

test("emergency hold during active question requires void replacement", async () => {
  const db = seedLiveRound();
  const app = Fastify();
  const io = new SocketIOServer(app.server);
  const manager = new LiveSessionManager(
    db,
    io,
    1,
    30_000,
  );

  manager.prepareRound(1);
  manager.confirmStations();
  manager.startRound();
  manager.prepareNextQuestion();
  manager.startQuestion();

  await new Promise((resolve) => setTimeout(resolve, 5));

  const held = manager.emergencyHold(
    "Team station lost power during active question",
  );

  assert.equal(held.phase, "QUESTION_CLOSED");
  assert.equal(held.closeReason, "EMERGENCY_HOLD");
  assert.throws(
    () => manager.revealQuestion(),
    /QUESTION_REQUIRES_VOID/,
  );

  const audit = db.prepare(`
    SELECT reason, payload_json AS payloadJson
    FROM audit_events
    WHERE event_type = 'EMERGENCY_HOLD'
    ORDER BY id DESC
    LIMIT 1
  `).get() as {
    reason: string;
    payloadJson: string;
  };

  assert.match(audit.reason, /lost power/);
  assert.match(audit.payloadJson, /VOID_REPLACEMENT_REQUIRED/);

  io.close();
  void app.close();
  db.close();
});
