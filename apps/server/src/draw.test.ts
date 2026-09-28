import assert from "node:assert/strict";
import test from "node:test";
import { generateQualificationRounds } from "./draw.js";

function firstIndex(upperExclusive: number): number {
  return upperExclusive > 0 ? 0 : 0;
}

test("even draw includes every college exactly once with no solo round", () => {
  const rounds = generateQualificationRounds(
    [1, 2, 3, 4, 5, 6],
    firstIndex,
  );

  assert.equal(rounds.length, 3);
  assert.equal(rounds.filter((round) => round.collegeBId === null).length, 0);

  const allCollegeIds = rounds
    .flatMap((round) => [round.collegeAId, round.collegeBId])
    .filter((id): id is number => id !== null)
    .sort((a, b) => a - b);

  assert.deepEqual(allCollegeIds, [1, 2, 3, 4, 5, 6]);
});

test("odd draw includes exactly one randomly positioned solo round", () => {
  const rounds = generateQualificationRounds(
    [1, 2, 3, 4, 5],
    firstIndex,
  );

  assert.equal(rounds.length, 3);
  assert.equal(rounds.filter((round) => round.collegeBId === null).length, 1);

  const allCollegeIds = rounds
    .flatMap((round) => [round.collegeAId, round.collegeBId])
    .filter((id): id is number => id !== null)
    .sort((a, b) => a - b);

  assert.deepEqual(allCollegeIds, [1, 2, 3, 4, 5]);
  assert.deepEqual(
    rounds.map((round) => round.order),
    [1, 2, 3],
  );
});

test("draw rejects duplicate college IDs", () => {
  assert.throws(
    () => generateQualificationRounds([1, 1], firstIndex),
    /unique/,
  );
});

test("draw rejects fewer than two colleges", () => {
  assert.throws(
    () => generateQualificationRounds([1], firstIndex),
    /At least two colleges/,
  );
});
