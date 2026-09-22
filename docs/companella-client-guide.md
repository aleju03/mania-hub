# Companella client guide

What a native client has to implement to send completed osu!stable mania plays
to Mania Hub. Nothing here needs write access to either repository: the contract
is the public HTTP API in `companella-api.openapi.yaml`, and
`scripts/companella-test-client.mjs` in the Mania Hub repo is a working
reference implementation of every step below.

The page client authors are actually sent is `/companella/docs`
(`src/routes/companella_.docs.tsx`), a plainer web version of this guide that
also serves the spec and the reference client. Change the two together.

## Split of responsibilities

**Mania Hub provides:** account approval and the consent screen, credential and
proof validation, durable submission endpoints, missing-file negotiation, all
server-side validation, chart identification, every difficulty and skill
calculation, the owner's views, revocation, limits, and status and error
semantics.

**Companella implements:** native key storage, opening the browser and receiving
the loopback callback, associating a finished play with its replay and chart
file, account-aware capture, supplying the complete replay, hashing the raw
bytes, uploading a missing chart when asked, a persistent queue with retries,
and the connection and submission UI.

Companella must **not** compute a server family id, a Mania Hub rating, or any
value the server would have to trust. Those fields are rejected by the manifest
validator rather than ignored.

## 1. Connecting

Authorization code + PKCE S256 + DPoP key binding, external browser, loopback
redirect. Start from `GET /api/integrations/companella/v1/capabilities`, which
tells you the issuer, the authorization and token endpoints, the supported
scopes and algorithms, and the current limits.

1. Generate a P-256 key pair. Keep the private key non-exportable where the
   platform allows it; this is the client's own responsibility, and the server
   records nothing about how it is stored.
2. Bind a loopback listener on an ephemeral port. Only `127.0.0.1` and `[::1]`
   are registered; `localhost` is deliberately not accepted (RFC 8252 §8.3).
   The path is exactly `/companella/callback`.
3. Create a fresh PKCE verifier and a `state` value for this attempt.
4. Open the system browser at:

```
{issuer}/companella/authorize
  ?client_id=companella
  &response_type=code
  &redirect_uri=http%3A%2F%2F127.0.0.1%3A{port}%2Fcompanella%2Fcallback
  &state={state}
  &code_challenge={S256(verifier)}
  &code_challenge_method=S256
  &scope=companella%3Ascores%3Asubmit%20companella%3Asubmissions%3Aread%20companella%3Acharts%3Aupload%20companella%3Ainstallation%3Aread
  &dpop_jkt={RFC7638 thumbprint of your public JWK}
```

5. The user signs in with osu! if needed, names the installation, and approves.
   Approval covers both the plays and, when the site does not already hold a
   chart, the `.osu` behind them.
6. The browser hits your callback. Verify `state`, close the listener, and stop
   listening. On approval it carries `code`; if the user pressed Cancel it
   carries `error=access_denied` instead (RFC 6749 §4.1.2.1), so do not wait
   for a code that will never come. A request nobody answers expires after 10
   minutes with no callback at all.
7. Exchange the code:

```http
POST /api/integrations/companella/v1/oauth/token
DPoP: <proof for POST on this URL, no ath>
Content-Type: application/json

{"grant_type":"authorization_code","code":"…","code_verifier":"…",
 "client_id":"companella","redirect_uri":"http://127.0.0.1:{port}/companella/callback"}
```

The response carries an access token (5 minutes), a refresh credential, the
scope, and the installation id.

If the exchange response is lost, start authorization again. Reconnecting the
same approved key on the same account reuses the existing installation rather
than creating a second one.

## 2. Proofs

Every request carries `Authorization: DPoP <access-token>` and a **fresh**
`DPoP` proof. The proof is a compact JWS:

- Header: `{"typ":"dpop+jwt","alg":"ES256","jwk":{public JWK}}`. A private JWK
  (`d` present) is refused.
- Payload: `jti` (unique per request), `htm` (the method), `htu` (the **public**
  endpoint URL with query and fragment stripped), `iat` (seconds), `ath`
  (base64url SHA-256 of the access token) on resource requests, and `nonce` when
  the server has issued one.
- Signature: ES256 over `header.payload`, as **raw r||s**, not DER.

`htu` is the public URL your client called. Never a proxy's internal address.

Timing: a proof may be at most 60 seconds old and at most 30 seconds in the
future. The `jti` is single use. A `DPoP-Nonce` response header should be used
in the next proof; a nonce stays valid for a few minutes and is reusable in that
window, so parallel uploads do not have to serialise.

On a nonce challenge: re-sign with the nonce and retry once. A retry after a
network failure uses the **same idempotency key and the same bytes**, but always
a **new proof**.

## 3. Submitting a play

Capture only completed native osu!stable mania plays with a complete usable
replay. Exclude replay playback, spectating, previously displayed results, and
autoplay. The server still validates everything, because a client claim is not
evidence, but filtering client-side saves both sides a round trip.

