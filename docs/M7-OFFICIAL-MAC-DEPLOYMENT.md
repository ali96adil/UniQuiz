# UniQuiz M7 — official Mac deployment and data rollback

**Status (23 Oct 2026):** code merged; **NOT YET DEPLOYED** to the original
University 2026 database. This guide is a fail-closed, staged operator
procedure. Keep the existing M6 Mac runtime and original DB unchanged
until stages 0–2 have passed and the operator explicitly starts stage 3.
No command in stages 0–2 upgrades or writes the original SQLite database.

## Tested software

- M7 \`main\` merge \`0b096edf2fd07dbe2cd3213bc7fb040b9ba19ec2\`
  (final CI pass: [39953557405](https://github.com/ali96adil/UniQuiz/actions/runs/39953557405)).
- Restore was previously proven only with an **isolated destination**.
  This does not make a destructive restore of the original live database safe.
- Pre-M7 code checkpoint:
  \`release/m6-main-before-m7-20261023\`
  at \`e2ad217792314d09e5d051307190c7c2276afce9\`.
  Git branches never contain a safe backup of private SQLite data.

## Stage 0 — identify the official runtime and source DB (READ ONLY)

Run the following commands in macOS Terminal:

\`\`\`bash
printf '=== OFFICIAL 8787 LISTENER ===\n'
lsof -nP -iTCP:8787 -sTCP:LISTEN || true

printf '\n=== OFFICIAL HEALTH ===\n'
curl --silent --show-error --max-time 3 \
  http://127.0.0.1:8787/health || true
printf '\n\n=== REVIEW HEALTH ===\n'
curl --silent --show-error --max-time 3 \
  http://127.0.0.1:8788/health || true
printf '\n\n=== DB CANDIDATE ===\n'
ls -lh "$HOME/UniQuiz/data/uniquiz.db" \
       "$HOME/UniQuiz/data/uniquiz.db-wal" \
       "$HOME/UniQuiz/data/uniquiz.db-shm" 2>/dev/null || true
printf '\n=== PROCESS COMMANDS (NO ENV PASSWORDS) ===\n'
ps -axo pid,command | grep -E '[u]niquiz/server|[d]ist/index.js|[t]sx.*index.ts' || true
\`\`\`

The historical official DB candidate is \`~/UniQuiz/data/uniquiz.db\`,
**but an operator may have overridden** \`UNIQUIZ_DB_PATH\`. If the running
service uses a different DB path, resolve it from the service configuration
before proceeding. A seemingly valid local \`.db\` may not be the live DB.
Never copy private SQLite or password data into public GitHub.

## Stage 1 — independently back up the VERIFIED official database (READ ONLY TO SOURCE)

Only after verifying the actual source DB from Stage 0:

\`\`\`bash
# Replace only if the live service uses a different confirmed path.
export UNIQUIZ_OFFICIAL_SOURCE="$HOME/UniQuiz/data/uniquiz.db"

cd "$HOME/UniQuiz-M7-Review" || exit 1
test -s "$UNIQUIZ_OFFICIAL_SOURCE" || {
  echo "OFFICIAL_SOURCE_MISSING"; exit 1;
}

umask 077
export UNIQUIZ_OFFICIAL_SAFE_DIR
UNIQUIZ_OFFICIAL_SAFE_DIR="$(mktemp -d "$HOME/UniQuiz-M7-Official-Backup-XXXXXXXX")" || exit 1
export UNIQUIZ_OFFICIAL_SAFE_DIR

python3 scripts/m7_rehearsal_copy.py \
  --source "$UNIQUIZ_OFFICIAL_SOURCE" \
  --destination "$UNIQUIZ_OFFICIAL_SAFE_DIR/official-before-m7.db" || exit 1

shasum -a 256 "$UNIQUIZ_OFFICIAL_SAFE_DIR/official-before-m7.db"
printf 'OFFICIAL_PRE_M7_BACKUP_DIR=%s\n' "$UNIQUIZ_OFFICIAL_SAFE_DIR"
\`\`\`

This uses SQLite's WAL-aware backup API, captures committed transactions,
runs \`integrity_check\` and \`foreign_key_check\`, hashes the copy, and
does not overwrite the source. Keep another copy on a separate physical disk
or protected offline storage before starting Stage 3. This newly backed-up
file is the recovery artifact; do not rely on a Git branch or the rehearsal
DB for recovery.

## Stage 2 — verify the fresh standalone backup (NEVER POINT TO ORIGINAL)

Check the source copy's history BEFORE migration and save its hash output.
Commands below inspect the backup **without** opening the original DB
writable:

\`\`\`bash
python3 - "$UNIQUIZ_OFFICIAL_SAFE_DIR/official-before-m7.db" <<'PY'
import sqlite3, sys
from pathlib import Path
from urllib.parse import quote

path = Path(sys.argv[1]).resolve()
db = sqlite3.connect("file:" + quote(str(path)) + "?mode=ro", uri=True)
assert db.execute("PRAGMA integrity_check").fetchone() == ("ok",)
assert db.execute("PRAGMA foreign_key_check").fetchall() == []
table_names = {r[0] for r in db.execute(
    "SELECT name FROM sqlite_master WHERE type='table'"
)}
def rows(name):
    return (db.execute('SELECT COUNT(*) FROM "' + name + '"').fetchone()[0]
            if name in table_names else "N/A")
version = (db.execute(
    "SELECT value FROM app_meta WHERE key='schema_version'"
).fetchone() if "app_meta" in table_names else None)
print("BACKUP_INTEGRITY=ok")
print("SCHEMA_VERSION=", version[0] if version else "unknown")
for name in ("colleges", "participants", "qualification_rounds",
             "qualification_round_questions", "live_submissions",
             "competition_workspaces", "competition_archives"):
    print(name, rows(name))
print("BACKUP_VALIDATION_OK")
db.close()
PY
\`\`\`

For M6/v12 official databases, run the already-tested offline audit
\`node scripts/m7-mac-offline-audit.mjs --source "$UNIQUIZ_OFFICIAL_SOURCE"\`
on a fresh copy if the source has changed since the last rehearsal. The
audit **must** report \`M7_MAC_OFFLINE_AUDIT_OK\`. It expects v12 and is not a
general-purpose verifier for an already-upgraded v17 source.

## Stage 3 — authorized maintenance window (NOT AUTOMATED HERE)

Prerequisites: Stage 0 confirmed the *actual* authoritative DB, Stage 1
saved the snapshot off the runtime directory, Stage 2 passed,
an **additional independent offline copy** is protected, no tournament
or answer station is active, and the M6 restart/rollback procedure is known.

1. Stop the old official service gracefully and confirm ports and DB
   writers are stopped. Do not overwrite files in the running M6 checkout.
2. Build \`main\` as a **separate release checkout**. Do not use the M7
   rehearsal DB, and do not assume the checkout's default relative
   \`data/uniquiz.db\` is the right production data path.
3. Take a final WAL-consistent SQLite backup after all writes have stopped.
4. Start M7 explicitly against the *confirmed absolute* DB path with
   \`UNIQUIZ_MODE=official\` and a privately entered operator password.
   Startup's M7 v17 migration **does write** to the original official DB.
5. Verify SQLite \`integrity_check\`, \`foreign_key_check\`, original 2026
   rankings/scores/times, logo BLOBs, safe station pairing, audience
   redaction, OSC reception and archived PDF. Do not host an active
   event until all gates pass.

This is intentionally a separately executed stage, not an unattended
deployment script; a wrong path or interrupted migration can affect the
only authoritative tournament history.

## Rollback if post-upgrade verification fails

- Stop ALL M7 app processes and confirm no process has the DB open.
- Preserve the failed upgraded DB as a forensic snapshot in a **separate**
  location first; avoid overwriting the known-good pre-upgrade backup.
- Restore the *verified pre-M7 DB snapshot* to the actual official DB
  **while the server is stopped**, including safe handling of its WAL/SHM
  files. The existing \`ops:restore\` can create a \`pre-restore\` safety
  backup but must NOT run while the authoritative DB is open.
- Restart the *old M6 code checkout* from the release checkpoint. M6 must
  not open an M7 schema v17 database. Restore code **and matching data**;
  reverting Git alone is not rollback.
- Validate the historical results and operator readiness before allowing
  an event.

No original database files, credentials or backup contents belong in git,
GitHub issues, screenshots or chat logs.
