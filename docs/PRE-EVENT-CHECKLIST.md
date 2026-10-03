# UniQuiz Pre-Event Checklist

Use this checklist on the authoritative Mac before the real competition.

## 1. Choose the correct runtime

Official competition:

```bash
pnpm event:start
```

Rehearsal:

```bash
pnpm event:start:rehearsal
```

The official database is `data/uniquiz.db`. Rehearsal uses `data/uniquiz-rehearsal.db`. The event-start command creates a verified backup before starting UniQuiz.

## 2. Operator verification

Open `/operator` and confirm:

- runtime mode is OFFICIAL for the real event;
- Preflight shows the database, draw and locked question allocation as READY;
- the latest verified backup is listed;
- Display is connected;
- Team A is connected;
- Team B is connected when the next round is paired;
- OSC target is configured when OSC is enabled;
- LAN Diagnostics shows the expected Mac IPv4 address.

## 3. Audience and team stations

- Put `/display` fullscreen on the external audience screen/projector.
- Open authenticated Team A and Team B station links.
- Confirm the visible college assignment before starting the round.
- For a solo round, Team B must appear as not required.

## 4. Show-control check

When OSC is enabled:

- send/observe a rehearsal cue before official scoring begins;
- confirm the receiving show system sees the expected UniQuiz OSC address;
- remember that OSC failure must never alter official scoring.

## 5. Recovery readiness

Before the first official round:

- create one additional verified backup from the Operator Preflight panel;
- verify the backup appears in the list;
- know the offline restore command:

```bash
pnpm ops:restore -- /path/to/backup.db
```

- stop UniQuiz before restore; restore intentionally refuses while the server is running.

## 6. Live safety

- Do not use Station Ready Override unless necessary; a reason is required and audited.
- Emergency Hold during 3-2-1 returns the same question to READY.
- Emergency Hold during an active question closes it and requires VOID + same-category replacement.
- A server restart during an active question follows the same fail-safe replacement path.
- Audience presentation scenes never mutate scores or live competition state.

## 7. End of qualification

- Confirm every round is COMPLETED.
- Confirm the final ranking screen is visible.
- Export the official results/audit workbook.
- Create a final verified database backup before shutting down.

## Hardware acceptance still required

The release is not event-ready until a real-device rehearsal succeeds on:

- authoritative Mac;
- Team A Windows PC;
- Team B Windows PC;
- external audience screen/projector;
- OSC receiver when enabled.
