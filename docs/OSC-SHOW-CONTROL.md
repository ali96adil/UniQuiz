# OSC Show Control

UniQuiz emits OSC over UDP from the authoritative Mac server. OSC is **show control only**: delivery failure never changes competition state, timing, submissions, scoring, ranking, draw state, or final results.

## Configuration

Set environment variables before starting the server:

```bash
export UNIQUIZ_OSC_ENABLED=true
export UNIQUIZ_OSC_HOST=127.0.0.1
export UNIQUIZ_OSC_PORT=9001
pnpm dev
```

For Ableton running on the same Mac, keep the host at `127.0.0.1`. The port must match the Max for Live / OSC receiver.

## Messages

Numeric arguments are OSC int32 values.

| Address | Arguments | Meaning |
| --- | --- | --- |
| `/uniquiz/system/test` | ISO timestamp | Preflight test cue |
| `/uniquiz/draw/start` | `round_count` | Animated draw presentation started |
| `/uniquiz/draw/complete` | `round_count` | Animated draw presentation finished |
| `/uniquiz/round/start` | `round_order` | Operator started the round |
| `/uniquiz/question/countdown` | `round_order, question_position, value` | Prestart cue; value is 3, 2, then 1 |
| `/uniquiz/question/start` | `round_order, question_position, duration_ms` | Question became visible and the official 25-second timing started |
| `/uniquiz/question/answered` | `round_order, question_position, reason` | All required stations answered |
| `/uniquiz/question/timeout` | `round_order, question_position` | Official 25-second answer window expired |
| `/uniquiz/question/closed` | `round_order, question_position, reason` | Question closed for any reason |
| `/uniquiz/question/reveal` | `round_order, question_position` | Result/reveal became visible |
| `/uniquiz/question/emergency_hold` | `round_order, question_position, phase` | Emergency hold was triggered |
| `/uniquiz/question/recovery_required` | state-dependent | Restart recovery requires operator action |
| `/uniquiz/intermission` | `round_order, question_position` | Operator entered Hold/Intermission |
| `/uniquiz/round/complete` | `round_order` | Operator completed the round |
| `/uniquiz/results/final` | `round_order` | Final ranking became available after the last round |
| `/uniquiz/awards/start` | none | Operator manually started the awards announcement |

## Ableton scene mapping

```text
0  ROUND START
1  COUNTDOWN
2  QUESTION
3  ANSWERED
4  TIMEOUT
5  REVEAL
6  BREAK
7  ROUND END
8  DRAW
9  DRAW END
10 FINAL RESULTS
11 AWARDS
```

For `/uniquiz/question/countdown`, launch the COUNTDOWN scene only when the third argument is `3`; the later `2` and `1` packets are timing cues and should not relaunch the scene.

The QUESTION scene begins on `/uniquiz/question/start`. Stop or transition it on `/uniquiz/question/answered` or `/uniquiz/question/timeout`.

The final-results cue is automatic when the last round is completed. The awards cue is intentionally manual from Operator so music does not start until the presenter is ready.

## Automatic reveal delay

When all required stations answer, or when the 25-second window expires, UniQuiz closes the question and automatically reveals the result after **1.5 seconds**. The reveal emits `/uniquiz/question/reveal`.
