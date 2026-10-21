import assert from "node:assert/strict";
import test from "node:test";
import { allocateRoundsByPlan } from "./allocation.js";
test("ascending difficulty keeps all distinct questions while sorting within every round", () => {
  const difficulty = new Map<number, number>();
  const ids = Array.from({length: 20}, (_, i) => i + 1);
  ids.forEach((id, i) => difficulty.set(id, (i % 5) + 1));
  const rounds = allocateRoundsByPlan(
    [{roundId:1,categories:[{categoryId:1,questions:5}]},{roundId:2,categories:[{categoryId:1,questions:7}]}],
    [{categoryId:1,questionIds:ids}],()=>0,
    {difficultyMode:"ascending",difficultyByQuestion:difficulty},
  );
  assert.equal(new Set(rounds.flatMap(r=>r.questions.map(q=>q.questionId))).size,12);
  for(const round of rounds){
    const values=round.questions.map(q=>difficulty.get(q.questionId)!);
    assert.deepEqual(values,[...values].sort((a,b)=>a-b));
    assert.deepEqual(round.questions.map(q=>q.position),Array.from({length:round.questions.length},(_,i)=>i+1));
  }
});
test("ascending fails closed when a question has no difficulty metadata", () => {
  assert.throws(() => allocateRoundsByPlan(
    [{roundId:1,categories:[{categoryId:2,questions:1}]}],
    [{categoryId:2,questionIds:[30]}],()=>0,{difficultyMode:"ascending",difficultyByQuestion:new Map()},
  ),/QUESTION_DIFFICULTY_METADATA_MISSING/);
});
