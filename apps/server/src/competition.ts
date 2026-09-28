import { randomInt } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Server as SocketIOServer } from "socket.io";
import { z } from "zod";
import type {
  College,
  CompetitionSetupSnapshot,
  QualificationRound,
  QualificationRoundStatus,
} from "@uniquiz/shared";
import type { AppDatabase } from "./database.js";
import { generateQualificationRounds } from "./draw.js";

const collegeInputSchema = z.object({
  name: z.string().trim().min(1).max(160),
  shortName: z.string().trim().min(1).max(80).nullable().optional(),
});

const replaceCollegesSchema = z.object({
  colleges: z.array(collegeInputSchema).max(20),
});

const participantsSchema = z.object({
  collegeIds: z.array(z.number().int().positive()).min(2).max(20),
});

const unlockSchema = z.object({
  confirm: z.literal("UNLOCK_PARTICIPANTS"),
});

const resetDrawSchema = z.object({
  confirm: z.literal("RESET_DRAW"),
});

const nextRoundSchema = z.object({
  roundId: z.number().int().positive().nullable(),
});

interface CollegeRow {
  id: number;
  name: string;
  shortName: string | null;
  sortOrder: number;
}

interface CompetitionStateRow {
  participantsLocked: number;
  drawCreatedAt: string | null;
  selectedRoundId: number | null;
}

interface ParticipantRow {
  collegeId: number;
}

interface RoundRow {
  id: number;
  roundOrder: number;
  status: QualificationRoundStatus;
  aId: number;
  aName: string;
  aShortName: string | null;
  aSortOrder: number;
  bId: number | null;
  bName: string | null;
  bShortName: string | null;
  bSortOrder: number | null;
}

function collegeFromRow(row: CollegeRow): College {
  return {
    id: row.id,
    name: row.name,
    shortName: row.shortName,
    sortOrder: row.sortOrder,
  };
}

function sendValidationError(
  reply: FastifyReply,
  issues: unknown,
) {
  return reply.code(400).send({
    error: "INVALID_REQUEST",
    issues,
  });
}

function sendConflict(
  reply: FastifyReply,
  code: string,
  message: string,
) {
  return reply.code(409).send({
    error: code,
    message,
  });
}

export function getCompetitionSnapshot(
  db: AppDatabase,
): CompetitionSetupSnapshot {
  const colleges = (
    db.prepare(`
      SELECT
        id,
        name,
        short_name AS shortName,
        sort_order AS sortOrder
      FROM colleges
      ORDER BY sort_order, id
    `).all() as CollegeRow[]
  ).map(collegeFromRow);

  const participantCollegeIds = (
    db.prepare(`
      SELECT p.college_id AS collegeId
      FROM participants p
      JOIN colleges c ON c.id = p.college_id
      ORDER BY c.sort_order, c.id
    `).all() as ParticipantRow[]
  ).map((row) => row.collegeId);

  const state = db.prepare(`
    SELECT
      participants_locked AS participantsLocked,
      draw_created_at AS drawCreatedAt,
      selected_round_id AS selectedRoundId
    FROM competition_state
    WHERE id = 1
  `).get() as CompetitionStateRow;

  const roundRows = db.prepare(`
    SELECT
      r.id,
      r.round_order AS roundOrder,
      r.status,
      a.id AS aId,
      a.name AS aName,
      a.short_name AS aShortName,
      a.sort_order AS aSortOrder,
      b.id AS bId,
      b.name AS bName,
      b.short_name AS bShortName,
      b.sort_order AS bSortOrder
    FROM qualification_rounds r
    JOIN colleges a ON a.id = r.college_a_id
    LEFT JOIN colleges b ON b.id = r.college_b_id
    ORDER BY r.round_order
  `).all() as RoundRow[];

  const rounds: QualificationRound[] = roundRows.map((row) => ({
    id: row.id,
    order: row.roundOrder,
    status: row.status,
    collegeA: {
      id: row.aId,
      name: row.aName,
      shortName: row.aShortName,
      sortOrder: row.aSortOrder,
    },
    collegeB:
      row.bId === null
        ? null
        : {
            id: row.bId,
            name: row.bName ?? "",
            shortName: row.bShortName,
            sortOrder: row.bSortOrder ?? 0,
          },
  }));

  const manuallySelected = rounds.find(
    (round) =>
      round.id === state.selectedRoundId &&
      round.status === "PENDING",
  );

  const nextByDrawOrder = rounds.find(
    (round) => round.status === "PENDING",
  );

  return {
    colleges,
    participantCollegeIds,
    participantsLocked: state.participantsLocked === 1,
    drawCreatedAt: state.drawCreatedAt,
    rounds,
    nextRoundId: manuallySelected?.id ?? nextByDrawOrder?.id ?? null,
    nextRoundSelectionMode: manuallySelected
      ? "MANUAL"
      : "DRAW_ORDER",
  };
}

