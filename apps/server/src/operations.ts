import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import type {
  OperationsBackupRecord,
  OperationsPreflightCheck,
  OperationsPreflightSnapshot,
  PresenceSnapshot,
} from "@uniquiz/shared";
import { getCompetitionSnapshot } from "./competition.js";
import type { AppDatabase } from "./database.js";
import { getQuestionAllocationSummary } from "./question-bank.js";
import type { OscOutputConfig } from "./osc-output.js";

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
  purpose: "manual" | "pre-restore" = "manual",
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
        parsed.purpose !== "pre-restore") ||
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
  copyFileSync(temp, target);
  rmSync(temp, { force: true });
  rmSync(target + "-wal", { force: true });
  rmSync(target + "-shm", { force: true });

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
      ready: true,
      detail: osc.enabled
        ? `UDP target configured: ${osc.host}:${osc.port}. Delivery remains best-effort; confirm downstream reception during rehearsal.`
        : "OSC is disabled and is not required.",
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

export function registerOperationsRoutes(
  app: FastifyInstance,
  db: AppDatabase,
  options: {
    databasePath: string;
    osc: OscOutputConfig;
    getPresence: () => PresenceSnapshot;
  },
): void {
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
