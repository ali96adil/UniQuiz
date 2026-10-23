import type { AppDatabase } from "./database.js";

export interface CategoryQuota {
  categoryKey: string;
  questions: number;
}

export interface CompetitionRules {
  questionsPerRound: number;
  categories: CategoryQuota[];
}

// Existing official competitions use 2 questions from each of the original
// five categories. An explicit rules row overrides this legacy default.
export function getCompetitionRules(db: AppDatabase): CompetitionRules {
  const row = db.prepare(
    "SELECT distribution_json AS distributionJson FROM competition_rules WHERE id = 1",
  ).get() as { distributionJson: string | null } | undefined;
  if (row?.distributionJson) {
    const categories = JSON.parse(row.distributionJson) as CategoryQuota[];
    return {
      categories,
      questionsPerRound: categories.reduce((total, category) => total + category.questions, 0),
    };
  }

  const oldCategories = db.prepare(
    "SELECT category_key AS categoryKey FROM categories ORDER BY sort_order, id LIMIT 5",
  ).all() as Array<{ categoryKey: string }>;
  return {
    questionsPerRound: 10,
    categories: oldCategories.map(({ categoryKey }) => ({ categoryKey, questions: 2 })),
  };
}

export interface RoundRules extends CompetitionRules {
  roundId: number;
  customized: boolean;
}

export function getRoundRules(db: AppDatabase, roundId: number): RoundRules {
  const override = db.prepare(
    "SELECT distribution_json AS distributionJson FROM qualification_round_rules WHERE round_id = ?",
  ).get(roundId) as { distributionJson: string } | undefined;
  const defaultRules = getCompetitionRules(db);
  const categories = override
    ? JSON.parse(override.distributionJson) as CategoryQuota[]
    : defaultRules.categories;
  return {
    roundId,
    customized: Boolean(override),
    categories,
    questionsPerRound: categories.reduce((sum, item) => sum + item.questions, 0),
  };
}

export function getAllRoundRules(db: AppDatabase): RoundRules[] {
  const rounds = db.prepare(
    "SELECT id FROM qualification_rounds ORDER BY round_order",
  ).all() as Array<{ id: number }>;
  return rounds.map((round) => getRoundRules(db, round.id));
}
