# Current Status

Updated: 2026-09-28

## Active milestone
Issue #2 — M1 Foundation & Local Runtime

## Master tracker
Issue #8 — UniQuiz Roadmap & Current Work

## Active branch
`feature/m1-local-runtime`

## Active pull request
PR #9 — M1: Foundation & Local Runtime

## Completed
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

## In progress
- M1 real-device verification on the two Windows browsers and audience display.

## Next action
Mac startup is verified. Next verify Operator + Display on the Mac, then Team A and Team B from the two Windows PCs over LAN using `http://192.168.3.114:5173/...`. Confirm live disconnect/reconnect presence without refresh. After that, align the Mac runtime from Node 23.11.0 to the project Node 24.21.0.

## Blockers
Mac runtime is verified. Windows LAN/reconnect verification is pending. The Mac currently runs Node 23.11.0 while the project requires Node >=24.21.0; development still started successfully, but runtime version alignment is required before M1 closure.

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
