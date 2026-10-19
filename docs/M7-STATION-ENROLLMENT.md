# M7 station enrollment and credential rotation

**Review-only: PR #40 stacked on PR #39.** This keeps the existing
authoritative Mac + two Windows browsers architecture, but removes reusable
answer-station bearer tokens from newly generated URLs.

## First enrollment

1. On the Mac, the authenticated operator opens `/operator` or `/setup`
   and finds **Station Access / رموز دخول المحطات**.
2. On Windows Team A, open `http://MAC_LAN_IP:5173/team/a`; Team B opens
   `http://MAC_LAN_IP:5173/team/b`. **Do not append `?token=...`**.
3. On the Mac, reveal/copy the token for the corresponding station and
   transfer it securely to that specific Windows device, over your physically
   trusted isolated network. Team A/B have distinct credentials.
4. Paste it into the Windows station's password-masked enrollment form.
   The token is saved locally only in that browser for reconnect/restart.
   Confirm the operator's station presence shows the right team and answer
   submissions work with a rehearsal question.
5. Screen/display browser `/display` does not need a station token or the
   operator login. Keep the operator credentials only on the operator Mac.

## Lost, replaced or potentially exposed Windows device

The operator can select **إلغاء الرمز وإصدار بديل A/B** and confirm. The
server only permits rotating credentials in `IDLE` or `ROUND_COMPLETE`
with **no active round**. Rotation is **blocked** during live questions,
countdowns, and active rounds. Do not force it during an official question.

The server updates the credential and writes a token-free audit event in
one SQLite transaction. It then disconnects the previous station's Socket.IO
sessions; answer submissions independently validate the currently active
credential to prevent a stale socket from submitting. The old browser removes
its saved token when forcibly disconnected, shows the enrollment form and
requires the replacement. The other team's token is unchanged.

The operator must provide the newly issued token to the correct Windows
device. Rehearse rotation and reconnection with a non-official question.

## Backwards compatibility

Old event bookmarks containing `?token=...` are accepted only to migrate
the saved credential into the team's browser, and the query parameter is
removed from address bar history immediately after opening the page.
However, a token embedded in a historical URL may already have appeared in
request/browser/proxy logs: **rotate that station's token before reusing a
historical link on an untrusted device**. All new UI-generated links are
token-free.

The station token is a bearer credential, not a physical device binding.
It remains in Windows browser localStorage for offline convenience; anyone
with access to that browser profile or copied credential could impersonate
that station until rotation. Use dedicated locked-down Windows station
profiles on a physically trusted, isolated LAN. Current HTTP transport is
not encrypted. HTTPS/WSS and a deployment review are mandatory before
exposing the system outside that network.

## Release acceptance

- Unauthorized HTTP POST to the rotate API returns 401.
- Explicit confirmation string is required; nonexistent stations return 404.
- Rotation in `QUESTION_ACTIVE` or while an ACTIVE round exists returns 409.
- New A token invalidates only old A, with B unchanged.
- No bearer credential appears in audit event payloads, shared question
  exports, new station URLs or preflight screenshots.
- Real WebSocket smoke proves an online station's old session disconnects,
  its old token reauthenticates only as `unknown`, and the new token
  authenticates as `team-a`. B remains authorized.
- Mac original competition database remains untouched until an explicitly
  authorized isolated rehearsal copy is tested.
