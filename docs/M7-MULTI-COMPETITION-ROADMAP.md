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

### M7.2 data model

Introduce `competitions(id, name, status, created_at, archived_at, settings_json)` and explicit `competition_id` on participants, rounds, rounds' questions, live results and sponsor/layout settings. Migrating a legacy active competition must create a dedicated competition record; all original row IDs, responses, timings, and scores remain unchanged. Prefer transactional, tested migration with rollback via backup. The central question bank exists independently.

### M7.3 scoring + allocation (implemented in stacked PR #26; draft)

The active competition now stores selected category quotas in `competition_rules.distribution_json`, e.g. `[{categoryKey:'sports_specialist',questions:12}]`, with the previous 5×2 distribution as the default. The allocator, live transitions, operator hotkeys, station view and public pre-show read the dynamic count. Legacy SQLite `position BETWEEN 1 AND 10` constraints upgrade transactionally while preserving answers and scores. Integration tests cover sports-only 12 questions, no repeats and schema upgrade. **Still pending:** per-round overrides, adjustable question duration and scoring strategy, multiple fully independent active competitions, and reusable participant types.

### M7.4 themes and reusable layouts

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
