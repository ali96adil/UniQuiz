export const SCORE_MICROS_PER_POINT = 1_000_000;
export const MAX_SCORE_MICROS = 10 * SCORE_MICROS_PER_POINT;
export const MIN_CORRECT_SCORE_MICROS = 1 * SCORE_MICROS_PER_POINT;

const FULL_SCORE_WINDOW_MS = 5_000;
const QUESTION_DEADLINE_MS = 45_000;

// Between 5s and 45s, 9 points are lost over 40,000ms.
// 9,000,000 micro-points / 40,000ms = 225 micro-points per millisecond.
const SCORE_DECAY_MICROS_PER_MS = 225;

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

  if (responseTimeMs > QUESTION_DEADLINE_MS) {
    return 0;
  }

  if (responseTimeMs <= FULL_SCORE_WINDOW_MS) {
    return MAX_SCORE_MICROS;
  }

  return (
    MAX_SCORE_MICROS -
    (responseTimeMs - FULL_SCORE_WINDOW_MS) *
      SCORE_DECAY_MICROS_PER_MS
  );
}

export function scoreMicrosToPoints(scoreMicros: number): number {
  return scoreMicros / SCORE_MICROS_PER_POINT;
}
