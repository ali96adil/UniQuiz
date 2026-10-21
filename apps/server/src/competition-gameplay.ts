import type { AppDatabase } from "./database.js";

export type ScoringMode = "time_decay" | "fixed";
export type DifficultyMode = "random" | "ascending";

export interface CompetitionGameplayRules {
  durationSeconds: number;
  scoringMode: ScoringMode;
  correctPoints: number;
  pointsLostPerSecond: number;
  difficultyMode?: DifficultyMode;
}

export const DEFAULT_GAMEPLAY_RULES: CompetitionGameplayRules = {
  durationSeconds: 25,
  scoringMode: "time_decay",
  correctPoints: 25,
  pointsLostPerSecond: 1,
  difficultyMode: "random",
};

export function getCompetitionGameplayRules(db: AppDatabase): CompetitionGameplayRules {
  const row = db.prepare(`
    SELECT
      duration_seconds AS durationSeconds,
      scoring_mode AS scoringMode,
      correct_points AS correctPoints,
      points_lost_per_second AS pointsLostPerSecond,
      difficulty_mode AS difficultyMode
    FROM competition_gameplay_rules WHERE id = 1
  `).get() as CompetitionGameplayRules | undefined;
  return row ?? DEFAULT_GAMEPLAY_RULES;
}

export function saveCompetitionGameplayRules(
  db: AppDatabase,
  rules: CompetitionGameplayRules,
): CompetitionGameplayRules {
  const locked = (db.prepare(
    "SELECT COUNT(*) AS count FROM qualification_rounds WHERE status <> 'PENDING'",
  ).get() as { count: number }).count;
  const submissions = (db.prepare(
    "SELECT COUNT(*) AS count FROM live_submissions",
  ).get() as { count: number }).count;
  const allocated = (db.prepare(
    "SELECT COUNT(*) AS count FROM qualification_round_question_sets",
  ).get() as { count: number }).count;
  const state = db.prepare("SELECT phase FROM live_state WHERE id = 1")
    .get() as { phase: string } | undefined;
  if (locked > 0 || submissions > 0 || allocated > 0 || (state?.phase !== "IDLE" && state?.phase !== undefined)) {
    throw new Error("GAMEPLAY_RULES_LOCKED");
  }
  db.prepare(`
    UPDATE competition_gameplay_rules SET
      duration_seconds = ?,
      scoring_mode = ?,
      correct_points = ?,
      points_lost_per_second = ?,
      difficulty_mode = ?
    WHERE id = 1
  `).run(rules.durationSeconds, rules.scoringMode, rules.correctPoints, rules.pointsLostPerSecond, rules.difficultyMode ?? "random");
  return getCompetitionGameplayRules(db);
}
