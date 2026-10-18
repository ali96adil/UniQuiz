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
