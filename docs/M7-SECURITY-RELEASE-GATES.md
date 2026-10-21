# M7 security release gates — current draft status

**Review-only.** The M7 branch contains meaningful operator/station
authentication and public answer masking, but it has not been approved for
an untrusted Wi-Fi network, public tunnel or Internet-facing deployment.
Testing is limited to the local Mac/LAN and isolated synthetic CI servers.
Do not interpret green CI as an audited remote production system.

## Implemented local security protections (stacked M7 PRs)

- **PR #39, operator sessions:** a private password (minimum 16 characters)
  is required before startup. All privileged `/api/*` operations, including
  viewing or rotating station tokens, exports, results, backup and project
  settings, require an authenticated operator session. Operator Socket.IO
  role requires the same valid HttpOnly cookie. Logout revokes sessions and
  established operator sockets; all sessions expire after eight hours.
  Login rate limiting and same-origin checks are included.
- **PR #40, station credentials:** Windows Team A/B stations use separate
  scoped bearer credentials; they do **not** grant operator access. Station
  secrets may be rotated by an authenticated operator only when the
  live session is in a safe state. Rotation immediately disconnects old
  sockets and the old token cannot submit an answer.
- **PR #47, public quiz answers:** the common `/api/live` and
  Socket.IO `live:snapshot` representation uses an explicit field allowlist
  and redaction before publishing. During preparation and countdown,
  the question prompt/options are hidden. During active/closed questions,
  the choices are visible but the correct option and graded results
  remain hidden. The correct answer and team grading are public only in
  `QUESTION_REVEAL`. Per-station private submission receipts are sent to
  their own authenticated Socket.IO room, never the public broadcast.
- **PR #34, verified backup readiness:** backups are checked using SQLite
  page integrity and SHA-256 rather than only relying on file size or
  metadata. A corrupt file does not count toward READY.

These are **draft branch implementations**, not proof of a successful
physical rehearsal or permission for open network exposure.

## CI security tests and their limits

CI currently exercises:

1. Unauthenticated requests to privileged API routes, session login and
   operator Socket.IO role impersonation.
2. Station credential rotation while connected, invalidated old sockets,
   fresh scoped tokens, and unauthorized station/role submissions.
3. The live-question state machine from countdown to Reveal: its public
   API and realtime payloads must not contain the answer key, selected
   team option or graded result until Reveal.
4. A synthetic **real Fastify/Socket.IO server** with clients representing
   an anonymous audience, a self-declared unauthorized operator and
   credentialed Team A/B stations. It checks real wire messages and that
   Team A does not receive Team B's private submission record.

Private station credentials, historical results, and question bank contents
must **never** be published to an issue, test log or shared screenshot.
These tests exercise synthetic records only.

## Remaining blockers before untrusted/remote deployment

1. **Encrypted transport:** provide HTTPS/WSS for operator cookies, station
   tokens and answer submissions. The existing HTTP LAN runtime does not
   encrypt traffic in transit. Do not tunnel or port-forward the draft.
2. **Network origin and proxy validation:** review CORS, forwarded host
   headers, Secure cookies and trust-proxy configuration in the exact
   deployment topology; same-origin safeguards alone are insufficient.
3. **Operator device and credential recovery:** document password reset,
   session expiration, lost device access, station credential enrollment
   and incident handling without deleting results or disabling auditing.
4. **Real hardware and browser rehearsal:** run the reviewed branch
   against a private WAL-consistent copy of the original University 2026
   event database and validate two Windows stations, operator login,
   audience display and results, including disconnect/reconnect.
5. **Disclosure and privacy review:** verify the public audience snapshot
   intentionally exposes only game-state information. Confirm display
   publishing and question category metadata are suitable for the event,
   and review any future added socket events before release.

## Operational boundary until approval

Run only on a trusted isolated LAN. Keep the offline rehearsal server on
`127.0.0.1`, disable OSC for database migration tests and never point the
M7 rehearsal code at the original university contest database.
See [M7 integration and copied-database rehearsal](M7-INTEGRATION-REHEARSAL.md).

A successful backup preflight validates recoverability; it does not prove
full operator authorization, encrypted communication, live-answer secrecy
or successful end-to-end Mac deployment. These are separate release gates.
