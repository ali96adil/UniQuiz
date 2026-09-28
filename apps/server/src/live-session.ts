import type { FastifyInstance, FastifyReply } from "fastify";
import type { Server as SocketIOServer } from "socket.io";
import { z } from "zod";
import type {
  ClientRole,
  College,
  LivePhase,
  LiveQuestionView,
  LiveRoundView,
  LiveSnapshot,
  LiveSubmissionReceipt,
  LiveTeamSubmissionState,
} from "@uniquiz/shared";
import { appendAuditEvent } from "./audit.js";
import type { AppDatabase } from "./database.js";
import {
  QUESTION_DURATION_MS,
  ServerQuestionClock,
} from "./question-clock.js";
import { calculateScoreMicros } from "./scoring.js";

const prepareRoundSchema = z.object({
  roundId: z.number().int().positive().optional(),
});

const emptyObjectSchema = z.object({}).strict();

interface LiveStateRow {
  phase: LivePhase;
  roundId: number | null;
  questionPosition: number | null;
  stationsConfirmed: number;
  countdownStartedAtEpochMs: number | null;
  questionStartedAtEpochMs: number | null;
  questionClosedAtEpochMs: number | null;
  closeReason: string | null;
}

interface RoundDbRow {
  id: number;
  roundOrder: number;
  status: "PENDING" | "ACTIVE" | "COMPLETED";
  aId: number;
  aName: string;
  aShortName: string | null;
  aSortOrder: number;
  bId: number | null;
  bName: string | null;
  bShortName: string | null;
  bSortOrder: number | null;
}

interface QuestionDbRow {
  questionId: number;
  position: number;
  categoryKey: string;
  categoryName: string;
  prompt: string;
  optionA: string;
  optionB: string;
  optionC: string;
  optionD: string;
  correctOption: "A" | "B" | "C" | "D";
}

function conflict(
  reply: FastifyReply,
  error: string,
  message: string,
) {
  return reply.code(409).send({ error, message });
}

function college(
  id: number,
  name: string,
  shortName: string | null,
  sortOrder: number,
): College {
  return { id, name, shortName, sortOrder };
}

