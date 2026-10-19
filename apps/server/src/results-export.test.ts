import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activateCompetitionWorkspace,
  activeWorkspaceId,
  createCompetitionWorkspace,
} from "./competition-workspaces.js";
import { openDatabase } from "./database.js";
import { buildResultsWorkbook } from "./results-export.js";

test("results workbook contains ranking, submissions and audit", async () => {
  const db = openDatabase(":memory:");

  db.exec(`
    INSERT INTO colleges (name, sort_order) VALUES
      ('College A', 1),
      ('College B', 2);
    INSERT INTO participants (college_id) VALUES (1), (2);
    INSERT INTO qualification_rounds (
      round_order, college_a_id, college_b_id, status
    ) VALUES (1, 1, 2, 'ACTIVE');
    INSERT INTO categories (category_key, name, sort_order)
    VALUES ('general', 'General', 1);
    INSERT INTO questions (
      category_id, prompt, option_a, option_b, option_c, option_d, correct_option
    ) VALUES (1, 'Question', 'A', 'B', 'C', 'D', 'A');
    INSERT INTO live_submissions (
      round_id, question_position, station, question_id,
      selected_option, submitted_at_epoch_ms, response_time_ms,
      is_correct, score_micros
    ) VALUES
      (1, 1, 'A', 1, 'A', 1000, 1000, 1, 25000000),
      (1, 1, 'B', 1, 'B', 2000, 2000, 0, 0);
    INSERT INTO audit_events (
      event_type, round_id, question_id, position, occurred_at
    ) VALUES
      ('QUESTION_REVEALED', 1, 1, 1, '2026-09-29T00:00:00.000Z');
  `);

  const buffer = await buildResultsWorkbook(db);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as any);

  const summary = workbook.getWorksheet("Summary");
  const ranking = workbook.getWorksheet("Ranking");
  const rounds = workbook.getWorksheet("Rounds");
  const submissions = workbook.getWorksheet("Submissions");
  const audit = workbook.getWorksheet("Audit");

  assert.ok(summary);
  assert.ok(ranking);
  assert.ok(rounds);
  assert.ok(submissions);
  assert.ok(audit);

  assert.equal(summary.getRow(7).getCell(2).value, 25);
  assert.match(
    summary.getRow(9).getCell(2).text,
    /displayed remaining whole second/,
  );

  assert.equal(ranking.getRow(1).getCell(5).text, "total_response_time_ms");
  assert.equal(ranking.getRow(1).getCell(6).text, "correct_answers");
  assert.equal(ranking.getRow(1).getCell(7).text, "wrong_answers");
  assert.equal(ranking.getRow(2).getCell(2).text, "College A");
  assert.equal(ranking.getRow(2).getCell(4).value, 25);
  assert.equal(ranking.getRow(2).getCell(5).value, 1000);
  assert.equal(ranking.getRow(2).getCell(6).value, 1);
  assert.equal(ranking.getRow(2).getCell(7).value, 0);
  assert.equal(ranking.getRow(2).getCell(8).value, 1);
  assert.equal(rounds.getRow(2).getCell(5).value, 25);
  assert.equal(submissions.rowCount, 3);
  assert.equal(submissions.getRow(2).getCell(13).text, "yes");
  assert.equal(audit.getRow(2).getCell(2).text, "QUESTION_REVEALED");

  db.close();
});


