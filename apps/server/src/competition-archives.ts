import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDatabase } from "./database.js";
import { getCompetitionSnapshot } from "./competition.js";
import { getQualificationRanking } from "./ranking.js";
import { getAudienceDisplaySettings } from "./audience-settings.js";
import { getQuestionBankSummary } from "./importer.js";

const createSchema = z.object({
  title: z.string().trim().min(1).max(180),
});

// Explicit allowlist: station access tokens and process settings are NOT archived.
// Historical images (BLOBs) are encoded losslessly for JSON export.
const historicalTables = [
  "colleges",
  "competition_state",
  "participants",
  "qualification_rounds",
  "qualification_round_question_sets",
  "qualification_round_questions",
  "qualification_question_reservations",
  "categories",
  "questions",
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

export function registerCompetitionArchiveRoutes(
  app: FastifyInstance,
  db: AppDatabase,
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

    // Snapshot and insert are a single SQLite transaction; no existing rows
    // are changed, and creating an archive never clears the live competition.
    const archive = db.transaction(() => {
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
        title: parsed.data.title,
        archivedAt,
        snapshot,
        tables,
      });

      db.prepare(`
        INSERT INTO competition_archives (
          id, title, archived_at, participant_count,
          round_count, question_count, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, parsed.data.title, archivedAt,
        participantCount, roundCount, questionCount, payloadJson,
      );

      return {
        id,
        title: parsed.data.title,
        archivedAt,
        participantCount,
        roundCount,
        questionCount,
      };
    })();

    if (!archive) {
      return reply.code(409).send({
        error: "NO_ROUNDS_TO_ARCHIVE",
        message: "Create a draw with rounds before archiving this competition.",
      });
    }

    return reply.code(201).send({ archive });
  });

  app.get<{ Params: { id: string } }>(
    "/api/archives/:id",
    async (request, reply) => {
      const row = findArchive(db, request.params.id);
      if (!row) return reply.code(404).send({ error: "ARCHIVE_NOT_FOUND" });
      const { payloadJson, ...metadata } = row;
      const payload = JSON.parse(payloadJson) as {
        snapshot: unknown;
      };
      return { archive: metadata, snapshot: payload.snapshot };
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
