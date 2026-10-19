# M7 release security gates — unresolved items

**Status: review-only, not production approval.** This audit identifies risks
in the *existing* local-network operator model that must be reviewed before
exposing UniQuiz to any untrusted Wi-Fi, VPN or Internet interface.

## Current network trust model

The authoritative Fastify server defaults to listening on `0.0.0.0:8787`.
Two Windows answer stations are authenticated at the Socket.IO team role
through per-station access tokens. However, the same authentication **does not
currently cover all operator functionality**:

- `GET /api/stations/credentials` returns both answer-station bearer tokens
  without verifying an operator secret.
- The Socket.IO roles `operator` and `display` currently accept a role label
  without an operator authentication challenge. Station authentication alone
  therefore does not authenticate an operator.
- Routes which create/switch/archive/reset competitions, edit question-bank
  rules or request backups currently rely primarily on workflow state and
  explicit confirmation strings, rather than a separate authenticated
  operator identity.
- A proxy running on the same Mac can forward requests from a remote browser.
  Consequently, restricting sensitive Fastify routes to a loopback **socket
  address alone** would not be sufficient without validating the original
  caller and providing proper authentication.

These are release security **gaps**, not evidence of unauthorized access.
No attack on an actual University competition has been observed or asserted.

## Required hardening before remote exposure

1. Define and enable explicit, revocable operator credentials and privileges
   for **both** HTTP mutations and privileged Socket.IO events. Apply the
   same policy to the team credential issuance/view endpoint.
2. Make the operator interface authenticate before it can view station tokens
   or send state-changing requests. Avoid putting bearer tokens in URLs,
   Git, browser-accessible audience pages or exported archives.
3. Add tests confirming an unauthenticated/answer-station user cannot alter
   competitions, question sets, scoring, final results, backups or credentials.
4. Validate behind the actual operator UI/reverse proxy, so remote access
   cannot accidentally become trusted merely because a Mac forwards requests.
5. Keep an explicit session rotation/recovery process for lost operator access
   that does not require deleting contestant results.

## Interim deployment boundary

Until those gates are implemented and tested, operate only on a **physically
trusted, isolated LAN**. Do not publish port 8787/5173 or Socket.IO through a
public tunnel or port-forward, and do not treat team station tokens as
protecting operator permissions. The offline rehearsal in
`docs/M7-INTEGRATION-REHEARSAL.md` remains loopback-only with OSC disabled.

## Backup preflight verification (PR #34)

The event-day `Backup` check now validates SQLite `integrity_check` plus
the actual SHA-256 against stored backup metadata before marking READY. A
matching byte length alone was insufficient. The checksum verifier reads
the file in bounded chunks rather than allocating a whole DB-sized buffer.
CI regression tests corrupt a backup without changing its size and alter its
metadata hash. Both must cause **NOT READY** until a newly verified backup
is available.

This protects backup correctness but **does not** resolve the separate
operator authorization gaps above. Do not equate a green backup preflight
with authorization of connected devices or administrators.
