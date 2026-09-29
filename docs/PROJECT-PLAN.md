# UniQuiz Project Plan

This file defines the execution order. Work moves milestone-by-milestone. Do not start a later milestone unless its dependency is satisfied.

## M1 — Foundation & Local Runtime
Goal: one command starts a local server and web app on the Mac.

Deliverables:
- apps/server scaffold
- apps/web scaffold
- packages/shared scaffold
- environment/config validation
- health endpoint
- realtime Socket.IO connection
- operator/display/team routes reachable
- local SQLite bootstrap
- basic smoke tests

Exit criteria:
- Mac can start UniQuiz locally.
- Two remote browsers on the LAN can connect.
- Operator can see connection state for Display, Team A and Team B.

## M2 — Participants & Draw
Goal: configure participating colleges and produce the ordered qualification sessions.

Deliverables:
- college master list, up to 20
- participant selection and lock
- randomized draw
- even/odd participant handling
- two-college and solo sessions
- ordered session schedule
- persistent draw result
- audience draw animation

Exit criteria:
- A locked participant list can be drawn exactly once unless explicitly reset by the operator.
- Every selected college appears exactly once in qualification sessions.
- Odd participant counts generate exactly one solo slot.

## M3 — Question Bank & Scoring
Goal: safely prepare unique question sets and calculate authoritative scores.

Deliverables:
- five configurable categories
- question import and validation
- 10 questions per session
- exactly 2 questions per category
- no repeated qualification question
- session question-set lock
- 30-second authoritative timer
- scoring formula
- answer validation
- audit records

Scoring:
- timer 30–25: 25 points
- timer 24–1: points equal the displayed remaining second
- timer 0 / wrong / no answer: 0 points
- whole-number scores only

Exit criteria:
- Every generated session receives 10 valid unique questions.
- Server-side scoring passes deterministic tests for boundary times.

## M4 — Live Session & Team Stations
Goal: run a complete qualification session with two browser-only team stations.

Deliverables:
- Team A / Team B station identity
- station access tokens
- question lifecycle state machine
- synchronized question start
- answer submission and lock
- reconnect behavior
- solo-session behavior
- operator controls
- automatic persistence

Exit criteria:
- A complete 10-question session can run without manually editing data.
- Refreshing a team browser does not corrupt the active session.
- Server remains authoritative for timing and answer acceptance.

## M5 — Audience Display, Reveal & Live Ranking
Goal: create the public-facing competition experience.

Deliverables:
- fullscreen audience display
- question/timer presentation
- answer received indicators
- automatic answered-path reveal after OSC handoff; explicit timeout reveal
- correct/wrong display
- response time display
- awarded points animation
- session score
- overall ranking sidebar
- PLAYING / COMPLETED / NOT_STARTED handling
- draw and transition animations

Exit criteria:
- After every question reveal, the ranking is recalculated and displayed.
- Audience can clearly see answer, correctness, response time and awarded points.

## M6 — Hardening & Event-Day Operations
Goal: make the system safe to use live.

Deliverables:
- recovery after server/browser restart
- backup/restore
- operator override with audit trail
- network diagnostics
- pre-event checklist
- rehearsal mode
- data export
- final-results screen
- packaging/start script
- full event simulation

Exit criteria:
- Full competition rehearsal succeeds on the real Mac + two Windows PCs + audience screen.
- Recovery procedures are documented and tested.

## Scope discipline
- One repository.
- One authoritative server.
- Browser-only team clients.
- No real competition question bank in Git.
- No CI workflow is added until the first runnable code exists.
- UI polish must not block core correctness.
