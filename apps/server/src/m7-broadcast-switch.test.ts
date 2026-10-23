import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Fastify from "fastify";
import { Server as SocketIOServer } from "socket.io";
import { openDatabase } from "./database.js";
import { LiveSessionManager } from "./live-session.js";
import {
  activeWorkspaceId,
  createCompetitionWorkspace,
  registerCompetitionWorkspaceRoutes,
} from "./competition-workspaces.js";
import { getCompetitionGameplayRules } from "./competition-gameplay.js";
import { getCompetitionRules } from "./competition-rules.js";

test("M7 multi-tab activation sends each workspace's actual quotas and scoring before active ID", async () => {
  const folder = mkdtempSync(join(tmpdir(), "uniquiz-m7-multitab-"));
  const path = join(folder, "tournaments.db");
  const db = openDatabase(path);
  const app = Fastify();
  const io = new SocketIOServer(app.server);
  const live = new LiveSessionManager(db, io);
  const emitted: Array<{ name: string; value: unknown }> = [];
  // Observe the same io.emit calls consumed by existing browser tabs.
  // No client sockets are necessary to verify the exact event payload/order.
  (io as unknown as { emit: (name: string, ...values: unknown[]) => boolean }).emit =
    (name, ...values) => {
      emitted.push({ name, value: values[0] });
      return true;
    };
  try {
    db.exec(`
      INSERT INTO categories(category_key,name,sort_order)
      VALUES ('sports','رياضة',1),('history','تاريخ',2);
      UPDATE competition_rules SET distribution_json =
        '[{"categoryKey":"history","questions":4}]' WHERE id=1;
      UPDATE competition_gameplay_rules
      SET duration_seconds=45,scoring_mode='time_decay',correct_points=60,
          points_lost_per_second=2 WHERE id=1;
      UPDATE audience_settings SET event_title='Legacy 2026' WHERE id=1;
    `);
    const next = createCompetitionWorkspace(db, "New Sports Cup", "team");
    registerCompetitionWorkspaceRoutes(app, db, io, live, path);
    await app.ready();
    const forward = await app.inject({
      method: "POST", url: `/api/competitions/${next.id}/activate`, payload: {},
    });
    assert.equal(forward.statusCode, 200, forward.body);
    assert.equal(activeWorkspaceId(db), next.id);
    const eventsFor = (key: string) => emitted.filter((event) => event.name === key);
    assert.equal(eventsFor("competition-rules:snapshot").length, 1);
    assert.equal(eventsFor("competition:gameplay").length, 1);
    const firstGameplay = eventsFor("competition:gameplay")[0]?.value as { durationSeconds: number };
    assert.equal(firstGameplay.durationSeconds, 25);
    const firstRules = eventsFor("competition-rules:snapshot")[0]?.value as { questionsPerRound: number };
    assert.equal(firstRules.questionsPerRound, 10);
    const firstWorkspaces = eventsFor("competition:workspaces")[0]?.value as Array<{
      id: string; active: boolean; participantType: string;
    }>;
    assert.equal(firstWorkspaces.find((row) => row.active)?.id, next.id);
    assert.equal(firstWorkspaces.find((row) => row.active)?.participantType, "team");
    assert.ok(
      emitted.findIndex((event) => event.name === "competition:gameplay") <
      emitted.findIndex((event) => event.name === "competition:workspaces"),
      "Active-workspace notification must follow its fresh data broadcasts",
    );
    assert.equal(
      (emitted.find((event) => event.name === "audience:settings")?.value as
        { eventTitle: string }).eventTitle,
      "New Sports Cup",
    );

    db.exec(`
      UPDATE competition_rules SET distribution_json =
        '[{"categoryKey":"sports","questions":3}]' WHERE id=1;
      UPDATE competition_gameplay_rules
        SET duration_seconds=40,scoring_mode='fixed',correct_points=10,
            points_lost_per_second=0 WHERE id=1;
    `);
    emitted.length = 0;
    const backwards = await app.inject({
      method: "POST", url: "/api/competitions/legacy/activate", payload: {},
    });
    assert.equal(backwards.statusCode, 200, backwards.body);
    assert.equal(activeWorkspaceId(db), "legacy");
    const previousRules = eventsFor("competition-rules:snapshot")[0]?.value as
      { questionsPerRound: number; categories: Array<{categoryKey:string}> };
    assert.equal(previousRules.questionsPerRound, 4);
    assert.equal(previousRules.categories[0]?.categoryKey, "history");
    const previousGameplay = eventsFor("competition:gameplay")[0]?.value as
      { durationSeconds: number; correctPoints: number };
    assert.equal(previousGameplay.durationSeconds, 45);
    assert.equal(previousGameplay.correctPoints, 60);
    assert.equal(getCompetitionRules(db).questionsPerRound, 4);
    assert.equal(getCompetitionGameplayRules(db).durationSeconds, 45);
    assert.equal(
      (emitted.find((event) => event.name === "audience:settings")?.value as
        { eventTitle: string }).eventTitle,
      "Legacy 2026",
    );

    emitted.length = 0;
    const reopen = await app.inject({
      method: "POST", url: `/api/competitions/${next.id}/activate`, payload: {},
    });
    assert.equal(reopen.statusCode, 200, reopen.body);
    assert.equal((eventsFor("competition-rules:snapshot")[0]?.value as
      { questionsPerRound: number }).questionsPerRound, 3);
    assert.equal((eventsFor("competition:gameplay")[0]?.value as
      { durationSeconds: number; correctPoints: number }).durationSeconds, 40);
    assert.equal(getCompetitionGameplayRules(db).correctPoints, 10);
  } finally {
    live.dispose();
    io.close();
    await app.close();
    db.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
