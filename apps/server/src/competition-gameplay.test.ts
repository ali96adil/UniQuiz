import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { Server as SocketIOServer } from "socket.io";
import { openDatabase } from "./database.js";
import { calculateScoreMicros, scoreMicrosToPoints } from "./scoring.js";
import { ServerQuestionClock } from "./question-clock.js";
import { getCompetitionGameplayRules } from "./competition-gameplay.js";
import { registerQuestionBankRoutes } from "./question-bank.js";
import { LiveSessionManager } from "./live-session.js";
import { getQualificationRanking } from "./ranking.js";

test("M7.5 preserves original 25-second countdown scoring exactly", () => {
  const db = openDatabase(":memory:");
  try {
    assert.deepEqual(getCompetitionGameplayRules(db), {
      durationSeconds: 25, scoringMode: "time_decay",
      correctPoints: 25, pointsLostPerSecond: 1, difficultyMode: "random",
    });
    assert.equal(scoreMicrosToPoints(calculateScoreMicros(true, 0)), 25);
    assert.equal(scoreMicrosToPoints(calculateScoreMicros(true, 999)), 25);
    assert.equal(scoreMicrosToPoints(calculateScoreMicros(true, 1000)), 24);
    assert.equal(scoreMicrosToPoints(calculateScoreMicros(true, 24999)), 1);
    assert.equal(scoreMicrosToPoints(calculateScoreMicros(true, 25000)), 0);
  } finally { db.close(); }
});

test("M7.5 supports 45s countdown or 60s fixed-point scoring", () => {
  const countdown = {
    durationSeconds: 45, scoringMode: "time_decay" as const,
    correctPoints: 60, pointsLostPerSecond: 2,
  };
  assert.equal(scoreMicrosToPoints(calculateScoreMicros(true,0,countdown)),60);
  assert.equal(scoreMicrosToPoints(calculateScoreMicros(true,1000,countdown)),58);
  assert.equal(scoreMicrosToPoints(calculateScoreMicros(true,44000,countdown)),1);
  assert.equal(calculateScoreMicros(true,45000,countdown),0);
  const fixed = {
    durationSeconds: 60, scoringMode: "fixed" as const,
    correctPoints: 12, pointsLostPerSecond: 0,
  };
  assert.equal(scoreMicrosToPoints(calculateScoreMicros(true,0,fixed)),12);
  assert.equal(scoreMicrosToPoints(calculateScoreMicros(true,59999,fixed)),12);
  assert.equal(calculateScoreMicros(true,60000,fixed),0);
  assert.equal(calculateScoreMicros(false,100,fixed),0);
});

test("M7.5 monotonic question clock obeys custom duration", () => {
  let nowNs = 2_000_000_000n;
  const clock = new ServerQuestionClock(() => nowNs, () => 1000);
  clock.start("custom", 45_000);
  nowNs += 25_000_000_000n;
  assert.equal(clock.snapshot().remainingMs,20_000);
  assert.equal(clock.snapshot().expired,false);
  nowNs += 20_000_000_000n;
  assert.equal(clock.snapshot().remainingMs,0);
  assert.equal(clock.snapshot().expired,true);
});

