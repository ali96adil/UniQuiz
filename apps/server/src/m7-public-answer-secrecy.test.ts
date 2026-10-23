import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { Server as SocketIOServer } from "socket.io";
import type { LiveSnapshot } from "@uniquiz/shared";
import { openDatabase } from "./database.js";
import { publicLiveSnapshot } from "./public-live-snapshot.js";
import { registerLiveSessionRoutes } from "./live-session.js";

function seedSingleQuestion() {
  const db = openDatabase(":memory:");
  db.exec(`
    INSERT INTO colleges(name,sort_order) VALUES('Team A',1),('Team B',2);
    INSERT INTO participants(college_id) VALUES(1),(2);
    INSERT INTO qualification_rounds(round_order,college_a_id,college_b_id,status)
      VALUES(1,1,2,'PENDING');
    INSERT INTO categories(category_key,name,display_name,sort_order)
      VALUES('history','History','تاريخ',1);
    UPDATE competition_rules
      SET distribution_json='[{"categoryKey":"history","questions":1}]'
      WHERE id=1;
    INSERT INTO questions(category_id,prompt,option_a,option_b,option_c,option_d,correct_option)
      VALUES(1,'Confidential question','Option A','Option B','Option C','Option D','B');
    INSERT INTO qualification_round_question_sets(round_id,locked_at)
      VALUES(1,CURRENT_TIMESTAMP);
    INSERT INTO qualification_round_questions(round_id,position,question_id,category_id)
      VALUES(1,1,1,1);
  `);
  return db;
}

function assertSealed(snapshot: LiveSnapshot, phase: LiveSnapshot["phase"]) {
  assert.equal(snapshot.phase, phase);
  assert.equal(snapshot.question?.correctOption ?? null, null,
    `Answer leaked during ${phase}`);
  assert.equal(snapshot.revealResults, null,
    `Team answer grades leaked during ${phase}`);
  const raw = JSON.stringify(snapshot);
  assert.ok(!raw.includes('"correctOption":"B"'), `Private key in ${phase}`);
  assert.ok(!raw.includes('"isCorrect":true'), `Private graded answer in ${phase}`);
  assert.ok(!raw.includes('"selectedOption":"B"'),
    `Team selected answer leaked during ${phase}`);
}

test("public snapshot projection fails closed even for accidentally enriched internal state", () => {
  const db = seedSingleQuestion();
  const app = Fastify();
  const io = new SocketIOServer(app.server);
  const manager = registerLiveSessionRoutes(app, db, io);
  try {
    const baseline = manager.getSnapshot();
    const fakePrivate = {
      ...baseline,
      internalCorrectAnswer: "B",
      phase: "QUESTION_COUNTDOWN" as const,
      question: {
        position: 1, categoryKey: "history", categoryName: "تاريخ",
        prompt: "Confidential question",
        options: { A: "Option A", B: "Option B", C: "Option C", D: "Option D" },
        correctOption: "B" as const,
      },
      revealResults: {
        teamA: {
          station: "A" as const, answered: true, selectedOption: "B" as const,
          isCorrect: true, responseTimeMs: 800, scorePoints: 25,
        },
        teamB: null,
      },
    };
    const filtered = publicLiveSnapshot(fakePrivate);
    assertSealed(filtered, "QUESTION_COUNTDOWN");
    assert.equal(filtered.question?.prompt, null);
    assert.equal(filtered.question?.options, null);
    assert.equal(Object.hasOwn(filtered, "internalCorrectAnswer"), false);

    const closed = publicLiveSnapshot({
      ...fakePrivate, phase: "QUESTION_CLOSED",
    });
    assertSealed(closed, "QUESTION_CLOSED");
    assert.equal(closed.question?.prompt, "Confidential question");
    assert.equal(closed.question?.options?.B, "Option B");

    const revealed = publicLiveSnapshot({
      ...fakePrivate, phase: "QUESTION_REVEAL",
    });
    assert.equal(revealed.question?.correctOption, "B");
    assert.equal(revealed.revealResults?.teamA?.isCorrect, true);
    assert.equal(Object.hasOwn(revealed, "internalCorrectAnswer"), false);
  } finally {
    manager.dispose();
    io.close();
    void app.close();
    db.close();
  }
});

