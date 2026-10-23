# UniQuiz M7 — Multi-competition evolution

## Status, 2026-10-18

M7.1 is an additive migration on the `feature/m7-archives-category-display` branch. It does **not** switch the production runtime to a fully multi-competition data model.

### Implemented in M7.1

- Immutable SQLite competition archives containing a historical copy of results, allocated questions, submissions, audit events, sponsor copy, assets, and the question bank snapshot. No station access tokens in archive JSON.
- Read-only archive management UI and downloadable full JSON archive.
- Existing reset route first creates a database backup and saves an archive automatically, then resets the competition while **retaining** the category/question library.
- Category `name` is the editorial/internal label. `display_name` is the public label, with a fallback to `name` for existing records. A sports-specialty internal category can display simply as `رياضة`.
- The public label is used on live question screens, audience pre-show and result export. The operator can edit it independently.
- Category and question Excel imports append/upsert rather than implicitly replace and erase the library.
- Patronage and supervision strings are now editable via audience settings and propagate to pre-show, broadcast header, and printable results.

### Known limitations before M7.2/M7.3

- The competition runtime, draw, ranking and legacy questions allocation are still scoped to one active competition. Historical archives are view/export-only and are *not* runnable competitions.
- The allocator still requires **exactly 5 categories**, **10 questions per round** and two questions per category; live/DB have independent hardcoded 10-position checks. Importing extra categories is supported as library data, but allocating new rounds must wait for M7.3.
- Team labels currently assume colleges and two stations. A generic participant model is a separate migration.
- Archived results should not be mistaken for an operational restore feature; users should retain regular SQLite backups.
- Import with locked legacy question sets is guarded; begin a new competition safely via the archive-and-reset workflow before changing the library.

## M7.2 workspace implementation — PR #27

