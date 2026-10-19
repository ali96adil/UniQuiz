import { randomInt } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Server as SocketIOServer } from "socket.io";
import { z } from "zod";
import type {
  QuestionAllocationSummary,
  RoundQuestionSetSummary,
} from "@uniquiz/shared";
import {
  allocateRoundsByPlan,
  type CategoryQuestionPool,
} from "./allocation.js";
import { appendAuditEvent } from "./audit.js";
import type { AppDatabase } from "./database.js";
import { getQuestionBankSummary } from "./importer.js";
import { getCompetitionRules, getRoundRules, getAllRoundRules } from "./competition-rules.js";
import { getCompetitionGameplayRules, saveCompetitionGameplayRules } from "./competition-gameplay.js";

const allocateSchema = z.object({
  confirm: z.literal("ALLOCATE_QUESTIONS"),
});

const resetSchema = z.object({
  confirm: z.literal("RESET_QUESTION_SETS"),
});

const gameplaySchema = z.object({
  durationSeconds: z.number().int().min(5).max(300),
  scoringMode: z.enum(["time_decay", "fixed"]),
  correctPoints: z.number().int().min(1).max(1000),
  pointsLostPerSecond: z.number().int().min(0).max(100),
}).strict();

const rulesSchema = z.object({
  categories: z.array(z.object({
    categoryKey: z.string().trim().min(1).max(100),
    questions: z.number().int().min(1).max(100),
  })).min(1).max(20),
});