test("M7 workbook reports configured 40s fixed scoring and independent 2/3-question rounds", async () => {
  const db = openDatabase(":memory:");
  try {
    db.exec(`
      UPDATE competition_workspaces SET participant_type='team' WHERE id='legacy';
      UPDATE audience_settings SET event_title='Sports Teams 2027' WHERE id=1;
      UPDATE competition_gameplay_rules
        SET duration_seconds=40, scoring_mode='fixed',
            correct_points=10, points_lost_per_second=0 WHERE id=1;
      INSERT INTO colleges(name,sort_order) VALUES('Team One',1),('Team Two',2);
      INSERT INTO participants(college_id) VALUES (1),(2);
      INSERT INTO qualification_rounds(round_order,college_a_id,college_b_id,status)
        VALUES (1,1,2,'ACTIVE'),(2,1,2,'PENDING');
      INSERT INTO categories(category_key,name,display_name,sort_order)
        VALUES ('sports','رياضة تخصصية','رياضة',1),('history','History','تاريخ',2);
      UPDATE competition_rules SET distribution_json=
        '[{"categoryKey":"sports","questions":2}]' WHERE id=1;
      INSERT INTO qualification_round_rules(round_id,distribution_json,updated_at)
        VALUES (2,'[{"categoryKey":"sports","questions":1},{"categoryKey":"history","questions":2}]',CURRENT_TIMESTAMP);
      INSERT INTO questions(category_id,prompt,option_a,option_b,option_c,option_d,correct_option)
        VALUES (1,'Sport 1','A','B','C','D','A');
      INSERT INTO live_submissions(
        round_id,question_position,station,question_id,selected_option,
        submitted_at_epoch_ms,response_time_ms,is_correct,score_micros
      ) VALUES (1,1,'A',1,'A',1000,2200,1,10000000),
               (1,1,'B',1,'B',1200,3000,0,0);
      INSERT INTO audit_events(event_type,round_id,question_id,position,occurred_at)
        VALUES ('QUESTION_REVEALED',1,1,1,CURRENT_TIMESTAMP);
      INSERT INTO qualification_round_question_sets(round_id,locked_at)
        VALUES (1,CURRENT_TIMESTAMP);
      INSERT INTO qualification_round_questions(round_id,position,question_id,category_id)
        VALUES (1,1,1,1);
    `);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await buildResultsWorkbook(db) as any);
    const summary=workbook.getWorksheet("Summary")!;
    const ranking=workbook.getWorksheet("Ranking")!;
    const rounds=workbook.getWorksheet("Rounds")!;
    const subs=workbook.getWorksheet("Submissions")!;

    assert.equal(summary.getRow(2).getCell(2).value,"Sports Teams 2027");
    assert.equal(summary.getRow(7).getCell(2).value,40);
    assert.equal(summary.getRow(8).getCell(2).value,10);
    assert.match(summary.getRow(9).getCell(2).text,/10 fixed points before 40s/);
    assert.equal(summary.getRow(10).getCell(2).value,"fixed");
    assert.equal(summary.getRow(11).getCell(2).value,0);
    assert.equal(summary.getRow(12).getCell(2).value,"team");
    assert.equal(ranking.getRow(1).getCell(2).value,"team");
    assert.equal(ranking.getRow(2).getCell(4).value,10);

    assert.equal(rounds.getRow(1).getCell(7).value,"planned_questions");
    assert.equal(rounds.getRow(2).getCell(5).value,10);
    assert.equal(rounds.getRow(2).getCell(7).value,2);
    assert.equal(rounds.getRow(2).getCell(8).value,1);
    assert.equal(rounds.getRow(2).getCell(9).value,"sports:2");
    assert.equal(rounds.getRow(3).getCell(7).value,3);
    assert.equal(rounds.getRow(3).getCell(8).value,0);
    assert.equal(rounds.getRow(3).getCell(9).value,"sports:1, history:2");
    assert.equal(subs.getRow(2).getCell(3).value,"رياضة");
    assert.equal(subs.getRow(2).getCell(11).value,10);
    assert.equal(subs.getRow(2).getCell(13).value,"yes");
  } finally { db.close(); }
});

test("M7 workbook describes custom time-decay settings instead of historical 25s copy", async () => {
  const db = openDatabase(":memory:");
  try {
    db.exec(`
      UPDATE competition_gameplay_rules
      SET duration_seconds=45, scoring_mode='time_decay',
          correct_points=60, points_lost_per_second=2 WHERE id=1;
    `);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await buildResultsWorkbook(db) as any);
    const summary=workbook.getWorksheet("Summary")!;
    assert.equal(summary.getRow(7).getCell(2).value,45);
    assert.equal(summary.getRow(8).getCell(2).value,60);
    assert.match(summary.getRow(9).getCell(2).text,/60 - 2/);
    assert.match(summary.getRow(9).getCell(2).text,/45s/);
    assert.equal(summary.getRow(10).getCell(2).value,"time_decay");
    assert.equal(summary.getRow(11).getCell(2).value,2);
  } finally { db.close(); }
});


