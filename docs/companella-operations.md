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

Set `LIVE_BRIDGE_TOKEN` on both sides before enabling the beta in production.
While it is unset, the frontend's Companella hop reaches the backend on the
admin token. Nothing on the Companella surface reads admin-ness from that
token, and the backend charges the hop the bridge rate bucket
(`BRIDGE_RATE_PER_MINUTE`) itself because the router's rate gate exempts admin
requests, but a separate token keeps the hop from carrying admin rights at all.

The frontend proxy has its own ceilings, independent of the backend's: 64 KiB
for the token, revoke and reservation bodies, 32 MiB for each file upload, no
body forwarded on the other routes, 4 minutes for an upload hop and 30 seconds
for the rest. Setting `COMPANELLA_MAX_REPLAY_BYTES` above 32 MiB or
`COMPANELLA_MAX_JSON_BYTES` above 64 KiB has no effect past the proxy. The
upload hop stays under Node's 5-minute `requestTimeout`, which the frontend's
Nitro server applies with no setting to raise it and the backend pins
(`server.ts`); raise the hop only after raising both.

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
Profiles live in the gitignored `.companella-profiles/` of the directory it
runs from (`COMPANELLA_PROFILE_DIR` moves them); the key file there is test
tooling, not production-grade storage.

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
   attempts stop immediately; `/companella` answers "not switched on", and
   imports leave the tracker and profiles.
2. Narrowing the allowlist instead stops everyone taken off it from connecting,
   refreshing or submitting, and takes their imports off the tracker, the
   profile Recent tab and the public profile route, while `/companella` still
   shows them their installations and plays to revoke and delete. Membership only gates starting a connection on the
   manage surface.
3. Accepted records are durable and are not dropped. No official migration needs
   reverting: every table this integration owns is additive and unrelated to the
   official projections.

## Operating notes

- One worker lane (`companella`, `claimLimit: 1`) runs both submission
  processing and the maintenance sweep, so housekeeping can never overlap an
  import on that process.
- The maintenance job self-chains every 15 minutes for the life of the
  process. Each link's dedupe key is `companella_maintenance:<due epoch ms>`;
  at most one link waits at a time, and the boot seed is skipped when one is
  already pending. A pass prunes proof ids, authorization requests and codes,
  and credentials; expires abandoned reservations; re-enqueues completions
  whose job insert was lost, and submissions left `queued`, `deferred`,
  `validating` or `analyzing` with nothing touching them for an hour (their
  job is gone, for example cleared from the admin page after failing); removes
  expired test scores and
  hard-deletes score rows deleted more than 30 days ago; prunes security
  events; reconciles staged objects older than an hour; and collects committed
  objects nothing has referenced for 24 hours (counted from the later of the
  last write and the end of the last reference: a chart whose last score was
  deleted an hour ago waits another 23), walking the registry by key with a
  cursor. Every prune drains in batches for up to 1.5 s per table per pass,
  and a failed sweep logs `companella_maintenance_sweep_failed` without stopping
  the others. The `companella_maintenance` log line reports `proofIds`,
  `authorizationRequests`, `authorizationCodes`, `credentials`,
  `expiredSubmissions`, `recoveredSubmissions`, `expiredTestScores`,
  `purgedScores`, `securityEvents`, `orphanedArtifacts` and
  `unreferencedArtifacts`.
- A failed submission run is retried by the job queue after 1, 2, 4, 8 and 16
  minutes, with the receipt saying `deferred` and a fixed message; the error
  itself is only in the `companella_submission_failed` log line, and each retry
  also shows up as a `job_failed` warning. The sixth attempt ends it as
  `rejected` / `processing_failed`. A long chart lookup continues in follow-up jobs keyed
  `companella:<submission>:match:<cursor>` and logs
  `companella_chart_lookup_continues`.
- A dev database copied from production can hold chart rows under the
  production environment; uploading one of those charts answers `409
  chart_environment_conflict` and logs `companella_chart_environment_conflict`.
- `PUT beatmap` still parses the chart on the serving process: linear, about
  100-300 ms for a maximum-size 8 MiB chart.
- MinaCalc stays serialized through `dan/msd.ts`; this integration adds no
  parallel calculator.
- Private responses are `no-store` end to end. If a CDN rule is ever added in
  front of `/api/companella/*` or `/api/integrations/companella/*`, it must not
  cache them.
- `TRUST_PROXY_HEADERS` is what makes `CF-IPCountry` usable. Without it, and for
  any request that did not come through the trusted edge, the country is
  `unknown` rather than invented.

## Reviewing a held play

A play is quarantined when its header's judgements are not in its key presses
(`judgements_disagree_with_inputs`, with both accuracies and the gap). The
event is recorded once per score and its detail carries `localScoreId`, which
is the id to review. There is no admin page for this
yet. Call the backend directly with the admin token. The route reads no actor
header, and a separate `LIVE_BRIDGE_TOKEN` does not open it:

```
curl -s -X POST "$LIVE_BACKEND_URL/api/admin/companella/review" \
  -H "Authorization: Bearer $LIVE_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"score_id": "<local score id>", "review_state": "clear"}'
```

`review_state` is `clear`, `flagged` or `quarantined`. Answers: `200 {"ok":
true}`; `404 {"ok": false}` for an unknown score; `400 invalid_review_state`;
`401` without the admin token (the bridge token included); `404` while the
integration is disabled. Each
call logs `companella_review_set`. The decision reaches the owner's stored
preview (and, for an account osu! turned away, its public plays) at once, and
the play's tracker and Recent rows on their next read. The
old `/api/integrations/companella/manage/admin/review` is gone and answers
`404`.

Honest replays sit well inside the thresholds (see "The key presses" in
`companella-integration.md`), so a held play is worth reading before clearing
it.

## Rate flags

A play whose frames do not confirm the speed its mods claim is not held. It
counts, the player is not told, and `/admin/companella?tab=flags` lists it (each
one also logs `companella_rate_suspicious`). "Frames read slower" is the one to
act on: `claimed_rate_too_high` never happened on an honest replay in the
measurement, and a NoMod replay relabelled DT reads about 1.00x against a 1.50x
claim. "Unreadable" is mostly honest: about 6% of honest DT plays have too few
idle frames to read or come from a game at 60 fps or below. Exclude takes a play
out of its owner's preview (`quarantined` through the review route); Restore
puts it back. Click a player name to open their Players tab details, including
their other plays and the account block control.

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
| Unpaired-press review rule | Run over 6,128 cached real stable 4K-10K replays: none flagged, at most 0.58 unpaired presses per note and 12.4 per second (`local-notes/companella-anticheat-check/`). |
| A header edited from NoMod to DT, or from HT to NoMod | Held for review from the frame clock (`replay-rate.ts`). Run over 7,514 cached real stable replays: every relabelled replay held, 0.3% of honest NoMod and 5.8% of honest DT plays held as unreadable, no honest replay read as edited. Respacing the idle frames defeats it. Not yet run on a local `.osr` straight from `Data/r`. |
| LZMA decoding of a real encoder's stream | Covered (one real stream in the fixtures), and separately checked by hand against 20 real `.osr` files on the owner's machine. |
| A real Companella capture payload | Tested once on a local setup: a play captured by a Companella build with the integration went through end to end and was accepted. |
| Production deployment | **Not done.** |
| Hardware-backed native key storage | **Not implemented and not claimed.** A client's declaration about its key store is unverifiable from here. |
| Public rating admission | **Not implemented.** Policy is fixed at `experimental_only`. |