const voidReplaceSchema = z.object({
  roundId: z.number().int().positive(),
  position: z.number().int().min(1).max(100),
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
      COALESCE(NULLIF(TRIM(c.display_name), ''), c.name) AS name,
      COUNT(q.id) AS availableQuestions
    FROM categories c
    LEFT JOIN questions q
      ON q.category_id = c.id
      AND q.active = 1
    GROUP BY c.id
    ORDER BY c.sort_order, c.id
  `).all() as CategoryRow[];

  const rules = getCompetitionRules(db);
  const quotas = new Map(rules.categories.map((item) => [item.categoryKey, item.questions]));
  const roundPlans = getAllRoundRules(db);
  const requiredByCategory = new Map<string, number>();
  for (const plan of roundPlans) {
    for (const quota of plan.categories) {
      requiredByCategory.set(quota.categoryKey, (requiredByCategory.get(quota.categoryKey) ?? 0) + quota.questions);
    }
  }
  const requiredPerCategory = rounds.length * 2; // Kept for older clients.

  const roundSummaries: RoundQuestionSetSummary[] = rounds.map((round) => {
    const plan = getRoundRules(db, round.id);
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
      plannedQuestionCount: plan.questionsPerRound,
      plannedCategoryCounts: Object.fromEntries(plan.categories.map((item) => [item.categoryKey, item.questions])),
      customized: plan.customized,
    };
  });

  return {
    roundCount: rounds.length,
    questionsPerRound: rules.questionsPerRound,
    requiredPerCategory,
    ready:
      rounds.length > 0 &&
      roundPlans.every((plan) => plan.categories.length > 0 &&
        plan.questionsPerRound >= 1 && plan.questionsPerRound <= 100 &&
        plan.categories.every((quota) => categories.some((category) => category.key === quota.categoryKey))) &&
      roundSummaries.every((round) =>
        round.locked &&
        round.questionCount === round.plannedQuestionCount &&
        Object.keys(round.categoryCounts).length === Object.keys(round.plannedCategoryCounts).length &&
        Object.entries(round.plannedCategoryCounts).every(
          ([key, count]) => round.categoryCounts[key] === count,
        ),
      ),
    categories: categories.map((category) => ({
      key: category.key,
      name: category.name,
      availableQuestions: category.availableQuestions,
      requiredQuestions: requiredByCategory.get(category.key) ?? 0,
      quotaPerRound: quotas.get(category.key) ?? 0,
    })),
    rounds: roundSummaries,
  };
}

export function registerQuestionBankRoutes(
  app: FastifyInstance,
  db: AppDatabase,
  io: SocketIOServer,
  onQuestionReplaced?: (
    roundId: number,
    position: number,
  ) => void,
) {
  const publish = () => {
    const summary = getQuestionAllocationSummary(db);
    io.emit("question-allocation:snapshot", summary);
    return summary;
  };

  // Editorial and audience labels are independent; updating one never rewrites old archives.
  app.put<{ Params: { key: string } }>(
    "/api/question-bank/categories/:key/display-name",
    async (request, reply) => {
      const body = z.object({
        displayName: z.string().trim().min(1).max(120),
      }).safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: "INVALID_DISPLAY_NAME", issues: body.error.issues });
      }
      const result = db.prepare(
        "UPDATE categories SET display_name = ? WHERE category_key = ?",
      ).run(body.data.displayName, request.params.key);
      if (result.changes === 0) {
        return reply.code(404).send({ error: "CATEGORY_NOT_FOUND" });
      }
      const questionBank = getQuestionBankSummary(db);
      io.emit("question-bank:snapshot", questionBank);
      return { ok: true, questionBank };
    },
  );

  app.get("/api/competition/gameplay", async () => getCompetitionGameplayRules(db));

  app.put("/api/competition/gameplay", async (request, reply) => {
    const parsed = gameplaySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_GAMEPLAY_RULES", issues: parsed.error.issues });
    try {
      const rules = saveCompetitionGameplayRules(db, parsed.data);
      io.emit("competition:gameplay", rules);
      return rules;
    } catch (error) {
      return conflict(reply, error instanceof Error ? error.message : "GAMEPLAY_RULES_ERROR", "Gameplay rules cannot be changed after a round starts.");
    }
  });

  app.get("/api/competition/rules", async () => getCompetitionRules(db));

  app.put("/api/competition/rules", async (request, reply) => {
    const parsed = rulesSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "INVALID_RULES", issues: parsed.error.issues });
    }
    const categories = parsed.data.categories;
    const total = categories.reduce((sum, item) => sum + item.questions, 0);
    if (total > 100 || new Set(categories.map((item) => item.categoryKey)).size !== categories.length) {
      return reply.code(400).send({ error: "INVALID_QUOTA_DISTRIBUTION" });
    }

    const existingKeys = new Set(
      (db.prepare("SELECT category_key AS categoryKey FROM categories").all() as Array<{ categoryKey: string }>)
        .map((item) => item.categoryKey),
    );
    if (categories.some((item) => !existingKeys.has(item.categoryKey))) {
      return reply.code(400).send({ error: "UNKNOWN_CATEGORY" });
    }
    const locked = (db.prepare(
      "SELECT COUNT(*) AS count FROM qualification_round_question_sets",
    ).get() as { count: number }).count;
    const started = (db.prepare(
      "SELECT COUNT(*) AS count FROM qualification_rounds WHERE status <> 'PENDING'",
    ).get() as { count: number }).count;
    if (locked > 0 || started > 0) {
      return conflict(reply, "RULES_LOCKED", "Rules cannot change after allocating or starting rounds.");
    }

    db.prepare("UPDATE competition_rules SET distribution_json = ? WHERE id = 1")
      .run(JSON.stringify(categories));
    const rules = getCompetitionRules(db);
    io.emit("competition-rules:snapshot", rules);
    publish();
    return rules;
  });

  // Per-round quotas override the competition default without altering other rounds.
  app.put<{ Params: { roundId: string } }>(
    "/api/competition/rounds/:roundId/rules",
    async (request, reply) => {
      const roundId = Number(request.params.roundId);
      const parsed = rulesSchema.safeParse(request.body);
      if (!Number.isSafeInteger(roundId) || roundId < 1 || !parsed.success) {
        return reply.code(400).send({ error: "INVALID_ROUND_RULES" });
      }
      const round = db.prepare(
        "SELECT status FROM qualification_rounds WHERE id=?",
      ).get(roundId) as { status: string } | undefined;
      if (!round) return reply.code(404).send({ error: "ROUND_NOT_FOUND" });
      const locked = db.prepare(
        "SELECT 1 FROM qualification_round_question_sets WHERE round_id=?",
      ).get(roundId);
      if (locked || round.status !== "PENDING") {
        return conflict(reply, "ROUND_RULES_LOCKED", "Round has already been allocated or started.");
      }
      const categories = parsed.data.categories;
      const total = categories.reduce((sum, item) => sum + item.questions, 0);
      const keys = new Set(categories.map((item) => item.categoryKey));
      if (total > 100 || keys.size !== categories.length) {
        return reply.code(400).send({ error: "INVALID_QUOTA_DISTRIBUTION" });
      }
      const existingRows = db.prepare(
        "SELECT category_key AS categoryKey FROM categories",
      ).all() as Array<{ categoryKey: string }>;
      const existing = new Set(existingRows.map((item) => item.categoryKey));
      if (categories.some((item) => !existing.has(item.categoryKey))) {
        return reply.code(400).send({ error: "UNKNOWN_CATEGORY" });
      }
      db.prepare(`
        INSERT INTO qualification_round_rules (round_id, distribution_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(round_id) DO UPDATE SET
          distribution_json=excluded.distribution_json, updated_at=excluded.updated_at
      `).run(roundId, JSON.stringify(categories), new Date().toISOString());
      return { rules: getRoundRules(db, roundId), allocation: publish() };
    },
  );

  app.delete<{ Params: { roundId: string } }>(
    "/api/competition/rounds/:roundId/rules",
    async (request, reply) => {
      const roundId = Number(request.params.roundId);
      if (!Number.isSafeInteger(roundId) || roundId < 1) {
        return reply.code(400).send({ error: "INVALID_ROUND_ID" });
      }
      const round = db.prepare("SELECT status FROM qualification_rounds WHERE id=?")
        .get(roundId) as { status: string } | undefined;
      if (!round) return reply.code(404).send({ error: "ROUND_NOT_FOUND" });
      const locked = db.prepare(
        "SELECT 1 FROM qualification_round_question_sets WHERE round_id=?",
      ).get(roundId);
      if (locked || round.status !== "PENDING") {
        return conflict(reply, "ROUND_RULES_LOCKED", "Round has already been allocated or started.");
      }
      db.prepare("DELETE FROM qualification_round_rules WHERE round_id=?").run(roundId);
      return { rules: getRoundRules(db, roundId), allocation: publish() };
    },
  );

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

    const categoryMap = new Map(categories.map((category) => [category.key, category]));
    const plans = rounds.map((round) => getRoundRules(db, round.id));
    if (plans.some((plan) =>
      plan.questionsPerRound < 1 || plan.questionsPerRound > 100 ||
      plan.categories.length === 0 ||
      plan.categories.some((quota) => !categoryMap.has(quota.categoryKey)))) {
      return conflict(reply, "ROUND_RULES_INCOMPLETE", "Select valid category quotas before allocation.");
    }
    const required = new Map<string, number>();
    for (const plan of plans) {
      for (const quota of plan.categories) {
        required.set(quota.categoryKey, (required.get(quota.categoryKey) ?? 0) + quota.questions);
      }
    }
    const insufficient = [...required.entries()]
      .map(([key, count]) => {
        const category = categoryMap.get(key)!;
        return { key, name: category.name, available: category.availableQuestions, required: count };
      })
      .filter((category) => category.available < category.required);

    if (insufficient.length > 0) {
      return conflict(
        reply,
        "INSUFFICIENT_QUESTION_INVENTORY",
        "There are not enough unique questions to allocate all qualification rounds.",
        insufficient,
      );
    }

    const pools: CategoryQuestionPool[] = [...required.keys()].map((key) => ({
      categoryId: categoryMap.get(key)!.id,
      questionIds: (
        db.prepare(`
          SELECT id
          FROM questions
          WHERE category_id = ?
            AND active = 1
          ORDER BY id
        `).all(categoryMap.get(key)!.id) as Array<{ id: number }>
      ).map((row) => row.id),
    }));

    const allocation = allocateRoundsByPlan(
      plans.map((plan) => ({
        roundId: plan.roundId,
        categories: plan.categories.map((quota) => ({
          categoryId: categoryMap.get(quota.categoryKey)!.id,
          questions: quota.questions,
        })),
      })),
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

    const liveState = db.prepare(`
      SELECT
        phase,
        round_id AS roundId,
        question_position AS questionPosition
      FROM live_state
      WHERE id = 1
    `).get() as {
      phase: string;
      roundId: number | null;
      questionPosition: number | null;
    };

    if (
      liveState.roundId === body.data.roundId &&
      liveState.questionPosition === body.data.position &&
      (
        liveState.phase === "QUESTION_COUNTDOWN" ||
        liveState.phase === "QUESTION_ACTIVE"
      )
    ) {
      return conflict(
        reply,
        "QUESTION_STILL_LIVE",
        "Close or recover the active question before replacing it.",
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

      db.prepare(`
        DELETE FROM live_submissions
        WHERE round_id = ?
          AND question_position = ?
      `).run(
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

    onQuestionReplaced?.(
      body.data.roundId,
      body.data.position,
    );

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
