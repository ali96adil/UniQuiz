import type { FastifyInstance } from "fastify";
import type { Server as SocketIOServer } from "socket.io";
import { z } from "zod";
import { getCompetitionSnapshot } from "./competition.js";
import type { AppDatabase } from "./database.js";
import {
  clearImportPreviews,
  getQuestionBankSummary,
} from "./importer.js";
import type { LiveSessionManager } from "./live-session.js";
import { getQuestionAllocationSummary } from "./question-bank.js";
import { getQualificationRanking } from "./ranking.js";

const resetAllSchema = z.object({
  confirm: z.literal("RESET_ALL_COMPETITION_DATA"),
});

export function resetAllCompetitionData(
  db: AppDatabase,
): void {
  const reset = db.transaction(() => {
    db.prepare("DELETE FROM live_submissions").run();
    db.prepare("DELETE FROM audit_events").run();
    db.prepare("DELETE FROM qualification_question_reservations").run();
    db.prepare("DELETE FROM qualification_round_questions").run();
    db.prepare("DELETE FROM qualification_round_question_sets").run();
    db.prepare("DELETE FROM qualification_rounds").run();
    db.prepare("DELETE FROM participants").run();
    db.prepare("DELETE FROM questions").run();
    db.prepare("DELETE FROM categories").run();
    db.prepare("DELETE FROM colleges").run();

    db.prepare(`
      UPDATE competition_state
      SET
        participants_locked = 0,
        draw_created_at = NULL,
        selected_round_id = NULL
      WHERE id = 1
    `).run();

    db.prepare(`
      UPDATE audience_presentation
      SET
        active = 0,
        updated_at = ?
      WHERE id = 1
    `).run(new Date().toISOString());

    db.prepare(`
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

    // Reset user-data row ids for a genuinely clean rehearsal/setup state.
    db.prepare(`
      DELETE FROM sqlite_sequence
      WHERE name IN (
        'colleges',
        'qualification_rounds',
        'categories',
        'questions',
        'audit_events'
      )
    `).run();
  });

  reset();
  clearImportPreviews();
}

export function registerResetAllRoute(
  app: FastifyInstance,
  db: AppDatabase,
  io: SocketIOServer,
  liveSession: LiveSessionManager,
): void {
  app.post("/api/setup/reset-all", async (request, reply) => {
    const body = resetAllSchema.safeParse(request.body);

    if (!body.success) {
      return reply.code(400).send({
        error: "INVALID_RESET_CONFIRMATION",
        message:
          "Explicit RESET_ALL_COMPETITION_DATA confirmation is required.",
      });
    }

    resetAllCompetitionData(db);
    const live = liveSession.resetForNewCompetition();
    const competition = getCompetitionSnapshot(db);
    const questionBank = getQuestionBankSummary(db);
    const allocation = getQuestionAllocationSummary(db);
    const ranking = getQualificationRanking(db);

    io.emit("competition:snapshot", competition);
    io.emit("question-bank:snapshot", questionBank);
    io.emit("question-allocation:snapshot", allocation);
    io.emit("ranking:snapshot", ranking);

    return {
      ok: true,
      resetAt: new Date().toISOString(),
      competition,
      questionBank,
      allocation,
      live,
      ranking,
    };
  });
}
