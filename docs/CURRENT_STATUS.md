# Current Status

Updated: 2026-09-28

## Active milestone
Issue #2 — M1 Foundation & Local Runtime

## Master tracker
Issue #8 — UniQuiz Roadmap & Current Work

## Active branch
`foundation/project-bootstrap`

## Active pull request
PR #1 — Bootstrap UniQuiz monorepo foundation

## Completed
- Repository created.
- Public visibility intentionally retained during development.
- Qualification rules documented.
- Initial architecture documented.
- pnpm monorepo workspace configured.
- Local/private competition data excluded from Git.
- Six milestone issues created (#2–#7).
- Master project tracker created (#8).
- Pull-request and issue templates added.
- Repository map, workflow, decisions and project plan documented.

## In progress
- M1 implementation preparation.

## Next action
Finish PR #1, then start the M1 implementation by scaffolding `apps/server`, `apps/web`, and `packages/shared`. The first target is a locally runnable server/web pair with a health endpoint and realtime client connection.

## Blockers
None.

## Do not repeat
- Do not recreate the repository.
- Do not reintroduce question difficulty levels.
- Do not create separate repositories for server/web/team stations.
- Do not commit real competition questions or correct answers.
- Do not build a knockout qualification bracket.
- Do not open speculative implementation issues unless that work is actually starting.

## Checkpoint format
Every meaningful batch should update this file with:
- completed work;
- verification performed;
- commit/PR references;
- next action;
- blockers, if any.
