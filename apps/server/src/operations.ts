import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import {
  hostname,
  networkInterfaces,
  platform,
} from "node:os";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type {
  OperationsBackupRecord,
  OperationsPreflightCheck,
  OperationsDiagnosticsSnapshot,
  OperationsPreflightSnapshot,
  PresenceSnapshot,
  RuntimeMode,
} from "@uniquiz/shared";
import { appendAuditEvent } from "./audit.js";
import { getCompetitionSnapshot } from "./competition.js";
import type { AppDatabase } from "./database.js";
import { getQuestionAllocationSummary } from "./question-bank.js";
import type { OscOutputConfig } from "./osc-output.js";

const oscConfirmSchema = z.object({
  confirm: z.literal("OSC_TEST_RECEIVED"),
});

interface BackupMetadata extends OperationsBackupRecord {
  version: 1;
  databaseFileName: string;
}

function safeTimestamp(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function sqlStringLiteral(value: string): string {
  return "'" + value.replaceAll("'", "''") + "'";
}

function sha256File(path: string): string {
  return createHash("sha256")
    .update(readFileSync(path))
    .digest("hex");
}

export function verifyDatabaseFile(path: string): {
  integrity: "ok";
  sizeBytes: number;
  sha256: string;
} {
  if (!existsSync(path)) {
    throw new Error("BACKUP_FILE_NOT_FOUND");
  }

  const db = new Database(path, {
    readonly: true,
    fileMustExist: true,
  });

  try {
    const rows = db.pragma("integrity_check") as Array<{
      integrity_check: string;
    }>;

    if (
      rows.length !== 1 ||
      rows[0]?.integrity_check !== "ok"
    ) {
      throw new Error("DATABASE_INTEGRITY_CHECK_FAILED");
    }
  } finally {
    db.close();
  }

  return {
    integrity: "ok",
    sizeBytes: statSync(path).size,
    sha256: sha256File(path),
  };
}

export function backupDirectory(
  databasePath: string,
): string {
  return join(dirname(resolve(databasePath)), "backups");
}

function metadataPath(databaseBackupPath: string): string {
  return databaseBackupPath + ".json";
}

export function createDatabaseBackup(
  db: AppDatabase,
  databasePath: string,
  purpose:
    | "manual"
    | "pre-restore"
    | "pre-reset" = "manual",
  now = new Date(),
): OperationsBackupRecord {
  if (databasePath === ":memory:") {
    throw new Error("IN_MEMORY_DATABASE_CANNOT_BE_BACKED_UP");
  }

  const directory = backupDirectory(databasePath);
  mkdirSync(directory, { recursive: true });

  const fileName =
    `uniquiz-${purpose}-${safeTimestamp(now)}.db`;
  const destination = join(directory, fileName);

  if (existsSync(destination)) {
    throw new Error("BACKUP_DESTINATION_ALREADY_EXISTS");
  }

  db.pragma("wal_checkpoint(FULL)");
  db.exec(
    `VACUUM INTO ${sqlStringLiteral(destination)}`,
  );

  const verified = verifyDatabaseFile(destination);
  const record: OperationsBackupRecord = {
    fileName,
    createdAt: now.toISOString(),
    sizeBytes: verified.sizeBytes,
    sha256: verified.sha256,
    integrity: "ok",
    purpose,
  };

  const metadata: BackupMetadata = {
    version: 1,
    databaseFileName: basename(databasePath),
    ...record,
  };

  writeFileSync(
    metadataPath(destination),
    JSON.stringify(metadata, null, 2) + "\n",
    "utf8",
  );

  return record;
}

function readBackupMetadata(
  path: string,
): BackupMetadata | null {
  try {
    const parsed = JSON.parse(
      readFileSync(path, "utf8"),
    ) as Partial<BackupMetadata>;

    if (
      parsed.version !== 1 ||
      typeof parsed.fileName !== "string" ||
      typeof parsed.createdAt !== "string" ||
      typeof parsed.sizeBytes !== "number" ||
      typeof parsed.sha256 !== "string" ||
      parsed.integrity !== "ok" ||
      (parsed.purpose !== "manual" &&
        parsed.purpose !== "pre-restore" &&
        parsed.purpose !== "pre-reset") ||
      typeof parsed.databaseFileName !== "string"
    ) {
      return null;
    }

    return parsed as BackupMetadata;
  } catch {
    return null;
  }
}

export function listDatabaseBackups(
  databasePath: string,
): OperationsBackupRecord[] {
  const directory = backupDirectory(databasePath);
  if (!existsSync(directory)) return [];

  return readdirSync(directory)
    .filter((name) => name.endsWith(".db"))
    .map((fileName) => {
      const backupPath = join(directory, fileName);
      const metadata = readBackupMetadata(
        metadataPath(backupPath),
      );

      if (
        !metadata ||
        metadata.fileName !== fileName ||
        !existsSync(backupPath) ||
        statSync(backupPath).size !== metadata.sizeBytes
      ) {
        return null;
      }

      return {
        fileName: metadata.fileName,
        createdAt: metadata.createdAt,
        sizeBytes: metadata.sizeBytes,
        sha256: metadata.sha256,
        integrity: metadata.integrity,
        purpose: metadata.purpose,
      } satisfies OperationsBackupRecord;
    })
    .filter(
      (
        record,
      ): record is OperationsBackupRecord =>
        record !== null,
    )
    .sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
}

export function restoreDatabaseFromBackup(
  backupPath: string,
  databasePath: string,
): {
  restoredFrom: string;
  safetyBackup: OperationsBackupRecord | null;
} {
  const source = resolve(backupPath);
  const target = resolve(databasePath);

  const verified = verifyDatabaseFile(source);
  const metadata = readBackupMetadata(metadataPath(source));

  if (
    metadata &&
    (metadata.sha256 !== verified.sha256 ||
      metadata.sizeBytes !== verified.sizeBytes)
  ) {
    throw new Error("BACKUP_METADATA_MISMATCH");
  }

  let safetyBackup: OperationsBackupRecord | null = null;

  if (existsSync(target)) {
    const current = new Database(target);
    try {
      current.pragma("journal_mode = WAL");
      current.pragma("wal_checkpoint(TRUNCATE)");
      safetyBackup = createDatabaseBackup(
        current as AppDatabase,
        target,
        "pre-restore",
      );
    } finally {
      current.close();
    }
  }

  const temp = target + ".restore.tmp";
  copyFileSync(source, temp);
  verifyDatabaseFile(temp);

  rmSync(target + "-wal", { force: true });
  rmSync(target + "-shm", { force: true });

  // The authoritative runtime is macOS. Renaming a fully verified
  // temp file in the same directory minimizes the window where the
  // target database could be partially replaced.
  renameSync(temp, target);

  verifyDatabaseFile(target);

  return {
    restoredFrom: source,
    safetyBackup,
  };
}

export async function isLocalServerRunning(
  port: number,
): Promise<boolean> {
  try {
    const response = await fetch(
      `http://127.0.0.1:${port}/health`,
      {
        signal: AbortSignal.timeout(600),
      },
    );

    if (!response.ok) return false;
    const body = (await response.json()) as {
      service?: unknown;
    };
    return body.service === "uniquiz-server";
  } catch {
    return false;
  }
}

export function getOscTestState(
  db: AppDatabase,
): {
  sentAt: string | null;
  confirmedAt: string | null;
} {
  return db.prepare(`
    SELECT
      osc_test_sent_at AS sentAt,
      osc_test_confirmed_at AS confirmedAt
    FROM operations_state
    WHERE id = 1
  `).get() as {
    sentAt: string | null;
    confirmedAt: string | null;
  };
}

export function resetOscTestState(
  db: AppDatabase,
): void {
  db.prepare(`
    UPDATE operations_state
    SET
      osc_test_sent_at = NULL,
      osc_test_confirmed_at = NULL,
      updated_at = ?
    WHERE id = 1
  `).run(new Date().toISOString());
}

export function markOscTestSent(
  db: AppDatabase,
): void {
  const sentAt = new Date().toISOString();

  db.prepare(`
    UPDATE operations_state
    SET
      osc_test_sent_at = ?,
      osc_test_confirmed_at = NULL,
      updated_at = ?
    WHERE id = 1
  `).run(sentAt, sentAt);

  appendAuditEvent(db, {
    eventType: "OSC_TEST_SENT",
    occurredAt: sentAt,
  });
}

export function confirmOscTest(
  db: AppDatabase,
): void {
  const state = getOscTestState(db);
  if (!state.sentAt) {
    throw new Error("OSC_TEST_NOT_SENT");
  }

  const confirmedAt = new Date().toISOString();

  db.prepare(`
    UPDATE operations_state
    SET
      osc_test_confirmed_at = ?,
      updated_at = ?
    WHERE id = 1
  `).run(confirmedAt, confirmedAt);

  appendAuditEvent(db, {
    eventType: "OSC_TEST_CONFIRMED",
    occurredAt: confirmedAt,
  });
}

function databaseQuickCheck(
  db: AppDatabase,
): boolean {
  try {
    const rows = db.pragma("quick_check") as Array<{
      quick_check: string;
    }>;
    return (
      rows.length === 1 &&
      rows[0]?.quick_check === "ok"
    );
  } catch {
    return false;
  }
}

function connected(
  presence: PresenceSnapshot,
  role: "display" | "team-a" | "team-b",
): boolean {
  return (
    presence.stations.find(
      (station) => station.role === role,
    )?.connected ?? false
  );
}

export function getOperationsPreflight(
  db: AppDatabase,
  databasePath: string,
  osc: OscOutputConfig,
  presence: PresenceSnapshot,
): OperationsPreflightSnapshot {
  const competition = getCompetitionSnapshot(db);
  const allocation = getQuestionAllocationSummary(db);
  const latestBackup =
    listDatabaseBackups(databasePath)[0] ?? null;
  const oscTest = getOscTestState(db);
  const oscReady =
    !osc.enabled ||
    (
      oscTest.sentAt !== null &&
      oscTest.confirmedAt !== null &&
      oscTest.confirmedAt >= oscTest.sentAt
    );

  const nextRound =
    competition.rounds.find(
      (round) => round.id === competition.nextRoundId,
    ) ??
    competition.rounds.find(
      (round) => round.status === "PENDING",
    ) ??
    null;

  const pairedNextRound =
    nextRound !== null && nextRound.collegeB !== null;

  const databaseReady = databaseQuickCheck(db);
  const displayReady = connected(presence, "display");
  const teamAReady = connected(presence, "team-a");
  const teamBReady = connected(presence, "team-b");

  const checks: OperationsPreflightCheck[] = [
    {
      key: "server",
      label: "Server",
      required: true,
      ready: true,
      detail: "UniQuiz server is responding.",
    },
    {
      key: "database",
      label: "Database",
      required: true,
      ready: databaseReady,
      detail: databaseReady
        ? "SQLite quick_check = ok."
        : "SQLite quick_check failed.",
    },
    {
      key: "draw",
      label: "Official Draw",
      required: true,
      ready:
        competition.participantsLocked &&
        competition.rounds.length > 0,
      detail:
        competition.rounds.length > 0
          ? `${competition.rounds.length} qualification rounds are persisted.`
          : "Official qualification draw is missing.",
    },
    {
      key: "question_allocation",
      label: "Question Allocation",
      required: true,
      ready: allocation.ready,
      detail: allocation.ready
        ? "Every round has a locked 10-question set."
        : "Question sets are not fully allocated and locked.",
    },
    {
      key: "display",
      label: "Audience Display",
      required: true,
      ready: displayReady,
      detail: displayReady
        ? "Audience display is connected."
        : "Audience display is offline.",
    },
    {
      key: "team_a",
      label: "Team A",
      required: true,
      ready: teamAReady,
      detail: teamAReady
        ? "Authenticated Team A station is connected."
        : "Authenticated Team A station is offline.",
    },
    {
      key: "team_b",
      label: "Team B",
      required: pairedNextRound,
      ready: !pairedNextRound || teamBReady,
      detail: !nextRound
        ? "No next round is available yet."
        : pairedNextRound
          ? teamBReady
            ? "Authenticated Team B station is connected."
            : "Team B is required for the next round and is offline."
          : "Next round is solo; Team B is not required.",
    },
    {
      key: "osc",
      label: "OSC",
      required: osc.enabled,
      ready: oscReady,
      detail: !osc.enabled
        ? "OSC is disabled and is not required."
        : oscReady
          ? `OSC test confirmed for ${osc.host}:${osc.port}.`
          : oscTest.sentAt
            ? "OSC test was sent but downstream reception has not been confirmed."
            : `OSC is enabled for ${osc.host}:${osc.port}; send and confirm a test cue.`,
    },
    {
      key: "backup",
      label: "Backup",
      required: true,
      ready: latestBackup !== null,
      detail: latestBackup
        ? `Verified backup: ${latestBackup.fileName}`
        : "No verified UniQuiz backup is available.",
    },
  ];

  return {
    generatedAt: new Date().toISOString(),
    ready: checks.every(
      (check) => !check.required || check.ready,
    ),
    checks,
    latestBackup,
  };
}

export function getOperationsDiagnostics(
  options: {
    mode: RuntimeMode;
    databasePath: string;
    serverPort: number;
    webPort: number;
    osc: OscOutputConfig;
    presence: PresenceSnapshot;
  },
  interfaces: Record<
    string,
    readonly {
      address: string;
      family: string;
      internal: boolean;
    }[] | undefined
  > = networkInterfaces(),
): OperationsDiagnosticsSnapshot {
  const lanInterfaces: OperationsDiagnosticsSnapshot["interfaces"] = [];

  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) {
        continue;
      }

      lanInterfaces.push({
        name,
        address: entry.address,
        webBaseUrl:
          `http://${entry.address}:${options.webPort}`,
        serverHealthUrl:
          `http://${entry.address}:${options.serverPort}/health`,
      });
    }
  }

  lanInterfaces.sort((a, b) =>
    a.name.localeCompare(b.name) ||
    a.address.localeCompare(b.address),
  );

  return {
    generatedAt: new Date().toISOString(),
    mode: options.mode,
    hostname: hostname(),
    platform: platform(),
    nodeVersion: process.version,
    serverPort: options.serverPort,
    webPort: options.webPort,
    databaseFileName: basename(options.databasePath),
    osc: {
      enabled: options.osc.enabled,
      host: options.osc.host,
      port: options.osc.port,
    },
    interfaces: lanInterfaces,
    presence: options.presence,
  };
}

