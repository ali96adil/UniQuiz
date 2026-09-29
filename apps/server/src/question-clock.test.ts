import assert from "node:assert/strict";
import test from "node:test";
import {
  QUESTION_DURATION_MS,
  ServerQuestionClock,
} from "./question-clock.js";

test("question clock starts at 30 seconds and uses monotonic time", () => {
  let nowNs = 5_000_000_000n;
  let wallMs = 1_800_000_000_000;

  const clock = new ServerQuestionClock(
    () => nowNs,
    () => wallMs,
  );

  const started = clock.start("round-1:q1");
  assert.equal(started.elapsedMs, 0);
  assert.equal(started.remainingMs, QUESTION_DURATION_MS);
  assert.equal(started.expired, false);
  assert.equal(started.startedAtEpochMs, wallMs);

  nowNs += 5_000_000_000n;
  wallMs += 999_999_999;

  const afterFiveSeconds = clock.snapshot();
  assert.equal(afterFiveSeconds.elapsedMs, 5000);
  assert.equal(afterFiveSeconds.remainingMs, 25000);
  assert.equal(afterFiveSeconds.expired, false);
});

test("question clock expires at exactly 30 seconds", () => {
  let nowNs = 0n;

  const clock = new ServerQuestionClock(
    () => nowNs,
    () => 1234,
  );

  clock.start("round-1:q1");
  nowNs = 30_000_000_000n;

  const snapshot = clock.snapshot();
  assert.equal(snapshot.elapsedMs, 30000);
  assert.equal(snapshot.remainingMs, 0);
  assert.equal(snapshot.expired, true);
});

test("question clock rejects concurrent starts and can close", () => {
  let nowNs = 0n;
  const clock = new ServerQuestionClock(
    () => nowNs,
    () => 1234,
  );

  clock.start("round-1:q1");

  assert.throws(
    () => clock.start("round-1:q2"),
    /already active/,
  );

  nowNs = 12_345_000_000n;
  const closed = clock.close();

  assert.equal(closed.elapsedMs, 12345);
  assert.equal(clock.isActive(), false);
});
