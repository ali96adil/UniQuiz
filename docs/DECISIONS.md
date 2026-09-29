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
Decision: The official answer window is 30 seconds. Correct answers use whole-number speed scoring: the maximum is 25 points while the displayed timer is 30 through 25, then the score follows the displayed remaining second (24 → 24 points, …, 1 → 1 point). At expiry, wrong, unanswered or expired responses earn 0.

## D-009 — Reveal before ranking update
Decision: Official answer, correctness, response time and awarded points are revealed after question closure. Ranking is then recalculated and published.

Reason: Transparency without leaking correctness while another team can still answer.

## D-010 — Real question data stays out of Git
Decision: Git contains schemas and samples only. Real competition questions and answers remain local runtime data.

## D-011 — Operator controls progression
Decision: Sessions and questions never advance automatically. The operator explicitly prepares/starts every session and every question. The 30-second countdown is the only automatic progression inside an active question.

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

## D-014 — Configurable audience-facing terminology
Decision: Internal domain/API terms remain stable in English, while audience-facing and operator-facing Arabic labels are configurable.

Default presentation terminology:
- session → جولة
- next session → الجولة القادمة
- current session → الجولة الحالية
- ranking → الترتيب العام
- question → السؤال
- correct answer → الإجابة الصحيحة
- intermission → استراحة قصيرة
- final results → النتائج النهائية

The operator can edit visible titles, labels, subtitles, announcements, event name, venue text, season/year text, footer text, and stage messages from competition settings without changing code.

Reason: Event wording may change between editions, organizers or presentation styles. Presentation text must not be coupled to internal state-machine names.

## D-015 — Qualification questions use four options
Decision: Every qualification question is multiple-choice with exactly four visible options: A, B, C and D.

Reason: This keeps answer submission, automatic scoring, audience transparency and station UX consistent.

## D-016 — Three-second pre-question countdown
Decision: Pressing Start Question first enters a server-controlled 3-2-1 presentation countdown. The question text and options remain hidden until the countdown completes. The authoritative 30-second answer timer begins only when the question becomes active after the countdown.

The operator remains the only actor that initiates a question. The countdown itself runs automatically once started.

OSC may emit prestart cues for 3, 2 and 1, followed by the normal question-start cue.

## D-017 — Solo qualification round is always last
Decision: When the qualification participant count is odd, the draw still randomly determines which college receives the solo round, but that solo round is always placed as the final round in the official draw order.

Reason: This keeps live-event staging and audience communication predictable while preserving random selection of the solo college.

## D-018 — Bulk data import from CSV/XLSX
Decision: Administrative setup supports bulk import from CSV and Excel `.xlsx` files. Import is always validated and previewed before data is committed.

Excel workbook sheet names:
- `Colleges`
- `Categories`
- `Questions`

CSV imports represent one data type per file and are detected from their headers.

College columns:
- `name` — required
- `short_name` — optional
- `participating` — optional boolean; when supplied, it may preselect participating colleges before participant lock

Category columns:
- `key` — required stable identifier
- `name` — required display name

Question columns:
- `category_key` — required and must reference an imported/existing category
- `question` — required
- `option_a` — required
- `option_b` — required
- `option_c` — required
- `option_d` — required
- `correct_option` — required, exactly `A`, `B`, `C`, or `D`
- `source_ref` — optional external reference for administration/audit

No difficulty column is accepted.

Importing a file never bypasses competition locks or question-bank validation. Real competition data remains runtime SQLite data and is never committed to Git.

## D-019 — Official scoring uses integer micro-points
Decision: Official scoring is calculated server-side using integer micro-points (1 point = 1,000,000 micro-points), while the UI converts them to normal decimal points for presentation.

Rules:
- Official question deadline: 30,000 ms
- Maximum correct score: 25 points
- While the displayed timer is 30, 29, 28, 27, 26 or 25: 25 points
- From displayed 24 seconds through 1 second: points equal the displayed remaining second
- At 30,000 ms or later: 0
- Wrong or unanswered: 0

Official storage remains integer micro-points (1 point = 1,000,000 micro-points), so ranking has no floating-point ambiguity.

## D-020 — Audit history is append-only and reference-tolerant
Decision: Audit rows preserve numeric round/question references and event payloads without foreign-key coupling to mutable setup tables.

Reason: Resetting a draw or replacing/importing a question bank must not erase historical audit evidence or be blocked by audit-table foreign keys.

## D-021 — Question timing uses the server monotonic clock
Decision: The authoritative 30-second question window is measured from the server's monotonic clock. Wall-clock timestamps are stored/published only for display and audit correlation.

Reason: Browser clocks and wall-clock adjustments must not change official elapsed response time.

## D-022 — Answered questions reveal automatically after OSC handoff
Decision: When all required team stations have submitted, the server closes the question immediately, emits `/uniquiz/question/answered`, waits 1.5 seconds, and then performs the official Reveal automatically.

Rules:
- Paired round: both Team A and Team B must have submitted.
- Solo round: Team A is the only required station, so its locked submission satisfies the same all-required-stations condition.
- The correct answer must never be exposed while a required station can still answer.
- Timeout closure does not use the answered-path automatic Reveal; the operator retains explicit Reveal control for timeout cases.
- Automatic Reveal is restored after a server restart if the persisted state is an answered `QUESTION_CLOSED` awaiting its reveal delay.

## D-023 — Thirty-second timer with whole-second scoring
Decision: Qualification questions use a 30-second official answer window and whole-number speed scores.

Scoring follows the countdown shown to competitors:
- timer 30–25 → 25 points
- timer 24 → 24 points
- timer 23 → 23 points
- …
- timer 2 → 2 points
- timer 1 → 1 point
- timer 0 / expiry → 0 points

The server remains authoritative at millisecond precision. The whole-number score is derived from the displayed remaining second; no fractional points are awarded.
