import { randomInt } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Server as SocketIOServer } from "socket.io";
import { z } from "zod";
import type {
  QuestionAllocationSummary,
  RoundQuestionSetSummary,
} from "@uniquiz/shared";
import {
  allocateQualificationQuestions,
  type CategoryQuestionPool,
} from "./allocation.js";
import { appendAuditEvent } from "./audit.js";
import type { AppDatabase } from "./database.js";

const allocateSchema = z.object({
  confirm: z.literal("ALLOCATE_QUESTIONS"),
});

const resetSchema = z.object({
  confirm: z.literal("RESET_QUESTION_SETS"),
});

const voidReplaceSchema = z.object({
  roundId: z.number().int().positive(),
  position: z.number().int().min(1).max(10),
  reason: z.string().trim().min(3).max(500),
  confirm: z.literal("VOID_AND_REPLACE"),
});

interface CategoryRow {
  id: number;
  key: string;
  name: string;
  availableQuestions: number;
}

interface RoundRow {
  id: number;
  roundOrder: number;
}

function conflict(
  reply: FastifyReply,
  error: string,
  message: string,
  details?: unknown,
) {
  return reply.code(409).send({
    error,
    message,
    details,
  });
}

export function getQuestionAllocationSummary(
  db: AppDatabase,
): QuestionAllocationSummary {
  const rounds = db.prepare(`
    SELECT id, round_order AS roundOrder
    FROM qualification_rounds
    ORDER BY round_order
  `).all() as RoundRow[];

  const categories = db.prepare(`
    SELECT
      c.id,
      c.category_key AS key,
      c.name,
      COUNT(q.id) AS availableQuestions
    FROM categories c
    LEFT JOIN questions q
      ON q.category_id = c.id
      AND q.active = 1
    GROUP BY c.id
    ORDER BY c.sort_order, c.id
  `).all() as CategoryRow[];

  const requiredPerCategory = rounds.length * 2;

  const roundSummaries: RoundQuestionSetSummary[] = rounds.map((round) => {
    const locked = db.prepare(`
      SELECT 1 AS locked
      FROM qualification_round_question_sets
      WHERE round_id = ?
    `).get(round.id) as { locked: number } | undefined;

    const rows = db.prepare(`
      SELECT
        c.category_key AS categoryKey,
        COUNT(*) AS count
      FROM qualification_round_questions rqq
      JOIN categories c ON c.id = rqq.category_id
      WHERE rqq.round_id = ?
      GROUP BY c.id
      ORDER BY c.sort_order
    `).all(round.id) as Array<{
      categoryKey: string;
      count: number;
    }>;

    const categoryCounts = Object.fromEntries(
      rows.map((row) => [row.categoryKey, row.count]),
    );

    return {
      roundId: round.id,
      roundOrder: round.roundOrder,
      locked: Boolean(locked),
      questionCount: rows.reduce((sum, row) => sum + row.count, 0),
      categoryCounts,
    };
  });

  return {
    roundCount: rounds.length,
    questionsPerRound: 10,
    requiredPerCategory,
    ready:
      rounds.length > 0 &&
      categories.length === 5 &&
      roundSummaries.every(
        (round) =>
          round.locked &&
          round.questionCount === 10 &&
          categories.every(
            (category) => round.categoryCounts[category.key] === 2,
          ),
      ),
    categories: categories.map((category) => ({
      key: category.key,
      name: category.name,
      availableQuestions: category.availableQuestions,
      requiredQuestions: requiredPerCategory,
    })),
    rounds: roundSummaries,
  };
}

