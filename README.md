# UniQuiz — مسابقة بنك المعلومات

Local-first, real-time platform for university knowledge competitions. A Mac
hosts the authoritative server and operator/audience screens; Windows browser
stations submit answers for Team A and Team B. Internet is not required during
a competition.

## Official historical rules and M7 extension

The **original University of Babylon competition** used up to 20 colleges,
two contestants per paired round (one solo team possible), 10 unique questions
per round, 5 categories × 2, 25 seconds per question and 25→1 time-decay
points. Correctness, response time, cumulative score and tiebreak order are
recorded, and final results are announced only when the operator requests it.

**Draft M7 changes are configurable and do not rewrite historical results:**

- Independent named competition workspaces (one live workspace at a time),
  including participant labels for colleges, departments, classes and teams.
- A persistent, shared question bank with distinct editorial and public
  category labels; archived competitions retain their own historical data.
- **1–100 questions per round**, selected from one or several categories.
  A competition-wide default is available, and each drawn round can override
  the category mix and total independently. **12 questions is only an example**.
- **5–300 seconds** per question and fixed or time-decay scoring, configurable
  per competition. The 25-second/25→1 original scoring remains the default.
- Guided five-stage setup for identity/branding, participants, question bank
  and rules, round draw/plans and actual event-day readiness.
- SQLite startup migration creates a protected, verified, WAL-consistent
  database backup before changing any older schema. Migration changes are
  atomic; workspace switching is guarded and transactional.

## Important: M7 is not deployed

All M7 work is currently in **stacked draft PRs**. Review in this order:
[#25](https://github.com/ali96adil/UniQuiz/pull/25) →
[#26](https://github.com/ali96adil/UniQuiz/pull/26) →
[#27](https://github.com/ali96adil/UniQuiz/pull/27) →
[#28](https://github.com/ali96adil/UniQuiz/pull/28) →
[#29](https://github.com/ali96adil/UniQuiz/pull/29) →
[#30](https://github.com/ali96adil/UniQuiz/pull/30) →
[#31](https://github.com/ali96adil/UniQuiz/pull/31) →
[#32](https://github.com/ali96adil/UniQuiz/pull/32) →
[#33](https://github.com/ali96adil/UniQuiz/pull/33) →
[#34](https://github.com/ali96adil/UniQuiz/pull/34) →
[#39](https://github.com/ali96adil/UniQuiz/pull/39) →
[#40](https://github.com/ali96adil/UniQuiz/pull/40) →
[#41](https://github.com/ali96adil/UniQuiz/pull/41) →
[#42](https://github.com/ali96adil/UniQuiz/pull/42) →
[#44](https://github.com/ali96adil/UniQuiz/pull/44).

A green CI check on synthetic data is **not** acceptance for upgrading the
official Mac. Follow the offline rehearsal and original-result verification
steps in [docs/M7-INTEGRATION-REHEARSAL.md](docs/M7-INTEGRATION-REHEARSAL.md)
before approval. Never point an unapproved development build at the original
event database.

## Operator authentication (draft M7)

The server now requires a **privately configured** operator password of at
least 16 characters (environment variable `UNIQUIZ_OPERATOR_PASSWORD`).
Without it the server refuses to start; no insecure/default operator account
is created. The Mac's operator browser logs in through a dedicated form, and
privileged API routes and operator Socket.IO now require an HttpOnly session
cookie. Windows answer stations retain their scoped team tokens, while the
audience display stays read-only.

For password setup, local restart/logout and safe rehearsal instructions, see
[docs/M7-OPERATOR-AUTH.md](docs/M7-OPERATOR-AUTH.md). A successful CI test
**does not make the existing HTTP-only LAN deployment safe to expose** to an
untrusted network or public tunnel; TLS and a deployment-specific security
review remain required.

## M7 real migration CI check (synthetic)

GitHub CI now exercises the real Node M7 SQLite startup/upgrade on an
isolated synthetic v15-marker rehearsal copy, including a historical
`question_position BETWEEN 1 AND 10` table constraint. It checks that the
upgrade widens the constraint, retains the original score and BLOB values,
creates a pre-migration physical backup, and passes the Python preservation
fingerprint verification. Deliberate tampering with the score must fail.

The test uses synthetic data and a representative historical table
constraint; it is **not** a substitute for an offline upgrade rehearsal on
the original October 2026 competition database copy.

## Verify historical data preservation before M7 rehearsal

After creating a WAL-consistent **copy** of the official SQLite database with
`scripts/m7_rehearsal_copy.py`, and **before** first starting M7 on the copy,
capture its original rows using `scripts/m7_rehearsal_verify.py capture`.
Immediately after M7's first startup, before editing any content, run
`scripts/m7_rehearsal_verify.py verify` on that same copied database.
Original questions, scores, participation, archives, images and any custom
user tables are compared using stable SHA-256 fingerprints; raw records do
not appear in the private baseline manifest. See
[the complete read-only Mac procedure](docs/M7-INTEGRATION-REHEARSAL.md).
This check is a **release gate**, not permission to alter original data.

## Cross-browser tournament switching (draft)

Each connected client receives the active workspace ID on initial Socket.IO
connection and after an activation. The setup journey is remounted when that ID
changes, so per-round question quotas, gameplay timing/scoring and editable
local drafts never remain attached to the prior tournament in a second
operator browser tab. See the two-browser acceptance procedure in
[docs/M7-INTEGRATION-REHEARSAL.md](docs/M7-INTEGRATION-REHEARSAL.md).

## Windows team station enrollment (draft)

New station links contain **no bearer token in the URL**. Open
`/team/a` or `/team/b` and enter the team-specific token supplied by the
authenticated operator. If a token is lost or the machine changes, the
operator can rotate it safely **outside active rounds**; old station sockets
are disconnected, and only the corresponding team's token is replaced.
See [docs/M7-STATION-ENROLLMENT.md](docs/M7-STATION-ENROLLMENT.md) for
operational safety limits, migration from old bookmarked URLs and rehearsal
tests. All HTTP-only station tokens remain sensitive on an untrusted LAN.

## Development

Requires Node 24.21+, pnpm 10.17.1, SQLite support through better-sqlite3.

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm dev:rehearsal
```

For a **production-data rehearsal**, use
`scripts/m7_rehearsal_copy.py` to make a read-only, WAL-aware copy and run
the test server on a different local-only port with OSC disabled. See the
rehearsal document for exact commands.

> Real question banks, contestant answers, official results, station tokens
> and database backups must not be committed to Git.
