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

test("ascending sampling spans difficulty levels instead of sorting an all-hard random slice", () => {
  const ids=Array.from({length:25},(_,i)=>i+1);
  const grades=new Map(ids.map(id=>[id,Math.ceil(id/5)]));
  const rounds=allocateRoundsByPlan(
    [{roundId:100,categories:[{categoryId:1,questions:5}]}],
    [{categoryId:1,questionIds:ids}],()=>0,
    {difficultyMode:"ascending",difficultyByQuestion:grades});
  assert.deepEqual(rounds[0]!.questions.map(q=>grades.get(q.questionId)),[1,2,3,4,5]);
});
test("ascending selects across multiple categories without reusing questions in later rounds", () => {
  const categories=[1,2,3].map(categoryId=>({categoryId,questionIds:Array.from({length:categoryId===1?40:20},(_,i)=>categoryId*100+i+1)}));
  const grades=new Map(categories.flatMap(p=>p.questionIds.map((id,i)=>[id,(i%5)+1] as [number,number])));
  const allocation=allocateRoundsByPlan(
    [5,12,20].map((size,i)=>({roundId:i+1,categories:[{categoryId:1,questions:size},{categoryId:2,questions:2},{categoryId:3,questions:1}]})),
    categories,()=>0,{difficultyMode:"ascending",difficultyByQuestion:grades});
  assert.equal(allocation.length,3);
  assert.equal(new Set(allocation.flatMap(r=>r.questions.map(q=>q.questionId))).size,46);
  for(const r of allocation) {
    const sorted=r.questions.map(q=>grades.get(q.questionId)!);
    assert.deepEqual(sorted,[...sorted].sort((a,b)=>a-b));
  }
});
