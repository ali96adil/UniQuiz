# Repository Map

## Root

`README.md`
Public project overview and agreed core competition behavior.

`package.json`
Root workspace scripts only. Application dependencies belong in their own package.

`pnpm-workspace.yaml`
Declares the monorepo workspaces.

`.gitignore`
Protects local databases, private question data, environment files, build outputs and editor files.

## Planned application structure

```text
apps/
  server/       Authoritative Fastify + Socket.IO + SQLite service
  web/          React/Vite UI for operator, display and team stations

packages/
  shared/       Shared TypeScript contracts, schemas and event types

data/
  examples/     Safe sample/import examples only

docs/
  PROJECT-PLAN.md       Ordered milestones and exit criteria
  CURRENT_STATUS.md     Single resumable checkpoint
  DECISIONS.md          Architecture/product decisions already agreed
  WORKFLOW.md           Branch/PR/checkpoint/CI rules
  REPOSITORY-MAP.md     This file
  architecture.md       Runtime architecture
  competition-rules.md  Official qualification rules

.github/
  ISSUE_TEMPLATE/       Structured implementation/bug issue forms
  PULL_REQUEST_TEMPLATE.md
```

## Ownership boundaries

### apps/server
Owns:
- official competition state;
- authoritative timing;
- answer acceptance;
- scoring;
- ranking;
- session/question locks;
- persistence;
- audit records;
- realtime event publication.

It must never trust a client-computed score or response duration.

### apps/web
Owns presentation and user interaction for:
- setup;
- draw;
- operator console;
- audience display;
- Team A station;
- Team B station.

It does not own official competition calculations.

### packages/shared
Owns stable contracts shared by server and web:
- IDs;
- enums;
- realtime event names and payloads;
- validation schemas;
- public-safe DTOs.

Correct answers must not be included in public/team DTOs before reveal.

## Data policy
Real competition questions, correct answers and live databases stay outside Git-tracked paths.

## Where to look first
When resuming work:
1. read `docs/CURRENT_STATUS.md`;
2. open Issue #8;
3. open the active milestone issue;
4. inspect the active PR;
5. continue only the recorded next action.
