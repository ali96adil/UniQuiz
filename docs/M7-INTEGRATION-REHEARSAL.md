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

Install and validate the reviewed branch before starting its test runtime:

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

Run the backend in a separate terminal with the rehearsal database and an
isolated loopback-only port. Keep OSC disabled to avoid sending cues to
Ableton, VDMX or competition equipment:

```bash
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
