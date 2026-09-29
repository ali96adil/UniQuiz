import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateScoreMicros,
  scoreMicrosToPoints,
} from "./scoring.js";

test("timer 30 through 25 awards the 25-point maximum", () => {
  for (const responseTimeMs of [0, 1000, 4999, 5000, 5001, 5999]) {
    assert.equal(
      scoreMicrosToPoints(
        calculateScoreMicros(true, responseTimeMs),
      ),
      25,
    );
  }
});

test("after the 25-second display, points follow the displayed second", () => {
  assert.equal(
    scoreMicrosToPoints(calculateScoreMicros(true, 6000)),
    24,
  );
  assert.equal(
    scoreMicrosToPoints(calculateScoreMicros(true, 15000)),
    15,
  );
  assert.equal(
    scoreMicrosToPoints(calculateScoreMicros(true, 25000)),
    5,
  );
  assert.equal(
    scoreMicrosToPoints(calculateScoreMicros(true, 29000)),
    1,
  );
  assert.equal(
    scoreMicrosToPoints(calculateScoreMicros(true, 29999)),
    1,
  );
});

test("at 30 seconds the question is expired and scores zero", () => {
  assert.equal(calculateScoreMicros(true, 30000), 0);
  assert.equal(calculateScoreMicros(true, 30001), 0);
});

test("wrong and unanswered responses receive zero", () => {
  assert.equal(calculateScoreMicros(false, 1000), 0);
  assert.equal(calculateScoreMicros(false, 29999), 0);
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
