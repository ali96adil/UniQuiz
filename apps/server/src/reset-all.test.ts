import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase } from "./database.js";
import { ensureStationCredentials } from "./station-auth.js";
import { resetAllCompetitionData } from "./reset-all.js";

test("full competition reset clears user data and preserves station credentials", () => {
  const db = openDatabase(":memory:");
  ensureStationCredentials(db);

  db.exec(`
    INSERT INTO colleges (name, sort_order)
    VALUES ('College A', 1), ('College B', 2);

    INSERT INTO participants (college_id)
    VALUES (1), (2);

    UPDATE competition_state
    SET participants_locked = 1,
        draw_created_at = '2026-09-29T00:00:00.000Z'
    WHERE id = 1;

    INSERT INTO qualification_rounds (
      round_order,
      college_a_id,
      college_b_id,
      status
    )
    VALUES (1, 1, 2, 'PENDING');

    INSERT INTO categories (category_key, name, sort_order)
    VALUES ('sports', 'Sports', 1);

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

    INSERT INTO audit_events (
      event_type,
      round_id,
      occurred_at
    )
    VALUES ('TEST', 1, CURRENT_TIMESTAMP);

    UPDATE live_state
    SET phase = 'ROUND_READY',
        round_id = 1,
        stations_confirmed = 1
    WHERE id = 1;
  `);

  const credentialsBefore = db.prepare(`
    SELECT station, access_token AS token
    FROM station_credentials
    ORDER BY station
  `).all();

  resetAllCompetitionData(db);

  for (const table of [
    "colleges",
    "participants",
    "qualification_rounds",
    "categories",
    "questions",
    "audit_events",
    "live_submissions",
    "qualification_round_question_sets",
    "qualification_round_questions",
    "qualification_question_reservations",
  ]) {
    const row = db.prepare(
      `SELECT COUNT(*) AS count FROM ${table}`,
    ).get() as { count: number };

    assert.equal(row.count, 0, table);
  }

  const competition = db.prepare(`
    SELECT
      participants_locked AS participantsLocked,
      draw_created_at AS drawCreatedAt,
      selected_round_id AS selectedRoundId
    FROM competition_state
    WHERE id = 1
  `).get() as {
    participantsLocked: number;
    drawCreatedAt: string | null;
    selectedRoundId: number | null;
  };

  assert.equal(competition.participantsLocked, 0);
  assert.equal(competition.drawCreatedAt, null);
  assert.equal(competition.selectedRoundId, null);

  const live = db.prepare(`
    SELECT
      phase,
      round_id AS roundId,
      stations_confirmed AS stationsConfirmed
    FROM live_state
    WHERE id = 1
  `).get() as {
    phase: string;
    roundId: number | null;
    stationsConfirmed: number;
  };

  assert.equal(live.phase, "IDLE");
  assert.equal(live.roundId, null);
  assert.equal(live.stationsConfirmed, 0);

  const credentialsAfter = db.prepare(`
    SELECT station, access_token AS token
    FROM station_credentials
    ORDER BY station
  `).all();

  assert.deepEqual(credentialsAfter, credentialsBefore);

  const schema = db.prepare(`
    SELECT value
    FROM app_meta
    WHERE key = 'schema_version'
  `).get() as { value: string };

  assert.ok(schema.value);

  db.close();
});
