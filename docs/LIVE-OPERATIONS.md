# Live Operations and Safety Requirements

These requirements are mandatory for live-event reliability.

## Station Ready Check
Before a round can start, the Operator must see readiness for:
- Display
- Team A
- Team B when the round has two teams
- OSC output when OSC is enabled

Normal start should require required stations to be ready. An explicit operator override may exist for emergencies and must be audited.

## Question Void and Replacement
The Operator can void a question when it is invalid or a technical incident makes it unfair.

Voiding a question:
- removes its score contribution;
- records the reason and operator action;
- does not silently delete the original event history;
- requires a replacement question from the same category;
- preserves the rule of exactly two scored questions per category.

A void action must require confirmation.

## Emergency Hold
Normal flow only pauses between questions or rounds.

If a live question needs emergency intervention:
- the action must be explicit;
- the reason must be recorded;
- any timer/score consequence must be visible to the operator;
- no silent timer manipulation is allowed.

## Recovery
Authoritative state is persisted frequently enough to recover after:
- browser refresh;
- browser restart;
- server restart;
- temporary station disconnect.

Recovery must restore the current round/question state without advancing it.

## Audit Log
Record at minimum:
- round start/end;
- question prepared/start/close/reveal;
- server timestamps;
- submitted option;
- response time;
- correctness;
- awarded points;
- timeout;
- void/replacement;
- manual override;
- operator identity/session where available.

## Preflight
Provide a pre-event check for:
- server
- database
- audience display
- Team A
- Team B
- OSC when enabled
- question-bank validity
- generated rounds
- backup availability

The operator should receive a clear READY / NOT READY summary.

## Rehearsal Mode
A rehearsal mode uses non-official data/results and cannot contaminate official competition rankings.

### Isolated rehearsal database
Run rehearsal with:

```bash
pnpm dev:rehearsal
```

Rehearsal defaults to `data/uniquiz-rehearsal.db`, while official mode defaults to `data/uniquiz.db`. The two modes therefore cannot contaminate each other's rankings, submissions, draw, questions or audit history unless an operator explicitly overrides `UNIQUIZ_DB_PATH`.

Every connected browser receives the authoritative runtime mode from the server and shows a persistent **REHEARSAL · تدريب** banner when rehearsal mode is active.

Backup/list/restore commands also have rehearsal variants:
```bash
pnpm ops:backup:rehearsal
pnpm ops:backups:rehearsal
pnpm ops:restore:rehearsal -- /path/to/backup.db
```

It should exercise:
- station connectivity;
- countdown;
- answer submission;
- reveal;
- ranking;
- OSC;
- audience display;
- recovery.

## Intermission / Announcement Scenes
The operator can put the audience display into manual presentation scenes such as:
- short break;
- please wait;
- next round;
- prepare teams;
- final results soon;
- custom announcement.

These presentation states must not mutate competition scoring/state.

## Hotkeys
Operator hotkeys are available but remain **OFF by default for every browser session**.

### Implemented operator hotkeys
- `Alt+N` — context-aware next action; during an active/intermission/revealed round it starts the next question directly with the 3-2-1 countdown.
- `Alt+S` — start round or question; requires confirmation.
- `Alt+R` — Reveal when manual Reveal is allowed; requires confirmation.
- `Alt+H` — Emergency Hold; still requires a reason and confirmation.
- `Alt+V` — VOID + same-category replacement; still requires a reason and confirmation.
- `Alt+C` — complete the round after question 10 Reveal; requires confirmation.

Hotkeys do not fire while focus is in an input, textarea, select, or editable field. They are intentionally session-only and do not persist as enabled after reopening the page.

## OSC Reliability
OSC is show-control output only. OSC failure never changes official state.

Critical show cues may include an event sequence identifier to help downstream systems ignore duplicate or stale messages.
