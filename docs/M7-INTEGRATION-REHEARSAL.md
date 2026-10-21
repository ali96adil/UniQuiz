# M7 integration review and offline rehearsal

This document applies to the stacked PR sequence:

1. PR #25 — archives and persistent question bank
2. PR #26 — flexible category/question totals for a competition
3. PR #27 — independent competition workspaces
4. PR #28 — independent per-round question/category plans
5. PR #29 — per-competition duration and scoring
6. PR #30 — guided setup UX
7. PR #31 — verified startup migration backup and integration hardening
8. PR #32 — full-flow competition verification and event-scoped readiness
9. PR #33 — accurate Excel results for configurable timing/scoring and variable rounds
10. PR #34 — verify on-disk SQLite backup hash and integrity before preflight READY
11. PR #39 — operator session login and privileged API/Socket.IO authentication
12. PR #40 — safe Windows answer-station enrollment and token rotation
13. PR #41 — synchronized cross-browser active workspace rules and editors
14. PR #42 — read-only historical-row fingerprint check of a copied DB
15. PR #44 — bind preservation baseline to its exact rehearsal database and test startup migration
16. PR #45 — verify M7 against pinned exact M6/v12 schema and historical ranking
17. PR #46 — compare the exact M6 leaderboard before migration with M7 after upgrade

**Status: DRAFT.** Do not merge or install on the official tournament Mac
until an operator has rehearsed the upgrade on an isolated copy of the actual
official competition database and recorded the results.

## Preservation guarantees

- The existing official database is never the input to a new M7 server while
  rehearsing. Use the supplied offline copying script first.
- The script `scripts/m7_rehearsal_copy.py` opens its source SQLite database
  in **read-only** mode and copies **committed WAL content** via the SQLite
  backup API. It never overwrites a destination.
- When the new server opens an existing, older SQLite schema, it creates a
  verified, 0600-permission physical SQLite snapshot in
  `migration-backups/` **before any schema DDL**, or fails closed.
- All schema installation/upgrade statements execute in one SQLite
  transaction. If any DDL or constraint change fails, SQLite rolls them back.
- A workspace switch makes a verified database backup, snapshots the
  competition being left and restores the destination in a single transaction.
  It is blocked during a live/unfinished round.
- The central shared questions/categories library is not removed when a new
  competition workspace is created.

## Safe procedure on a Mac — isolated database, LAN/OSC disabled

From a **clean checkout of the M7 review branch**, verify you are not in the
production runtime directory and review the real `UNIQUIZ_DB_PATH`. The
historical default is `data/uniquiz.db` relative to the repo, but the
official server may override it.

Use **an absolute source path** that you have confirmed belongs to the
existing event. Examples here are placeholders; do not copy the strings
literally without checking your own files.

```bash
# 1. Set this to the verified, existing production database.
export UNIQUIZ_OFFICIAL_SOURCE="/ABSOLUTE/PATH/TO/uniquiz.db"

# 2. Keep everything inside a private, separate rehearsal directory.
mkdir -p "$HOME/UniQuiz-M7-Rehearsal"
chmod 700 "$HOME/UniQuiz-M7-Rehearsal"
export UNIQUIZ_REHEARSAL_DB="$HOME/UniQuiz-M7-Rehearsal/rehearsal.db"

# 3. The destination must NOT already exist. This is a read-only
#    WAL-aware copy of the original, not a filesystem .db copy.
python3 scripts/m7_rehearsal_copy.py \
  --source "$UNIQUIZ_OFFICIAL_SOURCE" \
  --destination "$UNIQUIZ_REHEARSAL_DB"
```

If the script prints anything other than `REHEARSAL_COPY_OK`, stop. **Never**
point M7 to the official database until an approved deployment.

### Mandatory pre-upgrade fingerprint on the COPIED database

Before starting the new M7 server on the copy, capture an independent,
read-only baseline of all original tables. Run this on the **copied**
`$UNIQUIZ_REHEARSAL_DB` only:

