export type RandomIndex = (upperExclusive: number) => number;

export interface GeneratedRound {
  order: number;
  collegeAId: number;
  collegeBId: number | null;
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

export function shuffleCollegeIds(
  collegeIds: readonly number[],
  randomIndex: RandomIndex,
): number[] {
  const shuffled = [...collegeIds];

  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = checkedIndex(randomIndex, index + 1);
    [shuffled[index], shuffled[swapIndex]] = [
      shuffled[swapIndex],
      shuffled[index],
    ];
  }

  return shuffled;
}

export function generateQualificationRounds(
  collegeIds: readonly number[],
  randomIndex: RandomIndex,
): GeneratedRound[] {
  if (collegeIds.length < 2) {
    throw new Error("At least two colleges are required for the draw.");
  }

  if (new Set(collegeIds).size !== collegeIds.length) {
    throw new Error("College IDs must be unique.");
  }

  const shuffled = shuffleCollegeIds(collegeIds, randomIndex);
  const soloCollegeId =
    shuffled.length % 2 === 1 ? shuffled.pop() ?? null : null;

  const rounds: Omit<GeneratedRound, "order">[] = [];

  for (let index = 0; index < shuffled.length; index += 2) {
    const collegeAId = shuffled[index];
    const collegeBId = shuffled[index + 1];

    if (collegeAId === undefined || collegeBId === undefined) {
      throw new Error("Invalid paired draw state.");
    }

    rounds.push({
      collegeAId,
      collegeBId,
    });
  }

  if (soloCollegeId !== null) {
    const soloPosition = checkedIndex(randomIndex, rounds.length + 1);
    rounds.splice(soloPosition, 0, {
      collegeAId: soloCollegeId,
      collegeBId: null,
    });
  }

  return rounds.map((round, index) => ({
    order: index + 1,
    ...round,
  }));
}
