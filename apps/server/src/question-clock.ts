export const QUESTION_DURATION_MS = 25_000;

export interface QuestionClockSnapshot {
  questionKey: string;
  startedAtEpochMs: number;
  elapsedMs: number;
  remainingMs: number;
  expired: boolean;
}

type MonotonicNow = () => bigint;
type WallNow = () => number;

interface ActiveClock {
  questionKey: string;
  startedAtNs: bigint;
  startedAtEpochMs: number;
}

export class ServerQuestionClock {
  private active: ActiveClock | null = null;

  constructor(
    private readonly monotonicNow: MonotonicNow = process.hrtime.bigint,
    private readonly wallNow: WallNow = Date.now,
  ) {}

  start(questionKey: string): QuestionClockSnapshot {
    if (!questionKey.trim()) {
      throw new Error("questionKey is required.");
    }

    if (this.active) {
      throw new Error(
        `Question clock is already active for ${this.active.questionKey}.`,
      );
    }

    this.active = {
      questionKey,
      startedAtNs: this.monotonicNow(),
      startedAtEpochMs: this.wallNow(),
    };

    return this.snapshot();
  }

  snapshot(): QuestionClockSnapshot {
    if (!this.active) {
      throw new Error("Question clock is not active.");
    }

    const elapsedNs = this.monotonicNow() - this.active.startedAtNs;
    const elapsedMs = Math.max(
      0,
      Number(elapsedNs / 1_000_000n),
    );

    return {
      questionKey: this.active.questionKey,
      startedAtEpochMs: this.active.startedAtEpochMs,
      elapsedMs,
      remainingMs: Math.max(0, QUESTION_DURATION_MS - elapsedMs),
      expired: elapsedMs >= QUESTION_DURATION_MS,
    };
  }

  close(): QuestionClockSnapshot {
    const snapshot = this.snapshot();
    this.active = null;
    return snapshot;
  }

  clear(): void {
    this.active = null;
  }

  isActive(): boolean {
    return this.active !== null;
  }
}