```bash
export UNIQUIZ_BASELINE_MANIFEST="$HOME/UniQuiz-M7-Rehearsal/baseline-before-m7.json"
python3 scripts/m7_rehearsal_verify.py capture \
  --database "$UNIQUIZ_REHEARSAL_DB" \
  --manifest "$UNIQUIZ_BASELINE_MANIFEST"
```

Require `M7_BASELINE_CAPTURE_OK`. The private baseline file has permissions
`0600`; it contains row digests, not the names, question texts or logos.
The command will **refuse to overwrite** an existing manifest and binds it to the exact resolved rehearsal database path. Do not move or rename the rehearsal DB between capture and verification. Never upload
the private manifest or competition database to a public issue.

Start the M7 rehearsal server as instructed below, confirm that its
`/health` endpoint responds, then **stop it without clicking or changing any
competition content yet**. Verify the migrated rehearsal database:

```bash
python3 scripts/m7_rehearsal_verify.py verify \
  --database "$UNIQUIZ_REHEARSAL_DB" \
  --manifest "$UNIQUIZ_BASELINE_MANIFEST"
```

Require `M7_REHEARSAL_VERIFY_OK`. The check compares original row contents,
scoring, timestamps, categories, branding and even BLOB image contents by
SHA-256, while allowing explicitly documented additive migration rows.
It also requires SQLite integrity, valid foreign keys and initialized M7
workspace metadata. A changed or missing original row is a **release blocker**.
This guarantees raw historical preservation, **not** that the application
renders all old ranks correctly; still follow the official-results manual
comparison below. Only after a successful fingerprint verification proceed
with manual rehearsal operations. Do **not** rerun this baseline comparison
after intentionally editing the rehearsal database; it is designed to detect
such edits.

Install and validate the reviewed branch before starting its test runtime:

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

Run the backend in a separate terminal with the rehearsal database and an
isolated loopback-only port. Keep OSC disabled to avoid sending cues to
Ableton, VDMX or competition equipment. The operator password is **mandatory**
in M7; enter a unique secret interactively in the **same server terminal**
rather than committing it to the repo:

```bash
# This is zsh syntax (the standard interactive shell on current macOS).
read -rs "UNIQUIZ_OPERATOR_PASSWORD?Rehearsal operator password: "
echo
export UNIQUIZ_OPERATOR_PASSWORD
UNIQUIZ_MODE=rehearsal \
UNIQUIZ_DB_PATH="$HOME/UniQuiz-M7-Rehearsal/rehearsal.db" \
UNIQUIZ_HOST=127.0.0.1 \
UNIQUIZ_PORT=8788 \
UNIQUIZ_OSC_ENABLED=false \
pnpm --filter @uniquiz/server dev
```

In another terminal, run the web UI with its **rehearsal proxy** and separate
port (no need to interrupt the official 5173/8787 runtime):

```bash
UNIQUIZ_API_PROXY_TARGET=http://127.0.0.1:8788 \
pnpm --filter @uniquiz/web dev -- --host 127.0.0.1 --port 5174
```

Open `http://127.0.0.1:5174/setup` only on the rehearsal Mac.
This API points to the **copy**. Never place the rehearsal server or UI on
`0.0.0.0` during an actual event.

## Workspace-specific event-day verification

Even when the same hardware is used for consecutive tournaments, a verified
OSC reception from a **previous** tournament cannot certify the newly opened
competition. M7 clears OSC sent/confirmed state atomically each time a
different workspace is activated. The operator must send and confirm a new
`/uniquiz/system/test` before OSC preflight becomes READY.

Similarly, a backup made **before** opening or renaming a competition cannot
count toward the new active competition's preflight. Make a new verified
`/api/operations/backup` after activating the intended event. Existing older
backup files are retained for recovery but are marked stale for readiness.

The automated full-flow acceptance test also checks the entire two-round
lifecycle: 2 and 3 independently configured questions, fixed scoring,
nonrepeating allocations, final results requiring an explicit operator
announcement, previous tournament restoration and new OSC/backup preflight
conditions. This is **synthetic CI**, not the Mac rehearsal below.

## Full rehearsal scenarios

1. **Legacy preservation:** verify the copied original event title, colleges,
   qualification rounds, exact score totals, cumulative response times,
   correct/wrong counts, sponsor copy and logos. Make sure the previous
   official contest still produces its original ranking.