export function registerCompetitionRoutes(
  app: FastifyInstance,
  db: AppDatabase,
  io: SocketIOServer,
) {
  const publishSnapshot = () => {
    const snapshot = getCompetitionSnapshot(db);
    io.emit("competition:snapshot", snapshot);
    return snapshot;
  };

  app.get("/api/setup", async () => getCompetitionSnapshot(db));
  app.get("/api/draw", async () => getCompetitionSnapshot(db));

  app.put("/api/setup/colleges", async (request, reply) => {
    const parsed = replaceCollegesSchema.safeParse(request.body);

    if (!parsed.success) {
      return sendValidationError(reply, parsed.error.issues);
    }

    const snapshot = getCompetitionSnapshot(db);

    if (snapshot.participantsLocked || snapshot.drawCreatedAt !== null) {
      return sendConflict(
        reply,
        "SETUP_LOCKED",
        "College master list cannot change after participant lock.",
      );
    }

    const normalizedNames = parsed.data.colleges.map((college) =>
      college.name.toLocaleLowerCase(),
    );

    if (new Set(normalizedNames).size !== normalizedNames.length) {
      return sendValidationError(reply, [
        {
          message: "College names must be unique.",
        },
      ]);
    }

    const replace = db.transaction(() => {
      db.prepare("DELETE FROM participants").run();
      db.prepare("DELETE FROM colleges").run();

      const insert = db.prepare(`
        INSERT INTO colleges (name, short_name, sort_order)
        VALUES (?, ?, ?)
      `);

      parsed.data.colleges.forEach((college, index) => {
        insert.run(
          college.name,
          college.shortName ?? null,
          index + 1,
        );
      });
    });

    replace();
    return publishSnapshot();
  });

  app.put("/api/setup/participants", async (request, reply) => {
    const parsed = participantsSchema.safeParse(request.body);

    if (!parsed.success) {
      return sendValidationError(reply, parsed.error.issues);
    }

    const snapshot = getCompetitionSnapshot(db);

    if (snapshot.participantsLocked) {
      return sendConflict(
        reply,
        "PARTICIPANTS_LOCKED",
        "Participants are locked.",
      );
    }

    if (new Set(parsed.data.collegeIds).size !== parsed.data.collegeIds.length) {
      return sendValidationError(reply, [
        {
          message: "Participant college IDs must be unique.",
        },
      ]);
    }

    const existingIds = new Set(snapshot.colleges.map((college) => college.id));
    const missing = parsed.data.collegeIds.filter((id) => !existingIds.has(id));

    if (missing.length > 0) {
      return sendValidationError(reply, [
        {
          message: `Unknown college IDs: ${missing.join(", ")}`,
        },
      ]);
    }

    const replace = db.transaction(() => {
      db.prepare("DELETE FROM participants").run();
      const insert = db.prepare(
        "INSERT INTO participants (college_id) VALUES (?)",
      );

      for (const collegeId of parsed.data.collegeIds) {
        insert.run(collegeId);
      }
    });

    replace();
    return publishSnapshot();
  });

  app.post("/api/setup/participants/lock", async (_request, reply) => {
    const snapshot = getCompetitionSnapshot(db);

    if (snapshot.participantCollegeIds.length < 2) {
      return sendConflict(
        reply,
        "NOT_ENOUGH_PARTICIPANTS",
        "At least two participants are required before lock.",
      );
    }

    db.prepare(`
      UPDATE competition_state
      SET participants_locked = 1
      WHERE id = 1
    `).run();

    return publishSnapshot();
  });

  app.post("/api/setup/participants/unlock", async (request, reply) => {
    const parsed = unlockSchema.safeParse(request.body);

    if (!parsed.success) {
      return sendValidationError(reply, parsed.error.issues);
    }

    const snapshot = getCompetitionSnapshot(db);

    if (snapshot.drawCreatedAt !== null || snapshot.rounds.length > 0) {
      return sendConflict(
        reply,
        "DRAW_ALREADY_CREATED",
        "Reset the official draw before unlocking participants.",
      );
    }

    db.prepare(`
      UPDATE competition_state
      SET participants_locked = 0
      WHERE id = 1
    `).run();

    return publishSnapshot();
  });

  const emitDrawPresentation = (snapshot: CompetitionSetupSnapshot) => {
    const event = {
      startedAt: new Date().toISOString(),
      rounds: snapshot.rounds,
    };

    io.emit("draw:presentation:start", event);
    return event;
  };

  app.post("/api/draw", async (_request, reply) => {
    const snapshot = getCompetitionSnapshot(db);

    if (!snapshot.participantsLocked) {
      return sendConflict(
        reply,
        "PARTICIPANTS_NOT_LOCKED",
        "Participant list must be locked before the draw.",
      );
    }

    if (snapshot.drawCreatedAt !== null || snapshot.rounds.length > 0) {
      return sendConflict(
        reply,
        "DRAW_ALREADY_CREATED",
        "Official draw already exists. Explicit reset is required.",
      );
    }

    const generated = generateQualificationRounds(
      snapshot.participantCollegeIds,
      (upperExclusive) => randomInt(upperExclusive),
    );

    const createdAt = new Date().toISOString();

    const persist = db.transaction(() => {
      const insert = db.prepare(`
        INSERT INTO qualification_rounds (
          round_order,
          college_a_id,
          college_b_id,
          status
        )
        VALUES (?, ?, ?, 'PENDING')
      `);

      for (const round of generated) {
        insert.run(
          round.order,
          round.collegeAId,
          round.collegeBId,
        );
      }

      db.prepare(`
        UPDATE competition_state
        SET draw_created_at = ?,
            selected_round_id = NULL
        WHERE id = 1
      `).run(createdAt);
    });

    persist();
    const next = publishSnapshot();
    io.emit("draw:complete", next);
    emitDrawPresentation(next);
    return next;
  });

  app.post("/api/draw/present", async (_request, reply) => {
    const snapshot = getCompetitionSnapshot(db);

    if (snapshot.rounds.length === 0 || snapshot.drawCreatedAt === null) {
      return sendConflict(
        reply,
        "DRAW_NOT_CREATED",
        "Create the official draw before presenting it.",
      );
    }

    if (snapshot.rounds.some((round) => round.status !== "PENDING")) {
      return sendConflict(
        reply,
        "DRAW_ALREADY_IN_USE",
        "Draw presentation replay is only available before a round starts.",
      );
    }

    return emitDrawPresentation(snapshot);
  });

  app.post("/api/draw/reset", async (request, reply) => {
    const parsed = resetDrawSchema.safeParse(request.body);

    if (!parsed.success) {
      return sendValidationError(reply, parsed.error.issues);
    }

    const lockedQuestionSets = db.prepare(`
      SELECT COUNT(*) AS count
      FROM qualification_round_question_sets
    `).get() as { count: number };

    if (lockedQuestionSets.count > 0) {
      return sendConflict(
        reply,
        "QUESTION_SETS_MUST_BE_RESET",
        "Reset locked question sets before resetting the official draw.",
      );
    }

    const nonPending = db.prepare(`
      SELECT COUNT(*) AS count
      FROM qualification_rounds
      WHERE status <> 'PENDING'
    `).get() as { count: number };

    if (nonPending.count > 0) {
      return sendConflict(
        reply,
        "DRAW_ALREADY_IN_USE",
        "A started/completed draw cannot be reset by the M2 reset action.",
      );
    }

    const reset = db.transaction(() => {
      db.prepare("DELETE FROM qualification_rounds").run();
      db.prepare(`
        UPDATE competition_state
        SET draw_created_at = NULL,
            selected_round_id = NULL
        WHERE id = 1
      `).run();
    });

    reset();
    const next = publishSnapshot();
    io.emit("draw:reset", next);
    return next;
  });

  app.post("/api/draw/next-round", async (request, reply) => {
    const parsed = nextRoundSchema.safeParse(request.body);

    if (!parsed.success) {
      return sendValidationError(reply, parsed.error.issues);
    }

    if (parsed.data.roundId !== null) {
      const round = db.prepare(`
        SELECT id, status
        FROM qualification_rounds
        WHERE id = ?
      `).get(parsed.data.roundId) as
        | { id: number; status: QualificationRoundStatus }
        | undefined;

      if (!round || round.status !== "PENDING") {
        return sendConflict(
          reply,
          "ROUND_NOT_AVAILABLE",
          "Only an unplayed round can be manually selected.",
        );
      }
    }

    db.prepare(`
      UPDATE competition_state
      SET selected_round_id = ?
      WHERE id = 1
    `).run(parsed.data.roundId);

    return publishSnapshot();
  });
}
