# Local Development and LAN Verification

## Prerequisites
- macOS
- Node.js 24.21.0
- Corepack / pnpm 10.17.1

## First install

```bash
cd ~/UniQuiz
git fetch origin
git switch feature/m1-local-runtime
git pull --ff-only
corepack enable
corepack prepare pnpm@10.17.1 --activate
pnpm install
```

## Start UniQuiz

```bash
pnpm dev
```

Expected development services:
- Web: http://localhost:5173
- Server: http://localhost:8787
- Health: http://localhost:8787/health

## Mac routes
- Setup: http://localhost:5173/setup
- Draw: http://localhost:5173/draw
- Operator: http://localhost:5173/operator
- Audience display: http://localhost:5173/display
- Team A: http://localhost:5173/team/a
- Team B: http://localhost:5173/team/b

## LAN verification
Find the Mac LAN IPv4 address, then replace `<MAC_IP>` below.

- Operator: http://<MAC_IP>:5173/operator
- Display: http://<MAC_IP>:5173/display
- Team A: http://<MAC_IP>:5173/team/a
- Team B: http://<MAC_IP>:5173/team/b

The Windows team stations require only a modern browser.

## M1 manual verification checklist
1. Start `pnpm dev` on the Mac.
2. Open `/operator` on the Mac.
3. Open `/display` in a separate browser window.
4. Open `/team/a` from Windows PC A.
5. Open `/team/b` from Windows PC B.
6. Confirm the Operator page reports Display, Team A and Team B as connected without refreshing.
7. Close Team A browser and confirm it becomes disconnected automatically.
8. Reopen Team A and confirm it returns to connected automatically.
9. Open `http://localhost:8787/health` and confirm `ok: true`.

## Notes
- The current M1 pages are intentionally plain placeholders.
- Competition logic, draw, questions, scoring and final broadcast styling come in later milestones.
- The SQLite database is created automatically under `data/uniquiz.db` and is ignored by Git.
