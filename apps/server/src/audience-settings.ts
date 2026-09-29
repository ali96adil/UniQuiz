import type { FastifyInstance, FastifyReply } from "fastify";
import type { Server as SocketIOServer } from "socket.io";
import { z } from "zod";
import type { AudienceDisplaySettings } from "@uniquiz/shared";
import type { AppDatabase } from "./database.js";

const settingsSchema = z.object({
  eventTitle: z.string().trim().min(1).max(160),
  eventSubtitle: z.string().trim().max(240),
  venue: z.string().trim().max(160),
  season: z.string().trim().max(120),
  footerText: z.string().trim().max(240),
  roundLabel: z.string().trim().min(1).max(40),
});

const assetSlotSchema = z.enum(["university", "department"]);
const ALLOWED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
]);
const MAX_LOGO_BYTES = 5 * 1024 * 1024;

interface SettingsRow {
  eventTitle: string;
  eventSubtitle: string;
  venue: string;
  season: string;
  footerText: string;
  roundLabel: string;
  updatedAt: string;
}

function assetVersion(
  db: AppDatabase,
  slot: "university" | "department",
): string | null {
  const row = db.prepare(`
    SELECT updated_at AS updatedAt
    FROM audience_assets
    WHERE slot = ?
  `).get(slot) as { updatedAt: string } | undefined;

  return row?.updatedAt ?? null;
}

export function getAudienceDisplaySettings(
  db: AppDatabase,
): AudienceDisplaySettings {
  const row = db.prepare(`
    SELECT
      event_title AS eventTitle,
      event_subtitle AS eventSubtitle,
      venue,
      season,
      footer_text AS footerText,
      round_label AS roundLabel,
      updated_at AS updatedAt
    FROM audience_settings
    WHERE id = 1
  `).get() as SettingsRow;

  const universityVersion = assetVersion(db, "university");
  const departmentVersion = assetVersion(db, "department");

  return {
    ...row,
    universityLogoUrl: universityVersion
      ? `/api/audience/assets/university?v=${encodeURIComponent(
          universityVersion,
        )}`
      : null,
    departmentLogoUrl: departmentVersion
      ? `/api/audience/assets/department?v=${encodeURIComponent(
          departmentVersion,
        )}`
      : null,
  };
}

function badRequest(
  reply: FastifyReply,
  error: string,
  message: string,
) {
  return reply.code(400).send({ error, message });
}

export function registerAudienceSettingsRoutes(
  app: FastifyInstance,
  db: AppDatabase,
  io: SocketIOServer,
): void {
  const publish = () => {
    const settings = getAudienceDisplaySettings(db);
    io.emit("audience:settings", settings);
    return settings;
  };

  app.get("/api/audience/settings", async () =>
    getAudienceDisplaySettings(db),
  );

  app.put("/api/audience/settings", async (request, reply) => {
    const parsed = settingsSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({
        error: "INVALID_AUDIENCE_SETTINGS",
        issues: parsed.error.issues,
      });
    }

    const updatedAt = new Date().toISOString();
    const value = parsed.data;

    db.prepare(`
      UPDATE audience_settings
      SET
        event_title = ?,
        event_subtitle = ?,
        venue = ?,
        season = ?,
        footer_text = ?,
        round_label = ?,
        updated_at = ?
      WHERE id = 1
    `).run(
      value.eventTitle,
      value.eventSubtitle,
      value.venue,
      value.season,
      value.footerText,
      value.roundLabel,
      updatedAt,
    );

    return publish();
  });

  app.get(
    "/api/audience/assets/:slot",
    async (request, reply) => {
      const parsedSlot = assetSlotSchema.safeParse(
        (request.params as { slot?: unknown }).slot,
      );

      if (!parsedSlot.success) {
        return reply.code(404).send({
          error: "UNKNOWN_AUDIENCE_ASSET",
        });
      }

      const row = db.prepare(`
        SELECT
          mime_type AS mimeType,
          bytes
        FROM audience_assets
        WHERE slot = ?
      `).get(parsedSlot.data) as
        | { mimeType: string; bytes: Buffer }
        | undefined;

      if (!row) {
        return reply.code(404).send({
          error: "AUDIENCE_ASSET_NOT_FOUND",
        });
      }

      reply
        .header("content-type", row.mimeType)
        .header("cache-control", "no-cache, must-revalidate");

      return reply.send(row.bytes);
    },
  );

  app.post(
    "/api/audience/assets/:slot",
    async (request, reply) => {
      const parsedSlot = assetSlotSchema.safeParse(
        (request.params as { slot?: unknown }).slot,
      );

      if (!parsedSlot.success) {
        return badRequest(
          reply,
          "UNKNOWN_AUDIENCE_ASSET",
          "Unknown audience asset slot.",
        );
      }

      const file = await request.file();

      if (!file) {
        return badRequest(
          reply,
          "LOGO_FILE_REQUIRED",
          "Choose a logo image first.",
        );
      }

      if (!ALLOWED_IMAGE_TYPES.has(file.mimetype)) {
        return badRequest(
          reply,
          "UNSUPPORTED_LOGO_TYPE",
          "Logo must be PNG, JPEG or WebP.",
        );
      }

      const bytes = await file.toBuffer();

      if (bytes.length > MAX_LOGO_BYTES) {
        return badRequest(
          reply,
          "LOGO_TOO_LARGE",
          "Logo must be 5 MB or smaller.",
        );
      }

      const updatedAt = new Date().toISOString();

      db.prepare(`
        INSERT INTO audience_assets (
          slot,
          mime_type,
          bytes,
          updated_at
        )
        VALUES (?, ?, ?, ?)
        ON CONFLICT(slot) DO UPDATE SET
          mime_type = excluded.mime_type,
          bytes = excluded.bytes,
          updated_at = excluded.updated_at
      `).run(
        parsedSlot.data,
        file.mimetype,
        bytes,
        updatedAt,
      );

      return publish();
    },
  );

  app.delete(
    "/api/audience/assets/:slot",
    async (request, reply) => {
      const parsedSlot = assetSlotSchema.safeParse(
        (request.params as { slot?: unknown }).slot,
      );

      if (!parsedSlot.success) {
        return badRequest(
          reply,
          "UNKNOWN_AUDIENCE_ASSET",
          "Unknown audience asset slot.",
        );
      }

      db.prepare(`
        DELETE FROM audience_assets
        WHERE slot = ?
      `).run(parsedSlot.data);

      return publish();
    },
  );
}
