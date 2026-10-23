import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDatabase } from "./database.js";
import { getCompetitionSnapshot } from "./competition.js";
import { getQualificationRanking } from "./ranking.js";
import { getAudienceDisplaySettings } from "./audience-settings.js";
import { getQuestionBankSummary } from "./importer.js";
import { createDatabaseBackup } from "./operations.js";

const createSchema = z.object({
  title: z.string().trim().min(1).max(180),
});
const archiveDeleteSchema = z.object({
  confirm: z.literal("DELETE_ARCHIVE"),
  title: z.string(),
}).strict();

// Explicit allowlist: station access tokens and process settings are NOT archived.
// Historical images (BLOBs) are encoded losslessly for JSON export.
const historicalTables = [
  "colleges",
  "competition_state",
  "participants",
  "qualification_rounds",
  "qualification_round_rules",
  "qualification_round_question_sets",
  "qualification_round_questions",
  "qualification_question_reservations",
  "categories",
  "questions",
  "competition_rules",
  "competition_gameplay_rules",
  "audit_events",
  "live_state",
  "live_submissions",
  "audience_settings",
  "audience_copy",
  "audience_presentation",
  "audience_assets",
] as const;

function portableValue(value: unknown): unknown {
  if (Buffer.isBuffer(value)) {
    return { kind: "base64-blob", data: value.toString("base64") };
  }
  if (Array.isArray(value)) return value.map(portableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, part]) => [key, portableValue(part)]),
    );
  }
  return value;
}

interface ArchiveRow {
  id: string;
  title: string;
  archivedAt: string;
  participantCount: number;
  roundCount: number;
  questionCount: number;
}

function listArchives(db: AppDatabase): ArchiveRow[] {
  return db.prepare(`
    SELECT id, title, archived_at AS archivedAt,
      participant_count AS participantCount,
      round_count AS roundCount,
      question_count AS questionCount
    FROM competition_archives
    ORDER BY archived_at DESC, id DESC
  `).all() as ArchiveRow[];
}

function findArchive(db: AppDatabase, id: string) {
  return db.prepare(`
    SELECT id, title, archived_at AS archivedAt,
      participant_count AS participantCount,
      round_count AS roundCount,
      question_count AS questionCount,
      payload_json AS payloadJson
    FROM competition_archives
    WHERE id = ?
  `).get(id) as (ArchiveRow & { payloadJson: string }) | undefined;
}

