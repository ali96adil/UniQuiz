import type { FastifyInstance, FastifyReply } from "fastify";
import type { Server as SocketIOServer } from "socket.io";
import { z } from "zod";
import type {
  AudienceDisplayCopy,
  AudienceDisplaySettings,
} from "@uniquiz/shared";
import type { AppDatabase } from "./database.js";

export const DEFAULT_AUDIENCE_COPY: AudienceDisplayCopy = {
  preShow: {
    intervalSeconds: 10,
    identityEnabled: true,
    aboutEnabled: true,
    mechanismEnabled: true,
  },
  welcomeTitle: "أهلاً بكم",
  waitingParticipantsText: "بانتظار تثبيت الكليات المشاركة",
  drawPhaseLabel: "مرحلة القرعة",
  drawOfficialTitle: "القرعة الرسمية",
  participatingCollegeCountText: "{count} كلية مشاركة",
  drawWaitingText: "بانتظار إجراء القرعة",
  drawPresentingKicker: "جاري إعلان القرعة",
  drawResultsKicker: "نتائج القرعة",
  roundsTitle: "الجولات",
  versusLabel: "VS",
  soloLabel: "SOLO",
  soloRoundText: "جولة فردية",
  drawPresentingFooter: "يتم إعلان الجولات حسب ترتيب القرعة",
  drawCompleteFooter: "تم اعتماد ترتيب الجولات",
  rankingTitle: "الترتيب العام",
  rankingSubtitle: "بعد آخر Reveal",
  playingStatus: "يلعب الآن",
  completedStatus: "مكتملة",
  notStartedStatus: "لم تبدأ",
  pointsLabel: "نقطة",
  waitingRoundsText: "بانتظار بدء الجولات",
  waitingNextRoundText: "بانتظار الجولة القادمة",
  questionLabel: "سؤال",
  questionReadyText: "السؤال {question} جاهز — بانتظار START من النظام",
  intermissionText: "استراحة قصيرة",
  roundReadyText: "الجولة جاهزة",
  closedLabel: "مغلق",
  resultLabel: "النتيجة",
  answerPrefix: "الإجابة",
  correctStatus: "صحيحة",
  wrongStatus: "غير صحيحة",
  secondsLabel: "ثانية",
  noAnswerText: "لم تتم الإجابة",
  answerReceivedText: "تم استلام الإجابة",
  waitingAnswerText: "بانتظار الإجابة",
  correctAnswerLabel: "الإجابة الصحيحة",
  optionLabel: "الخيار",
  closedWaitingResultText: "تم إغلاق السؤال — بانتظار إعلان النتيجة",
  qualificationCompleteKicker: "انتهت مرحلة التصفيات",
  finalRankingTitle: "الترتيب النهائي للتصفيات",
  positionLabel: "المركز {rank}",
  qualificationFinalText: "تم اعتماد نتائج جميع جولات التصفيات",
  roundEndedPrefix: "انتهت",
  roundResultTitle: "نتيجة الجولة",
  nextRoundTitle: "الجولة القادمة",
  waitingNextRoundSelectionText: "بانتظار تحديد الجولة القادمة",
  teamALabel: "Team A",
  teamBLabel: "Team B",
};

