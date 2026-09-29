# Current Status

Updated: 2026-09-29

## Active milestone
Issue #6 — M5 Audience Display & Ranking (real external-screen acceptance pending)

## Stacked milestone
Issue #7 — M6 Event-Day Hardening & Recovery — code-complete candidate

## Master tracker
Issue #8 — UniQuiz Roadmap & Current Work

## Active branches
- `feature/m5-audience-live-display` — PR #13
- `feature/m6-hardening-recovery` — PR #14 stacked on M5

## Active pull requests
- PR #13 — M5: Audience Display & Ranking
- PR #14 — M6: Hardening & Event-Day Recovery (stacked; do not merge before M5)

## Completed
- M4 PR #12 merged to `main` as squash commit `ffb660561ab2c5ee8005ad1e247547656abe6a4f`.
- M3 PR #11 merged to `main` as squash commit `3a29003c0c50d83d0f54adf41e77862e1495e971`.
- M4 persistent operator-paced live state machine implemented.
- Team A/B answer submissions are locked once, persisted, and restored after reconnect; paired questions auto-close when both answer and solo questions close after Team A answers.
- Operator and Team A/B live interfaces implemented, including 3-2-1, question/options, countdown and answer lock feedback.
- CI Run #37 PASS: live runtime.
- CI Run #38 PASS: submission locking and solo/paired closure.
- CI Run #39 PASS: live web interfaces.
- CI Run #40 PASS: pre-question station-state correction.
- Fail-safe OSC show-control output implemented for countdown 3/2/1, question start, answered, timeout, close, reveal, intermission and round completion.
- Persistent Station A/B access tokens implemented; authenticated presence is required by Station Ready Check.
- CI Run #42 PASS: OSC output.
- CI Run #44 PASS: station token binding and readiness.
- CI Run #45 PASS: full 10-question paired-round integration with 20 locked submissions, manual Reveal, persisted completion, OSC events and OSC-failure isolation.
- M2 PR #10 merged to `main` as squash commit `359d72f2b5a63eb9be91035ef890bfff93a636a1`.
- M3 bulk import implemented for CSV/XLSX with Preview → Validation → Apply, plus downloadable Excel template.
- Categories/questions persist in SQLite; question schema has four options and one A/B/C/D correct option with no difficulty field.
- CI Run #24 PASS: CSV/XLSX parser and validation tests.
- CI Run #25 PASS: import UI, typecheck, tests, build and runtime smoke.
- Full Excel export added for current Colleges / Categories / Questions; blank `source_ref` is explicitly tested and supported.
- Locked question allocation implemented: 10 questions per round, exactly 2 per category, no cross-round reuse.
- Exact official scoring core implemented using integer micro-points with millisecond response timing.
- CI Run #27 PASS: export and optional `source_ref`.
- CI Run #28 PASS: allocation invariants.
- CI Run #29 PASS: allocation UI and scoring boundary tests.
- CI Run #31 PASS: monotonic question clock, audit and VOID/replacement core.
- CI Run #33 PASS: integration test for same-category replacement and persistent audit.
- CI Run #34 PASS: Excel export structure and blank `source_ref` verified.
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
- M5 is code-complete on PR #13. The only remaining gate is real external-screen/projector visual verification.
- App-generated Excel import sample verified successfully on the isolated rehearsal database.
- Answered questions now auto-reveal 1.5s after all required teams submit; OSC answered cue precedes the automatic reveal cue.
- Team reveal displays the full correct answer text plus option letter.
- Team waiting copy now says "بانتظار START من النظام".
- Final-round handling no longer offers a nonexistent next round; stale manual round selection falls back to the next pending round and completed qualification shows a terminal message.

## Next action
When the Mac and event devices are available, visually accept PR #13 on the real audience screen/projector. Then merge M5, retarget/rebase PR #14 onto `main`, and run the real-device M6 rehearsal/failure-simulation checklist.

## Completed
- CI Run #58 PASS: final M4 UI polish; system wording and correct/wrong reveal colors verified by CI.

## Completed
- M5 live audience question/reveal scene implemented with reveal-safe per-team results.
- CI Run #61 PASS: live display/reveal contract.
- Reveal-gated qualification ranking sidebar implemented; only revealed questions affect totals.
- CI Run #62 PASS: ranking logic and tie/not-started behavior.
- Dedicated fullscreen `/display` implemented.
- CI Run #63 PASS: fullscreen audience surface.
- Next-round and final qualification ranking scenes implemented.
- CI Run #64 PASS: M5 end-scene UI build/runtime validation.

## Completed
- CI Run #67 PASS: category-name question import + safe append mode.
- CI Run #68 PASS: full competition reset contract.
- CI Run #69 PASS: clearer M3 pre-draw allocation state.

## Completed
- CI Run #72 PASS: persistent audience branding + local offline logo assets.
- CI Run #73 PASS: revealed-only animated round totals.
- CI Run #76 PASS: all static audience wording configurable from Setup.
- CI Run #77 PASS: polished keyed scene transitions with reduced-motion fallback.

## M6 code-complete checkpoint
- CI Run #82 PASS: verified SQLite backup/restore core + Preflight API.
- CI Run #83 PASS: server-restart fail-safe during countdown/active question.
- CI Run #84/#85/#86 PASS: safe VOID/replacement, stale-score invalidation, live-slot reset, Operator recovery flow.
- CI Run #88 PASS: official results/submissions/audit XLSX export.
- CI Run #91 PASS: audited Station Ready Override + Emergency Hold.
- CI Run #92 PASS: isolated rehearsal database + visible REHEARSAL mode.
- CI Run #93 PASS: scoring-neutral audience presentation/announcement scenes.
- CI Run #103–#105 PASS: OSC readiness send/confirm gate + reset behavior.
- CI Run #106 PASS: opt-in safe Operator hotkeys; all M6 code paths validated.
- CI Run #110 PASS: backup directory excluded from Git, verified-temp restore replacement, and mandatory pre-reset safety backup.

## Blockers
No code blocker. M6 is code-complete on PR #14. Remaining gates require real hardware: M5 external-screen acceptance, M6 full Mac + 2 Windows + audience rehearsal, real OSC receiver confirmation, backup/restore drill, and failure simulation.

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
