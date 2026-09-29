import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateScoreMicros,
  scoreMicrosToPoints,
} from "./scoring.js";

test("25-second scoring drops by one point for each elapsed whole second", () => {
  assert.equal(scoreMicrosToPoints(calculateScoreMicros(true, 0)), 25);
  assert.equal(scoreMicrosToPoints(calculateScoreMicros(true, 999)), 25);
  assert.equal(scoreMicrosToPoints(calculateScoreMicros(true, 1000)), 24);
  assert.equal(scoreMicrosToPoints(calculateScoreMicros(true, 1999)), 24);
  assert.equal(scoreMicrosToPoints(calculateScoreMicros(true, 10_000)), 15);
  assert.equal(scoreMicrosToPoints(calculateScoreMicros(true, 24_000)), 1);
  assert.equal(scoreMicrosToPoints(calculateScoreMicros(true, 24_999)), 1);
});

test("at 25 seconds the question is expired and scores zero", () => {
  assert.equal(calculateScoreMicros(true, 25_000), 0);
  assert.equal(calculateScoreMicros(true, 25_001), 0);
});

test("wrong and unanswered responses receive zero", () => {
  assert.equal(calculateScoreMicros(false, 1000), 0);
  assert.equal(calculateScoreMicros(false, 24_999), 0);
  assert.equal(calculateScoreMicros(true, null), 0);
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
