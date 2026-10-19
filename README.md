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
- Windows stations can be linked through **one-use eight-digit pairing codes**
  instead of URLs containing permanent tokens. See
  [M7 station pairing](docs/M7-STATION-PAIRING.md) for rollout and legacy
  compatibility.
- Operator administration requires an explicitly configured passphrase and a
  server-side authenticated session; team stations retain independent tokens.
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
[#36](https://github.com/ali96adil/UniQuiz/pull/36) →
[#37](https://github.com/ali96adil/UniQuiz/pull/37) →
[#38](https://github.com/ali96adil/UniQuiz/pull/38).

A green CI check on synthetic data is **not** acceptance for upgrading the
official Mac. Follow the offline rehearsal and original-result verification
steps in [docs/M7-INTEGRATION-REHEARSAL.md](docs/M7-INTEGRATION-REHEARSAL.md)
before approval. Never point an unapproved development build at the original
event database.

## Development

Requires Node 24.21+, pnpm 10.17.1, SQLite support through better-sqlite3.

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
# Server startup now requires UNIQUIZ_OPERATOR_PASSPHRASE (12+ characters).
# See docs/M7-OPERATOR-AUTH-SETUP.md for a secure interactive prompt.
pnpm dev:rehearsal
```

For a **production-data rehearsal**, use
`scripts/m7_rehearsal_copy.py` to make a read-only, WAL-aware copy and run
the test server on a different local-only port with OSC disabled. See the
rehearsal document for exact commands.

> Real question banks, contestant answers, official results, station tokens
> and database backups must not be committed to Git.
