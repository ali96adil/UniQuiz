import assert from "node:assert/strict";
import test from "node:test";
import { RANKED_DUEL_MODE } from "@uniquiz/shared";
import { openDatabase } from "./database.js";
import { listCompetitionWorkspaces, createCompetitionWorkspace } from "./competition-workspaces.js";

test("M7 offers exactly Mode 01 Ranked Duel as metadata, not a second gameplay engine", () => {
  assert.deepEqual(RANKED_DUEL_MODE, {
    id: "ranked_duel",
    number: 1,
    labelAr: "المواجهة بالنقاط",
    labelEn: "Ranked Duel",
    descriptionAr: "فريق A ضد فريق B يجيبان عن الأسئلة نفسها؛ تُجمع النقاط وزمن الإجابات عبر الجولات لتحديد الترتيب العام دون إقصاء.",
  });
  assert.equal(Object.isFrozen(RANKED_DUEL_MODE), true);
});

test("2026 legacy and newly created workspace inherit ranked duel with no schema or score rewrite", () => {
  const db = openDatabase(":memory:");
  try {
    const columnsBefore = (db.pragma("table_info(competition_workspaces)") as Array<{name: string}>).map(c=>c.name);
    const original = listCompetitionWorkspaces(db);
    assert.equal(original.length, 1);
    assert.equal(original[0]?.id, "legacy");
    assert.equal(original[0]?.participantType, "college");

    db.exec(`
      INSERT INTO colleges (name, sort_order) VALUES ('College 2026', 1);
      INSERT INTO participants (college_id) VALUES (1);
      INSERT INTO qualification_rounds (round_order,college_a_id,status)
      VALUES (1,1,'COMPLETED');
      INSERT INTO live_submissions (
        round_id, question_position, station, question_id, selected_option,
        submitted_at_epoch_ms, response_time_ms, is_correct, score_micros
      ) VALUES (1,1,'A',NULL,'A',1000,450,1,192000000);
    `);
    const scoreBefore = db.prepare("SELECT score_micros AS score, response_time_ms AS ms FROM live_submissions")
      .all();
    const created = createCompetitionWorkspace(db,"Sport departments","department");
    assert.equal(created.participantType,"department");
    assert.equal(created.active,false);
    assert.equal(listCompetitionWorkspaces(db).length,2);
    assert.deepEqual(db.prepare("SELECT score_micros AS score, response_time_ms AS ms FROM live_submissions").all(),scoreBefore);
    assert.deepEqual((db.pragma("table_info(competition_workspaces)") as Array<{name:string}>).map(c=>c.name),columnsBefore);
    assert.equal(RANKED_DUEL_MODE.id,"ranked_duel");
  } finally { db.close(); }
});
