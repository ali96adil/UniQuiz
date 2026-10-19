import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { Server as SocketIOServer } from "socket.io";
import { openDatabase } from "./database.js";
import { getCompetitionSnapshot, registerCompetitionRoutes } from "./competition.js";
import { registerQuestionBankRoutes, getQuestionAllocationSummary } from "./question-bank.js";
import {
  activateCompetitionWorkspace,
  activeWorkspaceId,
  createCompetitionWorkspace,
} from "./competition-workspaces.js";
import { getCompetitionGameplayRules } from "./competition-gameplay.js";
import { getQualificationRanking } from "./ranking.js";
import { LiveSessionManager } from "./live-session.js";
import {
  confirmOscTest, createDatabaseBackup, getOperationsPreflight,
  getOscTestState, markOscTestSent,
} from "./operations.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve,ms));

async function question(manager: LiveSessionManager, correctA: boolean) {
  manager.prepareNextQuestion();
  manager.startQuestion();
  for (let attempt = 0; attempt < 80 && manager.getSnapshot().phase !== "QUESTION_ACTIVE"; attempt++) {
    await sleep(5);
  }
  assert.equal(manager.getSnapshot().phase, "QUESTION_ACTIVE");
  manager.submitAnswer("team-a", correctA ? "A" : "B");
  manager.submitAnswer("team-b", "B");
  assert.equal(manager.getSnapshot().phase,"QUESTION_CLOSED");
  manager.revealQuestion();
  assert.equal(manager.getSnapshot().phase,"QUESTION_REVEAL");
}

