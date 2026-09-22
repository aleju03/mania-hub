# Companella operations

Configuration, rollout and the runbook for the Companella integration. The
feature model is in `companella-integration.md`; the client contract is in
`companella-client-guide.md` and `companella-api.openapi.yaml`.

**Current state: off.** Nothing below has been enabled on production, and doing
so is an owner decision.

## Configuration

All backend, all in `live-backend/.env`, all read once at boot through
`readCompanellaConfig` (`live-backend/src/integrations/companella/config.ts`).

| Variable | Default | Notes |
|---|---|---|
| `COMPANELLA_MODE` | `disabled` | `disabled` / `allowlist` / `enabled`. |
| `COMPANELLA_ISSUER_ORIGIN` | (empty) | The public origin clients sign proofs against. **Empty disables the integration.** |
| `COMPANELLA_ALLOWLIST` | (empty) | Comma-separated osu! user ids. An empty list in `allowlist` mode disables the integration. |
| `COMPANELLA_ENVIRONMENT` | `production` / `development` | Tokens, grants, artifacts and idempotency keys never cross it. |
| `COMPANELLA_ENABLE_TEST_CLIENT` | `false` | Registers the `companella-test` client and its same-origin callback. |
| `COMPANELLA_CLIENT_ID` | `companella` | The native client id. |
| `COMPANELLA_TEST_CLIENT_ID` | `companella-test` | |
| `COMPANELLA_REQUIRE_PROOF_NONCE` | `false` | Turning it on costs every client one extra round trip on its first request. |
| `COMPANELLA_NONCE_SECRET` | `LIVE_ADMIN_TOKEN` | HMAC key behind the stateless nonce. |
| `COMPANELLA_LOCAL_STORAGE_DIR` | (unset) | Development only. Ignored when `NODE_ENV=production`. |

Lifetimes (ms): `COMPANELLA_AUTH_REQUEST_TTL_MS` (10 min),
`COMPANELLA_AUTH_CODE_TTL_MS` (2 min), `COMPANELLA_ACCESS_TTL_MS` (5 min),
`COMPANELLA_REFRESH_ABSOLUTE_TTL_MS` (90 d), `COMPANELLA_REFRESH_IDLE_TTL_MS`
(30 d),
`COMPANELLA_PROOF_MAX_AGE_MS` (60 s), `COMPANELLA_PROOF_MAX_SKEW_MS` (30 s),
`COMPANELLA_NONCE_TTL_MS` (5 min), `COMPANELLA_RESERVATION_TTL_MS` (72 h),
`COMPANELLA_TEST_SCORE_RETENTION_MS` (7 d),
`COMPANELLA_SECURITY_EVENT_RETENTION_MS` (30 d).

Budgets: `COMPANELLA_MAX_REPLAY_BYTES` (25 MiB),
`COMPANELLA_MAX_BEATMAP_BYTES` (8 MiB), `COMPANELLA_MAX_JSON_BYTES` (16 KiB),
`COMPANELLA_MAX_REPLAY_FRAMES` (400k),
`COMPANELLA_MAX_DECOMPRESSED_REPLAY_BYTES` (3.2 MiB),
`COMPANELLA_RESERVATIONS_PER_MINUTE` (12),
`COMPANELLA_MAX_INCOMPLETE_SUBMISSIONS` (32),
`COMPANELLA_MAX_UPLOAD_BYTES_PER_DAY` (256 MiB),
`COMPANELLA_MAX_RETAINED_BYTES` (1 GiB).

Frontend side: nothing new. It reuses `LIVE_BACKEND_URL`, `LIVE_BRIDGE_TOKEN`
and, for the trusted edge country, the existing `TRUST_PROXY_HEADERS`.

### Fail-closed rules

- No issuer origin: disabled, whatever `COMPANELLA_MODE` says.
- `allowlist` mode with an empty allowlist: disabled. An empty list never means
  "everyone".
- Never reuse `OSU_CLIENT_SECRET`, `LIVE_ADMIN_TOKEN` or `LIVE_BRIDGE_TOKEN` as a
  native credential. The bridge token authorizes a hop, never an actor.
- The local storage adapter refuses to arm when `NODE_ENV=production`, and a
  missing production R2 configuration is a real error, never a silent no-op.

## Turning it on locally

Add to `live-backend/.env`:

```
COMPANELLA_MODE=allowlist
COMPANELLA_ALLOWLIST=<your osu! user id>
COMPANELLA_ISSUER_ORIGIN=http://localhost:3000
COMPANELLA_ENVIRONMENT=development
COMPANELLA_ENABLE_TEST_CLIENT=1
COMPANELLA_LOCAL_STORAGE_DIR=./data/companella
```

