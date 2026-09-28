# Architecture

## Goals
UniQuiz is a local-first realtime competition system designed to keep operating even if internet access is unavailable.

## Runtime
- Mac: authoritative server, operator console, database, realtime event hub.
- Audience display: fullscreen browser route driven by the Mac.
- Team A PC: browser-only answer station.
- Team B PC: browser-only answer station.

## Planned routes
- /setup
- /draw
- /operator
- /display
- /team/a
- /team/b

## Planned stack
- TypeScript
- Node.js
- Fastify
- Socket.IO
- React
- Vite
- SQLite
- pnpm workspaces

## Trust model
The server is authoritative for:
- question lifecycle;
- timing;
- answer acceptance;
- scoring;
- ranking;
- session state;
- audit log.

Clients must never calculate authoritative scores or deadlines.

## Data security
Real competition question banks and correct answers are local runtime data and must not be committed to GitHub.
