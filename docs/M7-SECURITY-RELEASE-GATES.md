# M7 release security gates — unresolved items

**Status: review-only, not production approval.** This audit identifies risks
in the *existing* local-network operator model that must be reviewed before
exposing UniQuiz to any untrusted Wi-Fi, VPN or Internet interface.

## Operator authentication implemented in PR #36 (draft)

The original LAN system trusted anyone who claimed the `operator`
Socket.IO role and exposed team bearer tokens through an unauthenticated
HTTP endpoint. These were **real pre-release authorization gaps**; no
exploitation of a university event has been observed or asserted.

**PR #36 adds** a mandatory operator passphrase, HttpOnly SameSite=Strict
server-held sessions, login throttling and logout, authorization for all
privileged `/api` endpoints, and a verified operator Socket.IO handshake.
Team A/B still authenticate independently with station bearer tokens.
The public station portal no longer exposes credentials. Unauthorized
operator/team websocket attempts and HTTP admin requests are tested in CI.
Full setup and recovery steps:
[M7 operator login](M7-OPERATOR-AUTH-SETUP.md).

### Remaining gates before Internet/remote operation

1. Complete the full live UI / official Mac rehearsal on an **isolated
   copy** of original results before any code deployment.
2. Validate TLS, the real Mac Vite/reverse proxy, forwarded-cookie security
   and same-origin checks if external connections are ever planned.
3. Replace bearer-token **query URLs** used for first-time station pairing
   with short-lived one-time pairing, to avoid history/link leakage.
4. Define separate Owner vs Operator vs Viewer privileges only if needed
   for future multi-user administration. PR #36 provides one operator
   credential, not a granular per-project permissions model.
5. Audit all data emitted to unauthenticated audience/display sockets before
   operating on untrusted networks.

Even with PR #36, the recommended current deployment is a physically
trusted, isolated LAN. Do **not** publish port 8787/5173 or Socket.IO
through a public tunnel or port-forward merely because CI passed.

## Backup preflight verification (PR #34)

The event-day `Backup` check now validates SQLite `integrity_check` plus
the actual SHA-256 against stored backup metadata before marking READY. A
matching byte length alone was insufficient. The checksum verifier reads
the file in bounded chunks rather than allocating a whole DB-sized buffer.
CI regression tests corrupt a backup without changing its size and alter its
metadata hash. Both must cause **NOT READY** until a newly verified backup
is available.

Backup correctness and operator authorization are **independent**
release checks. Both have draft implementations, but neither replaces the
real Mac/live-network acceptance rehearsal.
