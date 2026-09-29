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
  LiveRevealResults,
  LiveTeamSubmissionState,
} from "@uniquiz/shared";
import { appendAuditEvent } from "./audit.js";
import type { AppDatabase } from "./database.js";
import {
  QUESTION_DURATION_MS,
  ServerQuestionClock,
} from "./question-clock.js";
import { calculateScoreMicros } from "./scoring.js";
import { getQualificationRanking } from "./ranking.js";
import {
  NOOP_SHOW_CONTROL,
  type OscArgument,
  type ShowControlOutput,
} from "./osc-output.js";

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
  private countdownCueTimers: NodeJS.Timeout[] = [];
  private questionTimer: NodeJS.Timeout | null = null;
  private autoRevealTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: AppDatabase,
    private readonly io: SocketIOServer,
    private readonly countdownMs = 3_000,
    private readonly questionDurationMs = QUESTION_DURATION_MS,
    private readonly showControl: ShowControlOutput = NOOP_SHOW_CONTROL,
    private readonly isStationConnected: (
      role: "team-a" | "team-b",
    ) => boolean = () => true,
    private readonly autoRevealDelayMs = 1_500,
  ) {
    this.restorePersistedRuntime();
  }

  private restorePersistedRuntime(): void {
    const state = this.stateRow();

    if (
      state.phase === "QUESTION_COUNTDOWN" &&
      state.roundId !== null &&
      state.questionPosition !== null
    ) {
      this.updateState({
        phase: "QUESTION_READY",
        countdownStartedAtEpochMs: null,
        questionStartedAtEpochMs: null,
        questionClosedAtEpochMs: null,
        closeReason: null,
      });

      appendAuditEvent(this.db, {
        eventType: "LIVE_RECOVERY",
        roundId: state.roundId,
        position: state.questionPosition,
        reason: "SERVER_RESTART_DURING_COUNTDOWN",
        payload: {
          fromPhase: "QUESTION_COUNTDOWN",
          toPhase: "QUESTION_READY",
          action: "REQUIRE_NEW_START",
        },
      });
      return;
    }

    if (
      state.phase === "QUESTION_ACTIVE" &&
      state.roundId !== null &&
      state.questionPosition !== null
    ) {
      const recoveredAt = Date.now();

      this.updateState({
        phase: "QUESTION_CLOSED",
        questionClosedAtEpochMs: recoveredAt,
        closeReason: "SERVER_RESTART_RECOVERY",
      });

      appendAuditEvent(this.db, {
        eventType: "LIVE_RECOVERY",
        roundId: state.roundId,
        position: state.questionPosition,
        reason: "SERVER_RESTART_DURING_ACTIVE_QUESTION",
        payload: {
          fromPhase: "QUESTION_ACTIVE",
          toPhase: "QUESTION_CLOSED",
          action: "VOID_REPLACEMENT_REQUIRED",
          originalQuestionStartedAtEpochMs:
            state.questionStartedAtEpochMs,
        },
        occurredAt: new Date(recoveredAt).toISOString(),
      });

      this.sendShowControl(
        "/uniquiz/question/recovery_required",
        [
          this.roundOrder(state.roundId),
          state.questionPosition,
        ],
      );
      return;
    }

    this.restoreAutomaticReveal();
  }


  private isAnsweredCloseReason(reason: string | null): boolean {
    return (
      reason === "ALL_TEAMS_ANSWERED" ||
      reason === "SOLO_ANSWERED"
    );
  }

  private scheduleAutomaticReveal(
    roundId: number,
    position: number,
    delayMs = this.autoRevealDelayMs,
  ): void {
    if (this.autoRevealTimer) {
      clearTimeout(this.autoRevealTimer);
    }

    this.autoRevealTimer = setTimeout(() => {
      const current = this.stateRow();

      if (
        current.phase !== "QUESTION_CLOSED" ||
        current.roundId !== roundId ||
        current.questionPosition !== position ||
        !this.isAnsweredCloseReason(current.closeReason)
      ) {
        return;
      }

      this.revealQuestion();
    }, Math.max(0, delayMs));

    this.autoRevealTimer.unref?.();
  }

  private restoreAutomaticReveal(): void {
    const state = this.stateRow();

    if (
      state.phase !== "QUESTION_CLOSED" ||
      state.roundId === null ||
      state.questionPosition === null ||
      state.questionClosedAtEpochMs === null ||
      !this.isAnsweredCloseReason(state.closeReason)
    ) {
      return;
    }

    const elapsed = Date.now() - state.questionClosedAtEpochMs;
    this.scheduleAutomaticReveal(
      state.roundId,
      state.questionPosition,
      Math.max(0, this.autoRevealDelayMs - elapsed),
    );
  }

  private sendShowControl(
    address: string,
    args: readonly OscArgument[] = [],
  ): void {
    try {
      this.showControl.send(address, args);
    } catch {
      // Show-control failures must never affect official competition state.
    }
  }

  private roundOrder(roundId: number): number {
    return this.roundRow(roundId)?.roundOrder ?? 0;
  }

  private clearCountdownCueTimers(): void {
    for (const timer of this.countdownCueTimers) {
      clearTimeout(timer);
    }
    this.countdownCueTimers = [];
  }

  private scheduleCountdownCues(
    roundId: number,
    position: number,
  ): void {
    this.clearCountdownCueTimers();

    const roundOrder = this.roundOrder(roundId);
    const values = [3, 2, 1] as const;

    values.forEach((value, index) => {
      const emit = () => {
        const current = this.stateRow();
        if (
          current.phase !== "QUESTION_COUNTDOWN" ||
          current.roundId !== roundId ||
          current.questionPosition !== position
        ) {
          return;
        }

        this.sendShowControl(
          "/uniquiz/question/countdown",
          [roundOrder, position, value],
        );
      };

      if (index === 0) {
        emit();
        return;
      }

      this.countdownCueTimers.push(
        setTimeout(emit, index * 1000),
      );
    });
  }

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
            SELECT
              station,
              selected_option AS selectedOption,
              response_time_ms AS responseTimeMs,
              is_correct AS isCorrect,
              score_micros AS scoreMicros
            FROM live_submissions
            WHERE round_id = ?
              AND question_position = ?
          `).all(
            state.roundId,
            state.questionPosition,
          ) as Array<{
            station: "A" | "B";
            selectedOption: "A" | "B" | "C" | "D";
            responseTimeMs: number;
            isCorrect: number;
            scoreMicros: number;
          }>)
        : [];

    const receivedStations = new Set(
      submissionRows.map((submission) => submission.station),
    );

    let revealResults: LiveRevealResults | null = null;

    if (
      state.phase === "QUESTION_REVEAL" &&
      round !== null
    ) {
      const resultFor = (
        station: "A" | "B",
      ): LiveRevealResults["teamA"] => {
        const submission = submissionRows.find(
          (entry) => entry.station === station,
        );

        return {
          station,
          answered: Boolean(submission),
          selectedOption: submission?.selectedOption ?? null,
          isCorrect:
            submission === undefined
              ? null
              : submission.isCorrect === 1,
          responseTimeMs: submission?.responseTimeMs ?? null,
          scorePoints:
            (submission?.scoreMicros ?? 0) / 1_000_000,
        };
      };

      revealResults = {
        teamA: resultFor("A"),
        teamB:
          round.teamB === null ? null : resultFor("B"),
      };
    }

    const roundCounts = this.db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END) AS completed
      FROM qualification_rounds
    `).get() as {
      total: number;
      pending: number | null;
      completed: number | null;
    };

    const pendingRoundCount = roundCounts.pending ?? 0;
    const completedRoundCount = roundCounts.completed ?? 0;

    let roundTotals: LiveSnapshot["roundTotals"] = null;

    if (state.roundId !== null && round !== null) {
      const totalRows = this.db.prepare(`
        SELECT
          s.station,
          COALESCE(SUM(s.score_micros), 0) AS scoreMicros
        FROM live_submissions s
        WHERE s.round_id = ?
          AND EXISTS (
            SELECT 1
            FROM audit_events a
            WHERE a.event_type = 'QUESTION_REVEALED'
              AND a.round_id = s.round_id
              AND a.position = s.question_position
              AND a.id > COALESCE((
                SELECT MAX(v.id)
                FROM audit_events v
                WHERE v.event_type = 'QUESTION_VOID_REPLACED'
                  AND v.round_id = s.round_id
                  AND v.position = s.question_position
              ), 0)
          )
        GROUP BY s.station
      `).all(state.roundId) as Array<{
        station: "A" | "B";
        scoreMicros: number;
      }>;

      const scoreFor = (station: "A" | "B") =>
        (totalRows.find((row) => row.station === station)
          ?.scoreMicros ?? 0) / 1_000_000;

      roundTotals = {
        teamA: scoreFor("A"),
        teamB: round.teamB === null ? null : scoreFor("B"),
      };
    }

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
      hasPendingRound: pendingRoundCount > 0,
      qualificationComplete:
        roundCounts.total > 0 &&
        completedRoundCount === roundCounts.total,
      stationReadiness: {
        teamARequired: round !== null,
        teamAConnected: this.isStationConnected("team-a"),
        teamBRequired: round?.teamB !== null,
        teamBConnected: this.isStationConnected("team-b"),
      },
      answerStatus: {
        teamARequired: round !== null,
        teamAReceived: receivedStations.has("A"),
        teamBRequired: round?.teamB !== null,
        teamBReceived: receivedStations.has("B"),
      },
      revealResults,
      roundTotals,
    };
  }

  onQuestionReplaced(
    roundId: number,
    position: number,
  ): LiveSnapshot | null {
    const state = this.stateRow();

    if (
      state.roundId !== roundId ||
      state.questionPosition !== position
    ) {
      return null;
    }

    if (
      state.phase === "QUESTION_COUNTDOWN" ||
      state.phase === "QUESTION_ACTIVE"
    ) {
      throw new Error("QUESTION_STILL_LIVE");
    }

    if (this.countdownTimer) {
      clearTimeout(this.countdownTimer);
      this.countdownTimer = null;
    }
    this.clearCountdownCueTimers();

    if (this.questionTimer) {
      clearTimeout(this.questionTimer);
      this.questionTimer = null;
    }

    if (this.autoRevealTimer) {
      clearTimeout(this.autoRevealTimer);
      this.autoRevealTimer = null;
    }

    this.questionClock.clear();

    this.updateState({
      phase: "QUESTION_READY",
      countdownStartedAtEpochMs: null,
      questionStartedAtEpochMs: null,
      questionClosedAtEpochMs: null,
      closeReason: null,
    });

    appendAuditEvent(this.db, {
      eventType: "QUESTION_REPLACEMENT_READY",
      roundId,
      position,
      reason: "VOID_REPLACEMENT",
    });

    return this.publish();
  }

  resetForNewCompetition(): LiveSnapshot {
    if (this.countdownTimer) {
      clearTimeout(this.countdownTimer);
      this.countdownTimer = null;
    }

    this.clearCountdownCueTimers();

    if (this.questionTimer) {
      clearTimeout(this.questionTimer);
      this.questionTimer = null;
    }

    if (this.autoRevealTimer) {
      clearTimeout(this.autoRevealTimer);
      this.autoRevealTimer = null;
    }

    this.questionClock.clear();

    this.db.prepare(`
      UPDATE live_state
      SET
        phase = 'IDLE',
        round_id = NULL,
        question_position = NULL,
        stations_confirmed = 0,
        countdown_started_at_epoch_ms = NULL,
        question_started_at_epoch_ms = NULL,
        question_closed_at_epoch_ms = NULL,
        close_reason = NULL,
        updated_at = ?
      WHERE id = 1
    `).run(new Date().toISOString());

    return this.publish();
  }

  publish(): LiveSnapshot {
    const snapshot = this.getSnapshot();
    this.io.emit("live:snapshot", snapshot);
    this.io.emit(
      "ranking:snapshot",
      getQualificationRanking(this.db),
    );

    const teamAState = this.getTeamSubmissionState("team-a");
    const teamBState = this.getTeamSubmissionState("team-b");

    if (teamAState) {
      this.io
        .to("team-a")
        .emit("live:team-submission", teamAState);
    }

    if (teamBState) {
      this.io
        .to("team-b")
        .emit("live:team-submission", teamBState);
    }

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
        SELECT r.id
        FROM competition_state cs
        JOIN qualification_rounds r
          ON r.id = cs.selected_round_id
        WHERE cs.id = 1
          AND r.status = 'PENDING'
      `).get() as { id: number } | undefined;

      targetRoundId = selected?.id ?? null;
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
      throw new Error("QUALIFICATION_COMPLETE");
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

    const round = this.roundRow(state.roundId);
    if (!round) {
      throw new Error("ROUND_NOT_FOUND");
    }

    if (!this.isStationConnected("team-a")) {
      throw new Error("TEAM_A_NOT_READY");
    }

    if (
      round.bId !== null &&
      !this.isStationConnected("team-b")
    ) {
      throw new Error("TEAM_B_NOT_READY");
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

    const round = this.roundRow(state.roundId);
    if (!round) {
      throw new Error("ROUND_NOT_FOUND");
    }

    if (!this.isStationConnected("team-a")) {
      this.updateState({
        phase: "ROUND_READY",
        stationsConfirmed: false,
      });
      this.publish();
      throw new Error("TEAM_A_NOT_READY");
    }

    if (
      round.bId !== null &&
      !this.isStationConnected("team-b")
    ) {
      this.updateState({
        phase: "ROUND_READY",
        stationsConfirmed: false,
      });
      this.publish();
      throw new Error("TEAM_B_NOT_READY");
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

    this.sendShowControl(
      "/uniquiz/round/start",
      [this.roundOrder(state.roundId)],
    );

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

    this.scheduleCountdownCues(roundId, position);

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

    this.clearCountdownCueTimers();
    this.sendShowControl(
      "/uniquiz/question/start",
      [
        this.roundOrder(roundId),
        position,
        this.questionDurationMs,
      ],
    );

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

    const roundOrder = this.roundOrder(state.roundId);
    this.sendShowControl(
      "/uniquiz/question/closed",
      [roundOrder, state.questionPosition, reason],
    );

    if (reason === "TIMEOUT") {
      this.sendShowControl(
        "/uniquiz/question/timeout",
        [roundOrder, state.questionPosition],
      );
    }

    if (this.isAnsweredCloseReason(reason)) {
      this.sendShowControl(
        "/uniquiz/question/answered",
        [roundOrder, state.questionPosition, reason],
      );

      this.scheduleAutomaticReveal(
        state.roundId,
        state.questionPosition,
      );
    }

    return this.publish();
  }

  revealQuestion(): LiveSnapshot {
    const state = this.stateRow();

    if (this.autoRevealTimer) {
      clearTimeout(this.autoRevealTimer);
      this.autoRevealTimer = null;
    }

    if (
      state.phase !== "QUESTION_CLOSED" ||
      state.roundId === null ||
      state.questionPosition === null
    ) {
      throw new Error("QUESTION_NOT_CLOSED");
    }

    if (state.closeReason === "SERVER_RESTART_RECOVERY") {
      throw new Error("RECOVERY_QUESTION_REQUIRES_VOID");
    }

    this.updateState({
      phase: "QUESTION_REVEAL",
    });

    const revealedQuestion = this.questionRow(
      state.roundId,
      state.questionPosition,
    );

    appendAuditEvent(this.db, {
      eventType: "QUESTION_REVEALED",
      roundId: state.roundId,
      questionId: revealedQuestion?.questionId,
      position: state.questionPosition,
    });

    this.sendShowControl(
      "/uniquiz/question/reveal",
      [
        this.roundOrder(state.roundId),
        state.questionPosition,
      ],
    );

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

    if (state.roundId !== null) {
      this.sendShowControl(
        "/uniquiz/intermission",
        [
          this.roundOrder(state.roundId),
          state.questionPosition ?? 0,
        ],
      );
    }

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

    if (state.roundId === null) {
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

    if (state.questionPosition === null) {
      return {
        station,
        required,
        locked: false,
        selectedOption: null,
        submittedAtEpochMs: null,
        responseTimeMs: null,
      };
    }

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
    if (clock.elapsedMs >= QUESTION_DURATION_MS) {
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

    const complete = this.db.transaction(() => {
      this.db.prepare(`
        UPDATE qualification_rounds
        SET status = 'COMPLETED'
        WHERE id = ?
      `).run(state.roundId);

      this.db.prepare(`
        UPDATE competition_state
        SET selected_round_id = NULL
        WHERE id = 1
          AND selected_round_id = ?
      `).run(state.roundId);
    });

    complete();

    this.updateState({
      phase: "ROUND_COMPLETE",
    });

    appendAuditEvent(this.db, {
      eventType: "ROUND_COMPLETED",
      roundId: state.roundId,
    });

    this.sendShowControl(
      "/uniquiz/round/complete",
      [this.roundOrder(state.roundId)],
    );

    return this.publish();
  }
}

export function registerLiveSessionRoutes(
  app: FastifyInstance,
  db: AppDatabase,
  io: SocketIOServer,
  showControl: ShowControlOutput = NOOP_SHOW_CONTROL,
  isStationConnected: (
    role: "team-a" | "team-b",
  ) => boolean = () => true,
): LiveSessionManager {
  const manager = new LiveSessionManager(
    db,
    io,
    3_000,
    QUESTION_DURATION_MS,
    showControl,
    isStationConnected,
  );

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
      const code =
        error instanceof Error ? error.message : "LIVE_ERROR";

      return conflict(
        reply,
        code,
        code === "QUALIFICATION_COMPLETE"
          ? "All qualification rounds are completed."
          : "Unable to prepare the selected round.",
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
