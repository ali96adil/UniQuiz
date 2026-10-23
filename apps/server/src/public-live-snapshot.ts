import type { LiveSnapshot } from "@uniquiz/shared";

/**
 * Explicit public wire shape shared by GET /api/live and Socket.IO.
 *
 * The public audience display, station clients and unauthenticated observers
 * all use live:snapshot. Keep this allowlist intentional: an additional
 * internal LiveSnapshot property must not be exposed simply because a
 * developer added it to the manager state and spread it into a response.
 *
 * Correct answers and per-team graded results are public ONLY after the
 * operator's QUESTION_REVEAL transition. Before QUESTION_ACTIVE, prompt
 * and options also remain hidden.
 */
export function publicLiveSnapshot(snapshot: LiveSnapshot): LiveSnapshot {
  const phase = snapshot.phase;
  const showingQuestion =
    phase === "QUESTION_ACTIVE" ||
    phase === "QUESTION_CLOSED" ||
    phase === "QUESTION_REVEAL";
  const revealingAnswer = phase === "QUESTION_REVEAL";
  const sourceQuestion = snapshot.question;

  return {
    phase,
    gameplay: {
      durationSeconds: snapshot.gameplay.durationSeconds,
      scoringMode: snapshot.gameplay.scoringMode,
      correctPoints: snapshot.gameplay.correctPoints,
      pointsLostPerSecond: snapshot.gameplay.pointsLostPerSecond,
    },
    questionsPerRound: snapshot.questionsPerRound,
    serverNowEpochMs: snapshot.serverNowEpochMs,
    round: snapshot.round,
    stationsConfirmed: snapshot.stationsConfirmed,
    question: sourceQuestion === null ? null : {
      position: sourceQuestion.position,
      categoryKey: sourceQuestion.categoryKey,
      categoryName: sourceQuestion.categoryName,
      prompt: showingQuestion ? sourceQuestion.prompt : null,
      options: showingQuestion ? sourceQuestion.options : null,
      correctOption: revealingAnswer ? sourceQuestion.correctOption : null,
    },
    countdownStartedAtEpochMs: snapshot.countdownStartedAtEpochMs,
    questionStartedAtEpochMs: snapshot.questionStartedAtEpochMs,
    questionDeadlineEpochMs: snapshot.questionDeadlineEpochMs,
    questionClosedAtEpochMs: snapshot.questionClosedAtEpochMs,
    closeReason: snapshot.closeReason,
    hasPendingRound: snapshot.hasPendingRound,
    qualificationComplete: snapshot.qualificationComplete,
    resultsAnnounced: snapshot.resultsAnnounced,
    stationReadiness: snapshot.stationReadiness,
    answerStatus: snapshot.answerStatus,
    revealResults: revealingAnswer ? snapshot.revealResults : null,
    roundTotals: snapshot.roundTotals,
  };
}
