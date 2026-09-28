export type RandomIndex = (upperExclusive: number) => number;

export interface CategoryQuestionPool {
  categoryId: number;
  questionIds: number[];
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

  if (categoryPools.length !== 5) {
    throw new Error("Exactly five categories are required.");
  }

  const requiredPerCategory = roundIds.length * 2;
  const preparedPools = categoryPools.map((pool) => {
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
      questionIds: shuffled(pool.questionIds, randomIndex).slice(
        0,
        requiredPerCategory,
      ),
    };
  });

  const allocatedQuestionIds = new Set<number>();

  return roundIds.map((roundId, roundIndex) => {
    const roundQuestions = preparedPools.flatMap((pool) => {
      const start = roundIndex * 2;
      return pool.questionIds.slice(start, start + 2).map((questionId) => ({
        questionId,
        categoryId: pool.categoryId,
      }));
    });

    if (roundQuestions.length !== 10) {
      throw new Error(
        `Round ${roundId} did not receive exactly 10 questions.`,
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
