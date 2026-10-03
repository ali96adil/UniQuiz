import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase } from "./database.js";
import { getAudienceDisplaySettings } from "./audience-settings.js";
import { resetAllCompetitionData } from "./reset-all.js";

test("audience branding persists across full competition reset", () => {
  const db = openDatabase(":memory:");

  db.prepare(`
    UPDATE audience_settings
    SET
      event_title = 'Custom Event',
      event_subtitle = 'Custom Subtitle',
      venue = 'Main Hall',
      season = '2026',
      footer_text = 'Custom Footer',
      round_label = 'مرحلة',
      updated_at = '2026-09-29T00:00:00.000Z'
    WHERE id = 1
  `).run();

  db.prepare(`
    INSERT INTO audience_assets (
      slot,
      mime_type,
      bytes,
      updated_at
    )
    VALUES ('university', 'image/png', ?, ?)
  `).run(
    Buffer.from([1, 2, 3]),
    '2026-09-29T00:00:00.000Z',
  );

  resetAllCompetitionData(db);

  const settings = getAudienceDisplaySettings(db);
  assert.equal(settings.eventTitle, "Custom Event");
  assert.equal(settings.eventSubtitle, "Custom Subtitle");
  assert.equal(settings.venue, "Main Hall");
  assert.equal(settings.season, "2026");
  assert.equal(settings.footerText, "Custom Footer");
  assert.equal(settings.roundLabel, "مرحلة");
  assert.equal(settings.copy.rankingTitle, "الترتيب العام");
  assert.equal(settings.copy.preShow.identityLine, "");
  assert.ok(settings.universityLogoUrl?.includes("/university"));
  assert.equal(settings.departmentLogoUrl, null);

  db.close();
});


test("custom audience copy persists with the branding settings", () => {
  const db = openDatabase(":memory:");
  const current = getAudienceDisplaySettings(db);

  const copy = {
    ...current.copy,
    rankingTitle: "الترتيب التجريبي",
    nextRoundTitle: "المواجهة التالية",
    correctAnswerLabel: "الحل الصحيح",
  };

  db.prepare(`
    INSERT INTO audience_copy (id, value_json, updated_at)
    VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      value_json = excluded.value_json,
      updated_at = excluded.updated_at
  `).run(
    JSON.stringify(copy),
    "2026-09-29T01:00:00.000Z",
  );

  const updated = getAudienceDisplaySettings(db);
  assert.equal(updated.copy.rankingTitle, "الترتيب التجريبي");
  assert.equal(updated.copy.nextRoundTitle, "المواجهة التالية");
  assert.equal(updated.copy.correctAnswerLabel, "الحل الصحيح");

  db.close();
});
