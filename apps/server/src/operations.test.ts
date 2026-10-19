import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
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
  verifyBackupRecord,
  confirmOscTest,
  getOscTestState,
  markOscTestSent,
  resetOscTestState,
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


test("LAN diagnostics reports usable browser and health URLs", async () => {
  const { getOperationsDiagnostics } =
    await import("./operations.js");

  const presence: PresenceSnapshot = {
    generatedAt: "2026-09-29T00:00:00.000Z",
    stations: [],
  };

  const snapshot = getOperationsDiagnostics(
    {
      mode: "official",
      databasePath: "/tmp/uniquiz.db",
      serverPort: 8787,
      webPort: 5173,
      osc: {
        enabled: true,
        host: "127.0.0.1",
        port: 9001,
      },
      presence,
    },
    {
      en0: [
        {
          address: "192.168.3.114",
          family: "IPv4",
          internal: false,
        },
      ],
      lo0: [
        {
          address: "127.0.0.1",
          family: "IPv4",
          internal: true,
        },
      ],
    },
  );

  assert.equal(snapshot.mode, "official");
  assert.equal(snapshot.interfaces.length, 1);
  assert.equal(
    snapshot.interfaces[0]?.webBaseUrl,
    "http://192.168.3.114:5173",
  );
  assert.equal(
    snapshot.interfaces[0]?.serverHealthUrl,
    "http://192.168.3.114:8787/health",
  );
});


test("enabled OSC stays NOT READY until test reception is confirmed", () => {
  const root = mkdtempSync(join(tmpdir(), "uniquiz-osc-preflight-"));
  const dbPath = join(root, "uniquiz.db");
  const db = openDatabase(dbPath);

  const presence: PresenceSnapshot = {
    generatedAt: new Date().toISOString(),
    stations: [],
  };

  const osc = {
    enabled: true,
    host: "127.0.0.1",
    port: 9001,
  };

  let snapshot = getOperationsPreflight(
    db,
    dbPath,
    osc,
    presence,
  );

  assert.equal(
    snapshot.checks.find((check) => check.key === "osc")?.ready,
    false,
  );

  markOscTestSent(db);

  snapshot = getOperationsPreflight(
    db,
    dbPath,
    osc,
    presence,
  );

  assert.equal(
    snapshot.checks.find((check) => check.key === "osc")?.ready,
    false,
  );

  confirmOscTest(db);

  snapshot = getOperationsPreflight(
    db,
    dbPath,
    osc,
    presence,
  );

  assert.equal(
    snapshot.checks.find((check) => check.key === "osc")?.ready,
    true,
  );

  resetOscTestState(db);
  assert.equal(getOscTestState(db).confirmedAt, null);

  db.close();
});


test("restore replaces the target only after the temp copy passes integrity", () => {
  const root = mkdtempSync(join(tmpdir(), "uniquiz-atomic-restore-"));
  const dbPath = join(root, "uniquiz.db");
  const db = openDatabase(dbPath);

  db.prepare(
    "INSERT INTO colleges (name, sort_order) VALUES (?, ?)",
  ).run("Backup College", 1);

  const backup = createDatabaseBackup(db, dbPath);
  const backupPath = join(
    backupDirectory(dbPath),
    backup.fileName,
  );

  db.prepare("DELETE FROM colleges").run();
  db.close();

  restoreDatabaseFromBackup(backupPath, dbPath);

  assert.equal(
    existsSync(dbPath + ".restore.tmp"),
    false,
  );

  const reopened = openDatabase(dbPath);
  const row = reopened.prepare(
    "SELECT name FROM colleges LIMIT 1",
  ).get() as { name: string };

  assert.equal(row.name, "Backup College");
  reopened.close();
});


test("pre-reset backups are recognized as verified backups", () => {
  const root = mkdtempSync(join(tmpdir(), "uniquiz-pre-reset-"));
  const dbPath = join(root, "uniquiz.db");
  const db = openDatabase(dbPath);

  db.prepare(
    "INSERT INTO colleges (name, sort_order) VALUES (?, ?)",
  ).run("Protected College", 1);

  const backup = createDatabaseBackup(
    db,
    dbPath,
    "pre-reset",
  );

  assert.equal(backup.purpose, "pre-reset");

  const listed = listDatabaseBackups(dbPath);
  assert.equal(
    listed.some(
      (entry) =>
        entry.fileName === backup.fileName &&
        entry.purpose === "pre-reset",
    ),
    true,
  );

  db.close();
});


test("M7 preflight refuses same-size corrupted SQLite backup even when metadata says ok", () => {
  const root = mkdtempSync(join(tmpdir(), "uniquiz-m7-backup-integrity-"));
  const dbPath = join(root, "uniquiz.db");
  const db = openDatabase(dbPath);
  try {
    const presence: PresenceSnapshot = { generatedAt: new Date().toISOString(), stations: [] };
    const osc = { enabled: false, host: "127.0.0.1", port: 9001 };
    const record = createDatabaseBackup(db, dbPath);
    const file = join(backupDirectory(dbPath), record.fileName);
    const baseline = readFileSync(file);
    assert.equal(verifyBackupRecord(dbPath, record), true);
    assert.equal(
      getOperationsPreflight(db, dbPath, osc, presence).checks.find((check) => check.key === "backup")?.ready,
      true,
    );

    const corrupt = Buffer.from(baseline);
    // Keep the exact file length and original JSON sidecar unchanged.
    // Header damage is an unambiguous failure independent of SQLite page size.
    corrupt[0] ^= 0xff;
    writeFileSync(file, corrupt);
    assert.equal(readFileSync(file).length, record.sizeBytes);
    assert.equal(verifyBackupRecord(dbPath, record), false);
    const failed = getOperationsPreflight(db, dbPath, osc, presence);
    assert.equal(failed.checks.find((check) => check.key === "backup")?.ready, false);
    assert.match(
      failed.checks.find((check) => check.key === "backup")?.detail ?? "",
      /content or checksum could not be verified/,
    );

    writeFileSync(file, baseline);
    assert.equal(verifyBackupRecord(dbPath, record), true);
    assert.equal(
      getOperationsPreflight(db, dbPath, osc, presence).checks.find((check) => check.key === "backup")?.ready,
      true,
    );
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("M7 preflight rejects forged backup sidecar checksum with intact database file", () => {
  const root = mkdtempSync(join(tmpdir(), "uniquiz-m7-backup-hash-"));
  const dbPath = join(root, "uniquiz.db");
  const db = openDatabase(dbPath);
  try {
    const record = createDatabaseBackup(db, dbPath);
    const metadataPath = join(backupDirectory(dbPath), record.fileName + ".json");
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as { sha256: string };
    metadata.sha256 = "0".repeat(64);
    writeFileSync(metadataPath, JSON.stringify(metadata));
    const presence: PresenceSnapshot = { generatedAt: new Date().toISOString(), stations: [] };
    const osc = { enabled: false, host: "127.0.0.1", port: 9001 };
    const result = getOperationsPreflight(db, dbPath, osc, presence);
    assert.equal(result.checks.find((check) => check.key === "backup")?.ready, false);
    assert.equal(result.ready, false);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