2. **Archive:** create a read-only history snapshot; export it and verify
   historical score values and public category labels are unchanged.
3. **New competition:** create a new workspace; select "department" or
   "team" participants; verify the question bank is retained and old
   participant scores are not mixed in.
4. **Flexible rounds:** create a draw with rounds of 5, 15 and 20 questions,
   assign a different category mix to each and allocate. Verify 40 unique
   questions are consumed, with no duplicates, and correct round totals.
5. **Timing/scoring:** create one 40s / 10 fixed-point competition and one
   45s / 60-point time-decay competition. Inspect countdown, correct/wrong
   scores, live cutoff and public labels.
6. **Safe switching:** test switching away from a completed competition,
   then back. Verify scores, sponsors, logo BLOB, round rules and scoring
   are unchanged. Confirm a new `backups/` file exists.
7. **Live blocking:** while a question is active, attempt to change
   workspaces or scoring rules. The server should reject both operations.
8. **Preflight:** allocate and lock question sets, then run the actual
   `/api/operations/preflight`. Offline stations should remain NOT READY;
   the guided progress tracker must not claim operational READY.
9. **Recovery:** restart only the rehearsal server and repeat checks for
   the archived event and new workspaces.
10. **Authentication:** verify operator login, logout, and login after server
    restart. Confirm that unauthorized browsers cannot retrieve station tokens
    or mutate competition setup, while both team stations and audience
    display remain operational.

## Automated upgrade smoke scope

PR #44 adds a GitHub CI end-to-end migration test. It creates an entirely
**synthetic** quiz database with historical scores, answer times, question
records, a logo BLOB and custom event metadata, recreates the old
10-question `live_submissions` SQLite position constraint and marks the
schema version as 15. CI then creates a WAL-aware copy, captures the
baseline, runs the **real M7 Node startup migration**, and checks every
original row fingerprint, upgraded constraints, SQLite foreign keys and
physical pre-migration backup. A subsequent deliberate score change must
fail verification.

This exercises migration code end to end but is **not a byte-for-byte M6
fixture**. Other historical schema variants might behave differently. It
does not certify the real University 2026 database until the separate Mac
rehearsal procedure above is completed successfully.

## Pinned main/M6 schema upgrade regression

PR #45 upgrades the actual pinned SQL table definitions from the existing
repository's `main:apps/server/src/database.ts` (Git blob
`1a81e22ba6279eaed81ae9ebd334f722d60b6ec7`, M6 schema version 12).
The fixture is preserved as
`scripts/fixtures/m6-main-schema.sql` and seeded **only** with invented
test colleges, historical answers and a test logo. This is separate from the
earlier constructed-v15 constraint test.

The real M7 `openDatabase` migration is run against a WAL-aware copy, then
CI checks that all three legacy position constraints (allocated questions,
reservations and answer submissions) are widened beyond 10, that no original
rows are lost, that a verified physical migration backup exists and that the
historical leaderboard remains 24.6 / 24.2 points with correct/wrong counts
unchanged. The original test database checksum must not change.

The SQL is pinned to the **observed main source**, so future modifications
to `main` do not quietly alter the regression fixture. A successful test
proves this particular M6 schema upgrade but does not prove that the real
2026 Mac database is identical or undamaged. Always run the private copied
database rehearsal and manually compare original final results.

## Golden historical ranking parity

PR #46 adds an independent cross-version ranking check. The exact M6 SQL
for the old official leaderboard is pinned at
`scripts/fixtures/m6-main-ranking.sql`, copied from
`main:apps/server/src/ranking.ts` (source blob
`b2f84d215a5cb24d069c502f9e142fd2e0dca6e3`). The historical
25,000 ms unanswered-question fallback is resolved as a literal; the
query is otherwise unchanged.

CI computes the leaderboard **before migration** on the pinned M6/v12
schema, including a tied score decided by faster cumulative response time,
correct and wrong answer counts, an unanswered revealed question, and
entrants in a pending round. It then migrates a WAL-aware copy with the
real M7 code and compares every public ranking entry (name, ID, status,
rank, score, total time, revealed questions and answer counts) to the
old M6 result, including after closing and reopening the migrated DB.