export function registerQuestionBankRoutes(
  app: FastifyInstance,
  db: AppDatabase,
  io: SocketIOServer,
) {
  const publish = () => {
    const summary = getQuestionAllocationSummary(db);
    io.emit("question-allocation:snapshot", summary);
    return summary;
  };

  app.get("/api/question-bank/allocation", async () =>
    getQuestionAllocationSummary(db),
  );

  app.post("/api/question-bank/allocate", async (request, reply) => {
    const body = allocateSchema.safeParse(request.body);

    if (!body.success) {
      return reply.code(400).send({
        error: "INVALID_REQUEST",
        issues: body.error.issues,
      });
    }

    const existingSetCount = (
      db.prepare(`
        SELECT COUNT(*) AS count
        FROM qualification_round_question_sets
      `).get() as { count: number }
    ).count;

    if (existingSetCount > 0) {
      return conflict(
        reply,
        "QUESTION_SETS_ALREADY_LOCKED",
        "Question sets already exist. Explicit reset is required before reallocation.",
      );
    }

    const rounds = db.prepare(`
      SELECT id, round_order AS roundOrder
      FROM qualification_rounds
      ORDER BY round_order
    `).all() as RoundRow[];

    if (rounds.length === 0) {
      return conflict(
        reply,
        "DRAW_REQUIRED",
        "Create the official qualification draw before allocating questions.",
      );
    }

    const categories = db.prepare(`
      SELECT
        id,
        category_key AS key,
        name,
        (
          SELECT COUNT(*)
          FROM questions q
          WHERE q.category_id = categories.id
            AND q.active = 1
        ) AS availableQuestions
      FROM categories
      ORDER BY sort_order, id
    `).all() as CategoryRow[];

    if (categories.length !== 5) {
      return conflict(
        reply,
        "FIVE_CATEGORIES_REQUIRED",
        "Exactly five categories are required before allocation.",
      );
    }

    const requiredPerCategory = rounds.length * 2;
    const insufficient = categories
      .filter((category) => category.availableQuestions < requiredPerCategory)
      .map((category) => ({
        key: category.key,
        name: category.name,
        available: category.availableQuestions,
        required: requiredPerCategory,
      }));

    if (insufficient.length > 0) {
      return conflict(
        reply,
        "INSUFFICIENT_QUESTION_INVENTORY",
        "There are not enough unique questions to allocate all qualification rounds.",
        insufficient,
      );
    }

    const pools: CategoryQuestionPool[] = categories.map((category) => ({
      categoryId: category.id,
      questionIds: (
        db.prepare(`
          SELECT id
          FROM questions
          WHERE category_id = ?
            AND active = 1
          ORDER BY id
        `).all(category.id) as Array<{ id: number }>
      ).map((row) => row.id),
    }));

    const allocation = allocateQualificationQuestions(
      rounds.map((round) => round.id),
      pools,
      (upperExclusive) => randomInt(upperExclusive),
    );

    const lockedAt = new Date().toISOString();

    const persist = db.transaction(() => {
      const insertSet = db.prepare(`
        INSERT INTO qualification_round_question_sets (
          round_id,
          locked_at
        )
        VALUES (?, ?)
      `);

      const insertQuestion = db.prepare(`
        INSERT INTO qualification_round_questions (
          round_id,
          position,
          question_id,
          category_id
        )
        VALUES (?, ?, ?, ?)
      `);

      const reserveQuestion = db.prepare(`
        INSERT INTO qualification_question_reservations (
          question_id,
          round_id,
          position,
          disposition,
          reserved_at
        )
        VALUES (?, ?, ?, 'ALLOCATED', ?)
      `);

      for (const round of allocation) {
        insertSet.run(round.roundId, lockedAt);

        for (const question of round.questions) {
          insertQuestion.run(
            round.roundId,
            question.position,
            question.questionId,
            question.categoryId,
          );

          reserveQuestion.run(
            question.questionId,
            round.roundId,
            question.position,
            lockedAt,
          );
        }

        appendAuditEvent(db, {
          eventType: "QUESTION_SET_LOCKED",
          roundId: round.roundId,
          payload: {
            questionCount: round.questions.length,
          },
          occurredAt: lockedAt,
        });
      }
    });

    persist();
    return publish();
  });

  app.post("/api/question-bank/allocation/reset", async (request, reply) => {
    const body = resetSchema.safeParse(request.body);

    if (!body.success) {
      return reply.code(400).send({
        error: "INVALID_REQUEST",
        issues: body.error.issues,
      });
    }

    const startedRounds = (
      db.prepare(`
        SELECT COUNT(*) AS count
        FROM qualification_rounds
        WHERE status <> 'PENDING'
      `).get() as { count: number }
    ).count;

    if (startedRounds > 0) {
      return conflict(
        reply,
        "ROUND_ALREADY_STARTED",
        "Question sets cannot be reset after a qualification round starts.",
      );
    }

    const resetAt = new Date().toISOString();

    const reset = db.transaction(() => {
      db.prepare("DELETE FROM qualification_question_reservations").run();
      db.prepare("DELETE FROM qualification_round_question_sets").run();

      appendAuditEvent(db, {
        eventType: "QUESTION_SETS_RESET",
        payload: {
          reason: "explicit operator reset before any round started",
        },
        occurredAt: resetAt,
      });
    });

    reset();
    return publish();
  });

  app.post("/api/question-bank/void-replace", async (request, reply) => {
    const body = voidReplaceSchema.safeParse(request.body);

    if (!body.success) {
      return reply.code(400).send({
        error: "INVALID_REQUEST",
        issues: body.error.issues,
      });
    }

    const current = db.prepare(`
      SELECT
        rqq.question_id AS questionId,
        rqq.category_id AS categoryId,
        c.category_key AS categoryKey,
        r.status AS roundStatus
      FROM qualification_round_questions rqq
      JOIN qualification_rounds r ON r.id = rqq.round_id
      JOIN categories c ON c.id = rqq.category_id
      WHERE rqq.round_id = ?
        AND rqq.position = ?
    `).get(
      body.data.roundId,
      body.data.position,
    ) as
      | {
          questionId: number;
          categoryId: number;
          categoryKey: string;
          roundStatus: "PENDING" | "ACTIVE" | "COMPLETED";
        }
      | undefined;

    if (!current) {
      return conflict(
        reply,
        "QUESTION_SLOT_NOT_FOUND",
        "The requested round question slot does not exist.",
      );
    }

    if (current.roundStatus === "COMPLETED") {
      return conflict(
        reply,
        "ROUND_ALREADY_COMPLETED",
        "A completed round cannot receive a replacement question.",
      );
    }

    const candidates = db.prepare(`
      SELECT q.id
      FROM questions q
      WHERE q.category_id = ?
        AND q.active = 1
        AND NOT EXISTS (
          SELECT 1
          FROM qualification_question_reservations r
          WHERE r.question_id = q.id
        )
      ORDER BY q.id
    `).all(current.categoryId) as Array<{ id: number }>;

    if (candidates.length === 0) {
      return conflict(
        reply,
        "NO_REPLACEMENT_AVAILABLE",
        "No unused replacement question is available in the same category.",
        {
          categoryKey: current.categoryKey,
        },
      );
    }

    const replacementQuestionId =
      candidates[randomInt(candidates.length)].id;
    const changedAt = new Date().toISOString();

    const replace = db.transaction(() => {
      db.prepare(`
        UPDATE qualification_question_reservations
        SET disposition = 'VOIDED',
            voided_at = ?
        WHERE question_id = ?
      `).run(changedAt, current.questionId);

      db.prepare(`
        INSERT INTO qualification_question_reservations (
          question_id,
          round_id,
          position,
          disposition,
          reserved_at
        )
        VALUES (?, ?, ?, 'REPLACEMENT', ?)
      `).run(
        replacementQuestionId,
        body.data.roundId,
        body.data.position,
        changedAt,
      );

      db.prepare(`
        UPDATE qualification_round_questions
        SET question_id = ?
        WHERE round_id = ?
          AND position = ?
      `).run(
        replacementQuestionId,
        body.data.roundId,
        body.data.position,
      );

      appendAuditEvent(db, {
        eventType: "QUESTION_VOID_REPLACED",
        roundId: body.data.roundId,
        questionId: current.questionId,
        relatedQuestionId: replacementQuestionId,
        position: body.data.position,
        reason: body.data.reason,
        payload: {
          categoryKey: current.categoryKey,
        },
        occurredAt: changedAt,
      });
    });

    replace();

    return {
      ok: true,
      roundId: body.data.roundId,
      position: body.data.position,
      categoryKey: current.categoryKey,
      voidedQuestionId: current.questionId,
      replacementQuestionId,
      allocation: publish(),
    };
  });
}
