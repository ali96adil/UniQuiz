# Current Status

Updated: 2026-09-29

## Active work
Post-M5 event-day refinement and visual acceptance.

## Master tracker
Issue #8 — UniQuiz Roadmap & Current Work

## Active branch
`feature/post-m5-presentation-scoring-pdf`

## Active pull request
PR #15 — Post-M5: presentation, scoring, ranking time & official PDF

Current head before this checkpoint:
`37ac0f5ed532830f153595e4fa4b7989604e7e11`

Latest verified CI:
Run #36555351727 — PASS

## Completed
- M5 PR #13 merged to `main` as squash commit `c9d4e5910db12eab3c03142c9b80afe3860904f2`.
- Issue #6 — M5 Audience Display, Reveal & Live Ranking — closed as completed.
- Principal audience-display headings centered, including the final qualification ranking title.
- University and Student Activities Department logos enlarged.
- Patronage and supervision lines added to the audience header.
- Final-results scene no longer duplicates the last-round result block above the podium.
- Authoritative answer window changed to 25 seconds.
- Correct-answer score equals the displayed remaining whole second: 25 → 25 points, 24 → 24, …, 1 → 1; timeout/wrong/no answer = 0.
- Normal operator flow moves directly from Reveal to the next 3-2-1 countdown without exposing a separate QUESTION_READY audience page.
- Qualification ranking includes cumulative response time per college.
- A revealed unanswered question counts as the full 25-second window in cumulative response time.
- Ranking order is points descending, then cumulative response time ascending; lower total time wins a point tie.
- Official A4 results statement implemented at `/report`.
- After qualification completion, Operator shows `تصدير بيان النتائج PDF`; `/report?print=1` waits for logos, decoded images, web fonts and completed browser paint before opening Print / Save as PDF, including repeated exports.
- Official report includes both logos, competition identity, patronage/supervision, issue date/time, top three, full ranking, points, cumulative answer time and counted questions.
- Live-session timer cleanup added for application shutdown and tests.
- Active documentation synchronized to the 25-second scoring rule and direct next-question flow.
- PR #15 has no open review comments or review threads.
- PR #15 is mergeable and its latest verified CI is green.

## M6 status
Issue #7 / PR #14 — M6 Event-Day Hardening & Recovery — remains code-complete and intentionally deferred.

PR #14 is still stacked on `feature/m5-audience-live-display`. Do not retarget or merge it yet. After PR #15 is visually accepted and merged to `main`, rebuild the M6 branch cleanly on the updated `main` to avoid the earlier squash-history conflict.

## Latest refinement
- Audience logos increased again to 150px on desktop presentation.
- Audience display is locked to exactly one viewport (100dvh) with page overflow disabled.
- Setup and Operator now have direct navigation buttons between each other.
- Short station portal added at `/s`; it provides direct authenticated Station A / Station B links plus Audience Display access.

## Next action
On the event Mac, pull PR #15 and perform the remaining acceptance checks:

1. Open `/display` on the real audience screen and verify logo sizing, patronage/supervision readability, centered headings, no duplicate college in final results, 25-second timer, direct next-question 3-2-1 flow, and cumulative response time.
2. Complete a qualification rehearsal and open `/report?print=1`.
3. Verify Print Preview / Save as PDF on A4: Arabic text and logos render correctly, top three and full table fit cleanly, and there is no clipping.

If accepted:
- mark PR #15 Ready for Review;
- merge PR #15 into `main`;
- resume M6 by rebuilding/retargeting PR #14 on the new `main`.

## Blockers
No code blocker. Only real-display and print-preview visual acceptance remain for PR #15.

## Do not repeat
- Do not recreate the repository.
- Do not reintroduce question difficulty levels.
- Do not create separate repositories for server/web/team stations.
- Do not commit real competition questions or correct answers.
- Do not build a knockout qualification bracket.
- Do not reintroduce the old 30/45-second scoring rules.
- Do not restore the unnecessary between-question audience page.
- Do not retarget PR #14 onto `main` until PR #15 has been accepted and merged.

## Latest test findings and fixes
- Timeout now follows the same automatic Reveal handoff as completed answers; no manual Reveal is required after the 25-second window expires.
- Unanswered required stations show an explicit red result state with 0 points on both audience/team result surfaces.
- Team Reveal now includes awarded points after correctness and response time.
- Next-round preview ignores the current/non-pending round, fixing the transition into a final solo round.
- Official report label changed to `عدد الكليات المشاركة`.
- Official report replaces counted-question column with correct-answer and wrong-answer counts.

## Setup / contestant layout refinement
- Contestant Station A/B surfaces now use a dedicated full-screen 100dvh layout with the generic app hero removed, giving the question and four answer choices the available screen area.
- Setup cards reordered into one dependency flow: data import → college list → participant selection → official draw → question allocation → audience branding.
- Official draw is embedded directly in `/setup`; the standalone `/draw` route remains available.
- Participant selection persists immediately on every checkbox change instead of requiring a separate Save Participants action.
- The server now accepts incremental participant lists before lock; the existing lock operation still enforces at least two participants.
- Before participant lock, the audience display now shows the currently selected colleges and updates from the authoritative competition snapshot in real time.

- Contestant answer-choice cards rebalanced after visual review: shorter card height, larger answer text, and larger A/B/C/D badges while preserving the full-screen station layout.

## M6 clean rebuild
- Rebuilt from current `main` after Post-M5 acceptance; historical stacked branch is reference-only.
- Active clean branch: `feature/m6-hardening-recovery-clean`.
- Transferred M6-only behavior: verified backup/restore, Preflight, restart recovery, safe VOID/replacement, XLSX results/audit export, readiness override backend, Emergency Hold, isolated rehearsal database, audience announcement scenes, LAN diagnostics, OSC readiness send/confirm, safe Operator hotkeys, shutdown timer disposal, and reset safety backup.
- Preserved current Post-M5 behavior: 25-second scoring, direct next-question 3-2-1 flow, timeout auto-reveal, current Setup/Draw flow, full-screen contestant stations, cumulative-time ranking, correct/wrong counts, and official A4 report.
- Alt+N hotkey follows the current direct `/api/live/start-next-question` flow.
- Timeout remains automatic and does not expose a manual Reveal action.
- VOID invalidation applies to score, revealed count, cumulative response time, correct answers, and wrong answers.
- Next gate: full CI on the clean branch, then real-device M6 rehearsal.