const copySchema = z.object({
  preShow: z.object({
    intervalSeconds: z.number().int().min(5).max(30),
    identityEnabled: z.boolean(),
    aboutEnabled: z.boolean(),
    mechanismEnabled: z.boolean(),
  }),
  welcomeTitle: z.string().trim().min(1).max(160),
  waitingParticipantsText: z.string().trim().min(1).max(240),
  drawPhaseLabel: z.string().trim().min(1).max(120),
  drawOfficialTitle: z.string().trim().min(1).max(160),
  participatingCollegeCountText: z.string().trim().min(1).max(160),
  drawWaitingText: z.string().trim().min(1).max(200),
  drawPresentingKicker: z.string().trim().min(1).max(160),
  drawResultsKicker: z.string().trim().min(1).max(160),
  roundsTitle: z.string().trim().min(1).max(120),
  versusLabel: z.string().trim().min(1).max(30),
  soloLabel: z.string().trim().min(1).max(30),
  soloRoundText: z.string().trim().min(1).max(120),
  drawPresentingFooter: z.string().trim().min(1).max(240),
  drawCompleteFooter: z.string().trim().min(1).max(240),
  rankingTitle: z.string().trim().min(1).max(120),
  rankingSubtitle: z.string().trim().max(160),
  playingStatus: z.string().trim().min(1).max(80),
  completedStatus: z.string().trim().min(1).max(80),
  notStartedStatus: z.string().trim().min(1).max(80),
  pointsLabel: z.string().trim().min(1).max(40),
  waitingRoundsText: z.string().trim().min(1).max(160),
  waitingNextRoundText: z.string().trim().min(1).max(160),
  questionLabel: z.string().trim().min(1).max(40),
  questionReadyText: z.string().trim().min(1).max(220),
  intermissionText: z.string().trim().min(1).max(160),
  roundReadyText: z.string().trim().min(1).max(160),
  closedLabel: z.string().trim().min(1).max(60),
  resultLabel: z.string().trim().min(1).max(60),
  answerPrefix: z.string().trim().min(1).max(60),
  correctStatus: z.string().trim().min(1).max(60),
  wrongStatus: z.string().trim().min(1).max(60),
  secondsLabel: z.string().trim().min(1).max(40),
  noAnswerText: z.string().trim().min(1).max(100),
  answerReceivedText: z.string().trim().min(1).max(100),
  waitingAnswerText: z.string().trim().min(1).max(100),
  correctAnswerLabel: z.string().trim().min(1).max(100),
  optionLabel: z.string().trim().min(1).max(40),
  closedWaitingResultText: z.string().trim().min(1).max(200),
  qualificationCompleteKicker: z.string().trim().min(1).max(160),
  finalRankingTitle: z.string().trim().min(1).max(160),
  positionLabel: z.string().trim().min(1).max(80),
  qualificationFinalText: z.string().trim().min(1).max(240),
  roundEndedPrefix: z.string().trim().min(1).max(80),
  roundResultTitle: z.string().trim().min(1).max(120),
  nextRoundTitle: z.string().trim().min(1).max(120),
  waitingNextRoundSelectionText: z.string().trim().min(1).max(180),
  teamALabel: z.string().trim().min(1).max(60),
  teamBLabel: z.string().trim().min(1).max(60),
});

const settingsSchema = z.object({
  eventTitle: z.string().trim().min(1).max(160),
  eventSubtitle: z.string().trim().max(240),
  venue: z.string().trim().max(160),
  season: z.string().trim().max(120),
  footerText: z.string().trim().max(240),
  roundLabel: z.string().trim().min(1).max(40),
  copy: copySchema,
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

function readAudienceCopy(db: AppDatabase): AudienceDisplayCopy {
  const row = db.prepare(`
    SELECT value_json AS valueJson
    FROM audience_copy
    WHERE id = 1
  `).get() as { valueJson: string } | undefined;

  if (!row) {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO audience_copy (id, value_json, updated_at)
      VALUES (1, ?, ?)
    `).run(JSON.stringify(DEFAULT_AUDIENCE_COPY), now);
    return { ...DEFAULT_AUDIENCE_COPY };
  }

  try {
    const parsed = JSON.parse(row.valueJson) as Partial<AudienceDisplayCopy>;
    return {
      ...DEFAULT_AUDIENCE_COPY,
      ...parsed,
      preShow: {
        ...DEFAULT_AUDIENCE_COPY.preShow,
        ...(parsed.preShow ?? {}),
      },
    };
  } catch {
    return { ...DEFAULT_AUDIENCE_COPY };
  }
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
    copy: readAudienceCopy(db),
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

    const save = db.transaction(() => {
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

      db.prepare(`
        INSERT INTO audience_copy (id, value_json, updated_at)
        VALUES (1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          value_json = excluded.value_json,
          updated_at = excluded.updated_at
      `).run(JSON.stringify(value.copy), updatedAt);
    });

    save();
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
