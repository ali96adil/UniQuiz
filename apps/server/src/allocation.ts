export type RandomIndex = (upperExclusive: number) => number;

export interface CategoryQuestionPool {
  categoryId: number;
  questionIds: number[];
  questionsPerRound?: number;
}

export interface AllocatedQuestion {
  questionId: number;
  categoryId: number;
  position: number;
}

export interface AllocatedRound {
  roundId: number;
  questions: AllocatedQuestion[];
}

function checkedIndex(
  randomIndex: RandomIndex,
  upperExclusive: number,
): number {
  const index = randomIndex(upperExclusive);

  if (
    !Number.isInteger(index) ||
    index < 0 ||
    index >= upperExclusive
  ) {
    throw new Error(
      `Random index ${index} is outside 0..${upperExclusive - 1}`,
    );
  }

  return index;
}

function shuffled<T>(
  values: readonly T[],
  randomIndex: RandomIndex,
): T[] {
  const output = [...values];

  for (let index = output.length - 1; index > 0; index -= 1) {
    const swapIndex = checkedIndex(randomIndex, index + 1);
    [output[index], output[swapIndex]] = [
      output[swapIndex],
      output[index],
    ];
  }

  return output;
}

export function allocateQualificationQuestions(
  roundIds: readonly number[],
  categoryPools: readonly CategoryQuestionPool[],
  randomIndex: RandomIndex,
): AllocatedRound[] {
  if (roundIds.length === 0) {
    throw new Error("At least one qualification round is required.");
  }

  if (categoryPools.length === 0) {
    throw new Error("At least one category quota is required.");
  }
  if (categoryPools.every((pool) => pool.questionsPerRound === undefined) && categoryPools.length !== 5) {
    throw new Error("Exactly five categories are required.");
  }

  const plannedQuestions = categoryPools.reduce((sum, pool) => sum + (pool.questionsPerRound ?? 2), 0);
  if (plannedQuestions < 1 || plannedQuestions > 100) throw new Error("Round question count must be 1..100.");
  const preparedPools = categoryPools.map((pool) => {
    const quota = pool.questionsPerRound ?? 2;
    if (!Number.isInteger(quota) || quota < 1) throw new Error("Invalid category quota.");
    const requiredPerCategory = roundIds.length * quota;
    if (pool.questionIds.length < requiredPerCategory) {
      throw new Error(
        `Category ${pool.categoryId} needs ${requiredPerCategory} questions but has ${pool.questionIds.length}.`,
      );
    }

    if (new Set(pool.questionIds).size !== pool.questionIds.length) {
      throw new Error(
        `Category ${pool.categoryId} contains duplicate question IDs.`,
      );
    }

    return {
      categoryId: pool.categoryId,
      quota,
      questionIds: shuffled(pool.questionIds, randomIndex).slice(
        0,
        requiredPerCategory,
      ),
    };
  });

  const allocatedQuestionIds = new Set<number>();

  return roundIds.map((roundId, roundIndex) => {
    const roundQuestions = preparedPools.flatMap((pool) => {
      const start = roundIndex * pool.quota;
      return pool.questionIds.slice(start, start + pool.quota).map((questionId) => ({
        questionId,
        categoryId: pool.categoryId,
      }));
    });

    if (roundQuestions.length !== plannedQuestions) {
      throw new Error(
        `Round ${roundId} did not receive exactly ${plannedQuestions} questions.`,
      );
    }

    for (const question of roundQuestions) {
      if (allocatedQuestionIds.has(question.questionId)) {
        throw new Error(
          `Question ${question.questionId} was allocated more than once.`,
        );
      }
      allocatedQuestionIds.add(question.questionId);
    }

    return {
      roundId,
      questions: shuffled(roundQuestions, randomIndex).map(
        (question, index) => ({
          ...question,
          position: index + 1,
        }),
      ),
    };
  });
}

/**
 * Allocate independently configured rounds from a shared pool of unused
 * questions. A category may appear in some rounds but not others.
 */
export function allocateRoundsByPlan(
  plans: readonly Array<{ roundId: number; categories: readonly Array<{ categoryId: number; questions: number }> }>,
  categoryPools: readonly CategoryQuestionPool[],
  randomIndex: RandomIndex,
): AllocatedRound[] {
  if (plans.length === 0) throw new Error("At least one qualification round is required.");
  if (new Set(plans.map((plan) => plan.roundId)).size !== plans.length) {
    throw new Error("Duplicate round IDs.");
  }
  const requirements = new Map<number, number>();
  for (const plan of plans) {
    const total = plan.categories.reduce((sum, quota) => sum + quota.questions, 0);
    if (!Number.isSafeInteger(total) || total < 1 || total > 100) {
      throw new Error("Round question count must be 1..100.");
    }
    if (new Set(plan.categories.map((quota) => quota.categoryId)).size !== plan.categories.length) {
      throw new Error("Duplicate category in round plan.");
    }
    for (const quota of plan.categories) {
      if (!Number.isSafeInteger(quota.questions) || quota.questions < 1) {
        throw new Error("Invalid category quota.");
      }
      requirements.set(quota.categoryId, (requirements.get(quota.categoryId) ?? 0) + quota.questions);
    }
  }
  const inventory = new Map<number, { ids: number[]; offset: number }>();
  const allIds = new Set<number>();
  for (const pool of categoryPools) {
    if (inventory.has(pool.categoryId)) throw new Error("Duplicate category inventory.");
    for (const id of pool.questionIds) {
      if (allIds.has(id)) throw new Error("Question ID appears in multiple categories.");
      allIds.add(id);
    }
    const required = requirements.get(pool.categoryId) ?? 0;
    if (new Set(pool.questionIds).size !== pool.questionIds.length) {
      throw new Error(`Category ${pool.categoryId} contains duplicate question IDs.`);
    }
    if (pool.questionIds.length < required) {
      throw new Error(`Category ${pool.categoryId} needs ${required} questions but has ${pool.questionIds.length}.`);
    }
    inventory.set(pool.categoryId, {
      ids: shuffled(pool.questionIds, randomIndex),
      offset: 0,
    });
  }
  for (const [categoryId] of requirements) {
    if (!inventory.has(categoryId)) throw new Error(`Missing question inventory for category ${categoryId}.`);
  }

  return plans.map((plan) => {
    const questions: Array<{ questionId: number; categoryId: number }> = [];
    for (const quota of plan.categories) {
      const pool = inventory.get(quota.categoryId)!;
      for (const questionId of pool.ids.slice(pool.offset, pool.offset + quota.questions)) {
        questions.push({ questionId, categoryId: quota.categoryId });
      }
      pool.offset += quota.questions;
    }
    return {
      roundId: plan.roundId,
      questions: shuffled(questions, randomIndex).map((question, index) => ({
        ...question,
        position: index + 1,
      })),
    };
  });
}
