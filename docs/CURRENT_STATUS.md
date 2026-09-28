# Current Status

Updated: 2026-09-28

## Active milestone
Issue #2 — M1 Foundation & Local Runtime

## Master tracker
Issue #8 — UniQuiz Roadmap & Current Work

## Active branch
`feature/m1-local-runtime`

## Active pull request
PR #9 — M1: Foundation & Local Runtime

## Completed
- Repository created.
- Public visibility intentionally retained during development.
- Foundation PR #1 merged to `main` as squash commit `ad5990353c36d555fe8decfd0fc0defa200652f5`.
- Qualification rules documented.
- Initial architecture documented.
- pnpm monorepo workspace configured.
- Local/private competition data excluded from Git.
- Six milestone issues created (#2–#7).
- Master project tracker created (#8).
- Pull-request and issue templates added.
- Repository map, workflow, decisions and project plan documented.
- Dedicated M1 branch and Draft PR #9 created.

## In progress
- M1 implementation.

## Next action
Scaffold `apps/server`, `apps/web`, and `packages/shared`. First verified checkpoint: one local command starts server + web, exposes a health endpoint, and establishes realtime browser connectivity.

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
