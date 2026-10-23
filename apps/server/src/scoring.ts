import type { CompetitionGameplayRules } from "./competition-gameplay.js";
import { DEFAULT_GAMEPLAY_RULES } from "./competition-gameplay.js";
export const SCORE_MICROS_PER_POINT = 1_000_000;
export const MAX_SCORE_POINTS = 25;
export const MAX_SCORE_MICROS =
  MAX_SCORE_POINTS * SCORE_MICROS_PER_POINT;
export const MIN_CORRECT_SCORE_MICROS =
  1 * SCORE_MICROS_PER_POINT;

export const QUESTION_DEADLINE_MS = 25_000;

export function calculateScoreMicros(
  correct: boolean,
  responseTimeMs: number | null,
  rules: CompetitionGameplayRules = DEFAULT_GAMEPLAY_RULES,
): number {
  if (!correct || responseTimeMs === null) {
    return 0;
  }

  if (
    !Number.isInteger(responseTimeMs) ||
    responseTimeMs < 0
  ) {
    throw new Error("responseTimeMs must be a non-negative integer.");
  }

  if (responseTimeMs >= rules.durationSeconds * 1000) {
    return 0;
  }

  if (rules.scoringMode === "fixed") {
    return rules.correctPoints * SCORE_MICROS_PER_POINT;
  }

  // The first 999 ms receive full credit, as in the original competition.
  const elapsedWholeSeconds = Math.floor(responseTimeMs / 1000);
  const scorePoints = Math.max(
    1,
    rules.correctPoints - elapsedWholeSeconds * rules.pointsLostPerSecond,
  );
  return scorePoints * SCORE_MICROS_PER_POINT;
}

export function scoreMicrosToPoints(scoreMicros: number): number {
  return scoreMicros / SCORE_MICROS_PER_POINT;
}