test("M7.5 validates gameplay API and locks scoring rules once competition starts", async () => {
  const db = openDatabase(":memory:");
  const app = Fastify();
  const io = new SocketIOServer(app.server);
  try {
    registerQuestionBankRoutes(app,db,io);
    await app.ready();
    const rules = {
      durationSeconds: 45, scoringMode: "time_decay",
      correctPoints: 60, pointsLostPerSecond: 2,
    };
    const save = await app.inject({method:"PUT",url:"/api/competition/gameplay",payload:rules});
    assert.equal(save.statusCode,200,save.body);
    assert.deepEqual(getCompetitionGameplayRules(db),{...rules,difficultyMode:"random"});
    const read = await app.inject({method:"GET",url:"/api/competition/gameplay"});
    assert.equal(read.statusCode,200);
    assert.deepEqual(read.json(),{...rules,difficultyMode:"random"});
    for (const payload of [
      {...rules,durationSeconds:4},
      {...rules,durationSeconds:301},
      {...rules,correctPoints:0},
      {...rules,scoringMode:"invalid"},
      {...rules,pointsLostPerSecond:-1},
    ]) {
      assert.equal((await app.inject({method:"PUT",url:"/api/competition/gameplay",payload})).statusCode,400);
    }
    db.exec(`
      INSERT INTO colleges(name,sort_order) VALUES('A',1);
      INSERT INTO qualification_rounds(round_order,college_a_id,status)
      VALUES(1,1,'ACTIVE');
    `);
    const blocked = await app.inject({
      method:"PUT",url:"/api/competition/gameplay",
      payload:{...rules,scoringMode:"fixed"},
    });
    assert.equal(blocked.statusCode,409);
    assert.deepEqual(getCompetitionGameplayRules(db),{...rules,difficultyMode:"random"});
  } finally {
    io.close();
    await app.close();
    db.close();
  }
});

test("M7.5 live session and ranking use configured 40-second timeout", async () => {
  const db = openDatabase(":memory:");
  const app = Fastify();
  const io = new SocketIOServer(app.server);
  try {
    db.exec(`
      INSERT INTO colleges(name,sort_order) VALUES('A',1);
      INSERT INTO participants(college_id) VALUES(1);
      INSERT INTO qualification_rounds(round_order,college_a_id,status)
      VALUES(1,1,'PENDING');
      INSERT INTO categories(category_key,name,sort_order)
      VALUES('sports','رياضة',1);
      UPDATE competition_rules
      SET distribution_json='[{"categoryKey":"sports","questions":1}]';
      UPDATE competition_gameplay_rules
      SET duration_seconds=40,scoring_mode='fixed',
          correct_points=10,points_lost_per_second=0;
      INSERT INTO questions(category_id,prompt,option_a,option_b,option_c,option_d,correct_option)
      VALUES(1,'Q','A','B','C','D','A');
      INSERT INTO qualification_round_question_sets(round_id,locked_at)
      VALUES(1,CURRENT_TIMESTAMP);
      INSERT INTO qualification_round_questions(round_id,position,question_id,category_id)
      VALUES(1,1,1,1);
    `);
    const manager = new LiveSessionManager(db,io,1);
    try {
      assert.equal(manager.prepareRound(1).questionsPerRound,1);
      manager.confirmStations();
      manager.startRound();
      manager.prepareNextQuestion();
      manager.startQuestion();
      await new Promise((resolve) => setTimeout(resolve, 15));
      const snapshot = manager.getSnapshot();
      assert.equal(snapshot.gameplay.durationSeconds,40);
      assert.ok(snapshot.questionDeadlineEpochMs !== null);
      assert.ok(snapshot.questionStartedAtEpochMs !== null);
      assert.equal(snapshot.questionDeadlineEpochMs! - snapshot.questionStartedAtEpochMs!,40_000);
      manager.submitAnswer("team-a","A");
      const result = db.prepare("SELECT score_micros AS score FROM live_submissions")
        .get() as {score:number};
      assert.equal(result.score,10_000_000);
    } finally { manager.dispose(); }

    // Unanswered participants accrue a full, configured 40-second tiebreak.
    db.exec(`
      DELETE FROM live_submissions;
      UPDATE qualification_rounds SET status='COMPLETED' WHERE id=1;
      INSERT INTO audit_events(event_type,round_id,position,occurred_at)
      VALUES('QUESTION_REVEALED',1,1,CURRENT_TIMESTAMP);
    `);
    const ranking = getQualificationRanking(db);
    assert.equal(ranking.entries[0]?.totalResponseTimeMs,40_000);
  } finally {
    io.close();
    await app.close();
    db.close();
  }
});