test("M7 results exports stay attached to their competition after a real server database restart", async () => {
  const folder=mkdtempSync(join(tmpdir(),"uniquiz-m7-export-restart-"));
  const path=join(folder,"competitions.sqlite3");
  let db=openDatabase(path);
  let secondId="";
  try {
    db.exec(`
      UPDATE audience_settings SET event_title='2026 Original College Cup' WHERE id=1;
      INSERT INTO colleges(name,sort_order) VALUES('Original College',1);
      INSERT INTO participants(college_id) VALUES(1);
      INSERT INTO qualification_rounds(round_order,college_a_id,status)
        VALUES(1,1,'COMPLETED');
      INSERT INTO categories(category_key,name,sort_order) VALUES('sports','رياضة',1);
      INSERT INTO questions(category_id,prompt,option_a,option_b,option_c,option_d,correct_option)
        VALUES(1,'Original question','A','B','C','D','A');
      INSERT INTO live_submissions(
        round_id,question_position,station,question_id,selected_option,
        submitted_at_epoch_ms,response_time_ms,is_correct,score_micros
      ) VALUES(1,1,'A',1,'A',1000,1500,1,24000000);
      INSERT INTO audit_events(event_type,round_id,question_id,position,occurred_at)
        VALUES('QUESTION_REVEALED',1,1,1,CURRENT_TIMESTAMP);
    `);
    const second=createCompetitionWorkspace(db,"2027 Sports Teams","team");
    secondId=second.id;
    activateCompetitionWorkspace(db,secondId);
    db.exec(`
      UPDATE competition_gameplay_rules
        SET duration_seconds=40,scoring_mode='fixed',correct_points=10,
            points_lost_per_second=0 WHERE id=1;
      UPDATE audience_settings SET event_title='2027 Sports Teams' WHERE id=1;
    `);
    db.close();

    // Closing and reopening this physical database simulates a full server
    // restart and verifies both the active tables and inactive JSON snapshot.
    db=openDatabase(path);
    assert.equal(activeWorkspaceId(db),secondId);
    const newer=new ExcelJS.Workbook();
    await newer.xlsx.load(await buildResultsWorkbook(db) as any);
    assert.equal(newer.getWorksheet("Summary")!.getRow(2).getCell(2).value,"2027 Sports Teams");
    assert.equal(newer.getWorksheet("Summary")!.getRow(7).getCell(2).value,40);
    assert.equal(newer.getWorksheet("Summary")!.getRow(8).getCell(2).value,10);
    assert.equal(newer.getWorksheet("Summary")!.getRow(12).getCell(2).value,"team");

    activateCompetitionWorkspace(db,"legacy");
    const previous=new ExcelJS.Workbook();
    await previous.xlsx.load(await buildResultsWorkbook(db) as any);
    assert.equal(previous.getWorksheet("Summary")!.getRow(2).getCell(2).value,"2026 Original College Cup");
    assert.equal(previous.getWorksheet("Summary")!.getRow(7).getCell(2).value,25);
    assert.equal(previous.getWorksheet("Summary")!.getRow(8).getCell(2).value,25);
    assert.equal(previous.getWorksheet("Summary")!.getRow(12).getCell(2).value,"college");
    assert.equal(previous.getWorksheet("Ranking")!.getRow(2).getCell(4).value,24);
    assert.equal(previous.getWorksheet("Rounds")!.getRow(2).getCell(5).value,24);
    assert.equal(previous.getWorksheet("Submissions")!.getRow(2).getCell(11).value,24);
    activateCompetitionWorkspace(db,secondId);
    assert.equal(activeWorkspaceId(db),secondId);
  } finally {
    if(db.open) db.close();
    rmSync(folder,{recursive:true,force:true});
  }
});
