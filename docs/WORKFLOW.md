# Development Workflow

## Branches
`main` is the stable integration branch.

Use one focused branch per active task:
- `foundation/*`
- `feature/*`
- `fix/*`
- `docs/*`
- `test/*`

Examples:
- `foundation/project-bootstrap`
- `feature/participants-draw`
- `feature/scoring-engine`
- `fix/team-reconnect`

## Pull requests
Every implementation branch uses a PR.

A PR must state:
- purpose;
- included changes;
- verification;
- known limitations;
- next step.

Keep a PR focused on one milestone or one coherent task.

## Checkpoints
After each resumable batch:
1. commit working changes;
2. record what was verified;
3. update `docs/CURRENT_STATUS.md`;
4. leave unfinished work clearly identified;
5. avoid starting duplicate work elsewhere.

## Issues
Milestone issues are the high-level source of scope.

Create a separate implementation issue only when:
- the task is actively starting;
- it has meaningful acceptance criteria;
- it can be completed independently;
- or a discovered defect needs tracking.

Do not pre-create dozens of speculative issues.

## CI policy
During early development:
- keep CI minimal;
- batch related changes before triggering CI;
- run fast checks locally when possible;
- add CI only when runnable code and tests exist.

## Definition of Done
A task is Done only when:
- implementation is committed;
- relevant tests/checks pass;
- behavior is verified;
- documentation/status is updated;
- no known blocker is hidden.

## Language
- User-facing competition UI: Arabic.
- Code, types, API names, branches, commits, PRs, issues and technical docs: English.
