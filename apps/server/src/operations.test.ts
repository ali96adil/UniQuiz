import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PresenceSnapshot } from "@uniquiz/shared";
import { openDatabase } from "./database.js";
import {
  backupDirectory,
  createDatabaseBackup,
  getOperationsPreflight,
  listDatabaseBackups,
  restoreDatabaseFromBackup,
  verifyDatabaseFile,
} from "./operations.js";

test("backup is integrity-checked, hashed and restorable", () => {
  const root = mkdtempSync(join(tmpdir(), "uniquiz-ops-"));
  const dbPath = join(root, "uniquiz.db");
  const db = openDatabase(dbPath);

  db.prepare(
    "INSERT INTO colleges (name, sort_order) VALUES (?, ?)",
  ).run("Original College", 1);

  const backup = createDatabaseBackup(
    db,
    dbPath,
    "manual",
    new Date("2026-09-29T07:00:00.000Z"),
  );

  assert.equal(backup.integrity, "ok");
  assert.equal(backup.purpose, "manual");

  const backupPath = join(
    backupDirectory(dbPath),
    backup.fileName,
  );
  assert.equal(existsSync(backupPath), true);
  assert.equal(
    verifyDatabaseFile(backupPath).sha256,
    backup.sha256,
  );

  const metadata = JSON.parse(
    readFileSync(backupPath + ".json", "utf8"),
  ) as { sha256: string };
  assert.equal(metadata.sha256, backup.sha256);

  db.prepare("DELETE FROM colleges").run();
  db.close();

  const restored = restoreDatabaseFromBackup(
    backupPath,
    dbPath,
  );
  assert.equal(restored.restoredFrom, backupPath);
  assert.ok(restored.safetyBackup);

  const reopened = openDatabase(dbPath);
  const row = reopened
    .prepare("SELECT name FROM colleges")
    .get() as { name: string };
  assert.equal(row.name, "Original College");
  reopened.close();

  assert.ok(listDatabaseBackups(dbPath).length >= 2);
});

test("preflight requires draw, allocation, stations and backup", () => {
  const root = mkdtempSync(join(tmpdir(), "uniquiz-preflight-"));
  const dbPath = join(root, "uniquiz.db");
  const db = openDatabase(dbPath);

  const presence: PresenceSnapshot = {
    generatedAt: new Date().toISOString(),
    stations: [
      { role: "operator", connected: true, connections: 1 },
      { role: "display", connected: false, connections: 0 },
      { role: "team-a", connected: false, connections: 0 },
      { role: "team-b", connected: false, connections: 0 },
    ],
  };

  const initial = getOperationsPreflight(
    db,
    dbPath,
    {
      enabled: false,
      host: "127.0.0.1",
      port: 9001,
    },
    presence,
  );

  assert.equal(initial.ready, false);
  assert.equal(
    initial.checks.find((check) => check.key === "database")
      ?.ready,
    true,
  );
  assert.equal(
    initial.checks.find((check) => check.key === "backup")
      ?.ready,
    false,
  );

  createDatabaseBackup(db, dbPath);

  const withBackup = getOperationsPreflight(
    db,
    dbPath,
    {
      enabled: false,
      host: "127.0.0.1",
      port: 9001,
    },
    presence,
  );

  assert.equal(
    withBackup.checks.find(
      (check) => check.key === "backup",
    )?.ready,
    true,
  );

  db.close();
});
