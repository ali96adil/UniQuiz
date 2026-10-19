# M7 operator authentication — draft acceptance guide

This PR adds a separate login for the UniQuiz operator. **It is not approved
for public Internet exposure.** Only test it with a private copied database and
the existing isolated LAN / localhost rehearsal process.

## Private password setup

The M7 server now **refuses to start** if `UNIQUIZ_OPERATOR_PASSWORD` is
missing or shorter than 16 characters. Choose a **unique strong secret**
preferably 24+ random characters, never a university/default/shared test
password. Configure it privately in the local Mac process environment (or
a private OS service environment). Do **not** commit it to Git, paste it in
public issues or put it in the browser's URL. The sample `.env.example`
does not include a working password.

For an isolated terminal rehearsal, use an interactive prompt so the secret
does not appear in shell history. The example assumes you already set up the
separate rehearsal DB path and disabled OSC as in
`docs/M7-INTEGRATION-REHEARSAL.md`:

```bash
read -r -s -p 'Unique UniQuiz operator password: ' UNIQUIZ_OPERATOR_PASSWORD
echo
export UNIQUIZ_OPERATOR_PASSWORD

UNIQUIZ_MODE=rehearsal \
UNIQUIZ_DB_PATH="$HOME/UniQuiz-M7-Rehearsal/rehearsal.db" \
UNIQUIZ_HOST=127.0.0.1 \
UNIQUIZ_PORT=8788 \
UNIQUIZ_OSC_ENABLED=false \
pnpm --filter @uniquiz/server dev

# After you stop the rehearsal:
unset UNIQUIZ_OPERATOR_PASSWORD
```

The password environment must still be present when starting the authoritative
server through its normal service. Changing the private password and restarting
the server invalidates all old login sessions; no official competition scores
or station credentials are erased.

## Operator and stations

- `/setup`, `/operator`, `/draw`, `/archives`, `/stations`, the
  printable `/report` and the home operator screen show a password login.
- On success the server issues a random 8-hour **HttpOnly, SameSite=Strict**
  cookie. The browser does not put the password/session in localStorage, and
  operator Socket.IO is bound to the authenticated cookie. Sessions are
  memory-only and intentionally lost on server restart.
- The server protects all privileged `/api/*` routes including team-token
  retrieval, competition changes, scoring, backup, import, reveal, archive,
  export, and reset. Public `GET` access is limited to event presence/live
  summaries, leaderboard and competition metadata.
- The audience display stays public/read-only. Windows team answer stations
  keep their separately scoped station access tokens; these **cannot grant
  operator access**.
- Logout invalidates the cookie and disconnects matching operator Socket.IO
  clients. New privileged actions need a fresh login.
- Five bad login attempts from one source IP in ten minutes are blocked
  temporarily; intentional lockout is temporary. Authentication uses scrypt
  verification with timing-safe comparison.

## Boundary before release

- Keep the network isolated and physically trusted: this local HTTP system
  **does not encrypt cookies/passwords in transit**. A future public/remote
  deployment requires HTTPS/WSS, secure cookie handling through trusted proxy,
  additional connection-origin controls and review of all read-only realtime
  payloads. Do not use a public tunnel to bypass this requirement.
- This first phase has one operator/admin role, not a multi-user permission
  hierarchy. Per-user roles, audit ownership and password rotation UI
  are separate possible extensions.
- Before approving, test a fully copied official DB, every station browser,
  the audience display and the logout/restart process with real operators.

## CI tests

The new operator-auth regressions check that unauthenticated requests cannot
retrieve station credentials or mutate setup/scoring or access archive data;
authenticated sessions can; logout revokes access; cross-site writes are
rejected; brute force is rate-limited. The GitHub Actions smoke explicitly
logs in and verifies that the realtime operator role works with a cookie,
then logs in again after restarting the server to prove competition persistence.