Restart the backend. Check:

```
curl -s http://localhost:3000/api/integrations/companella/v1/capabilities | jq .enabled
```

Then open `/companella`, use **Create test installation**, and submit a `.osr`
plus its `.osu`. Or drive the CLI:

```
npm run companella:test-client -- connect --origin http://localhost:3000 --profile windows-test
npm run companella:test-client -- me --profile windows-test
npm run companella:test-client -- submit --profile windows-test --replay play.osr --beatmap chart.osu
npm run companella:test-client -- status --profile windows-test --submission <id>
npm run companella:test-client -- disconnect --profile windows-test
```

Approve `windows-test` and `linux-test` as two profiles to exercise dual boot.
Profiles live in the gitignored `local-notes/companella-test-client/`; the key
file there is test tooling, not production-grade storage.

## Rollout

Preferred order, none of which has been done:

1. Enable on a staging database and storage namespace, `allowlist` with the
   owner only, test client on.
2. Exercise the full journey with the CLI and the browser test client, both
   installations, a revoke, a delete.
3. Once Companella's developer has a build, do a joint capture test: a real
   `.osr` the app produced, through the real endpoints. Record the result in
   the compatibility note below.
4. Only then widen the allowlist.

Where the beta shares the production service, the isolated tables and the
`experimental_only` policy are mandatory, not optional. `ninja.mania-tracker.com`
being a dev/admin host does **not** mean it has an isolated database; do not
assume it does.

### Rollback

1. Set `COMPANELLA_MODE=disabled` and restart. New authorization and submission
   attempts stop immediately; `/companella` answers "not switched on".
2. Owner data stays readable for inspection and deletion if the mode is instead
   narrowed to an allowlist of one.
3. Accepted records are durable and are not dropped. No official migration needs
   reverting: every table this integration owns is additive and unrelated to the
   official projections.

## Operating notes

- One worker lane (`companella`, `claimLimit: 1`) runs both submission
  processing and the maintenance sweep, so housekeeping can never overlap an
  import on that process.
- The maintenance job self-chains every 15 minutes: prunes proof ids and
  expired grants, expires abandoned reservations, re-enqueues completions whose
  job insert was lost, removes expired test scores, prunes security events, and
  reconciles staged artifacts older than an hour.
- MinaCalc stays serialized through `dan/msd.ts`; this integration adds no
  parallel calculator.
- Private responses are `no-store` end to end. If a CDN rule is ever added in
  front of `/api/companella/*` or `/api/integrations/companella/*`, it must not
  cache them.
- `TRUST_PROXY_HEADERS` is what makes `CF-IPCountry` usable. Without it, and for
  any request that did not come through the trusted edge, the country is
  `unknown` rather than invented.

## Reviewing a held play

A play is quarantined when the name on the replay is not the account's, or when
its header's judgements are not in its key presses (a `judgements_disagree_with_inputs`
security event with both accuracies and the gap). There is no admin page for
this yet. With the admin token:

```
POST /api/integrations/companella/manage/admin/review
{"score_id": "<local score id>", "review_state": "clear" | "flagged" | "quarantined"}
```

A cleared play counts from the next preview recompute. Honest replays sit well
inside the threshold (see "The key presses" in `companella-integration.md`),
so a disagreement is worth reading before clearing it.

## What is deliberately NOT logged

Credential strings, proof JWTs, authorization codes, refresh bodies, whole
request bodies, local filesystem paths, replay frames, private file names. The
structured logs carry submission ids, analysis state, match outcome and client
kind.

## Compatibility note

| Case | Status |
|---|---|
| Protocol, parser, matcher, preview | Covered by `live-backend/tests/companella-*.test.ts` with synthetic fixtures. |
| Rating from key presses | Covered with synthetic inputs, and run over 6,137 cached real stable replays: none held for review, press targets identical to the calibration audit (`local-notes/companella-timing-check/`). |
| LZMA decoding of a real encoder's stream | Covered (one real stream in the fixtures), and separately checked by hand against 20 real `.osr` files on the owner's machine. |
| A real Companella capture payload | **Not tested.** Needs a sample from the app. |
| Production deployment | **Not done.** |
| Hardware-backed native key storage | **Not implemented and not claimed.** A client's declaration about its key store is unverifiable from here. |
| Public rating admission | **Not implemented.** Policy is fixed at `experimental_only`. |
