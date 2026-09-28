# Current Status

Updated: 2026-09-28

## Active milestone
Issue #4 — M3 Question Bank & Scoring

## Master tracker
Issue #8 — UniQuiz Roadmap & Current Work

## Active branch
`feature/m3-question-bank-import`

## Active pull request
PR #11 — M3: Question Bank, Bulk Import & Scoring

## Completed
- M2 PR #10 merged to `main` as squash commit `359d72f2b5a63eb9be91035ef890bfff93a636a1`.
- M3 bulk import implemented for CSV/XLSX with Preview → Validation → Apply, plus downloadable Excel template.
- Categories/questions persist in SQLite; question schema has four options and one A/B/C/D correct option with no difficulty field.
- CI Run #24 PASS: CSV/XLSX parser and validation tests.
- CI Run #25 PASS: import UI, typecheck, tests, build and runtime smoke.
- M1 PR #9 merged to `main` as squash commit `2fe7cc17ae79329677907cd8aff15baa762a13fe`.
- Repository foundation merged to `main`.
- Public visibility intentionally retained during development.
- Qualification rules and architecture decisions documented.
- Audience display states and layout documented in `docs/AUDIENCE-DISPLAY.md`.
- Audience-facing terminology is configurable; default Arabic term for session is `جولة`.
- Qualification questions are fixed to four options: A, B, C, D.
- Server-controlled 3-2-1 countdown is required before every question.
- OSC show-control events and manual round/question progression are documented.
- Live safety requirements are documented: Station Ready Check, VOID + same-category replacement, recovery, audit, preflight, rehearsal and intermission scenes.
- `apps/server`, `apps/web`, and `packages/shared` are scaffolded.
- Fastify server, SQLite bootstrap, `/health`, Socket.IO presence and placeholder web surfaces are implemented.
- Routes recognized by the M1 web shell: `/setup`, `/draw`, `/operator`, `/display`, `/team/a`, `/team/b`.
- Operator placeholder displays live station connection state without refresh.
- CI workflow added with install, typecheck, build, live server health check and Socket.IO handshake.
- CI Run #4 passed on commit `2a1fbc43e49cb9813e071f92deaeeaba8d7a66db`.
- Local/LAN verification instructions added in `docs/LOCAL-DEVELOPMENT.md`.
- Real Mac startup verified on 2026-09-28: Vite `192.168.3.114:5173`, Fastify/Socket.IO `192.168.3.114:8787`, SQLite created at `data/uniquiz.db`.
- Real realtime presence verified: Operator connected, Display connected, Team A and Team B both verified over LAN, and disconnect/reconnect state reflected live in Operator without refresh.
- Vite development proxy emitted `ECONNRESET` WebSocket logs during client disconnect/reconnect activity; no functional failure has been observed. Reclassify as a bug only if presence flaps while clients remain continuously open.
- Node 24.21.0 verified on the Mac after installing Homebrew `node@24` and updating PATH.
- Clean restart verified under Node 24.21.0 after stopping stale processes: Vite `172.20.10.4:5173`, Fastify/Socket.IO `172.20.10.4:8787`, SQLite reused successfully.
- M2 core implemented and CI verified: participant setup/lock, persistent official draw, manual next-round selection, solo-last rule, audience draw presentation, and replay.
- CI Run #20 PASS: official draw remained byte-equivalent at the round payload level after server restart using the same SQLite database.

## In progress
- M3 question-bank allocation, no-repeat rules, timer and scoring foundation.
- Bulk CSV/XLSX import is implemented and awaiting real Mac workflow verification.

## Next action
Pull the latest M3 branch on the Mac and verify the `/setup` bulk-import flow using the generated Excel template. After import verification, continue with 10-question round allocation, exactly 2 per category, no-repeat enforcement, timer and scoring.

## Blockers
No code blocker. Bulk import needs one real Mac verification before it is considered operationally verified.

## Do not repeat
- Do not recreate the repository.
- Do not reintroduce question difficulty levels.
- Do not create separate repositories for server/web/team stations.
- Do not commit real competition questions or correct answers.
- Do not build a knockout qualification bracket.
- Do not auto-advance rounds or questions.
- Do not hard-code visible Arabic event terminology.
- Do not open speculative implementation issues unless that work is actually starting.

## Checkpoint format
Every meaningful batch should update this file with:
- completed work;
- verification performed;
- commit/PR references;
- next action;
- blockers, if any.
