# OSC Show Control

UniQuiz can emit OSC over UDP from the authoritative Mac server. OSC is **show control only**: delivery failure never changes competition state, timing, submissions, scoring, or ranking.

## Configuration

Set environment variables before starting the server:

```bash
export UNIQUIZ_OSC_ENABLED=true
export UNIQUIZ_OSC_HOST=127.0.0.1
export UNIQUIZ_OSC_PORT=9001
pnpm dev
```

For Ableton running on the same Mac, keep the host at `127.0.0.1`. The port must match the OSC receiver used by Ableton / Max for Live.

## Messages

All numeric arguments are OSC int32 values.

| Address | Arguments | Meaning |
| --- | --- | --- |
| `/uniquiz/round/start` | `round_order` | Operator started the round |
| `/uniquiz/question/countdown` | `round_order, question_position, value` | Prestart cue; value is 3, 2, then 1 |
| `/uniquiz/question/start` | `round_order, question_position, duration_ms` | Question became visible and official 45s timing started |
| `/uniquiz/question/answered` | `round_order, question_position, reason` | All required stations answered; result auto-reveal is scheduled after this cue |
| `/uniquiz/question/timeout` | `round_order, question_position` | Official answer window expired |
| `/uniquiz/question/closed` | `round_order, question_position, reason` | Question closed for any reason |
| `/uniquiz/question/reveal` | `round_order, question_position` | Operator triggered Reveal |
| `/uniquiz/intermission` | `round_order, question_position` | Operator entered Hold/Intermission |
| `/uniquiz/round/complete` | `round_order` | Operator completed the round |

## Ableton mapping idea

Use the countdown cues for a short 3-2-1 sound sequence. Use `/uniquiz/question/start` to launch the 45-second question bed/timer cue. Stop or transition that cue on either `/uniquiz/question/answered` or `/uniquiz/question/timeout`. Use `/uniquiz/question/reveal` for the answer/reveal sting.

UniQuiz does not require Ableton to acknowledge any cue.


## Automatic reveal delay

When all required stations have answered, UniQuiz closes the question immediately and emits `/uniquiz/question/answered`. The result is then revealed automatically after **1.5 seconds**, at which point `/uniquiz/question/reveal` is emitted.

This prevents the correct answer from appearing while another required team can still answer. Timeout closure does **not** use this automatic answered-path reveal; the operator retains the explicit Reveal action for timeout cases.
