import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase } from "./database.js";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { Server as SocketIOServer } from "socket.io";
import { LiveSessionManager } from "./live-session.js";
import { registerCompetitionWorkspaceRoutes } from "./competition-workspaces.js";
import { getCompetitionRules } from "./competition-rules.js";
import {
  activateCompetitionWorkspace,
  activeWorkspaceId,
  createCompetitionWorkspace,
  listCompetitionWorkspaces,
  renameCompetitionWorkspace,
} from "./competition-workspaces.js";

test("M7.2 keeps results and sponsorship isolated while retaining the shared question library", () => {
  const db = openDatabase(":memory:");
  try {
    const original = activeWorkspaceId(db);
    assert.equal(original, "legacy");
    db.exec(`
      INSERT INTO colleges (name, sort_order) VALUES ('كلية العلوم', 1);
      INSERT INTO participants (college_id) VALUES (1);
      INSERT INTO qualification_rounds (
        round_order, college_a_id, status
      ) VALUES (1, 1, 'COMPLETED');
      INSERT INTO categories (category_key, name, display_name, sort_order)
      VALUES ('sports_specialist', 'رياضة تخصصية', 'رياضة', 1);
      INSERT INTO questions (
        category_id,prompt,option_a,option_b,option_c,option_d,correct_option
      ) VALUES (1,'Historic Q','A','B','C','D','A');
      INSERT INTO qualification_round_question_sets (round_id,locked_at)
      VALUES (1,CURRENT_TIMESTAMP);
      INSERT INTO qualification_round_questions (
        round_id,position,question_id,category_id
      ) VALUES (1,1,1,1);
      INSERT INTO qualification_question_reservations (
        question_id,round_id,position,disposition,reserved_at
      ) VALUES (1,1,1,'ALLOCATED',CURRENT_TIMESTAMP);
      INSERT INTO live_submissions (
        round_id,question_position,station,question_id,selected_option,
        submitted_at_epoch_ms,response_time_ms,is_correct,score_micros
      ) VALUES (1,1,'A',1,'A',1000,200,1,24000000);
      UPDATE live_state SET phase='ROUND_COMPLETE',round_id=1,question_position=1;
      UPDATE audience_settings SET event_title='جامعة بابل 2026';
      UPDATE competition_rules SET distribution_json='[{"categoryKey":"sports_specialist","questions":12}]';
    `);
    const logo = Buffer.from([0,1,2,3,255]);
    db.prepare("INSERT INTO audience_assets(slot,mime_type,bytes,updated_at) VALUES('university','image/png',?,CURRENT_TIMESTAMP)").run(logo);
    const second = createCompetitionWorkspace(db, "بطولة الرياضة", "department");
    assert.equal(second.active, false);

    activateCompetitionWorkspace(db, second.id);
    assert.equal(activeWorkspaceId(db), second.id);
    assert.equal(getCompetitionRules(db).questionsPerRound, 10);
    assert.deepEqual(db.prepare("SELECT * FROM colleges").all(), []);
    assert.deepEqual(db.prepare("SELECT * FROM live_submissions").all(), []);
    assert.deepEqual(db.prepare("SELECT * FROM audience_assets").all(), []);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM questions").get() as {count:number}).count,1);
    assert.equal((db.prepare("SELECT event_title AS title FROM audience_settings").get() as {title:string}).title,"بطولة الرياضة");

    db.exec(`
      INSERT INTO colleges (name,sort_order) VALUES ('قسم الفيزياء',1);
      UPDATE audience_settings SET event_title='بطولة الأقسام 2027';
    `);
    renameCompetitionWorkspace(db, second.id, "المنافسة الرياضية الجديدة", "class");
    assert.equal(listCompetitionWorkspaces(db).find(x=>x.active)?.participantType, "class");

    activateCompetitionWorkspace(db, original);
    assert.equal((db.prepare("SELECT name FROM colleges").get() as {name:string}).name,"كلية العلوم");
    assert.equal((db.prepare("SELECT score_micros AS score FROM live_submissions").get() as {score:number}).score,24000000);
    assert.equal((db.prepare("SELECT event_title AS title FROM audience_settings").get() as {title:string}).title,"جامعة بابل 2026");
    assert.equal(getCompetitionRules(db).questionsPerRound,12);
    assert.deepEqual((db.prepare("SELECT bytes FROM audience_assets").get() as {bytes:Buffer}).bytes,logo);
    assert.deepEqual(db.pragma("foreign_key_check"),[]);

    activateCompetitionWorkspace(db, second.id);
    assert.equal((db.prepare("SELECT name FROM colleges").get() as {name:string}).name,"قسم الفيزياء");
    assert.equal((db.prepare("SELECT event_title AS title FROM audience_settings").get() as {title:string}).title,"بطولة الأقسام 2027");
  } finally { db.close(); }
});

