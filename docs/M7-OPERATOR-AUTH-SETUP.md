# M7 operator login — deployment and recovery

**Status: draft PR #36. Do not upgrade the official event until the real
database-copy rehearsal passes and an operator passphrase has been configured.**

The M7 server requires an operator passphrase of at least 12 characters
**before opening or migrating any SQLite database**. This is a deliberate
fail-closed design. There is NO default password or anonymous operator role.

## First-time local setup on Mac

Use the Terminal attached to the **rehearsal copy**, with OSC disabled:

```bash
# Use a fresh private terminal, not a recorded shell history.
read -s "UNIQUIZ_OPERATOR_PASSPHRASE?Operator passphrase: "
echo
export UNIQUIZ_OPERATOR_PASSPHRASE
export UNIQUIZ_MODE=rehearsal
export UNIQUIZ_DB_PATH="$HOME/UniQuiz-M7-Rehearsal/rehearsal.db"
export UNIQUIZ_HOST=127.0.0.1
export UNIQUIZ_PORT=8788
export UNIQUIZ_OSC_ENABLED=false
pnpm --filter @uniquiz/server dev
```

The example uses a macOS zsh `read -s` prompt, so the passphrase is neither
echoed to the terminal nor written in the command itself. Do not put the
passphrase in a Git-tracked `.env` or share it in chat/screenshots.

The web UI uses the same-origin API proxy. When rehearsing on port 8788,
configure both `/api` **and** `/socket.io` to that isolated server:

```bash
UNIQUIZ_API_PROXY_TARGET=http://127.0.0.1:8788 \
  pnpm --filter @uniquiz/web dev -- --host 127.0.0.1 --port 5174
```

Open `http://127.0.0.1:5174/operator`. On the operator's browser, enter the
configured passphrase. A randomly generated session ID is stored in an
`HttpOnly; SameSite=Strict` cookie lasting up to 12 hours. Browser JavaScript
cannot read the cookie value; the server holds its SHA-256 digest. Restarting
the server clears sessions, so a login is needed again. Logging out
immediately invalidates the session.

### Team station and display behavior

- The two Windows team stations still use their own per-station bearer tokens
  to submit answers. Those credentials are available **only** on the
  authenticated operator setup screen.
- `/stations` is intentionally public but no longer returns or embeds bearer
  tokens automatically. The operator provides each station's unique link
  during provisioning. Returning to `/team/a` or `/team/b` afterwards works
  if the station browser saved its token previously.
- `/display`, public ranking/live endpoints and spectator updates do not
  require operator login. They cannot claim the operator socket role.
- Protect the initial station-token provisioning URLs because they contain
  secrets. Long-term roadmap: replace query-token links with one-time pairing.
  Until then, keep the competition LAN private.

## Loss of access, rotation and event-day recovery

An administrator with access to the Mac server process can stop the server
**outside the active competition**, set a new
`UNIQUIZ_OPERATOR_PASSPHRASE` in the secure startup environment, and restart.
This immediately invalidates all old in-memory sessions. It does **not**
clear participants, rankings, question sets, station credentials or
competition archives. If the passphrase is missing or too short, the server
will refuse startup before touching the database.

During an active show, do not rotate passphrases or restart the server merely
to recover a logged-out browser unless the operator deliberately enters a
safe hold/recovery procedure. Keep a second *authenticated* operator window
ready on the trusted Mac if needed.

## Authorization and limitations

- All privileged `/api` requests require the server-side operator session,
  including reading station tokens, setup, import, scoring, results exports,
  archives, backups, OSC tests and workspace changes.
- Operator Socket.IO connections require the same session. Team A/B sockets
  still validate their separate station credentials. Invalid or unknown
  roles do not connect.
- Failed passphrase attempts are throttled (8 per source IP per 10 minutes).
- The cookie is marked `Secure` for direct HTTPS connections. The local
  rehearsal uses loopback HTTP. If a reverse proxy or TLS terminator is
  introduced later, retest Secure cookies, origin checks and forwarded headers;
  **do not expose these ports on the public Internet yet**.
- This implementation protects administrative actions, but the spectator
  Socket.IO event stream is still broadcast on the local network by design.
  It must not carry confidential data. Review event payloads before enabling
  remote access.
- There is currently a single operator credential for this local-first
  system, not separate Owner/Editor/Viewer permission tiers. Granular roles
  are future work and should not be inferred from this login.

Keep the network physically trusted and isolated until the full release audit
(including the rehearsal database migration and end-to-end UI tests) passes.
