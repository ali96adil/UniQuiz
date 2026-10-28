# Stage official M7 plus rehearsed competitions without changing either source

When the original 2026 M6/v12 database has been independently backed up
and the offline audit reports \`M7_MAC_OFFLINE_AUDIT_OK\`, prepare a **new**
candidate DB by reconciling the migrated **audit copy** (17) with the latest
M7 **rehearsal** (17) snapshot.

Do **not** run this tool on the v12 original production database, and do not
use the output as the production DB without another review.

\`\`\`bash
cd "$HOME/UniQuiz-M7-Review" || exit 1
git fetch origin
git switch feature/m7-staged-data-reconciliation
git pull --ff-only

# This path is printed by the earlier successful offline migration audit.
OFFICIAL_MIGRATED="$HOME/UniQuiz-M7-Rehearsal/audit-ifAcOm/rehearsal-copy.sqlite3"
REHEARSAL="$HOME/UniQuiz-M7-Rehearsal/interactive-wcqAV5/rehearsal.db"
CANDIDATE_DIR=$(mktemp -d "$HOME/UniQuiz-M7-Candidate-XXXXXXXX") || exit 1

python3 scripts/m7_reconcile_official.py \
  --official-migrated "$OFFICIAL_MIGRATED" \
  --m7-rehearsal "$REHEARSAL" \
  --destination "$CANDIDATE_DIR/candidate.db"
\`\`\`

The tool requires BOTH sources to be healthy v17 SQLite databases with
identical complete question and category rows (not just counts). It creates
a WAL-aware snapshot of the rehearsal, preserving **the active workspace's
current materialized tables**. The destination starts from the official
v17 database, keeping its \`legacy\` event tables, original historical scores,
auth data and active workspace unchanged. It adds only the other workspaces
and frozen archives. Every archive's stored rankings must be structurally
valid. It rejects an active round, mismatched bank, missing question
references, pre-existing destination, or unexpected official workspace
state. The final DB gets \`integrity_check\` and \`foreign_key_check\`, and
hashes of *all* previously existing official tables are rechecked. No
app server, OSC transport, or port listener is started.

**Important:** this is an **offline staging step**, not a migration/deploy
script. The user should still inspect the resulting inactive workspaces
and archives before deciding whether experimental competitions belong in the
official installation. A fresh M6 backup remains the rollback anchor.


## Independent read-only candidate verification

Before any runtime test or production deployment, run the independent audit
against the same immutable source databases:

\`\`\`bash
python3 scripts/m7_verify_candidate.py \
  --official-migrated "$OFFICIAL_MIGRATED" \
  --m7-rehearsal "$REHEARSAL" \
  --candidate "$CANDIDATE_DIR/candidate.db"
\`\`\`

Require \`M7_CANDIDATE_INDEPENDENT_CHECK_OK\`. It compares **every original
official table**, the full bank, the original legacy workspace record, the
complete rehearsal-only workspaces (including the active materialized one),
and all historical archives byte-for-byte. It also checks SQLite and foreign
keys for all databases and ensures official \`legacy\` remains active. If
the rehearsal database changes after the candidate is generated, the check
may fail: recreate the candidate from a fresh snapshot instead of copying
rows selectively.

Do not serve the one-time verified candidate DB directly during rehearsal.
First make a separate SQLite backup copy of the candidate and run the test
server on **that new runtime copy**, never the candidate or original.