test("M7 full journey: create teams, draw, varied rounds, score and reopen previous competition", async () => {
  const root=mkdtempSync(join(tmpdir(),"uniquiz-m7-journey-"));
  const path=join(root,"rehearsal.db");
  const db=openDatabase(path);
  const app=Fastify();
  const io=new SocketIOServer(app.server);
  const manager=new LiveSessionManager(db,io,1,null,undefined,() => true,60_000);
  try {
    registerCompetitionRoutes(app,db,io);
    registerQuestionBankRoutes(app,db,io);
    await app.ready();

    // Start with a distinct historical competition, never overwriting it.
    db.prepare("UPDATE audience_settings SET event_title='Legacy October Event' WHERE id=1").run();
    const event=createCompetitionWorkspace(db,"2027 Sports Cup","team");
    const beforeSwitch=createDatabaseBackup(db,path,"pre-switch");
    assert.equal(beforeSwitch.integrity,"ok");
    activateCompetitionWorkspace(db,event.id);
    assert.equal(activeWorkspaceId(db),event.id);

    const people=await app.inject({
      method:"PUT",url:"/api/setup/colleges",
      payload:{colleges:[
        {name:"Sports Team A"},{name:"Sports Team B"},
        {name:"Sports Team C"},{name:"Sports Team D"},
      ]},
    });
    assert.equal(people.statusCode,200,people.body);
    const entrants=getCompetitionSnapshot(db);
    assert.equal(entrants.colleges.length,4);
    const selection=await app.inject({
      method:"PUT",url:"/api/setup/participants",
      payload:{collegeIds:entrants.colleges.map((team)=>team.id)},
    });
    assert.equal(selection.statusCode,200,selection.body);
    assert.equal((await app.inject({
      method:"POST",url:"/api/setup/participants/lock",
      payload:{},
    })).statusCode,200);
    const draw=await app.inject({method:"POST",url:"/api/draw",payload:{}});
    assert.equal(draw.statusCode,200,draw.body);
    const rounds=getCompetitionSnapshot(db).rounds;
    assert.equal(rounds.length,2);

    db.exec(`
      INSERT INTO categories(category_key,name,display_name,sort_order)
      VALUES ('sports','Advanced Sports','رياضة',1),('history','History','تاريخ',2);
    `);
    const insert=db.prepare(`
      INSERT INTO questions(category_id,prompt,option_a,option_b,option_c,option_d,correct_option)
      VALUES(?,?,'A','B','C','D','A')
    `);
    for(let i=0;i<10;i++) insert.run(1,"Sports question "+i);
    for(let i=0;i<10;i++) insert.run(2,"History question "+i);

    const defaults=await app.inject({
      method:"PUT",url:"/api/competition/rules",
      payload:{categories:[{categoryKey:"sports",questions:2}]},
    });
    assert.equal(defaults.statusCode,200,defaults.body);
    const override=await app.inject({
      method:"PUT",url:`/api/competition/rounds/${rounds[1]!.id}/rules`,
      payload:{categories:[
        {categoryKey:"sports",questions:1},
        {categoryKey:"history",questions:2},
      ]},
    });
    assert.equal(override.statusCode,200,override.body);
    const timing=await app.inject({
      method:"PUT",url:"/api/competition/gameplay",
      payload:{
        durationSeconds:40,scoringMode:"fixed",
        correctPoints:10,pointsLostPerSecond:0,
      },
    });
    assert.equal(timing.statusCode,200,timing.body);

    const plan=getQuestionAllocationSummary(db);
    assert.deepEqual(plan.rounds.map((r)=>r.plannedQuestionCount),[2,3]);
    const allocated=await app.inject({
      method:"POST",url:"/api/question-bank/allocate",
      payload:{confirm:"ALLOCATE_QUESTIONS"},
    });
    assert.equal(allocated.statusCode,200,allocated.body);
    assert.equal(getQuestionAllocationSummary(db).ready,true);
    const used=db.prepare("SELECT question_id AS id FROM qualification_round_questions")
      .all() as Array<{id:number}>;
    assert.equal(used.length,5);
    assert.equal(new Set(used.map((q)=>q.id)).size,5);
    assert.equal(getQuestionAllocationSummary(db).categories.find((c)=>c.key==="sports")?.requiredQuestions,3);

    // Live session plays round 1 with exactly two questions, not a fixed ten.
    const prepared=manager.prepareRound(rounds[0]!.id);
    assert.equal(prepared.questionsPerRound,2);
    manager.confirmStations();
    manager.startRound();
    await question(manager,true);
    await question(manager,false);
    const completed=manager.completeRound();
    assert.equal(completed.phase,"ROUND_COMPLETE");
    assert.equal(completed.questionsPerRound,2);
    assert.equal(completed.gameplay.durationSeconds,40);
    const results=getQualificationRanking(db);
    const scores=results.entries.map((entry)=>entry.scorePoints).sort((a,b)=>a-b);
    assert.deepEqual(scores,[0,10]);

    markOscTestSent(db);
    confirmOscTest(db);
    assert.ok(getOscTestState(db).confirmedAt);
    const manual=createDatabaseBackup(db,path);
    assert.equal(manual.integrity,"ok");
    const noPresence={generatedAt:new Date().toISOString(),stations:[]};
    const osc={enabled:true,host:"127.0.0.1",port:9001};
    assert.equal(
      getOperationsPreflight(db,path,osc,noPresence).checks.find((check)=>check.key==="osc")?.ready,
      true,
    );

    const archiveScore=db.prepare(
      "SELECT SUM(score_micros) AS total FROM live_submissions",
    ).get() as {total:number};
    const historyId=activeWorkspaceId(db);
    activateCompetitionWorkspace(db,"legacy");
    const legacyTitle = db.prepare("SELECT event_title AS title FROM audience_settings").get() as { title: string };
    assert.equal(legacyTitle.title,"Legacy October Event");
    assert.deepEqual(db.prepare("SELECT * FROM live_submissions").all(),[]);
    assert.equal(getOscTestState(db).confirmedAt,null);
    assert.equal(getOperationsPreflight(db,path,osc,noPresence)
      .checks.find((check)=>check.key==="backup")?.ready,false);
    assert.equal(getOperationsPreflight(db,path,osc,noPresence)
      .checks.find((check)=>check.key==="osc")?.ready,false);

    activateCompetitionWorkspace(db,historyId);
    assert.equal(getOscTestState(db).confirmedAt,null);
    assert.equal(getCompetitionGameplayRules(db).correctPoints,10);
    assert.deepEqual(getQuestionAllocationSummary(db).rounds.map((r)=>r.plannedQuestionCount),[2,3]);
    assert.deepEqual(db.pragma("foreign_key_check"),[]);
    assert.equal((db.prepare("SELECT SUM(score_micros) AS total FROM live_submissions")
      .get() as {total:number}).total,archiveScore.total);
    assert.equal(getQualificationRanking(db).entries.reduce(
      (sum,entry)=>sum+entry.scorePoints,0,
    ),10);
    assert.equal(getOperationsPreflight(db,path,osc,noPresence)
      .checks.find((check)=>check.key==="backup")?.ready,false);
    assert.equal(createDatabaseBackup(db,path).integrity,"ok");
    assert.equal(getOperationsPreflight(db,path,osc,noPresence)
      .checks.find((check)=>check.key==="backup")?.ready,true);
  } finally {
    manager.dispose();
    io.close();
    await app.close();
    db.close();
    rmSync(root,{recursive:true,force:true});
  }
});
