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

  if (responseTimeMs >= QUESTION_DEADLINE_MS) {
    return 0;
  }

  const remainingMs =
    QUESTION_DEADLINE_MS - responseTimeMs;
  const displayedRemainingSeconds = Math.ceil(
    remainingMs / 1000,
  );
  const scorePoints = Math.min(
    MAX_SCORE_POINTS,
    displayedRemainingSeconds,
  );

  return scorePoints * SCORE_MICROS_PER_POINT;
}

export function scoreMicrosToPoints(scoreMicros: number): number {
  return scoreMicros / SCORE_MICROS_PER_POINT;
}
