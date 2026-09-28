import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateScoreMicros,
  scoreMicrosToPoints,
} from "./scoring.js";

test("correct answers at or before 5 seconds receive 10 points", () => {
  assert.equal(scoreMicrosToPoints(calculateScoreMicros(true, 0)), 10);
  assert.equal(scoreMicrosToPoints(calculateScoreMicros(true, 5000)), 10);
});

test("score decreases linearly after 5 seconds", () => {
  assert.equal(
    scoreMicrosToPoints(calculateScoreMicros(true, 5001)),
    9.999775,
  );
  assert.equal(
    scoreMicrosToPoints(calculateScoreMicros(true, 25000)),
    5.5,
  );
});

test("correct answer at exactly 45 seconds receives 1 point", () => {
  assert.equal(
    scoreMicrosToPoints(calculateScoreMicros(true, 45000)),
    1,
  );
});

test("wrong, unanswered and late answers receive zero", () => {
  assert.equal(calculateScoreMicros(false, 1000), 0);
  assert.equal(calculateScoreMicros(false, 45000), 0);
  assert.equal(calculateScoreMicros(true, null), 0);
  assert.equal(calculateScoreMicros(true, 45001), 0);
});

test("invalid response times are rejected", () => {
  assert.throws(
    () => calculateScoreMicros(true, -1),
    /non-negative integer/,
  );
  assert.throws(
    () => calculateScoreMicros(true, 10.5),
    /non-negative integer/,
  );
});