M7.2 now includes a working **single-active-competition workspace registry**, stacked on M7.3 (PR #26) and M7.1 (PR #25). Legacy 2026 data is automatically registered as the `legacy` workspace without moving or resetting it.

- Administrators can create a blank competition; rename its administrative name; choose participant labels: colleges, departments, classes or teams; or duplicate another competition's **setup without old scores or draw**.
- Inactive competitions are serialized snapshots of their event-scoped SQLite tables. The selected competition is materialized into the application's existing tables, so current live/OSC clients work without maintaining parallel active runs.
- Switching is a single SQLite transaction. Source data is captured first, the target data is restored with foreign keys ON, and the active workspace pointer changes only if restoration succeeds. Database backup is required before switching from the HTTP API.
- The globally shared `categories` and `questions` tables and station credentials remain independent of workspaces.
- Audience sponsors, presentation copy, branding image blobs, rounds, answers, history and results are stored separately for each workspace.
- Switching is refused when a round is ACTIVE or the runtime phase is not IDLE/ROUND_COMPLETE; restoring a target that has an unfinished live session is also refused.
- The existing destructive Reset button has been removed from setup, favoring Create and Switch. Legacy backup/reset API remains available for compatibility.

**Limitations:** Only one competition may be running live at a time; the original DB tables remain physically named `colleges` internally even when teams/departments/classes are shown. The current participant/draw limit of 20 remains. Common question-bank category metadata is shared, including the global default public label, although completed archives preserve the historical text. We still need tests on an offline copy of the actual theater Mac database and a controlled deployment before merging any of the stacked drafts.

### M7.2 data model (normalized long-term option)

Introduce `competitions(id, name, status, created_at, archived_at, settings_json)` and explicit `competition_id` on participants, rounds, rounds' questions, live results and sponsor/layout settings. Migrating a legacy active competition must create a dedicated competition record; all original row IDs, responses, timings, and scores remain unchanged. Prefer transactional, tested migration with rollback via backup. The central question bank exists independently.

### M7.3 scoring + allocation (implemented in stacked PR #26; draft)

The active competition now stores selected category quotas in `competition_rules.distribution_json`, e.g. `[{categoryKey:'sports_specialist',questions:12}]`, with the previous 5×2 distribution as the default. The allocator, live transitions, operator hotkeys, station view and public pre-show read the dynamic count. Legacy SQLite `position BETWEEN 1 AND 10` constraints upgrade transactionally while preserving answers and scores. Integration tests cover sports-only 12 questions, no repeats and schema upgrade. **Still pending after M7.4:** adjustable question duration and scoring strategy, multiple simultaneously live competitions, and removing the current 20-participant draw limit.

### M7.4 independent per-round plans — PR #28 (draft)

**The number 12 is only an example, never a fixed or mandatory count.** The competition default can specify 1–100 questions from one or multiple categories, and **each drawn round may independently override** the categories and counts (e.g. round 1: 5 sports; round 2: 12 sports + 3 geography; round 3: 20 sports).

- Optional `qualification_round_rules(round_id, distribution_json)` stores per-round quotas. Existing rounds without overrides inherit `competition_rules`.
- Operator screen shows a per-round plan editor with a revert-to-default action; edits are blocked once a round has a locked question set or has started.
- Allocation pools all categories used across rounds, sums required inventory, randomly distributes only unused questions, and rejects insufficient inventory before inserting any sets.
- `LiveSessionManager` reads the prepared round's own question count for 3-2-1 sequencing, question bounds, question counters and final reveal/round completion.
- Audience pre-show displays varying question counts correctly. Excel inventory warnings use the sum of the actual planned quotas rather than a hard-coded 2×roundCount.
- Round rules are included in historical archives, retained by workspace switching, and have a backward-compatibility fallback for M7.2 saved workspaces.
- Integration tests cover a single competition's 5/15/20-question rounds, multiple categories, no repeats, count validation and locking.

The validated user-configurable limit is currently 1–100 questions per round for operator safety and practical performance. This is an implementation range, **not a requirement to choose 12**. Changing the time limit or scoring independently is a separate upcoming feature.

### M7.5 timing and scoring per competition — PR #29 (draft)

Gameplay settings are stored independently from category/round distributions in `competition_gameplay_rules`. They belong to the active competition workspace, copy across Setup Duplicate, survive switching and are retained in archival snapshots.

- `durationSeconds`: integer **5–300**; the legacy competition remains **25 seconds** by default.
- `scoringMode="time_decay"`: score starts at `correctPoints` (1–1000), subtracts `pointsLostPerSecond` (0–100) after each **whole elapsed second**, and has minimum 1 point if correct before timeout. The old 25-to-1 rule is therefore reproduced exactly with 25 points and loss 1/sec.
- `scoringMode="fixed"`: each correct answer before the deadline earns `correctPoints`, regardless of response time. Wrong, unanswered and too-late answers always yield zero.
- Server authoritative monotonic clock, submission cut-off, the configured deadline published to clients, OSC start payload, recorded scoring, tiebreak time and public pre-show text all share these rules.
- Setup UI and API reject invalid settings and prevent changes once a competition round has started, so changing the rules cannot retroactively alter a partial ranking.
- Legacy 25-second behavior remains unchanged for existing datasets; older workspace snapshots without the new table receive the defaults.
- Automated tests include compatibility, 45-second time decay, 60-second fixed points, 40-second live deadline, score computation, ranking tiebreaks, API validation/locking and workspace isolation.

**Boundary:** Duration and scoring are configurable **per competition**. Round-specific question counts and categories are supported in PR #28. Round-specific time/scoring overrides are not part of this phase and should be added only with safe locking and historical transparency.

### M7.6 guided tournament setup — PR #30 (draft)

The `/setup` screen now provides five clear stages for operators and organizers, with a responsive visual progress tracker, explicit Next/Back controls, a deep link for each stage (`?step=identity`, `participants`, `questions`, `draw`, `readiness`) and an optional **Show all settings** view for advanced users. Existing APIs, station behavior and official scoring logic are unchanged.

1. **Competition and branding:** choose/create/clone a competition, set participant type, event title, patronage, logos and pre-show identity.
2. **Participants:** enter and select participants (colleges, departments, classes or teams) and lock the selected lineup.
3. **Questions and rules:** import/manage the shared question bank, public category labels, competition-wide question counts, time limit and scoring scheme.
4. **Draw and round plans:** generate/present the official draw and optionally choose different question totals/category allocations per round.
5. **Allocation and event-day preflight:** allocate and lock nonrepeating questions, generate verified backups, verify station links/presence, OSC and display readiness, and then proceed to the operator screen.

The UI progress check is **advisory**, not an authorization to begin live rounds. A stage is marked provisionally complete based on locally available setup snapshots; actual safety/readiness is confirmed only through the existing **server-side** `/api/operations/preflight`. Existing operator/draw routes continue working, and no extra live-session mutations are introduced.

The shared progress model has regression tests for fresh competitions, missing identity, participant lock, question inventory, draw and allocation, including verification that allocated questions do *not* automatically imply event-day READY.

### M7.7 themes and reusable layouts

Each competition gets editable title, logo, sponsor identity, colors, animation and pre-show pages, using presets. Reuse proven permissively licensed components rather than importing unrelated quiz frameworks wholesale:

- `omgovich/react-colorful` — MIT — candidate for a theme color picker.
- `clauderic/dnd-kit` — MIT — candidate for drag/drop ordering.
- `i18next/react-i18next` — MIT — candidate if localization and multiple label languages are later required.

Do not add dependencies until there is a matching feature and license/security review.

### External question sources

Potential opt-in import sources after license review:
- `uberspot/OpenTriviaQA` — CC BY-SA 4.0; requires attribution/share-alike compliance.
- `opentdb.com` — CC BY-SA 4.0; internet-only import stage, never a live-show dependency.
- `thetriviaapi.com` — CC BY-NC 4.0 free non-commercial data; incompatible with commercial reuse without additional rights.

Imported facts must be checked, translated and rewritten to suitable Iraqi university competition difficulty; deduplicate, track source URLs/attribution, and keep official answer keys private. A public repository with answers is unsuitable for ranked competitions with important prizes.

## Deployment invariant

Never deploy over the 2026 University of Babylon official results before `pnpm ops:backup`, CI green and a restore/migration rehearsal. Do not merge this draft PR until the live computer's database has a verified backup.