export function registerOperationsRoutes(
  app: FastifyInstance,
  db: AppDatabase,
  options: {
    mode: RuntimeMode;
    databasePath: string;
    serverPort: number;
    webPort: number;
    osc: OscOutputConfig;
    getPresence: () => PresenceSnapshot;
    sendOscTest: () => void;
  },
): void {
  resetOscTestState(db);

  app.post("/api/operations/osc-test/send", async (_request, reply) => {
    if (!options.osc.enabled) {
      return reply.code(409).send({
        error: "OSC_DISABLED",
        message: "OSC is disabled.",
      });
    }

    options.sendOscTest();
    markOscTestSent(db);

    return getOperationsPreflight(
      db,
      options.databasePath,
      options.osc,
      options.getPresence(),
    );
  });

  app.post("/api/operations/osc-test/confirm", async (request, reply) => {
    const body = oscConfirmSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({
        error: "INVALID_OSC_CONFIRMATION",
        issues: body.error.issues,
      });
    }

    if (!options.osc.enabled) {
      return reply.code(409).send({
        error: "OSC_DISABLED",
        message: "OSC is disabled.",
      });
    }

    try {
      confirmOscTest(db);
    } catch (error) {
      return reply.code(409).send({
        error:
          error instanceof Error
            ? error.message
            : "OSC_CONFIRMATION_FAILED",
      });
    }

    return getOperationsPreflight(
      db,
      options.databasePath,
      options.osc,
      options.getPresence(),
    );
  });

  app.get("/api/operations/diagnostics", async () =>
    getOperationsDiagnostics({
      mode: options.mode,
      databasePath: options.databasePath,
      serverPort: options.serverPort,
      webPort: options.webPort,
      osc: options.osc,
      presence: options.getPresence(),
    }),
  );

  app.get("/api/operations/preflight", async () =>
    getOperationsPreflight(
      db,
      options.databasePath,
      options.osc,
      options.getPresence(),
    ),
  );

  app.get("/api/operations/backups", async () => ({
    backups: listDatabaseBackups(options.databasePath),
  }));

  app.post("/api/operations/backup", async (_request, reply) => {
    try {
      const backup = createDatabaseBackup(
        db,
        options.databasePath,
      );

      return {
        ok: true,
        backup,
      };
    } catch (error) {
      return reply.code(500).send({
        error: "BACKUP_FAILED",
        message:
          error instanceof Error
            ? error.message
            : "Backup failed.",
      });
    }
  });
}
