import assert from "node:assert/strict";
import test from "node:test";
import { allocateQualificationQuestions } from "./allocation.js";

function firstIndex(): number {
  return 0;
}

function pool(categoryId: number, start: number, count: number) {
  return {
    categoryId,
    questionIds: Array.from({ length: count }, (_, index) => start + index),
  };
}

test("allocates 10 unique questions per round with 2 from each category", () => {
  const allocation = allocateQualificationQuestions(
    [101, 102, 103],
    [
      pool(1, 1000, 6),
      pool(2, 2000, 6),
      pool(3, 3000, 6),
      pool(4, 4000, 6),
      pool(5, 5000, 6),
    ],
    firstIndex,
  );

  assert.equal(allocation.length, 3);

  const allQuestionIds: number[] = [];

  for (const round of allocation) {
    assert.equal(round.questions.length, 10);
    assert.deepEqual(
      round.questions.map((question) => question.position).sort((a, b) => a - b),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    );

    const categoryCounts = new Map<number, number>();
    for (const question of round.questions) {
      categoryCounts.set(
        question.categoryId,
        (categoryCounts.get(question.categoryId) ?? 0) + 1,
      );
      allQuestionIds.push(question.questionId);
    }

    assert.deepEqual(
      [...categoryCounts.values()].sort((a, b) => a - b),
      [2, 2, 2, 2, 2],
    );
  }

  assert.equal(allQuestionIds.length, 30);
  assert.equal(new Set(allQuestionIds).size, 30);
});

test("rejects insufficient question inventory", () => {
  assert.throws(
    () =>
      allocateQualificationQuestions(
        [101, 102, 103],
        [
          pool(1, 1000, 5),
          pool(2, 2000, 6),
          pool(3, 3000, 6),
          pool(4, 4000, 6),
          pool(5, 5000, 6),
        ],
        firstIndex,
      ),
    /needs 6 questions but has 5/,
  );
});

test("requires exactly five categories", () => {
  assert.throws(
    () =>
      allocateQualificationQuestions(
        [101],
        [
          pool(1, 1000, 2),
          pool(2, 2000, 2),
          pool(3, 3000, 2),
          pool(4, 4000, 2),
        ],
        firstIndex,
      ),
    /Exactly five categories/,
  );
});