test("GET /api/live and realtime broadcasts never reveal answers until operator Reveal", async () => {
  const db = seedSingleQuestion();
  const app = Fastify();
  const io = new SocketIOServer(app.server);
  const emitted: LiveSnapshot[] = [];
  const originalEmit = io.emit.bind(io);
  io.emit = ((event: string, ...values: unknown[]) => {
    if (event === "live:snapshot") emitted.push(values[0] as LiveSnapshot);
    return originalEmit(event, ...values);
  }) as typeof io.emit;
  const manager = registerLiveSessionRoutes(app, db, io);
  const httpSnapshot = async () => {
    const response = await app.inject({method: "GET",url: "/api/live"});
    assert.equal(response.statusCode, 200, response.body);
    return response.json() as LiveSnapshot;
  };
  const waitForPhase = async (phase: LiveSnapshot["phase"]) => {
    for (let attempt = 0; attempt < 180; attempt += 1) {
      if (manager.getSnapshot().phase === phase) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out waiting for ${phase}`);
  };
  try {
    await app.ready();
    assertSealed(await httpSnapshot(), "IDLE");
    manager.prepareRound(1);
    assertSealed(await httpSnapshot(), "ROUND_READY");
    manager.confirmStations();
    manager.startRound();
    assertSealed(await httpSnapshot(), "ROUND_ACTIVE");
    manager.prepareNextQuestion();
    assertSealed(await httpSnapshot(), "QUESTION_READY");

    manager.startQuestion();
    const countdown = await httpSnapshot();
    assertSealed(countdown, "QUESTION_COUNTDOWN");
    assert.equal(countdown.question?.prompt, null);
    assert.equal(countdown.question?.options, null);

    await waitForPhase("QUESTION_ACTIVE");
    const active = await httpSnapshot();
    assertSealed(active, "QUESTION_ACTIVE");
    assert.equal(active.question?.prompt, "Confidential question");
    assert.equal(active.question?.options?.B, "Option B");

    manager.submitAnswer("team-a", "B");
    assertSealed(await httpSnapshot(), "QUESTION_ACTIVE");
    assert.equal(manager.getTeamSubmissionState("team-b")?.selectedOption, null);
    assert.equal(manager.getTeamSubmissionState("team-b")?.locked, false);
    assert.equal(manager.getTeamSubmissionState("unknown"), null);

    manager.submitAnswer("team-b", "C");
    assertSealed(await httpSnapshot(), "QUESTION_CLOSED");
    assert.equal(manager.getTeamSubmissionState("team-a")?.selectedOption, "B");
    assert.equal(manager.getTeamSubmissionState("team-b")?.selectedOption, "C");

    // Closing a question must not disclose correct option, score or grading.
    assert.equal(manager.getSnapshot().roundTotals?.teamA, 0);
    const revealed = manager.revealQuestion();
    assert.equal(revealed.phase, "QUESTION_REVEAL");
    assert.equal(revealed.question?.correctOption, "B");
    assert.equal(revealed.revealResults?.teamA?.isCorrect, true);
    assert.equal(revealed.revealResults?.teamB?.isCorrect, false);
    const httpReveal = await httpSnapshot();
    assert.equal(httpReveal.question?.correctOption, "B");
    assert.equal(httpReveal.revealResults?.teamA?.scorePoints !== undefined, true);

    manager.enterIntermission();
    assertSealed(await httpSnapshot(), "INTERMISSION");
    assert.ok(emitted.some((snap) => snap.phase === "QUESTION_REVEAL" &&
      snap.question?.correctOption === "B"), "Explicit Reveal broadcast missing");
    const earlyBroadcasts = emitted.filter((snap) => snap.phase !== "QUESTION_REVEAL");
    assert.ok(earlyBroadcasts.length > 5, "No early realtime snapshots tested");
    for (const snap of earlyBroadcasts) assertSealed(snap, snap.phase);
  } finally {
    manager.dispose();
    io.close();
    await app.close();
    db.close();
  }
});