export class LiveSessionManager {
  private readonly questionClock = new ServerQuestionClock();
  private countdownTimer: NodeJS.Timeout | null = null;
  private questionTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: AppDatabase,
    private readonly io: SocketIOServer,
    private readonly countdownMs = 3_000,
    private readonly questionDurationMs = QUESTION_DURATION_MS,
  ) {}

  private stateRow(): LiveStateRow {
    return this.db.prepare(`
      SELECT
        phase,
        round_id AS roundId,
        question_position AS questionPosition,
        stations_confirmed AS stationsConfirmed,
        countdown_started_at_epoch_ms AS countdownStartedAtEpochMs,
        question_started_at_epoch_ms AS questionStartedAtEpochMs,
        question_closed_at_epoch_ms AS questionClosedAtEpochMs,
        close_reason AS closeReason
      FROM live_state
      WHERE id = 1
    `).get() as LiveStateRow;
  }

  private roundRow(roundId: number): RoundDbRow | undefined {
    return this.db.prepare(`
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
      WHERE r.id = ?
    `).get(roundId) as RoundDbRow | undefined;
  }

  private questionRow(
    roundId: number,
    position: number,
  ): QuestionDbRow | undefined {
    return this.db.prepare(`
      SELECT
        rqq.question_id AS questionId,
        rqq.position,
        c.category_key AS categoryKey,
        c.name AS categoryName,
        q.prompt,
        q.option_a AS optionA,
        q.option_b AS optionB,
        q.option_c AS optionC,
        q.option_d AS optionD,
        q.correct_option AS correctOption
      FROM qualification_round_questions rqq
      JOIN questions q ON q.id = rqq.question_id
      JOIN categories c ON c.id = rqq.category_id
      WHERE rqq.round_id = ?
        AND rqq.position = ?
    `).get(roundId, position) as QuestionDbRow | undefined;
  }

  getSnapshot(): LiveSnapshot {
    const state = this.stateRow();
    let round: LiveRoundView | null = null;
    let question: LiveQuestionView | null = null;

    if (state.roundId !== null) {
      const row = this.roundRow(state.roundId);
      if (row) {
        round = {
          id: row.id,
          order: row.roundOrder,
          teamA: college(
            row.aId,
            row.aName,
            row.aShortName,
            row.aSortOrder,
          ),
          teamB:
            row.bId === null
              ? null
              : college(
                  row.bId,
                  row.bName ?? "",
                  row.bShortName,
                  row.bSortOrder ?? 0,
                ),
        };
      }
    }

    if (
      state.roundId !== null &&
      state.questionPosition !== null
    ) {
      const row = this.questionRow(
        state.roundId,
        state.questionPosition,
      );

      if (row) {
        const visible =
          state.phase === "QUESTION_ACTIVE" ||
          state.phase === "QUESTION_CLOSED" ||
          state.phase === "QUESTION_REVEAL";

        question = {
          position: row.position,
          categoryKey: row.categoryKey,
          categoryName: row.categoryName,
          prompt: visible ? row.prompt : null,
          options: visible
            ? {
                A: row.optionA,
                B: row.optionB,
                C: row.optionC,
                D: row.optionD,
              }
            : null,
          correctOption:
            state.phase === "QUESTION_REVEAL"
              ? row.correctOption
              : null,
        };
      }
    }

    const submissionRows =
      state.roundId !== null && state.questionPosition !== null
        ? (this.db.prepare(`
            SELECT station
            FROM live_submissions
            WHERE round_id = ?
              AND question_position = ?
          `).all(
            state.roundId,
            state.questionPosition,
          ) as Array<{ station: "A" | "B" }>)
        : [];

    const receivedStations = new Set(
      submissionRows.map((submission) => submission.station),
    );

    return {
      phase: state.phase,
      serverNowEpochMs: Date.now(),
      round,
      stationsConfirmed: state.stationsConfirmed === 1,
      question,
      countdownStartedAtEpochMs:
        state.countdownStartedAtEpochMs,
      questionStartedAtEpochMs: state.questionStartedAtEpochMs,
      questionDeadlineEpochMs:
        state.questionStartedAtEpochMs === null
          ? null
          : state.questionStartedAtEpochMs + QUESTION_DURATION_MS,
      questionClosedAtEpochMs: state.questionClosedAtEpochMs,
      closeReason: state.closeReason,
      answerStatus: {
        teamARequired: round !== null,
        teamAReceived: receivedStations.has("A"),
        teamBRequired: round?.teamB !== null,
        teamBReceived: receivedStations.has("B"),
      },
    };
  }

  publish(): LiveSnapshot {
    const snapshot = this.getSnapshot();
    this.io.emit("live:snapshot", snapshot);
    return snapshot;
  }

  private updateState(fields: {
    phase: LivePhase;
    roundId?: number | null;
    questionPosition?: number | null;
    stationsConfirmed?: boolean;
    countdownStartedAtEpochMs?: number | null;
    questionStartedAtEpochMs?: number | null;
    questionClosedAtEpochMs?: number | null;
    closeReason?: string | null;
  }) {
    const current = this.stateRow();

    this.db.prepare(`
      UPDATE live_state
      SET
        phase = ?,
        round_id = ?,
        question_position = ?,
        stations_confirmed = ?,
        countdown_started_at_epoch_ms = ?,
        question_started_at_epoch_ms = ?,
        question_closed_at_epoch_ms = ?,
        close_reason = ?,
        updated_at = ?
      WHERE id = 1
    `).run(
      fields.phase,
      fields.roundId !== undefined ? fields.roundId : current.roundId,
      fields.questionPosition !== undefined
        ? fields.questionPosition
        : current.questionPosition,
      fields.stationsConfirmed !== undefined
        ? (fields.stationsConfirmed ? 1 : 0)
        : current.stationsConfirmed,
      fields.countdownStartedAtEpochMs !== undefined
        ? fields.countdownStartedAtEpochMs
        : current.countdownStartedAtEpochMs,
      fields.questionStartedAtEpochMs !== undefined
        ? fields.questionStartedAtEpochMs
        : current.questionStartedAtEpochMs,
      fields.questionClosedAtEpochMs !== undefined
        ? fields.questionClosedAtEpochMs
        : current.questionClosedAtEpochMs,
      fields.closeReason !== undefined
        ? fields.closeReason
        : current.closeReason,
      new Date().toISOString(),
    );
  }

  prepareRound(roundId?: number): LiveSnapshot {
    const state = this.stateRow();

    if (!["IDLE", "ROUND_COMPLETE", "INTERMISSION"].includes(state.phase)) {
      throw new Error("LIVE_STATE_NOT_READY_FOR_ROUND");
    }

    let targetRoundId = roundId ?? null;

    if (targetRoundId === null) {
      const selected = this.db.prepare(`
        SELECT selected_round_id AS selectedRoundId
        FROM competition_state
        WHERE id = 1
      `).get() as { selectedRoundId: number | null };

      targetRoundId = selected.selectedRoundId;
    }

    if (targetRoundId === null) {
      const next = this.db.prepare(`
        SELECT id
        FROM qualification_rounds
        WHERE status = 'PENDING'
        ORDER BY round_order
        LIMIT 1
      `).get() as { id: number } | undefined;

      targetRoundId = next?.id ?? null;
    }

    if (targetRoundId === null) {
      throw new Error("NO_PENDING_ROUND");
    }

    const round = this.roundRow(targetRoundId);
    if (!round || round.status !== "PENDING") {
      throw new Error("ROUND_NOT_PENDING");
    }

    const questionCount = (
      this.db.prepare(`
        SELECT COUNT(*) AS count
        FROM qualification_round_questions
        WHERE round_id = ?
      `).get(targetRoundId) as { count: number }
    ).count;

    if (questionCount !== 10) {
      throw new Error("ROUND_QUESTION_SET_NOT_READY");
    }

    this.updateState({
      phase: "ROUND_READY",
      roundId: targetRoundId,
      questionPosition: null,
      stationsConfirmed: false,
      countdownStartedAtEpochMs: null,
      questionStartedAtEpochMs: null,
      questionClosedAtEpochMs: null,
      closeReason: null,
    });

    appendAuditEvent(this.db, {
      eventType: "ROUND_PREPARED",
      roundId: targetRoundId,
    });

    return this.publish();
  }

  confirmStations(): LiveSnapshot {
    const state = this.stateRow();
    if (state.phase !== "ROUND_READY" || state.roundId === null) {
      throw new Error("ROUND_NOT_READY");
    }

    this.updateState({
      phase: "ROUND_READY",
      stationsConfirmed: true,
    });

    appendAuditEvent(this.db, {
      eventType: "STATIONS_CONFIRMED",
      roundId: state.roundId,
    });

    return this.publish();
  }

  startRound(): LiveSnapshot {
    const state = this.stateRow();

    if (
      state.phase !== "ROUND_READY" ||
      state.roundId === null ||
      state.stationsConfirmed !== 1
    ) {
      throw new Error("ROUND_NOT_CONFIRMED");
    }

    this.db.prepare(`
      UPDATE qualification_rounds
      SET status = 'ACTIVE'
      WHERE id = ?
    `).run(state.roundId);

    this.updateState({
      phase: "ROUND_ACTIVE",
      questionPosition: null,
    });

    appendAuditEvent(this.db, {
      eventType: "ROUND_STARTED",
      roundId: state.roundId,
    });

    return this.publish();
  }

  prepareNextQuestion(): LiveSnapshot {
    const state = this.stateRow();

    if (
      state.roundId === null ||
      !["ROUND_ACTIVE", "QUESTION_REVEAL", "INTERMISSION"].includes(
        state.phase,
      )
    ) {
      throw new Error("LIVE_STATE_NOT_READY_FOR_QUESTION");
    }

    const round = this.roundRow(state.roundId);
    if (!round || round.status !== "ACTIVE") {
      throw new Error("ROUND_NOT_ACTIVE");
    }

    const nextPosition = (state.questionPosition ?? 0) + 1;
    if (nextPosition > 10) {
      throw new Error("ALL_ROUND_QUESTIONS_COMPLETED");
    }

    if (!this.questionRow(state.roundId, nextPosition)) {
      throw new Error("QUESTION_SLOT_NOT_FOUND");
    }

    this.updateState({
      phase: "QUESTION_READY",
      questionPosition: nextPosition,
      countdownStartedAtEpochMs: null,
      questionStartedAtEpochMs: null,
      questionClosedAtEpochMs: null,
      closeReason: null,
    });

    appendAuditEvent(this.db, {
      eventType: "QUESTION_PREPARED",
      roundId: state.roundId,
      position: nextPosition,
    });

    return this.publish();
  }

  startQuestion(): LiveSnapshot {
    const state = this.stateRow();

    if (
      state.phase !== "QUESTION_READY" ||
      state.roundId === null ||
      state.questionPosition === null
    ) {
      throw new Error("QUESTION_NOT_READY");
    }

    const startedAt = Date.now();
    this.updateState({
      phase: "QUESTION_COUNTDOWN",
      countdownStartedAtEpochMs: startedAt,
      questionStartedAtEpochMs: null,
      questionClosedAtEpochMs: null,
      closeReason: null,
    });

    appendAuditEvent(this.db, {
      eventType: "QUESTION_COUNTDOWN_STARTED",
      roundId: state.roundId,
      position: state.questionPosition,
      occurredAt: new Date(startedAt).toISOString(),
    });

    const roundId = state.roundId;
    const position = state.questionPosition;

    if (this.countdownTimer) clearTimeout(this.countdownTimer);
    this.countdownTimer = setTimeout(() => {
      this.activateQuestion(roundId, position);
    }, this.countdownMs);

    return this.publish();
  }

  private activateQuestion(
    roundId: number,
    position: number,
  ): void {
    const state = this.stateRow();

    if (
      state.phase !== "QUESTION_COUNTDOWN" ||
      state.roundId !== roundId ||
      state.questionPosition !== position
    ) {
      return;
    }

    this.questionClock.clear();
    const clock = this.questionClock.start(
      `round-${roundId}:question-${position}`,
    );

    this.updateState({
      phase: "QUESTION_ACTIVE",
      questionStartedAtEpochMs: clock.startedAtEpochMs,
      questionClosedAtEpochMs: null,
      closeReason: null,
    });

    appendAuditEvent(this.db, {
      eventType: "QUESTION_STARTED",
      roundId,
      position,
      occurredAt: new Date(clock.startedAtEpochMs).toISOString(),
      payload: {
        durationMs: QUESTION_DURATION_MS,
      },
    });

    this.publish();

    if (this.questionTimer) clearTimeout(this.questionTimer);
    this.questionTimer = setTimeout(() => {
      const state = this.stateRow();
      if (state.phase === "QUESTION_ACTIVE") {
        this.closeActiveQuestion("TIMEOUT");
      }
    }, this.questionDurationMs + 1);
  }

  closeActiveQuestion(reason: string): LiveSnapshot {
    const state = this.stateRow();

    if (
      state.phase !== "QUESTION_ACTIVE" ||
      state.roundId === null ||
      state.questionPosition === null
    ) {
      throw new Error("QUESTION_NOT_ACTIVE");
    }

    if (this.questionTimer) {
      clearTimeout(this.questionTimer);
      this.questionTimer = null;
    }

    const clock = this.questionClock.close();
    const closedAt = Date.now();

    this.updateState({
      phase: "QUESTION_CLOSED",
      questionClosedAtEpochMs: closedAt,
      closeReason: reason,
    });

    appendAuditEvent(this.db, {
      eventType: "QUESTION_CLOSED",
      roundId: state.roundId,
      position: state.questionPosition,
      reason,
      payload: {
        elapsedMs: clock.elapsedMs,
      },
      occurredAt: new Date(closedAt).toISOString(),
    });

    return this.publish();
  }

  revealQuestion(): LiveSnapshot {
    const state = this.stateRow();

    if (
      state.phase !== "QUESTION_CLOSED" ||
      state.roundId === null ||
      state.questionPosition === null
    ) {
      throw new Error("QUESTION_NOT_CLOSED");
    }

    this.updateState({
      phase: "QUESTION_REVEAL",
    });

    appendAuditEvent(this.db, {
      eventType: "QUESTION_REVEALED",
      roundId: state.roundId,
      position: state.questionPosition,
    });

    return this.publish();
  }

  enterIntermission(): LiveSnapshot {
    const state = this.stateRow();

    if (
      ["QUESTION_ACTIVE", "QUESTION_COUNTDOWN", "QUESTION_READY"].includes(
        state.phase,
      )
    ) {
      throw new Error("INTERMISSION_NOT_SAFE_NOW");
    }

    this.updateState({ phase: "INTERMISSION" });
    return this.publish();
  }


  private stationFromRole(role: ClientRole): "A" | "B" | null {
    if (role === "team-a") return "A";
    if (role === "team-b") return "B";
    return null;
  }

  getTeamSubmissionState(
    role: ClientRole,
  ): LiveTeamSubmissionState | null {
    const station = this.stationFromRole(role);
    if (!station) return null;

    const state = this.stateRow();
    if (
      state.roundId === null ||
      state.questionPosition === null
    ) {
      return {
        station,
        required: false,
        locked: false,
        selectedOption: null,
        submittedAtEpochMs: null,
        responseTimeMs: null,
      };
    }

    const round = this.roundRow(state.roundId);
    if (!round) return null;

    const required =
      station === "A" ||
      (station === "B" && round.bId !== null);

    const submission = this.db.prepare(`
      SELECT
        selected_option AS selectedOption,
        submitted_at_epoch_ms AS submittedAtEpochMs,
        response_time_ms AS responseTimeMs
      FROM live_submissions
      WHERE round_id = ?
        AND question_position = ?
        AND station = ?
    `).get(
      state.roundId,
      state.questionPosition,
      station,
    ) as
      | {
          selectedOption: "A" | "B" | "C" | "D";
          submittedAtEpochMs: number;
          responseTimeMs: number;
        }
      | undefined;

    return {
      station,
      required,
      locked: Boolean(submission),
      selectedOption: submission?.selectedOption ?? null,
      submittedAtEpochMs: submission?.submittedAtEpochMs ?? null,
      responseTimeMs: submission?.responseTimeMs ?? null,
    };
  }

  submitAnswer(
    role: ClientRole,
    selectedOption: "A" | "B" | "C" | "D",
  ): LiveSubmissionReceipt {
    const station = this.stationFromRole(role);
    if (!station) {
      throw new Error("TEAM_STATION_REQUIRED");
    }

    const state = this.stateRow();
    if (
      state.phase !== "QUESTION_ACTIVE" ||
      state.roundId === null ||
      state.questionPosition === null
    ) {
      throw new Error("QUESTION_NOT_ACTIVE");
    }

    const round = this.roundRow(state.roundId);
    if (!round) {
      throw new Error("ROUND_NOT_FOUND");
    }

    if (station === "B" && round.bId === null) {
      throw new Error("TEAM_B_NOT_USED_IN_SOLO_ROUND");
    }

    const question = this.questionRow(
      state.roundId,
      state.questionPosition,
    );
    if (!question) {
      throw new Error("QUESTION_SLOT_NOT_FOUND");
    }

    const existing = this.db.prepare(`
      SELECT 1 AS existsRow
      FROM live_submissions
      WHERE round_id = ?
        AND question_position = ?
        AND station = ?
    `).get(
      state.roundId,
      state.questionPosition,
      station,
    );

    if (existing) {
      throw new Error("ANSWER_ALREADY_LOCKED");
    }

    if (!this.questionClock.isActive()) {
      throw new Error("QUESTION_CLOCK_NOT_ACTIVE");
    }

    const clock = this.questionClock.snapshot();
    if (clock.elapsedMs > QUESTION_DURATION_MS) {
      const current = this.stateRow();
      if (current.phase === "QUESTION_ACTIVE") {
        this.closeActiveQuestion("TIMEOUT");
      }
      throw new Error("ANSWER_TOO_LATE");
    }

    const submittedAtEpochMs = Date.now();
    const isCorrect = selectedOption === question.correctOption;
    const scoreMicros = calculateScoreMicros(
      isCorrect,
      clock.elapsedMs,
    );

    this.db.prepare(`
      INSERT INTO live_submissions (
        round_id,
        question_position,
        station,
        question_id,
        selected_option,
        submitted_at_epoch_ms,
        response_time_ms,
        is_correct,
        score_micros
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      state.roundId,
      state.questionPosition,
      station,
      question.questionId,
      selectedOption,
      submittedAtEpochMs,
      clock.elapsedMs,
      isCorrect ? 1 : 0,
      scoreMicros,
    );

    appendAuditEvent(this.db, {
      eventType: "TEAM_ANSWER_LOCKED",
      roundId: state.roundId,
      questionId: question.questionId,
      position: state.questionPosition,
      payload: {
        station,
        selectedOption,
        responseTimeMs: clock.elapsedMs,
        scoreMicros,
      },
      occurredAt: new Date(submittedAtEpochMs).toISOString(),
    });

    const requiredStations: Array<"A" | "B"> =
      round.bId === null ? ["A"] : ["A", "B"];

    const answered = this.db.prepare(`
      SELECT station
      FROM live_submissions
      WHERE round_id = ?
        AND question_position = ?
    `).all(
      state.roundId,
      state.questionPosition,
    ) as Array<{ station: "A" | "B" }>;

    const answeredSet = new Set(
      answered.map((entry) => entry.station),
    );

    if (
      requiredStations.every((requiredStation) =>
        answeredSet.has(requiredStation),
      )
    ) {
      this.closeActiveQuestion(
        round.bId === null ? "SOLO_ANSWERED" : "ALL_TEAMS_ANSWERED",
      );
    } else {
      this.publish();
    }

    return {
      station,
      selectedOption,
      submittedAtEpochMs,
      responseTimeMs: clock.elapsedMs,
    };
  }

  completeRound(): LiveSnapshot {
    const state = this.stateRow();

    if (
      state.phase !== "QUESTION_REVEAL" ||
      state.roundId === null ||
      state.questionPosition !== 10
    ) {
      throw new Error("ROUND_NOT_READY_TO_COMPLETE");
    }

    this.db.prepare(`
      UPDATE qualification_rounds
      SET status = 'COMPLETED'
      WHERE id = ?
    `).run(state.roundId);

    this.updateState({
      phase: "ROUND_COMPLETE",
    });

    appendAuditEvent(this.db, {
      eventType: "ROUND_COMPLETED",
      roundId: state.roundId,
    });

    return this.publish();
  }
}

export function registerLiveSessionRoutes(
  app: FastifyInstance,
  db: AppDatabase,
  io: SocketIOServer,
): LiveSessionManager {
  const manager = new LiveSessionManager(db, io);

  app.get("/api/live", async () => manager.getSnapshot());

  app.post("/api/live/prepare-round", async (request, reply) => {
    const body = prepareRoundSchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.code(400).send({
        error: "INVALID_REQUEST",
        issues: body.error.issues,
      });
    }

    try {
      return manager.prepareRound(body.data.roundId);
    } catch (error) {
      return conflict(
        reply,
        error instanceof Error ? error.message : "LIVE_ERROR",
        "Unable to prepare the selected round.",
      );
    }
  });

  const simple = (
    path: string,
    action: () => LiveSnapshot,
  ) => {
    app.post(path, async (request, reply) => {
      const body = emptyObjectSchema.safeParse(request.body ?? {});
      if (!body.success) {
        return reply.code(400).send({
          error: "INVALID_REQUEST",
          issues: body.error.issues,
        });
      }

      try {
        return action();
      } catch (error) {
        return conflict(
          reply,
          error instanceof Error ? error.message : "LIVE_ERROR",
          "Live-state transition is not allowed from the current state.",
        );
      }
    });
  };

  simple("/api/live/confirm-stations", () => manager.confirmStations());
  simple("/api/live/start-round", () => manager.startRound());
  simple("/api/live/prepare-question", () => manager.prepareNextQuestion());
  simple("/api/live/start-question", () => manager.startQuestion());
  simple("/api/live/reveal", () => manager.revealQuestion());
  simple("/api/live/intermission", () => manager.enterIntermission());
  simple("/api/live/complete-round", () => manager.completeRound());

  return manager;
}