test("M7.2 refuses to switch during an active round and keeps source untouched", () => {
  const db = openDatabase(":memory:");
  try {
    const next = createCompetitionWorkspace(db,"قادم","team");
    db.prepare("UPDATE live_state SET phase='QUESTION_ACTIVE' WHERE id=1").run();
    assert.throws(
      () => activateCompetitionWorkspace(db,next.id),
      /WORKSPACE_SWITCH_BLOCKED_BY_LIVE_SESSION/,
    );
    assert.equal(activeWorkspaceId(db),"legacy");
    assert.equal(listCompetitionWorkspaces(db).length,2);
  } finally { db.close(); }
});

test("M7.2 duplicate copies setup, sponsor branding and question quotas but not past scoring", () => {
  const db = openDatabase(":memory:");
  try {
    db.exec(`
      INSERT INTO colleges (name,sort_order) VALUES ('Team A',1);
      INSERT INTO participants (college_id) VALUES(1);
      INSERT INTO qualification_rounds(round_order,college_a_id,status) VALUES(1,1,'COMPLETED');
      UPDATE audience_settings SET event_title='المسابقة الأم';
      UPDATE competition_rules SET distribution_json='[{"categoryKey":"sport","questions":12}]';
    `);
    const copied = createCompetitionWorkspace(db,"نسخة باسم مختلف","team","legacy");
    activateCompetitionWorkspace(db,copied.id);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM colleges").get() as {count:number}).count,1);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM participants").get() as {count:number}).count,1);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM qualification_rounds").get() as {count:number}).count,0);
    assert.equal((db.prepare("SELECT event_title AS title FROM audience_settings").get() as {title:string}).title,"نسخة باسم مختلف");
    assert.equal(getCompetitionRules(db).questionsPerRound,12);
    assert.equal((db.prepare("SELECT phase FROM live_state").get() as {phase:string}).phase,"IDLE");
  } finally { db.close(); }
});

test("M7.2 HTTP activation creates a verified physical backup before switching", async () => {
  const dir = mkdtempSync(join(tmpdir(), "uniquiz-m7-workspaces-"));
  const path = join(dir, "active.db");
  const db = openDatabase(path);
  const app = Fastify();
  const io = new SocketIOServer(app.server);
  const live = new LiveSessionManager(db, io);
  try {
    registerCompetitionWorkspaceRoutes(app, db, io, live, path);
    await app.ready();
    const created = await app.inject({
      method: "POST",
      url: "/api/competitions",
      payload: { name: "Tournament 2", participantType: "department" },
    });
    assert.equal(created.statusCode, 201, created.body);
    const id = (created.json() as {competition: {id: string}}).competition.id;
    const switched = await app.inject({
      method: "POST",
      url: "/api/competitions/" + id + "/activate",
      payload: {},
    });
    assert.equal(switched.statusCode, 200, switched.body);
    assert.equal(activeWorkspaceId(db), id);
    const backups = readdirSync(join(dir, "backups"));
    assert.equal(backups.filter((item) => item.endsWith(".db")).length, 1);
    assert.ok(backups.some((item) => item.includes("pre-switch")));
    const backupName = backups.find((item) => item.endsWith(".db"))!;
    assert.ok(existsSync(join(dir, "backups", backupName + ".json")));

    const list = await app.inject({ method: "GET", url: "/api/competitions" });
    assert.equal(list.statusCode, 200);
    assert.equal((list.json() as { activeId: string }).activeId, id);
  } finally {
    live.dispose();
    io.close();
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
