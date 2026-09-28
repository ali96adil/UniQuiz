# Current Status

Updated: 2026-09-28

## Active milestone
Issue #3 — M2 Participants & Draw

## Master tracker
Issue #8 — UniQuiz Roadmap & Current Work

## Active branch
`feature/m2-participants-draw`

## Active pull request
Pending creation for M2 implementation

## Completed
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

## In progress
- M2 implementation starting.

## Next action
Implement the college master list, participant selection/lock, server-side draw, ordered rounds, and odd-count solo round handling. Keep round order persistent and allow later operator selection without modifying the official draw.

## Blockers
No remaining M1 blocker. Clean restart under Node 24.21.0 is verified.

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