This blocks unintended changes to historical result calculations that
cannot be caught by raw SQLite data fingerprints alone. For an actual
event, keep the official end-of-competition results export/screenshots
and compare against the isolated M7 rehearsal results **before release**.
Synthetic parity is not a substitute for that manual comparison.

## Migration acceptance gate

An upgrade is eligible for manual operational testing only when all of
these conditions hold: `REHEARSAL_COPY_OK`, `M7_BASELINE_CAPTURE_OK`,
`M7_REHEARSAL_VERIFY_OK`, and the GitHub CI run for the exact reviewed
commit is green. The first three results refer only to a **separate copied
SQLite database**. Do not interpret synthetic tests as proof that your real
2026 tournament data has been checked until you run this procedure locally.

## Two-browser workspace-switch acceptance

Before deploying M7, explicitly rehearse a **cross-browser workspace switch**,
not only the same-browser navigation that does a full reload:

1. In authenticated operator browser A, create two named competitions with
   different default category quotas and different 25s / 40s scoring rules.
2. Open browser B (also authenticated as operator) on
   `/setup?step=questions`. Verify B displays the first competition's
   round quotas and scoring.
3. In browser A, switch to the other competition. Without reloading B,
   check B's round quotas and gameplay draft were **reloaded from the new
   workspace**, and that old values cannot be saved to the wrong competition.
4. Repeat for `/setup?step=draw` to confirm stale per-round editor selections
   do not remain visible after activation.
5. Disconnect B temporarily from the LAN, switch competition using A, then
   reconnect B. It must receive the current workspace identity with fresh
   snapshots, without requiring a manual browser reload.
6. Verify the audience display and ranking reflect the active event and the
   original competition remains intact after switching back.

PR #41 adds a physical-SQLite integration test of the activation HTTP route
and its ordered Socket.IO broadcasts for quotas, scoring, title and active ID.
GitHub CI also checks that a **newly connected** operator socket receives
the current active workspace. These automated tests do not replace the
two-browser manual rehearsal.

## Backup checksum acceptance

The event-day Backup check validates both SQLite page integrity and the
SHA-256 of the backup file, rather than relying solely on the stored
metadata and file size. An altered or unreadable backup must show NOT READY,
even if its JSON sidecar has not changed. Create a fresh backup from the
current competition and recheck before the show.

See [M7 security release gates](M7-SECURITY-RELEASE-GATES.md) for remaining
operator/privileged API authorization risks: **do not expose this draft on
an untrusted LAN or public tunnel**.

## Historical results export acceptance

M7 changes the participant type, question duration, scoring mode and number
of questions/categories per round. For **each** saved competition, verify
the exported `/api/export/results.xlsx` contains the actual settings:

- Summary: event title, participant type, real duration, correct-point value,
  scoring mode and points deducted per whole second.
- Ranking: official scores, response time, correct/wrong counts and entrant
  naming appropriate to colleges, teams, departments or classes.
- Rounds: the configured and allocated question count and selected category
  quotas for **each round separately**. The original 10-question format is
  only a historical default; 12 is only an example.
- Submissions/Audit: question response details and whether a submission
  counts in the official revealed result; question replacement must not
  inflate score totals.
- After closing and reopening the rehearsal server, switch to a historical
  competition and export again. Old timing, scoring, result totals and labels
  must remain unchanged.

Automated tests in PR #33 validate 40s fixed/10-point rules, 45s custom
time-decay, per-round 2/3-question plans, team labels and physical SQLite
restart/restore of two competitions. These tests **do not** replace the
manual check against the actual 2026 event copy.

## Acceptance and release gate

Record the exact review commit, CI run, backup checksums, preserved official
totals, and any rehearsal errors. Do not merge if any original result changes,
schema backup fails, or switching causes partial data restoration. When all
checks pass, merge the **stacked PRs in dependency order** into `main` only
after explicit release approval. Deployment to the actual tournament Mac is
a separate, explicitly authorized action.