### Reserve

```http
POST /api/integrations/companella/v1/submissions
Authorization: DPoP <access-token>
DPoP: <fresh proof>
Idempotency-Key: <persistent UUID for this local play>
Content-Type: application/json

{"protocol_version":1,"client_version":"companella/1.2.3","game_client":"stable",
 "capture_kind":"automatic_completed_play",
 "replay":{"sha256":"<64 hex>","byte_length":123456},
 "chart":{"md5":"<32 hex>","sha256":"<64 hex>","byte_length":54321}}
```

Both chart digests are required. MD5 connects the replay header to osu!'s chart
identity; SHA-256 identifies the exact stored bytes. Hash the **raw bytes on
disk**: do not normalize line endings, strip a BOM, or re-encode.

Do not send accuracy, MSD, dan, a user id, a username, an official beatmap id, a
rate, or the mods. Those fields are rejected.

The response tells you what is still needed:

```json
{"submission_id":"…","state":"awaiting_assets","created":true,
 "needs_replay":true,"needs_beatmap":false,
 "replay_upload_path":"/api/integrations/companella/v1/submissions/…/replay",
 "beatmap_upload_path":null,"expires_at":"…"}
```

`needs_beatmap: false` means the server already holds that exact file. Only ever
follow a path the server returned, and only on this origin.

### Upload

`PUT` the replay, and the chart if asked, as `application/octet-stream` with the
exact bytes. No base64, no gzip, no rewriting. Identical bytes can be re-sent
safely; different bytes for a committed asset are a `409`.

### Complete

`POST …/complete`. A `202` means it is queued, not analyzed. Poll
`GET …/{id}` with backoff until the state is terminal.

## 4. Errors and what to do

| Condition | Client behaviour |
|---|---|
| `401` token expired | Refresh once, retry with a fresh proof. |
| `401` invalid proof or wrong key | Stop. Never fall back to bearer or a cookie. |
| `401` + `DPoP-Nonce` | Re-sign with the nonce, retry once. |
| Installation revoked | Stop uploading; ask the user to approve again. |
| `error=access_denied` on the callback | The user declined on the consent screen. Nothing was connected; offer Connect again. |
| `needs_beatmap: true` | Send the one `.osu`. Not a failure. Maps the site already holds (ranked and most known charts) come back `false` and need no upload. |
| Connection lost mid-upload | Re-read the receipt, then re-send the same bytes. |
| `429` | Honour `Retry-After`. Keep the queue; do not retry in parallel. |
| `503` / `deferred` | Retryable. Never substitute a zero-valued result. |
| `digest_mismatch`, `not_mania`, malformed file | Permanent for this input. Do not retry unchanged. |
| `404` on a submission | Treat as gone. Do not probe for other ids. |
| Quarantined receipt | Show the server's guidance. Do not re-attribute the play. |

## 5. The queue

Persist a queue entry with its idempotency key **before** the first request, and
bind it at capture time to the account, installation and environment that
authorized it.

Never retarget a pending item because a different account connected later. If
the account no longer matches, stop that item's automatic attribution and show
the server's guidance. Reconnecting, reinstalling or dual booting must not
produce duplicate credit: the server refuses the same play under a new key, but
a client that retargets a queue is asking the user to be told "duplicate play"
on every retry.

## 6. Two installations on one machine

A dual boot approves two keys on the same account. They are independent:
separate credentials, separate revocation, and switching between them is normal
and is not treated as suspicious. Name them so the user can tell them apart on
`/companella`.

## 7. What the server will and will not say

It will say whether the file was intact, whether the name on the replay is the
account's, whether the judgement total is consistent with finishing the chart,
what the chart is a version of and at what relative rate, what the play rates
at, and why a play is or is not counted in the experimental preview.

The rating is read from the replay's key presses: each press is paired with
its note and scored on Wife3 by how many milliseconds it was off. The replay therefore has to carry the play's real input frames; a
file rebuilt from local score data without them cannot be rated. The header's
judgements are what the site displays, and a header its own key presses do not
support is held for review rather than counted.

Only plays on a chart the site already knows count toward the preview, rate
copies included. A copy whose scroll speed differs from its original, or a
chart the site does not know, is still analyzed and shown to its owner, but
does not move the number.

It will not say that a human set the score. An installation credential proves
possession of a key. A complete replay is an editable file. Please keep client
copy honest about that too.

## Before shipping

Confirm with the Mania Hub side:

- whether complete automatic replay capture, with the play's real input frames,
  is actually available in the app (a file assembled from local score data has
  no key presses to rate),
- the preferred tested callback arrangement,
- which native platforms are supported (the API is OS-neutral; that is not a
  claim that the app runs everywhere),
- the desired initial score eligibility.

Until an actual capture sample has been tested jointly, "the server accepts a
synthetic replay" is not the same as "Companella's output is accepted".
