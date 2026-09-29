import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase } from "./database.js";
import { getQualificationRanking } from "./ranking.js";

test("ranking includes only revealed scores and leaves not-started colleges unranked", () => {
  const db = openDatabase(":memory:");

  db.exec(`
    INSERT INTO colleges (name, sort_order) VALUES
      ('College A', 1),
      ('College B', 2),
      ('College C', 3);

    INSERT INTO participants (college_id) VALUES (1), (2), (3);

    INSERT INTO qualification_rounds (
      round_order,
      college_a_id,
      college_b_id,
      status
    )
    VALUES
      (1, 1, 2, 'ACTIVE'),
      (2, 3, NULL, 'PENDING');

    INSERT INTO categories (category_key, name, sort_order)
    VALUES ('general', 'General', 1);

    INSERT INTO questions (
      category_id,
      prompt,
      option_a,
      option_b,
      option_c,
      option_d,
      correct_option
    )
    VALUES
      (1, 'Q1', 'A', 'B', 'C', 'D', 'A'),
      (1, 'Q2', 'A', 'B', 'C', 'D', 'A');

    INSERT INTO live_submissions (
      round_id,
      question_position,
      station,
      question_id,
      selected_option,
      submitted_at_epoch_ms,
      response_time_ms,
      is_correct,
      score_micros
    )
    VALUES
      (1, 1, 'A', 1, 'A', 1000, 1000, 1, 25000000),
      (1, 1, 'B', 1, 'B', 2000, 2000, 0, 0),
      (1, 2, 'A', 2, 'A', 3000, 3000, 1, 25000000),
      (1, 2, 'B', 2, 'A', 4000, 4000, 1, 25000000);

    INSERT INTO audit_events (
      event_type,
      round_id,
      position,
      occurred_at
    )
    VALUES (
      'QUESTION_REVEALED',
      1,
      1,
      CURRENT_TIMESTAMP
    );
  `);

  const snapshot = getQualificationRanking(db);

  assert.equal(snapshot.entries.length, 3);

  const a = snapshot.entries.find((entry) => entry.college.id === 1);
  const b = snapshot.entries.find((entry) => entry.college.id === 2);
  const c = snapshot.entries.find((entry) => entry.college.id === 3);

  assert.equal(a?.status, "PLAYING");
  assert.equal(a?.rank, 1);
  assert.equal(a?.scorePoints, 25);
  assert.equal(a?.revealedQuestions, 1);

  assert.equal(b?.status, "PLAYING");
  assert.equal(b?.rank, 2);
  assert.equal(b?.scorePoints, 0);
  assert.equal(b?.revealedQuestions, 1);

  assert.equal(c?.status, "NOT_STARTED");
  assert.equal(c?.rank, null);
  assert.equal(c?.scorePoints, 0);
  assert.equal(c?.revealedQuestions, 0);

  db.close();
});

test("equal revealed scores share the same rank", () => {
  const db = openDatabase(":memory:");

  db.exec(`
    INSERT INTO colleges (name, sort_order) VALUES
      ('College A', 1),
      ('College B', 2);

    INSERT INTO participants (college_id) VALUES (1), (2);

    INSERT INTO qualification_rounds (
      round_order,
      college_a_id,
      college_b_id,
      status
    )
    VALUES (1, 1, 2, 'COMPLETED');

    INSERT INTO categories (category_key, name, sort_order)
    VALUES ('general', 'General', 1);

    INSERT INTO questions (
      category_id,
      prompt,
      option_a,
      option_b,
      option_c,
      option_d,
      correct_option
    )
    VALUES (1, 'Q1', 'A', 'B', 'C', 'D', 'A');

    INSERT INTO live_submissions (
      round_id,
      question_position,
      station,
      question_id,
      selected_option,
      submitted_at_epoch_ms,
      response_time_ms,
      is_correct,
      score_micros
    )
    VALUES
      (1, 1, 'A', 1, 'A', 1000, 1000, 1, 25000000),
      (1, 1, 'B', 1, 'A', 1000, 1000, 1, 25000000);

    INSERT INTO audit_events (
      event_type,
      round_id,
      position,
      occurred_at
    )
    VALUES ('QUESTION_REVEALED', 1, 1, CURRENT_TIMESTAMP);
  `);

  const snapshot = getQualificationRanking(db);

  assert.equal(snapshot.entries[0]?.rank, 1);
  assert.equal(snapshot.entries[1]?.rank, 1);
  assert.equal(snapshot.entries[0]?.scorePoints, 25);
  assert.equal(snapshot.entries[1]?.scorePoints, 25);

  db.close();
});


test("latest void invalidates an earlier reveal until replacement is revealed", () => {
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
    ) VALUES
      (1, 'Original', 'A', 'B', 'C', 'D', 'A'),
      (1, 'Replacement', 'A', 'B', 'C', 'D', 'A');
    INSERT INTO live_submissions (
      round_id, question_position, station, question_id,
      selected_option, submitted_at_epoch_ms, response_time_ms,
      is_correct, score_micros
    ) VALUES
      (1, 1, 'A', 1, 'A', 1000, 1000, 1, 25000000);
    INSERT INTO audit_events (
      event_type, round_id, question_id, position, occurred_at
    ) VALUES ('QUESTION_REVEALED', 1, 1, 1, CURRENT_TIMESTAMP);
  `);

  assert.equal(
    getQualificationRanking(db).entries[0]?.scorePoints,
    25,
  );

  db.exec(`
    INSERT INTO audit_events (
      event_type, round_id, question_id, related_question_id,
      position, reason, occurred_at
    ) VALUES (
      'QUESTION_VOID_REPLACED', 1, 1, 2, 1, 'technical', CURRENT_TIMESTAMP
    );
    DELETE FROM live_submissions
    WHERE round_id = 1 AND question_position = 1;
    INSERT INTO live_submissions (
      round_id, question_position, station, question_id,
      selected_option, submitted_at_epoch_ms, response_time_ms,
      is_correct, score_micros
    ) VALUES
      (1, 1, 'A', 2, 'A', 2000, 10000, 1, 20000000);
  `);

  assert.equal(
    getQualificationRanking(db).entries[0]?.scorePoints,
    0,
  );

  db.exec(`
    INSERT INTO audit_events (
      event_type, round_id, question_id, position, occurred_at
    ) VALUES ('QUESTION_REVEALED', 1, 2, 1, CURRENT_TIMESTAMP);
  `);

  assert.equal(
    getQualificationRanking(db).entries[0]?.scorePoints,
    20,
  );

  db.close();
});
