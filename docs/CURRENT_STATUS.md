# Current Status

Updated: 2026-09-29

## Active work
M6 — Event-Day Hardening & Recovery, rebuilt cleanly on the accepted Post-M5 `main`.

## Master tracker
Issue #8 — UniQuiz Roadmap & Current Work

## Active branch
`feature/m6-hardening-recovery-clean`

## Active pull request
PR #16 — M6: hardening & recovery on current main

Current verified feature head before this documentation checkpoint:
`47f102ce2528a585fff5dbbd55e6908f140f13d9`

Latest verified CI:
Run #37132056774 — PASS

PR #16 passed the automated merge gate. Real-device rehearsal remains required before event-day use, but is no longer a blocker to integrating M6 into `main`.

## Main baseline
Post-M5 PR #15 is merged to `main` as:
`faf70890c5539847492f20f46a2d9499214d48a5`

The accepted baseline includes:
- 25-second authoritative question window;
- correct-answer score = displayed remaining whole second, 25 → 1;
- wrong / no answer / expiry = 0;
- direct next-question → 3-2-1 flow;
- timeout auto-Reveal;
- cumulative response-time ranking;
- correct/wrong answer counts;
- current Setup/Draw workflow with live participant selection;
- full-screen contestant stations;
- current audience/final-results presentation;
- official A4 browser Print / Save as PDF report.

## M6 clean rebuild
Historical PR #14 is closed and superseded. Do not retarget or merge it.

The clean M6 candidate includes:
- verified SQLite backup creation and offline restore;
- automatic safety backup before restore/reset;
- Preflight READY / NOT READY dashboard;
- LAN/network diagnostics;
- restart recovery during countdown and active question;
- safe VOID + same-category replacement;
- invalidation of stale score, revealed count, cumulative time, correct count and wrong count after VOID;
- audited Station Ready Override, exposed only when a required station is offline;
- Emergency Hold;
- isolated rehearsal database with visible REHEARSAL mode;
- scoring-neutral audience announcement/intermission scenes;
- official results/submissions/audit XLSX export;
- XLSX metadata aligned to the current 25-second scoring rule;
- OSC readiness send/confirm gate when OSC is enabled;
- opt-in safe Operator hotkeys aligned with the current direct question flow;
- shutdown timer cleanup;
- event-day startup commands and checklist.

## Latest verification
- CI #36605322460 PASS.
- Typecheck PASS.
- Tests PASS.
- Build PASS.
- Server/realtime/M2 persistence smoke PASS.
- VOID regression now verifies score, revealed-count, cumulative-time, correct-count and wrong-count invalidation.
- XLSX export regression verifies 25-second metadata plus ranking time/correct/wrong columns.
- PR #16 is mergeable/clean and has no known code blocker.

## Post-merge event acceptance
Still requires real hardware before event-day use:
1. Full Mac + Team A Windows + Team B Windows + audience display rehearsal.
2. Real OSC receiver send/confirm.
3. Browser disconnect/reconnect test.
4. Server restart during countdown.
5. Server restart during active question → Recovery → VOID + replacement.
6. Emergency Hold test.
7. Backup creation + offline restore drill.
8. Visual acceptance of Operator Preflight, rehearsal banner, announcement scenes and exported workbook.

Automated verification is complete. Merge PR #16 into `main`; keep the real-device checks above as the final event-readiness gate before official use.

## Do not repeat
- Do not recreate the repository.
- Do not create separate repositories for server/web/team stations.
- Do not reintroduce question difficulty levels.
- Do not reintroduce the old 30/45-second scoring rules.
- Do not restore the unnecessary between-question audience page.
- Do not commit real competition questions or correct answers.
- Do not build a knockout qualification bracket.
- Do not reopen or retarget superseded PR #14.
