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
