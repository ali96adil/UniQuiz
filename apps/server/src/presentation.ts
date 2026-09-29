import type { FastifyInstance } from "fastify";
import type { Server as SocketIOServer } from "socket.io";
import { z } from "zod";
import type {
  AudiencePresentationKind,
  AudiencePresentationSnapshot,
} from "@uniquiz/shared";
import { appendAuditEvent } from "./audit.js";
import type { AppDatabase } from "./database.js";

const presentationSchema = z
  .object({
    kind: z.enum([
      "BREAK",
      "PLEASE_WAIT",
      "NEXT_ROUND",
      "PREPARE_TEAMS",
      "FINAL_RESULTS_SOON",
      "CUSTOM",
    ]),
    title: z.string().trim().max(160).optional(),
    message: z.string().trim().max(500).optional(),
  })
  .superRefine((value, context) => {
    if (
      value.kind === "CUSTOM" &&
      !value.title?.trim()
    ) {
      context.addIssue({
        code: "custom",
        path: ["title"],
        message: "Custom presentation title is required.",
      });
    }
  });

const emptyObjectSchema = z.object({}).strict();

const presets: Record<
  Exclude<AudiencePresentationKind, "CUSTOM">,
  { title: string; message: string }
> = {
  BREAK: {
    title: "استراحة قصيرة",
    message: "نعود بعد قليل",
  },
  PLEASE_WAIT: {
    title: "يرجى الانتظار",
    message: "سيتم استئناف المسابقة بعد قليل",
  },
  NEXT_ROUND: {
    title: "الجولة القادمة",
    message: "يرجى استعداد الفرق المشاركة",
  },
  PREPARE_TEAMS: {
    title: "استعداد الفرق",
    message: "يرجى التوجه إلى محطات الإجابة",
  },
  FINAL_RESULTS_SOON: {
    title: "النتائج النهائية",
    message: "سيتم إعلان النتائج بعد قليل",
  },
};

export function getAudiencePresentation(
  db: AppDatabase,
): AudiencePresentationSnapshot {
  const row = db.prepare(`
    SELECT
      active,
      kind,
      title,
      message,
      updated_at AS updatedAt
    FROM audience_presentation
    WHERE id = 1
  `).get() as {
    active: number;
    kind: AudiencePresentationKind;
    title: string;
    message: string;
    updatedAt: string;
  };

  return {
    active: row.active === 1,
    kind: row.kind,
    title: row.title,
    message: row.message,
    updatedAt: row.updatedAt,
  };
}

export function showAudiencePresentation(
  db: AppDatabase,
  input: {
    kind: AudiencePresentationKind;
    title?: string;
    message?: string;
  },
): AudiencePresentationSnapshot {
  const fallback =
    input.kind === "CUSTOM"
      ? {
          title: input.title?.trim() ?? "",
          message: input.message?.trim() ?? "",
        }
      : presets[input.kind];

  const title =
    input.title?.trim() || fallback.title;
  const message =
    input.message?.trim() || fallback.message;
  const updatedAt = new Date().toISOString();

  db.prepare(`
    UPDATE audience_presentation
    SET
      active = 1,
      kind = ?,
      title = ?,
      message = ?,
      updated_at = ?
    WHERE id = 1
  `).run(
    input.kind,
    title,
    message,
    updatedAt,
  );

  appendAuditEvent(db, {
    eventType: "AUDIENCE_PRESENTATION_SHOWN",
    payload: {
      kind: input.kind,
      title,
      message,
    },
    occurredAt: updatedAt,
  });

  return getAudiencePresentation(db);
}

export function clearAudiencePresentation(
  db: AppDatabase,
): AudiencePresentationSnapshot {
  const updatedAt = new Date().toISOString();

  db.prepare(`
    UPDATE audience_presentation
    SET
      active = 0,
      updated_at = ?
    WHERE id = 1
  `).run(updatedAt);

  appendAuditEvent(db, {
    eventType: "AUDIENCE_PRESENTATION_CLEARED",
    occurredAt: updatedAt,
  });

  return getAudiencePresentation(db);
}

export function registerAudiencePresentationRoutes(
  app: FastifyInstance,
  db: AppDatabase,
  io: SocketIOServer,
): void {
  const publish = (
    snapshot: AudiencePresentationSnapshot,
  ) => {
    io.emit("audience:presentation", snapshot);
    return snapshot;
  };

  app.get("/api/presentation", async () =>
    getAudiencePresentation(db),
  );

  app.post("/api/presentation/show", async (request, reply) => {
    const body = presentationSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({
        error: "INVALID_PRESENTATION",
        issues: body.error.issues,
      });
    }

    return publish(
      showAudiencePresentation(db, body.data),
    );
  });

  app.post("/api/presentation/clear", async (request, reply) => {
    const body = emptyObjectSchema.safeParse(
      request.body ?? {},
    );
    if (!body.success) {
      return reply.code(400).send({
        error: "INVALID_REQUEST",
        issues: body.error.issues,
      });
    }

    return publish(clearAudiencePresentation(db));
  });
}
