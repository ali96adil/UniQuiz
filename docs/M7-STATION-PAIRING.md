# M7 station onboarding — one-time pairing (draft PR #38)

This upgrade removes the need to **distribute permanent team tokens in browser
URLs** to the Windows A/B stations. It is deliberately compatible with
already-configured legacy stations until the real theater rehearsal is done.

## Operator on the Mac

1. Start the **rehearsal** instance with the required private operator
   passphrase (see `M7-OPERATOR-AUTH-SETUP.md`). Keep its database separate and
   OSC disabled. Sign in as operator.
2. Open `/setup` → **Distribution & Readiness** or `/operator`.
   Under **Station Pairing**, press **Generate pairing code** for A or B.
3. The eight digits are valid for **5 minutes**, **one successful redemption**,
   and only the chosen station. A newly generated code replaces the unused
   preceding one for that station. Never project the code on the public
   audience screen or send it to untrusted devices.
4. On the Windows team PC, navigate to `http://<Mac-LAN-IP>:5173/stations`
   for normal trusted-LAN use. In an isolated rehearsal, use the configured
   test proxy address instead. Choose A or B, type the eight digits and
   click **Pair this station**. It then opens `/team/a` or `/team/b`.
5. The station receives a separate **7-day station-scoped session**. This
   credential is bound cryptographically to A or B and expires even if its
   WebSocket stays open. The *pairing code* is never a session credential.
   Unlike the old workflow, **no token is put into a URL**. The station
   browser stores the session token locally and uses it on reconnect.
6. A second PC for the same station can be provisioned separately by issuing
   a new pairing code. Issuing a new code does **not** disconnect already
   paired sessions; the code itself only authorizes onboarding.

## Recovery and live-show safety

- **Do not begin pairing during an active question**. Pair both Windows
  machines before rehearsal; check each authenticated team is shown online.
- An unused pairing code is memory-only and disappears on Mac-server restart.
  Generate a new code. A successfully paired 7-day session keeps working
  after a restart because it is signed with the persistent station secret
  already stored in the database.
- If a team session expires or its browser storage is cleared, open
  `/stations` and pair again. Do not rotate station master credentials during
  an event; doing so invalidates every derived session for that station.
- Legacy static station tokens are still accepted during transition. Old
  long URLs are no longer shown by the operator panel; when one is opened,
  its token is stripped from the address bar and history immediately.
  **The old long-lived token is not revoked by this PR.** It should be rotated
  in a separate, approved migration after both real Windows stations have
  been tested on one-time pairing.
- The public `/stations` screen has no API for listing the master tokens.
  Only an authenticated operator can generate a code; an anonymous station
  can redeem that exact short code but cannot access administrative routes.

## Security boundaries

- Eight-digit codes are securely random and held only as salted SHA-256
  digests in server RAM, valid for five minutes.
- Any one code is disabled after 6 wrong guesses across all source IPs.
  A separate 12-attempt per-IP/10-minute window restricts online guessing.
- A successful redemption consumes the code before a station token is
  created; repeated use fails. A new code supersedes the previous code.
- Derived sessions use an HMAC-SHA256 signature bound to the specific team,
  expiration and random nonce. No new SQLite migrations are required.
- Same-origin check applies to pairing redemption in browsers.
- Stored client-side station tokens are still bearer credentials. A stolen
  station browser profile or injected script could misuse them; isolate the
  LAN and keep station PCs locked down. Do not make these ports public.
- A trusted operator can still retrieve legacy master tokens through the
  protected recovery API. Token rotation and secure cookie-only station
  sessions may be considered in a future phase.

## Acceptance checks

1. Generate A code; redeem on A; connect team-a Socket.IO successfully.
2. Redeem same code again; expect `PAIRING_INVALID_OR_EXPIRED`.
3. Use A session on team-b socket; expect `STATION_AUTH_REQUIRED`.
4. Generate B code; wait over 5 minutes; expect expired-code rejection.
5. Generate code then enter 6 wrong guesses; even the correct code must be
   rejected until operator issues a fresh one.
6. Close/reopen Windows browser and restart only the rehearsal server;
   previously paired station should reconnect during its 7-day term.
7. Run a test round and confirm answers remain private to their station,
   with scoreboard only revealing correct/wrong after the operator's reveal.
8. Confirm audience display remains unauthenticated while operator settings
   stay protected.

GitHub CI exercises most of these cases on temporary data, but **physical
Mac/Windows acceptance on an isolated copy of the official competition
database remains mandatory before merging to `main`.**
