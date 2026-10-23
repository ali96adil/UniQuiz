# M7 release review and ordered merge runbook

**Status:** REVIEW PREPARED; DO NOT DEPLOY TO THE OFFICIAL 2026 DATABASE.
This runbook describes the tested Mode 01 / **المواجهة بالنقاط (Ranked Duel)**
revision. It is not permission to auto-merge unreviewed PRs.

## Tested release head

- Branch: `feature/m7-question-library-editor`.
- Reviewed application head: `3fcfbf5596d4ef3c88d448aebf5c0fdb332da501`.
- CI pass: [GitHub run 39919615089](https://github.com/ali96adil/UniQuiz/actions/runs/39919615089).
- Prior `main` observed in review:
  `e2ad217792314d09e5d051307190c7c2276afce9`.
- At that snapshot, the release head was **236 commits ahead, zero behind**
  `main`; the complete diff affected **84 files**. Recheck immediately
  before merging; these counts are review observations, not permanent guarantees.
- M7 does NOT expose a multi-mode switcher. The sole live mode is
  `ranked_duel` / `المواجهة بالنقاط` / `Ranked Duel`.
  Participant types and configurable point formulas are not separate modes.

## Evidence recorded

- Operator confirmed a complete Mac rehearsal with both answer-station
  flows, the audience screen, round/question workflow, manual final-results
  announcement, archive results PDF and networked OSC to Max.
- A pre-switch SQLite backup was restored into a **separate empty test DB**.
  SQLite integrity check returned `ok`. Read-only historical archive
  inspection reproduced the 2026 competition's participant/round/question
  counts and winner/score and preserved a second rehearsal archive.
- Automated CI tests migration, ranking parity, authentication, public
  answer secrecy, old database schema upgrades, allocation, backups and
  integration workflows. Automated tests alone are not deployment approval.
- Release evidence/issues: [#50](https://github.com/ali96adil/UniQuiz/issues/50)
  and [#51](https://github.com/ali96adil/UniQuiz/pull/51).

## Which PRs belong to the tested branch?

The following is the **ancestor-chain merge order**; each branch is based
on the previous step until retargeted for merging into `main`:

| Sequence | PR | Concern |
| --- | --- | --- |
| 1 | #25 | Archives, category display, historical question bank |
| 2 | #26 | Variable question/category counts |
| 3 | #27 | Separate competition workspaces |
| 4 | #28 | Per-round category and question plans |
| 5 | #29 | Competition timing and scoring |
| 6 | #30 | Guided setup UX |
| 7 | #31 | Rehearsal/migration hardening |
| 8 | #32 | Full-flow acceptance and readiness |
| 9 | #33 | Results export correctness |
| 10 | #34 | Verified database backup integrity |
| 11 | #39 | Authenticated operator sessions |
| 12 | #40 | Secure station credentials |
| 13 | #41 | Browser synchronization on workspace switches |
| 14 | #42 | Read-only historical preservation fingerprint |
| 15 | #44 | Fingerprint binding to the actual rehearsal DB |
| 16 | #45 | Pinned M6 schema regression |
| 17 | #46 | Golden historic ranking parity |
| 18 | #47 | Answer redaction until Reveal |
| 19 | #51 | M7 editor, Mode 01 naming, archives/PDF, numeric pairing and fixes |

**Do not merge PRs #36, #37, #38 or #43 into this release by number.**
They have parallel/diverged histories not in the tested release head,
and some overlap later security and migration tests. Review their unique
changes independently before closing or labelling them superseded.
They are not stages in the ancestor-chain above.

## Recommended manual merge procedure — NO AUTOMATIC BATCH MERGE

1. **Freeze and compare.** Confirm every intended PR is approved, all
   required status checks pass, and no blocking review threads remain.
   Fetch `main` and the release head again. If either has moved,
   reevaluate the diff and rerun CI.
2. Start at **#25** (already targets `main`). Verify its diff and CI.
   Merge using a **merge commit** so Git history retains the original
   feature commits. Do not squash the first PR of a stacked chain unless
   the entire follow-up rebasing/review plan has been changed explicitly.
3. For **each next PR**, after its predecessor is *in main*, change that
   next PR's base to `main`, **review the new diff and CI**, verify it
   contains only the expected incremental changes and merge with a merge
   commit. Never merge a PR that still targets its older feature branch
   if the goal is to release to `main`.
4. If a base retarget is not mergeable, the diff unexpectedly includes old
   changes, tests fail, or a branch diverges, **STOP** and resolve/review
   rather than force-push or cherry-pick blindly.
5. After #51, verify the tested head has become an **ancestor of main**
   (merge commits retain ancestry):
   ```bash
   git fetch origin
   git merge-base --is-ancestor 3fcfbf5596d4ef3c88d448aebf5c0fdb332da501 origin/main \
     && echo "M7_SHA_IN_MAIN" \
     || echo "M7_SHA_NOT_IN_MAIN"
   ```
   The release is not complete if it prints `M7_SHA_NOT_IN_MAIN`.
   Verify full CI on the resulting main commit as well.
6. **Release and deployment are separate tasks.** A Git merge cannot
   overwrite the Mac's official SQLite database, but starting a newer
   M7 server against that DB *can migrate it*. Keep the deployed M6
   runtime and official 2026 DB untouched until the operator authorizes
   a deployment and there is an offline verified physical backup and
   a rehearsed rollback. Run no schema migration against the official
   DB during code-review merges.

## Final operational check after deployment authorization

- Stop the official runtime before replacing application binaries.
- Verify an external, read-only backup of the official DB, including WAL
  content. Keep its integrity/hash record off the production application.
- Compare historical rankings, cumulative response times and question
  counts against the pre-upgrade baseline; check SQLite integrity and
  foreign keys, plus archive export and logos.
- Confirm local operator auth, both stations, public answer secrecy,
  audience display, Max OSC receipt, final-results timing and PDF output.
- If any result differs, stop and restore from the verified backup using
  the tested offline recovery procedure, never a live database copy.

This file is a **runbook**, not a statement that the release has already
been merged or installed.
