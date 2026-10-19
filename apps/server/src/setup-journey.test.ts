import assert from "node:assert/strict";
import test from "node:test";
import { getSetupJourney, SETUP_STEP_IDS } from "@uniquiz/shared";
import { openDatabase } from "./database.js";
import { getCompetitionSnapshot } from "./competition.js";
import { getQuestionBankSummary } from "./importer.js";
import { getQuestionAllocationSummary } from "./question-bank.js";

test("M7.6 guided setup always retains five stages and starts from missing participants", () => {
  const db = openDatabase(":memory:");
  try {
    const setup = getCompetitionSnapshot(db);
    const state = getSetupJourney(
      setup,
      getQuestionBankSummary(db),
      getQuestionAllocationSummary(db),
      "بنك المعلومات",
    );
    assert.deepEqual(state.steps.map((step) => step.id), [...SETUP_STEP_IDS]);
    assert.equal(state.suggestedStep, "participants");
    assert.equal(state.steps.find((step) => step.id === "participants")?.status, "pending");
    assert.equal(state.steps.find((step) => step.id === "readiness")?.status, "pending");
  } finally { db.close(); }
});

test("M7.6 progresses through participants, bank, draw, allocation without claiming preflight READY", () => {
  const db = openDatabase(":memory:");
  try {
    const current = () => getSetupJourney(
      getCompetitionSnapshot(db),
      getQuestionBankSummary(db),
      getQuestionAllocationSummary(db),
      "بطولة رياضية",
    );
    db.exec(`
      INSERT INTO colleges(name,sort_order) VALUES('A',1),('B',2);
      INSERT INTO participants(college_id) VALUES(1),(2);
      UPDATE competition_state SET participants_locked=1 WHERE id=1;
    `);
    assert.equal(current().suggestedStep, "questions");

    db.exec(`
      INSERT INTO categories(category_key,name,sort_order)
      VALUES('sports','رياضة',1);
      INSERT INTO questions(category_id,prompt,option_a,option_b,option_c,option_d,correct_option)
      VALUES(1,'Q','A','B','C','D','A');
      UPDATE competition_rules
      SET distribution_json='[{"categoryKey":"sports","questions":1}]' WHERE id=1;
    `);
    assert.equal(current().suggestedStep, "draw");

    db.exec(`
      INSERT INTO qualification_rounds(round_order,college_a_id,college_b_id)
      VALUES(1,1,2);
      UPDATE competition_state SET draw_created_at=CURRENT_TIMESTAMP WHERE id=1;
    `);
    assert.equal(current().suggestedStep, "readiness");
    assert.equal(current().steps.find((step) => step.id === "readiness")?.status, "pending");

    db.exec(`
      INSERT INTO qualification_round_question_sets(round_id,locked_at)
      VALUES(1,CURRENT_TIMESTAMP);
      INSERT INTO qualification_round_questions(round_id,position,question_id,category_id)
      VALUES(1,1,1,1);
    `);
    const state = current();
    assert.equal(state.completedCount,4);
    assert.equal(state.steps.find((step) => step.id === "readiness")?.status,"review");
    assert.equal(state.suggestedStep,"readiness");
  } finally { db.close(); }
});

test("M7.6 blank title and insufficient participants keep setup explicitly incomplete", () => {
  const db = openDatabase(":memory:");
  try {
    const state = getSetupJourney(
      getCompetitionSnapshot(db),
      getQuestionBankSummary(db),
      getQuestionAllocationSummary(db),
      " ",
    );
    assert.equal(state.suggestedStep,"identity");
    assert.equal(state.steps[0]?.status,"pending");
    assert.equal(state.completedCount,0);
  } finally { db.close(); }
});
