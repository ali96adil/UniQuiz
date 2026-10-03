import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase } from "./database.js";
import {
  clearAudiencePresentation,
  getAudiencePresentation,
  showAudiencePresentation,
} from "./presentation.js";

test("audience presentation does not mutate live competition state", () => {
  const db = openDatabase(":memory:");

  db.prepare(`
    UPDATE live_state
    SET
      phase = 'ROUND_ACTIVE',
      round_id = NULL,
      question_position = NULL,
      stations_confirmed = 0,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = 1
  `).run();

  const before = db.prepare(`
    SELECT
      phase,
      round_id AS roundId,
      question_position AS questionPosition,
      stations_confirmed AS stationsConfirmed
    FROM live_state
    WHERE id = 1
  `).get();

  const shown = showAudiencePresentation(db, {
    kind: "BREAK",
  });

  assert.equal(shown.active, true);
  assert.equal(shown.kind, "BREAK");
  assert.equal(shown.title, "استراحة قصيرة");

  const preShow = showAudiencePresentation(db, {
    kind: "CUSTOM",
    title: "__UNIQUIZ_PRESHOW__",
  });
  assert.equal(preShow.active, true);
  assert.equal(preShow.kind, "CUSTOM");
  assert.equal(preShow.title, "__UNIQUIZ_PRESHOW__");

  const afterShow = db.prepare(`
    SELECT
      phase,
      round_id AS roundId,
      question_position AS questionPosition,
      stations_confirmed AS stationsConfirmed
    FROM live_state
    WHERE id = 1
  `).get();

  assert.deepEqual(afterShow, before);

  const cleared = clearAudiencePresentation(db);
  assert.equal(cleared.active, false);

  const afterClear = db.prepare(`
    SELECT
      phase,
      round_id AS roundId,
      question_position AS questionPosition,
      stations_confirmed AS stationsConfirmed
    FROM live_state
    WHERE id = 1
  `).get();

  assert.deepEqual(afterClear, before);

  const audit = db.prepare(`
    SELECT event_type AS eventType
    FROM audit_events
    WHERE event_type LIKE 'AUDIENCE_PRESENTATION_%'
    ORDER BY id
  `).all() as Array<{ eventType: string }>;

  assert.deepEqual(
    audit.map((entry) => entry.eventType),
    [
      "AUDIENCE_PRESENTATION_SHOWN",
      "AUDIENCE_PRESENTATION_SHOWN",
      "AUDIENCE_PRESENTATION_CLEARED",
    ],
  );

  assert.equal(
    getAudiencePresentation(db).active,
    false,
  );

  db.close();
});
