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
  plans: ReadonlyArray<{ roundId: number; categories: ReadonlyArray<{ categoryId: number; questions: number }> }>,
  categoryPools: readonly CategoryQuestionPool[],
  randomIndex: RandomIndex,
  options: { difficultyMode?: "random" | "ascending"; difficultyByQuestion?: ReadonlyMap<number, number> } = {},
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

  // In the legacy mode, preserve the original random selection and order
  // byte-for-byte. Only ascending mode uses difficulty-aware sampling.
  if (options.difficultyMode === "ascending") {
    const grades = options.difficultyByQuestion;
    if (!grades) throw new Error("QUESTION_DIFFICULTY_METADATA_MISSING");
    const pools = new Map<number, number[]>();
    for (const pool of categoryPools) {
      for (const questionId of pool.questionIds) {
        const level = grades.get(questionId);
        if (!Number.isInteger(level) || level! < 1 || level! > 5)
          throw new Error("QUESTION_DIFFICULTY_METADATA_MISSING");
      }
      pools.set(pool.categoryId, shuffled(pool.questionIds, randomIndex));
    }
    const assigned = new Set<number>();
    return plans.map((plan) => {
      // Spread category slots randomly across the rising target levels,
      // selecting available questions nearest each target. This samples
      // across levels *before* sorting, rather than selecting at random and
      // merely sorting a potentially all-hard sample afterwards.
      const slots = shuffled(plan.categories.flatMap((quota) =>
        Array.from({length:quota.questions}, () => quota.categoryId)), randomIndex);
      const questions: Array<{ questionId: number; categoryId: number }> = [];
      for (let index = 0; index < slots.length; index++) {
        const categoryId = slots[index]!;
        const candidates = pools.get(categoryId);
        if (!candidates || candidates.length === 0)
          throw new Error("INSUFFICIENT_QUESTION_INVENTORY");
        const target = slots.length === 1 ? 1 : 1 + Math.round(4 * index / (slots.length - 1));
        let best = 0;
        for (let i = 1; i < candidates.length; i++) {
          const left = grades.get(candidates[i]!)!;
          const right = grades.get(candidates[best]!)!;
          if (Math.abs(left - target) < Math.abs(right - target) ||
              (Math.abs(left - target) === Math.abs(right - target) && left < right)) best = i;
        }
        const [questionId] = candidates.splice(best, 1);
        if (questionId === undefined || assigned.has(questionId))
          throw new Error("DUPLICATE_QUESTION_ALLOCATION");
        assigned.add(questionId);
        questions.push({ questionId, categoryId });
      }
      const randomWithinGrade = shuffled(questions, randomIndex);
      randomWithinGrade.sort((a,b) => grades.get(a.questionId)! - grades.get(b.questionId)!);
      return { roundId: plan.roundId, questions: randomWithinGrade.map((question, index) =>
        ({...question, position: index+1})) };
    });
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
    const randomized = shuffled(questions, randomIndex);
    return {
      roundId: plan.roundId,
      questions: randomized.map((question, index) => ({
        ...question,
        position: index + 1,
      })),
    };
  });
}