export function saveCompetitionArchive(db: AppDatabase, title: string) {
  // Snapshot and insert are a single SQLite transaction; no existing rows
  // are changed, and creating an archive never clears the live competition.
  return db.transaction(() => {
    const roundCount = (db.prepare(
      "SELECT COUNT(*) AS count FROM qualification_rounds",
    ).get() as { count: number }).count;

    if (roundCount === 0) return null;

    const participantCount = (db.prepare(
      "SELECT COUNT(*) AS count FROM participants",
    ).get() as { count: number }).count;
    const questionCount = (db.prepare(
      "SELECT COUNT(*) AS count FROM qualification_round_questions",
    ).get() as { count: number }).count;

    const id = randomUUID();
    const archivedAt = new Date().toISOString();
    // New archives carry the entrant label as it was when archived.
    // Old archives without this metadata print a neutral "participant" label.
    const currentType = db.prepare(`
      SELECT participant_type AS participantType
      FROM competition_workspaces
      WHERE id = (SELECT value FROM app_meta WHERE key='active_workspace_id')
    `).get() as { participantType: string } | undefined;
    const snapshot = {
      competition: getCompetitionSnapshot(db),
      ranking: getQualificationRanking(db),
      audienceSettings: getAudienceDisplaySettings(db),
      questionBank: getQuestionBankSummary(db),
    };
    const tables = Object.fromEntries(
      historicalTables.map((table) => [
        table,
        portableValue(db.prepare(`SELECT * FROM ${table}`).all()),
      ]),
    );
    const payloadJson = JSON.stringify({
      formatVersion: 1,
      id,
      title: title,
      archivedAt,
      participantType: currentType?.participantType ?? null,
      snapshot,
      tables,
    });

    db.prepare(`
      INSERT INTO competition_archives (
        id, title, archived_at, participant_count,
        round_count, question_count, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, title, archivedAt,
      participantCount, roundCount, questionCount, payloadJson,
    );

    return {
      id,
      title: title,
      archivedAt,
      participantCount,
      roundCount,
      questionCount,
    };
  })();

}

export function registerCompetitionArchiveRoutes(
  app: FastifyInstance,
  db: AppDatabase,
  databasePath?: string,
) {
  app.get("/api/archives", async () => ({ archives: listArchives(db) }));

  app.post("/api/archives", async (request, reply) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "INVALID_ARCHIVE_TITLE",
        issues: parsed.error.issues,
      });
    }

    const archive = saveCompetitionArchive(db, parsed.data.title);

    if (!archive) {
      return reply.code(409).send({
        error: "NO_ROUNDS_TO_ARCHIVE",
        message: "Create a draw with rounds before archiving this competition.",
      });
    }

    return reply.code(201).send({ archive });
  });

  // Editing an archive changes ONLY its human-readable title.
  // Score snapshots, logos, question history and recorded times stay immutable.
  app.patch<{ Params: { id: string } }>("/api/archives/:id", async (request, reply) => {
    const body = createSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "INVALID_ARCHIVE_TITLE" });
    const row = findArchive(db, request.params.id);
    if (!row) return reply.code(404).send({ error: "ARCHIVE_NOT_FOUND" });
    try {
      db.transaction(() => {
        const data = JSON.parse(row.payloadJson) as Record<string, unknown>;
        data.title = body.data.title;
        db.prepare("UPDATE competition_archives SET title=?, payload_json=? WHERE id=?")
          .run(body.data.title, JSON.stringify(data), row.id);
      })();
    } catch {
      return reply.code(409).send({ error: "ARCHIVE_PAYLOAD_INVALID" });
    }
    return { archive: listArchives(db).find(entry=>entry.id===row.id) };
  });

  app.delete<{ Params: { id: string } }>("/api/archives/:id", async (request, reply) => {
    const body = archiveDeleteSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "ARCHIVE_DELETE_CONFIRMATION_REQUIRED" });
    const row = findArchive(db, request.params.id);
    if (!row) return reply.code(404).send({ error: "ARCHIVE_NOT_FOUND" });
    if (body.data.title !== row.title)
      return reply.code(409).send({ error: "ARCHIVE_DELETE_TITLE_MISMATCH" });
    if (!databasePath) return reply.code(503).send({ error: "ARCHIVE_BACKUP_UNAVAILABLE" });
    try {
      createDatabaseBackup(db, databasePath, "pre-reset");
    } catch (error) {
      return reply.code(500).send({
        error: "PRE_DELETE_BACKUP_FAILED",
        message: error instanceof Error ? error.message : "Backup failed",
      });
    }
    db.prepare("DELETE FROM competition_archives WHERE id=?").run(row.id);
    return { deleted: true, id: row.id };
  });

  app.get<{ Params: { id: string } }>(
    "/api/archives/:id",
    async (request, reply) => {
      const row = findArchive(db, request.params.id);
      if (!row) return reply.code(404).send({ error: "ARCHIVE_NOT_FOUND" });
      const { payloadJson, ...metadata } = row;
      const payload = JSON.parse(payloadJson) as {
        snapshot: unknown;
        participantType?: unknown;
      };
      const participantType = ["college", "department", "class", "team"]
        .includes(String(payload.participantType))
        ? payload.participantType
        : null;
      return { archive: metadata, participantType, snapshot: payload.snapshot };
    },
  );

  // Serve the logos stored INSIDE this archive, not the currently active
  // event's mutable /api/audience/assets/* endpoints. The operator session
  // protects both the archived JSON and its media.
  app.get<{ Params: { id: string; slot: string } }>(
    "/api/archives/:id/assets/:slot",
    async (request, reply) => {
      if (request.params.slot !== "university" && request.params.slot !== "department")
        return reply.code(404).send({ error: "ARCHIVE_ASSET_NOT_FOUND" });
      const row = findArchive(db, request.params.id);
      if (!row) return reply.code(404).send({ error: "ARCHIVE_NOT_FOUND" });
      const payload = JSON.parse(row.payloadJson) as {
        tables?: {
          audience_assets?: Array<{
            slot?: string;
            mime_type?: string;
            bytes?: { kind?: string; data?: string };
          }>;
        };
      };
      const found = payload.tables?.audience_assets?.find(
        asset => asset.slot === request.params.slot,
      );
      if (!found) return reply.code(404).send({ error: "ARCHIVE_ASSET_NOT_FOUND" });
      if (!["image/png", "image/jpeg", "image/webp"].includes(found.mime_type ?? "") ||
          found.bytes?.kind !== "base64-blob" ||
          typeof found.bytes.data !== "string" ||
          found.bytes.data.length > 12_000_000 ||
          !/^[A-Za-z0-9+/]*={0,2}$/.test(found.bytes.data)) {
        return reply.code(422).send({ error: "ARCHIVE_ASSET_INVALID" });
      }
      return reply
        .header("cache-control", "private, no-store")
        .type(found.mime_type!)
        .send(Buffer.from(found.bytes.data, "base64"));
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/archives/:id/export",
    async (request, reply) => {
      const row = findArchive(db, request.params.id);
      if (!row) return reply.code(404).send({ error: "ARCHIVE_NOT_FOUND" });
      return reply
        .header("content-type", "application/json; charset=utf-8")
        .header(
          "content-disposition",
          `attachment; filename="uniquiz-archive-${row.id}.json"`,
        )
        .send(row.payloadJson);
    },
  );
}
