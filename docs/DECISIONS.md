# Architecture Decision Log

## D-001 — Single repository
Decision: Use one monorepo for server, web client and shared contracts.

Reason: All runtime surfaces are one tightly-coupled product and share realtime contracts and scoring rules.

## D-002 — Mac is authoritative
Decision: The Mac server owns competition state, timers, answer acceptance, scoring, ranking and audit records.

Reason: Client clocks and browser state must never determine official results.

## D-003 — Browser-only team stations
Decision: Team Windows PCs use a browser and require no installed custom application.

Reason: Faster setup and fewer event-day deployment failures.

## D-004 — Qualification is ranking-based
Decision: Qualification sessions collect points; they do not eliminate a losing college.

Reason: Final qualification is based on the overall ranking.

## D-005 — Odd participant count supports solo session
Decision: A single college may complete a session alone under identical timing and scoring rules.

## D-006 — No question difficulty field
Decision: All official questions are treated as the same difficulty level.

## D-007 — Session question composition
Decision: Every qualification session contains 10 unique questions across 5 categories, exactly 2 questions per category.

## D-008 — Speed-weighted scoring
Decision: A correct answer at or before 5 seconds earns 10 points. From 5 to 45 seconds, the score decreases linearly to 1 point. Wrong and unanswered responses earn 0.

## D-009 — Reveal before ranking update
Decision: Official answer, correctness, response time and awarded points are revealed after question closure. Ranking is then recalculated and published.

Reason: Transparency without leaking correctness while another team can still answer.

## D-010 — Real question data stays out of Git
Decision: Git contains schemas and samples only. Real competition questions and answers remain local runtime data.

## D-011 — Operator controls progression
Decision: Sessions and questions never advance automatically. The operator explicitly prepares/starts every session and every question. The 45-second countdown is the only automatic progression inside an active question.

Reason: Live events may require pauses, announcements, technical checks or unscheduled breaks.

## D-012 — Next session can follow draw order or be manually selected
Decision: The default next session is the next unplayed session in the official draw order. The operator may instead manually select any unplayed session.

Reason: The draw determines the official session list/order, but live-event operations may require a different running order. Manual selection does not alter the saved draw result.

## D-013 — Server-originated OSC cues
Decision: UniQuiz emits optional OSC/UDP cues directly from the authoritative server for show-control integration such as Ableton Live.

Initial cue set:
- `/uniquiz/session/ready`
- `/uniquiz/session/start`
- `/uniquiz/question/ready`
- `/uniquiz/question/start`
- `/uniquiz/team/a/answered`
- `/uniquiz/team/b/answered`
- `/uniquiz/question/all_answered`
- `/uniquiz/question/timeout`
- `/uniquiz/question/closed`
- `/uniquiz/question/reveal`
- `/uniquiz/session/complete`

OSC is best-effort show control only. Failure to deliver an OSC packet must never change official competition state, timing, scoring or results.

The target host/port and OSC enable state are configurable. No fixed port is part of the competition protocol.
