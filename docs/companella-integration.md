# Companella integration

The Companella score-import beta: a native osu! companion app sends completed
osu!stable mania plays to Mania Tracker over an authenticated HTTPS API. The owner
of the account sees them, and their effect on an experimental rating preview, on
`/companella`; plays that pass every check also show on the tracker and on the
player's profile Recent tab (see "Privacy").

**Status: off by default.** `COMPANELLA_MODE` is `disabled` unless a deployment
sets it, and nothing in this integration affects snipes, packs, goals or any
official projection. The one public total it produces is simulated pp for
accounts osu! turned away (see "Simulated pp for restricted players"); a public
row may show the play's own pp beside it. See
`companella-operations.md` for the rollout switch and
`companella-client-guide.md` for the client contract.

This file is the maintained reference for how it works. It does not describe the
Companella app itself, which is a separate project.

## What it is not

- Not anti-cheat. A complete replay is an editable file, and input simulation is
  indistinguishable from play. Nothing here proves a human set a score.
- Not identity verification. An installation credential proves possession of a
  signing key, and nothing about the machine or the person holding it.
- Not an osu! result. Imported plays are marked `client_submitted` for life.
- Not a generic OAuth provider. Two fixed client ids, no dynamic registration,
  no secret issued to anyone.

## Shape

```
Companella / reference client
    |  HTTPS, DPoP token + a fresh proof per request
    v
frontend  /api/integrations/companella/v1/*        (src/routes/api/integrations/…)
    |  narrow proxy: bridge token + the client's credentials in their own headers
    v
backend   /api/integrations/companella/native/*    (http/routes/companella.ts)
    +-- SQLite: installations, grants, credentials, submissions, scores, previews
    +-- private R2 prefix: replays and contributed charts
    +-- the ordinary job queue: one submission per job, one lane
    |
    v
frontend  /companella  (owner-scoped server functions -> …/manage/*)
```

The two backend surfaces are disjoint. `native/*` needs the bridge token AND a
valid DPoP access token with a fresh proof; `manage/*` needs the bridge token
AND an actor the site derived from its own session cookie. A generic route that
accepted either is how a write-as-any-user path gets built, so there isn't one.
The one admin action, the review decision on a held play, is a third route
again: `POST /api/admin/companella/review` answers to the admin token alone and
reads no actor (see `companella-operations.md`). Nothing on `manage/*` treats
the admin token as a way past the allowlist.

The actor's name travels percent-encoded in `x-companella-actor-name`, cut to
60 code points before encoding. The backend decodes it once; a value that does
not decode, or carries control characters, is `400 invalid_actor`. Usernames
are stored decoded. Rows written before 2026-09-22 may still hold the encoded
form (`Some%20Player`); approving the same key again rewrites the
installation's name.

## Modules

Backend, all under `live-backend/src/integrations/companella/`:

| Module | Responsibility |
|---|---|
| `config.ts` | The whole configuration block, read once at boot. Fails closed. |
| `schema.ts` | Additive DDL, called from `db.ts`'s migration pass. |
| `protocol.ts` | Wire types, manifest validation, error envelope. |
| `proof.ts` | RFC 9449 proof checking and RFC 7638 thumbprints, on Node WebCrypto. |
| `credentials.ts` | Opaque hashed credentials; the durable proof-replay store. |
| `authorization.ts` | Redirect rules, consent, one-time codes, PKCE, token issue. |
| `installations.ts` | The rows behind the page, plus rename / revoke. |
| `storage.ts` | R2 (production) and a local-disk adapter (never in production). |
| `artifacts.ts` | Staged/committed object registry. An object stays while something points at it; the rest is collected. |
| `charts.ts` | Exact chart bytes, parsed facts, shared-pool consent. |
| `chart-matching.ts` | Read-only relationship lookup and the directional rate. |
| `lzma.ts`, `replay-file.ts` | Bounded LZMA1 and `.osr` parsing. |
| `validation.ts` | Identity, completion and the mod capability matrix. |
| `replay-timing.ts` | Judges the replay's key presses: the Wife3 goals the rating runs at, and the header check. |
| `analysis.ts` | Per-play MSD / SSR / LN / chart-dan through the existing engines. |
| `preview.ts` | The experimental aggregate, and its deduplication. |
| `process.ts` | The job body: validate, store, match, analyze, recompute. |
| `security-events.ts` | What the server observed. Not a cheating score. |
| `lifecycle.ts` | One self-chaining maintenance job: retention, recovery, object collection. |
| `public-profile.ts` | The imports of an account osu! turned away, for its public profile. |
| `public-feed.ts` | Every account's checked imports as tracker and profile Recent rows, merged at read time. |

The replay judge itself is shared with the replay viewer: one copy under
`live-backend/src/replay-judge/`, reached from the frontend as `#replay-judge/*`
(see the root `AGENTS.md`).

Frontend: `src/lib/companella-integration/` (proxy, server functions, browser
test client), `src/components/companella/`, `src/routes/companella*.tsx`,
`src/routes/api/integrations/companella/v1/*`, `src/routes/api/companella/*`.
`/companella/docs` (`src/routes/companella_.docs.tsx`) is the public page sent
to client authors, with the spec and the reference client served beside it.

## Connecting an installation

Authorization code + PKCE S256 + DPoP key binding, with an external browser and
a loopback redirect (RFC 8252).

1. The client creates a P-256 key, binds a loopback listener on an ephemeral
   port, and opens `/companella/authorize` with `client_id`, `redirect_uri`,
   `state`, `code_challenge`, `code_challenge_method=S256`, `scope` and
   `dpop_jkt`, plus an optional `app_name`. The consent screen names the app
   from `app_name` as sent (stored on the request, printable, 40 characters at
   most) and says "An external application" without one; nothing is looked up
   from the client id.
2. An unauthenticated browser goes through the ordinary osu! login first, with
   a `next` that points back at the same URL and keeps the OAuth query
   (normalized to a path on this site). Only then does the page validate the
   parameters and open a short-lived request row: `manage/authorize/request`
   needs a signed-in actor (`401 no_actor`), current beta membership (`403
   account_not_allowed`) and at most 10 requests per account per minute (`429
   rate_limited`, `Retry-After: 60`). A failure to open the request is shown
   as what it is (signed out, not in the beta, bad parameters) rather than as
   an expired request.
3. The consent screen names the osu! account and the client, takes an
   installation name, and takes the two consents separately: importing scores,
   and contributing chart files to the shared pool.
4. Approval is a same-origin POST carrying the consent token minted with the
   request. A GET, a page load, or an existing session can never approve.
5. The backend records consent and issues a one-time code bound to the account,
   request, client, redirect, scopes, PKCE challenge, environment and key
   thumbprint.
6. The browser redirects to the loopback callback with `code` and `state`. No
   token is ever in a URL.
7. The client exchanges the code with its verifier and a fresh proof. The code
   is consumed by a conditional UPDATE, so a duplicate exchange is a losing race
   rather than a second installation. An account taken off the allowlist
   between approval and exchange gets `invalid_grant` with an
   `error_description`.

Reconnecting an already-approved key reuses its row (partial unique index on
`environment, user_id, key_thumbprint` where active), so a reinstall does not
leave a graveyard, and refreshes the stored username. Two different keys on one
account are two installations, which is what dual boot looks like.

Lifetimes: consent request 10 minutes, code 2 minutes, access token 5 minutes,
refresh 90 days absolute / 30 days idle. Refresh credentials are
sender-constrained and **not** rotated: RFC 9700 allows either, and doing both
means a lost response burns a credential the client never received. The refresh
grant mints a new access token only and echoes the refresh credential the
client sent. An account that has left the beta gets `400 invalid_grant` ("This
account is not in the beta.") from refresh; its refresh credential stays valid,
so re-admitting it needs no new approval.

The token endpoint writes nothing for a proof over a made-up grant: the proof's
`jti` is recorded only once the code or refresh credential in the body is found
and bound to the proof's key, and (for a code) after the key and PKCE checks
but before the code is spent. A replayed proof over a real grant is
`invalid_dpop_proof` and does not spend the code.

Nonces at the OAuth endpoints: `/oauth/token` and `/oauth/revoke` answer a
missing (when required), expired or foreign nonce with `400 use_dpop_nonce`,
`WWW-Authenticate: DPoP error="use_dpop_nonce"` and a fresh `DPoP-Nonce`
(RFC 9449 section 8), even while `COMPANELLA_REQUIRE_PROOF_NONCE` is off. A
server with no nonce secret answers `invalid_dpop_proof` instead, since asking
for a nonce it cannot issue would loop the client. Revocation needs a proof
signed by the key the token is bound to, on the same nonce terms.

## Submitting a play

Metadata first, files second, completion third.

`POST /submissions` reserves an idempotent submission from a manifest carrying
only digests and lengths. Identity-setting fields (`user_id`, `username`,
`accuracy`, `msd`, `beatmap_id`, `mods`, …) are **rejected**, not ignored: a
field we would have to distrust is better refused than silently accepted.

The response says which assets the server still needs. `needs_beatmap: false`
is answered only when the exact bytes are verified to exist and are reusable by
this account, with the stored chart's sha256, md5 and length all equal to the
manifest's. A metadata row, a matching family, or a beatmap id is not a file.

Concurrent reservations under one idempotency key return the one stored row
(`created: false` for the others). A quota or incomplete-cap refusal first
re-reads the key, so a retry that lost the race gets the receipt instead of a
`429`. Reservations in `awaiting_assets` whose `expires_at` has passed no longer
count toward the incomplete cap.

`PUT …/replay` and `PUT …/beatmap` take raw bytes. No base64, no gzip, no line
ending or BOM rewriting: the digests were taken over exactly these bytes, and
the `.osr` header's MD5 is over the chart's original bytes.

`POST …/complete` first checks that the replay and the chart are still there:
the registry rows must be committed, the chart's md5 and length must match the
manifest, and a HEAD on each object must find it (a storage error other than
"not found" answers 5xx and changes nothing). A missing one sets
`needs_replay` / `needs_beatmap` back to true and answers
`409 assets_missing`, so the client sends it again. Then it transitions the row
durably and enqueues. If the enqueue is lost to a crash the row stays `queued`
with `enqueued = 0`, and the maintenance sweep picks it up. A completion never
means "analyzed". A repeat completion returns the receipt as it stands and only
enqueues where that helps: a `deferred` submission runs its retry now, and a
`queued` one whose enqueue was lost is enqueued again. It leaves a submission
that is `validating` or `analyzing` alone, `updated_at` included, so a client
repeating it cannot keep pushing back the stalled-run sweep.

Three separate deduplications:

1. **Delivery**: same owner + idempotency key + manifest returns the same
   submission. A conflicting manifest under one key is `409`.
2. **Same play**: a versioned fingerprint over parsed score facts and the
   canonicalised input timeline, enforced by a partial unique index. Its
   limitation is the mirror image (two genuinely different plays sharing every
   fact would collide), which is why it gates credit and never deletes data.
   The replay's own stored hash is untrusted metadata and is not used.
3. **Rating evidence**: see the preview section.

### Processing retries

A run that fails on something a later run might not repeat (storage, the calc
workers, the database) sets the receipt to `deferred` with
`processing_deferred` ("Processing hit a temporary problem and will be
retried.") and rethrows, so the job queue retries it after 1, 2, 4, 8 and 16
minutes. The error itself goes only to the `companella_submission_failed` log
line, never to the receipt. The sixth attempt
(`COMPANELLA_PROCESS_MAX_ATTEMPTS`) settles it: `rejected` with
`processing_failed` ("Processing kept failing, so this play was not imported.")
and any score it inserted is withdrawn. A calculator outage
(`failed_retryable`) is retried the same way; on the last attempt the play is
kept, unrated as `analysis_failed`. `/companella` re-reads deferred rows every
30 seconds rather than at the 4-second pace of rows still moving.

Every re-run (restart, lost lease, retry, lookup continuation) resumes from the
submission's own score: `insertLocalScore` hands it back instead of calling it a
duplicate, timing and analysis rows are upserts on the score id, and per-score
security events are recorded once (their detail carries `localScoreId`). Each
stage re-checks the installation and the score before it commits, and every
state change is conditional on the row still being in flight, so a revoked
installation's submission ends `rejected` with `installation_revoked` (its score
withdrawn) and a score the owner deleted mid-run is never written back.

A withdrawal (`processing_failed` or `installation_revoked`) settles the receipt
first and removes the score only if the receipt now says so: a second run that
accepted the play first (after a lost lease, the reclaimed run and the original
can overlap) keeps its score. The owner's preview is then recomputed, because
another import's recompute may already have counted the score. If the delete
fails, the job fails too, and the next run finds the rejected receipt and
finishes the withdrawal.

The maintenance sweep re-queues a `queued`, `deferred`, `validating` or
`analyzing` submission nobody has touched for an hour, which covers a job
cleared from the admin page, including one that failed before its first
transition and so left the row `queued`.

## Validation

`process.ts` runs as a queued job, never on the request path.

- Raw replay bytes match the manifest's length and SHA-256.
- The stored chart's MD5 equals the manifest's (`beatmap_checksum_mismatch`
  otherwise), and the `.osr` header's beatmap MD5 matches the manifest and the
  **raw bytes** of the stored chart.
- Header strings are capped before they are decoded: player name 64 bytes,
  beatmap and replay checksums 32 characters of hex, life bar graph 1 MiB. Over
  a limit is `replay_header_too_long` ("This replay's player name is too
  long."); a checksum that is not hex is `replay_malformed`.
- Ruleset is mania; the chart is native mania and parses.
- LZMA output is bounded three times: declared dictionary size, declared output
  size, and the actual emitted byte count. The frame budget is spent on the
  declared size *before* decoding, because the decode allocates per frame.
- Large integers (online score id, timestamp ticks) stay `bigint` / decimal
  strings. A JS number would round a stable score id.

Then three separate verdicts, none of which is "verified":

| Verdict | Values |
|---|---|
| Identity | `name_matches_account`, `name_mismatch`, `identity_unresolved` |
| Completion | `consistent_with_completed_play`, `incomplete`, `unknown` |
| Analysis | `supported`, `unsupported`, `pending`, `failed_retryable` |

Completion is the judgement total against the chart's object count: stable
awards one judgement per mania object, holds included. Under ScoreV2 a hold is
judged at its head and again at its tail, so the expected total is notes plus
holds there. A count *above* the expected total is `unknown`, not a pass.

Identity compares the replay's player name to the account's, through a
conservative normalization (case folding plus osu!'s space/underscore
equivalence), and is recorded only. It holds nothing and leaves nothing out of
the preview or a restricted player's public plays: a play from an offline or
private-server client carries that client's name, and the name is one editable
header string, so it proved nothing about who played. The original header is
kept rather than rewritten to the token owner. The comparison reads the cached
`users` row, never an osu! API call per upload.

Mods:

| Class | Mods | Outcome |
|---|---|---|
| Rejected | AT, CN, RX, AP, TP | submission refused (`automated_play_mods`) |
| Contradictory | DT or NC with HT, EZ with HR, NF with SD or PF, HD with FI, two key mods | submission refused (`contradictory_mods`): stable cannot produce them, so the header was edited |
| Stored unrated | RD, key conversion, CO, unknown bits | accepted, explicit reason |
| Supported | NF, EZ, HD, HR, SD, PF, DT, NC, HT, FL, FI, MR, V2, TD, SO | analyzed; the judge flips a Mirror play's columns back, and its ratings read the original chart as the official pipeline's do |

An unrecognised bit is never read as NoMod. Playback rate and hit windows come
from the header mods, and `replay-rate.ts` checks that rate against the frames
(see "The key presses").

Only 4K to 10K is judged and rated (`isImportRatedKeyCount`). 11K and wider are
stored unrated as `keymode_unsupported`, without judging, a timing row or a
header review.

### The key presses

The header's six judgement counts are editable numbers, and they depend on the
OD written in the chart file, which is editable too. So nothing is rated from
them. `replay-timing.ts` decodes the frames the way the replay viewer does and
runs the shared judge over them, which pairs every press with its note. Each
note is then scored on Etterna's Wife3 curve from how many real milliseconds it
was off, giving the two targets the count calibration was fitted to
(`docs/wife-calibration.md`): press/hold Wife3 (taps and heads, minus 2.25 per
failed hold) and LN action Wife3. `goalsFromMeasuredWife` applies the same caps
and 0.8 floor as `calibrateScoreForMsd`. A play whose presses cannot be judged
is not rated; it never falls back to the header.

The judge reproduces stable's judgements very closely but not exactly, so a
disagreement never rejects a play. It goes to review (`quarantined`, plus a
`judgements_disagree_with_inputs` security event) when the header's accuracy
and the judge's differ by at least 1 percentage point *and* 3 judgements' worth,
in either direction: a header worse than its own inputs means the inputs were
edited. The header's counts stay what is displayed, since they are what the
player saw.

The threshold came from the audit cache: 7,156 stable replays up to 10K never
differed from their headers by more than 0.62 points (p99.9 0.40), and the
backend path flagged none of 6,137 of them (2026-09-22, script in
`local-notes/companella-timing-check/`). 18K replays all read as misses in the
judge, which is one reason only 4K to 10K is judged at all.

Presses that hit nothing are not checked. An early press inside a note's miss
window misses it, in the game and in the judge alike, so a replay that mashes
every key reads as misses (and a header claiming otherwise goes to review as
above), while tapping along in a break costs nothing in either.

The playback rate comes from the header's mods, so a NoMod replay with the DT
bit set would be judged with its offsets divided by 1.5 and rated at 1.5x.
`replay-rate.ts` reads the real rate from the frames instead. Stable writes a
frame on every key change plus idle frames on a 60 Hz real-time clock that
catches up rather than resetting, and frame times are song time, so the idle
gaps average 16.67 ms x the real rate: 25 under DT, 12.5 under HT. The check
pools gaps with no key held between the first and last key change into 2 s
windows (3 to 100 ms, gaps under 0.3 of a window's median dropped as split
ticks, at least 12 per window, at least 5 windows) and takes the median of the
window means. Measured over claimed rate:

| Verdict | When | NoMod claim | DT/NC claim | HT claim |
|---|---|---|---|---|
| `claimed_rate_too_high` | below 0.80, or 2+ windows and a third of them below it | flagged | flagged | flagged |
| `inconclusive_low` | 0.80 to 0.90 | flagged | flagged | - |
| `too_few_windows` | fewer than 5 windows, and the held-key fallback does not confirm | flagged | flagged | - |
| `frame_locked` | the 5th percentile gap is 0.85 of the clock or more: a game at or below 60 fps, whose clock reads its frame rate | - | flagged | - |
| `consistent` | 0.90 to 1.10 | - | - | - |
| `claimed_rate_too_low`, `inconclusive_high` | above 1.10 | - | flagged | - |
| `not_stable` | an osu!lazer header (game version 30000000 and up) | flagged | flagged | flagged |

A claim slower than the real rate gains nothing, so HT is only flagged when the
file is not a stable replay at all. When too few released gaps exist (dense or
hold-heavy charts), gaps with one unchanged key state are tried instead; key
repeat makes those read fast, so they may confirm a claim and never count
against one.

A flag holds nothing back: the play keeps its review state and counts like any
other. The verdict is stored on the timing row as `rate_check_json` (with
`suspicious`), the owner's copy of the timing leaves it out, and no security
event is written, so the player never sees it. Each flag logs
`companella_rate_suspicious`, and `/admin/companella-flags` lists flagged plays
(backend `GET /api/admin/companella/rate-flags`, admin token) with a Hold
button that goes through the review route.

Measured 2026-09-22 on 7,514 cached stable replays (6,183 NoMod, 758 DT/NC,
573 HT, clients from 2015 to 2026) and re-checked by a second, independent
implementation over 1.8M cut segments of 10 s to 2 min. No honest replay read
slower than its claim. Every NoMod replay relabelled DT, and every HT replay
relabelled NoMod or DT, was flagged. Honest plays flagged: 21 of 6,176 NoMod (17
unreadable, 4 steadily at 0.85, which looks like a slowed game clock), 44 of
757 DT/NC (41 unreadable, 3 frame-locked), none of 573 HT (scripts in
`local-notes/companella-anticheat-check/rate/`). It is a tripwire, not proof:
respacing the idle frames defeats it.

## Chart identity and rates

Exact bytes are the identity: SHA-256 over the original byte sequence, computed
before anything decodes text. MD5 is the compatibility reference from the
`.osr`. A copied `.osu` can carry a stale `BeatmapID`; it is shown as the
uploader's own metadata and never promotes anything into the official catalogue.

`chart-matching.ts` is read-only. It finds candidates from
`beatmap_chart_families` (topology first, then edge keys), reads their cached
bytes, and compares. It **never writes to that table**: an upload that appears
to bridge two official families reports `ambiguous` for a human, because merging
them would change the ratings of players who never touched this integration.

Directional convention, tested in both argument orders:

```
uploaded_time = reference_time × timeScale + timeOffsetMs
relativeRate  = 1 / timeScale
```

So a 1.2× edit of the reference has `timeScale ≈ 0.8333` and `relativeRate ≈
1.2`. A nonzero offset moves the chart in time and does not change the rate.

Three relationships are kept apart, because conflating them is how a rate edit
inherits someone else's calibration:

- `exact_file`: identical bytes.
- `strict_note_rate_copy`: every note and hold endpoint corresponds under one
  uniform transform.
- `padded_family`: the same chart with a few notes slipped in. Duplicate
  *evidence*, nothing more.

Gameplay settings (OD, BPM, SV, breaks) are reported as differences, never
folded into the relationship: identical notes can judge completely differently.
Scroll speed is compared as a whole timeline under the time transform (the
parser's multipliers are already relative to each file's main BPM, so a rate
copy keeps them and only moves their times); removing or flattening SVs does
not survive that. A fresh match also returns the original's OD, which the rating
judges the replay at, so a copy with easier windows keeps no more holds than the
original would have. That OD is not stored.

The lookup first compares every chart with the upload's exact note sequence
(`topology_key`); a strict match there settles it at once, since the upload is
that chart. Otherwise it walks the charts sharing either end (head/tail keys) in
one beatmap-id order, 60 per step. An exhausted step returns `deferred` with a
cursor and the best match so far, not `unmatched`, and the next step resumes
there. A run takes up to 4 steps, then queues a follow-up job
(`companella:<id>:match:<cursor>`) and leaves the submission `analyzing`. A
deferred step never overwrites a stored match; if a fresh lookup cannot finish,
the stored match is used, with its reference OD re-read from the reference
file. A stored negative answer (unmatched or ambiguous) is not reused that way:
the index may have gained the chart since, so the fresh lookup's progress
replaces it and the lookup runs to its own finish. A missing reference file is
skipped, which is why a negative result is never described as exhaustive.

Rows are keyed by `(chart_sha256, matcher_version)`, and the matcher is version
3 (exact note sequence first, then head/tail candidates in beatmap-id order,
with the cursor and best match carried on a deferred row). A version 2 row is
read only when it is a match: the relationship it found still holds, while a
version 2 deferred row's cursor means something else and its negative answers
are looked up again. A version 3 answer, once stored, is read before it.

The matcher also records the upload's rate against each family member it
compared and matched (`member_rates_json`, `memberRates` on the score detail's
`match`, by beatmap id). The family index keeps no per-member time scale, so
this is how the preview tells which official play is the same effective play.
A member the lookup never reached (a padded member past a strict match) is not
in it.

Baked rate and runtime speed stay separate:

| File | Replay mod | Analysis rate | Speed vs reference |
|---|---|---:|---:|
| Original | NM | 1.0 | 1.0 |
| Generated 1.2× | NM | 1.0 | 1.2 |
| Generated 1.2× | DT | 1.5 | 1.8 |
| Generated 1.2× | HT | 0.75 | 0.9 |

The analyzers always see the exact uploaded file at the play's runtime rate. The
baked rate is display and deduplication only; multiplying it into an
already-retimed file would rate a chart nobody played.

## Analysis and the experimental preview

`analysis.ts` drives the existing engines: `computeMsd` through `dan/msd.ts`
(which keeps MinaCalc serialized against the job lanes),
`classifyChartWithCompanella` + `leanClassification` for the chart verdict, and
`computePlaySsrValues` from `player-skills.ts` for the SSRs at the goal measured
from the key presses (see "The key presses"). Nothing is reimplemented and no
client-supplied rating is read.

Two deliberate departures from the official chart pipeline: no star rating is
supplied (there is no official SR for an unsubmitted file), and no title /
version / creator is supplied. On an official chart those come from osu!; here
the uploader writes them, and a chart rating must not be movable by editing a
metadata line.

The cache key carries the chart SHA-256, runtime rate, mods, ScoreV2 flag, the
calibrated goal and the analysis version (`LOCAL_ANALYSIS_VERSION`, now 3). A
family id alone would be wrong.

Vibro is decided the way the official pass decides it for a chart with no pp
behind it (`rateVibroVerdictWithoutPpTrust`, so no clear-evidence exception). A
non-4K chart flagged vibro at 1.0x is unrated `chart_vibro`. Where the official
pass checks the rate (4K, and other keymodes away from 1.0x), an excluded
result is unrated `rate_vibro`, an adjusted one lowers the goal and LN goal with
`conservativeVibroAccuracy`, and an unreadable chart is `vibro_check_failed`.
A goal left at or under the calc floor is `accuracy_below_calc_floor`. Imports
analysed before version 3 keep their stored analyses; there is no re-analysis
sweep.

`preview.ts` reads the player's stored official ratings and retained evidence
from `player_skill_ratings` and computes a second aggregate over the same
evidence plus every live local import (read in keyset pages, no cap), using the
exported `selectMsdRatingPlays` + `aggregateSsrs` + `SKILL_RATING_SKILLSETS`.
It writes only `companella_rating_previews`. Each computation reserves its
generation atomically before it starts (a first reservation writes a
placeholder that reads as "no preview yet"), and a store under an older
generation writes nothing, so a slow older computation cannot overwrite a newer
one. The preview is version 3.

Each import takes its own rating slot, `companella:<family>:<effective rate>`
(`StoredPlaySsr.ratingSlot`, never set on an official play), which ignores the
ScoreV2 flag, so one chart at one rate counts once. Imports carry the raw
family key official plays carry, so the two-per-family cap counts both
together.

Evidence deduplication uses a versioned effective-play key:

```
keyCount | familyIdentity | (relativeRate × runtimeRate, 3dp) | sv1|sv2 | std|inv
```

where `relativeRate` is the upload's rate against the lowest-id family member
it matched, so a baked 1.2× file played at NoMod collapses onto the original
played at 1.2×, while two genuinely adjacent rates stay distinct. An import is
`already_counted_officially` when an official play that counts (not
rating-excluded, Overall above 0) sits on one of the members it matched, at the
rate the import amounts to on that member. Dan-only evidence does not stand in
for an import.

Only charts the index recognises count, rate copies and padded copies included,
the way official ratings only take ranked and loved maps: a chart built to be
overrated would otherwise be the easiest way to move the number. A recognised
copy whose scroll speed differs from its original is left out too, because MSD
cannot see scroll speed and an easier-to-read copy would rate the same.
Everything else is still analyzed and shown per play.

Every ineligible play is explained: `analysis_pending`, `analysis_failed`,
`analysis_unsupported`, `vibro_excluded`, `vibro_check_failed` (the vibro check
could not read the chart), `under_review`, `completion_unconfirmed`, `relationship_ambiguous`, `chart_match_pending`,
`chart_not_recognized`, `scroll_speed_changed`, `already_counted_officially`,
`duplicate_effective_play`. "Your import did not
move the number" and "your upload failed" are different things and the page says
which.

`ratingPolicy` is fixed at `experimental_only`. Widening it is an owner
decision, not a config flag someone can flip by accident.

## Privacy

Imports are owner-scoped, with two public read-time views.

Every account's imports that pass the checks show on the tracker and on the
profile Recent tab (`public-feed.ts`), marked with the Companella icon. A play
shows only when it is in this environment, not deleted, from the native client,
with a `clear` review, `consistent_with_completed_play`, and its submission
`accepted`, while the mode is on and the beta admits the account, and while the
owner is active (or has no `users` row) or gone on osu! per `accountGoneOnOsu`.
An admin deactivation or wipe hides them. An import whose `online_score_id`
equals one of the same user's `score_events` score ids is skipped, so a play
osu! also sent is listed once. The row is a lean tracker score with a stable
negative id derived from the import id and a `companella: { importId, replay }`
mark. It uses the official beatmap and set when the import's chart is the exact
official file (the priced beatmap id, else the same md5 match
`resolveExactBeatmap` makes), and otherwise a beatmap built from
`companella_local_charts` with id 0 and no link. Its stars and BPM are the
file's own, measured when the chart is stored (nomod star rating and main
BPM, so a 1.2x rate edit reads at 1.2x; charts stored earlier are filled by
the maintenance sweep). Its art is the covers of the official set the chart
matcher tied it to (a rate edit or other copy), else of the set the file
names in its own `BeatmapSetID` (osu!'s asset URLs either way, set still
unlinked); with neither, the profile shows the blurred generic header art,
its hue and framing picked per chart. The player comes from `users`,
else the installation's latest username; never the replay's player name. The
time is the play time clamped to the receipt time. The pp is the play's own
`companella_local_score_pp` value at the current pp version, shown for every
account; it enters no total except the restricted simulated pp. Tracker
snapshots merge these rows on read, new ones go out live as their own
`companella_score` SSE event, and profile recent sections carry them in
`imports`. A reconnecting browser's replay of those events runs the same
listing rules again, so a play or owner hidden since is not sent. A play osu!
also delivered is listed once, as the osu! row: matched by online score id
when the replay has one, else by player, official map and total score within
5 minutes (a stable replay saved locally carries no id). The tracker applies
the same match to rows arriving live in either order. Nothing is written to `score_events`, a `live_event_log` score ref,
`users`, rosters or any official projection. Only a restricted player's play in
their current top-200 list has `replay: true` and a Watch button; every other
row shows without one, since the site may not have the map's audio or
background.

An account osu! itself turned away also shows its imports on its public
profile, because nothing else can add a play to that page. That means
`isAccountGoneOnOsu`: inactive, and either restricted at sign-in
(`restricted_at`) or recorded missing from an osu! 404 lookup. An admin
deactivation on this site (`admin:` reasons) and the permanent wipe are this
site's own decisions, so those imports stay private.
`GET /api/integrations/companella/public/players/<id>` (`public-profile.ts`,
no bridge token) answers only for such an account that is also still admitted
by the beta allowlist, and only with plays that passed every check the preview
requires, read from the stored preview: completed, clear review, supported
analysis, a recognised chart. A weaker repeat of a counted play still shows;
it only lost the deduplication. It pages newest first until
it has up to 100 counted plays, and sends the play, its MSD/SSR and the
preview's per-keymode overall, never the replay, the chart bytes, the
installation, or any private explanation.

Beta membership gates starting a connection only: `authorize/request`,
`authorize/detail` and `authorize/approve`. An account taken off the allowlist
keeps everything else on `manage/*` over its own data (installations list,
rename, revoke, revoke-all, submissions, score detail, replay, chart, delete,
preview, security events), and `/companella` shows it that data under "This
account is not in the Companella beta." so it can revoke and delete. `GET
manage/installations` returns `{installations, allowed}` for that page. Its
native requests are refused with `403 account_not_allowed` and its refreshes
with `invalid_grant`. `manage/installations/clear-revoked` takes the owner's
revoked connections off that list (`cleared_at`); the rows stay, since imports
and security events still name them. `GET manage/submissions` carries each
stored play as `play`, the same row the profile's Recent tab draws
(`readOwnCompanellaScoreRows`), test and held imports included, so the page
lists them ten at a time with the profile's row and popup. Native `GET /me`
also returns `avatar_accent`, the site's colour for the player's avatar, or
null until it has been measured.

Replays live under `integrations/companella/<environment>/replays/<owner>/…` in
the private replay-cache bucket, behind unguessable content-addressed keys, and
are read only through the owner-scoped `/api/companella/replay` route, which
authorizes before a byte moves and answers `404` for a foreign id (a `403`
would confirm the score exists). They never enter the public upload flow, the
community listing, or any shared cache, and the `companella_score` SSE event
carries the play, never the replay: every private response is `no-store`. The
exception is a restricted player's play in their current top-200 list (next
section), whose replay is public.

## Simulated pp for restricted players

osu! prices none of the plays of an account it turned away, so
`restricted-pp.ts` does, and the number stands in for the osu! one while the
account is gone: it ranks on the leaderboards like anyone's, with no marker.

- **Pricing.** During processing, an import whose chart is the exact file of a
  mania map (the md5 equals the checksum osu! gave us for the declared or
  matched beatmap id, or a cached official file with that md5), played under
  ranked mods only (NF, EZ, HD, HR, SD, PF, DT, NC, HT, FL, FI, MR; not
  ScoreV2, key mods, RD or CO), gets its star
  rating at the played rate (`dan/mania-star-rating.ts`, lazer's
  calculator) and its pp (`dan/mania-pp.ts`) stored in
  `companella_local_score_pp`, whatever the map's status. The pp is the lower
  of the header's judgements and the key presses' own, so a header nudged up
  inside the review threshold earns nothing for it.
- **What counts.** Only while the account is gone on osu!
  (`accountGoneOnOsu`), only plays received after the account last came back
  (`inactive_user_reviews.reactivated_at`, now written on every reactivation),
  on a map whose status is `ranked` or `approved` at read time, completed,
  with a clear review state, and only while the beta admits the account. The
  best play per beatmap, weighted 0.95 per place, plus
  (417 - 1/3) x (1 - 0.995^n) over the n distinct maps: osu!'s own aggregate
  (`UserTotalPerformanceAggregateHelper` in osu-queue-score-statistics). The
  list shows 200; accuracy is osu!'s weighted, normalised accuracy.
- **Archive.** When the account comes back (a clean sign-in or the admin
  toggle), every play before that moment stops counting at once and stays
  stored as an ordinary import; a later restriction starts from nothing.
  Detection lags until the player signs in, since nothing re-checks an
  inactive account.
- **Ranks.** The global rank is one below the lowest-pp active player osu!
  ranks at or above the total (plus any simulated player above); the country
  rank counts the country's ranked roster and simulated players above.
- **Where it shows.** Each play's own pp shows on its tracker and Recent row
  for every account (see "Privacy"); only the restricted total adds it up.
  Totals are computed on read (cached a minute) and merged
  into the global and region boards in the snapshot routes
  (`withExtraEntries`, only when the player would sit inside their country's
  roster), never into the cached board, the pack pool or `users`. Public,
  no-token routes: `GET /api/integrations/companella/public/players/<id>/pp`
  (totals, ranks and the list; the rate flag and review state stay out),
  `GET /api/integrations/companella/public/rankings?country=XX` (the site's
  country board merges these into osu!'s list), and
  `GET /api/integrations/companella/public/replays/<id>` (the .osr, only for a
  play in the current top-200 list), opened at `/replay?importId=`.
- **Control.** `/admin/banned-users` shows each account's simulated pp and its
  plays, and removes flagged, chosen or all plays (the ordinary `quarantined`
  review hold, reversible) through
  `GET`/`POST /api/admin/companella/restricted-pp/<id>`.
- **Play count and time.** The standing's play count and play time (shown on
  the profile rail beside the simulated pp) count every checked import in the
  window, priced or not: each chart's length at the played rate. An account
  with no priced play still gets them, with pp 0 and no rank.
- **Skills and Activity.** For a gone account the profile's Skills and Activity
  endpoints answer from the checked imports in the same window
  (`restricted-profile.ts`), never from osu! and without queueing anything: an
  import placed on the official beatmap it is (its exact file, or a clean rate
  copy on the family's lowest id) goes through the official skill fold, plays
  lists, dan evidence and unrated list with its own SSR and chart dan, and the
  calendar buckets imports by their feed display time. Skill history is empty.
  A beatmap with no official chart analysis takes its dan facts from the
  imports' own analysis (eligibility, OD, the verdict at each played rate), so
  its clears still count; it has no pattern tags. The cached read is dropped by
  every delete, quarantine and restore, as the standings are.

Chart files are different: they are the site's own map data, not a score. A
reservation first looks for the exact bytes in the pool, then in the site's own
`beatmap_osu_files` copy by declared md5 (re-hashed against the manifest before
it counts, `seedChartFromSiteCopy`), and only then asks the client for the
file. Contributed charts go into one shared pool: reuse is keyed by sha256, so
another account benefits only if it already holds the identical file, and the
bytes are served solely through the owner-scoped score routes. The consent
screen says the file may be sent; there is no separate opt-in.

Deletion is owner-scoped and idempotent: access and eligibility go first, then
the preview is recomputed, then the objects are released. A retried job cannot
resurrect a deleted submission.

Whether an object is kept is read from what points at it, never from a counter
(`companella_artifacts.refcount` is legacy and no longer read). A replay stays
while its owner has a live score with that key, or a submission with the same
replay sha256 in `awaiting_assets`, `queued`, `validating`, `analyzing` or
`deferred`. A chart stays while any live score or such submission in the
environment uses its sha256, whoever uploaded it, so a shared chart survives
one owner's deletion. Deleting a score frees its replay at once if nothing else
needs it. `releaseArtifact` claims the row as `orphaned` in the same statement
that checks for references, deletes the object, then the row; a failed object
delete leaves the orphaned row for the next pass. The files of rejected,
expired and duplicate submissions, and charts nobody plays any more, are
collected by maintenance 24 hours after the later of their last write and the
end of their last reference. The end of a reference is read from the rows
themselves: a chart is held while any score on it was deleted, or any
submission on it changed (rejected, expired, deleted), within the grace; a
replay while any of its owner's submissions with that digest changed, except
an owner-deleted one. A collected chart keeps its `companella_local_charts`
row with `storage_state = 'collected'`; the
next reservation gets `needs_beatmap: true`, and re-uploading restores
`committed`. One window stays open: a removal that claimed a row just before an
identical re-upload of the same bytes took it back can delete the new object,
leaving a committed row with nothing behind it (object storage is not
transactional with SQLite). The completion check's HEAD catches this when the
delete lands before `POST …/complete`, and the client re-sends the file. If it
lands after, processing cannot read the file, retries, and ends
`processing_failed`.

`companella_local_charts` is keyed by sha256 alone. A row another environment
wrote (a production database copied to a dev box) holds the key, so uploading
that chart answers `409 chart_environment_conflict` and logs
`companella_chart_environment_conflict` instead of storing anything. Making
those charts uploadable would need the table rebuilt with `(environment,
sha256)` as the key.

## Retention and quotas

| Thing | Default |
|---|---|
| Incomplete reservations | 72 hours |
| Test-client scores | 7 days |
| Accepted beta imports | kept until the owner deletes them |
| Deleted score rows | hard-deleted 30 days after `deleted_at` |
| Unreferenced replays and charts | collected 24 hours after their last write or the end of their last reference, whichever is later |
| Security events | 30 days |
| Proof ids / grants | pruned on the maintenance sweep |
| Revoked credentials | 30 days after revocation |
| Refresh credentials | 30 days after absolute or idle expiry |
| Access tokens | 1 day after expiry once a newer one exists; the newest is kept until 30 days after expiry and until the installation has no usable refresh credential |

A pruned credential answers `invalid_token` rather than `token_expired` or
`token_revoked`. Keeping the newest access token while refresh still works is
what lets a client that slept past expiry hear `token_expired` and refresh.

| Budget | Default |
|---|---:|
| Replay file | 25 MiB |
| Single `.osu` | 8 MiB |
| Manifest / token body | 16 KiB |
| Reservations | 12 per minute per account |
| Authorization requests | 10 per minute per account |
| Incomplete submissions | 32 per account (unexpired only) |
| New stored bytes | 256 MiB per account per day |
| Retained file quota | 1 GiB per account (replays and uploaded charts) |

A chart uploaded with `PUT beatmap` is charged to its uploader in both byte
budgets even though it joins the shared pool, and the charge stays with the
first uploader while other users' scores keep it alive; charts seeded from the
site's own copy are free. The reservation counts the replay, the chart when
`needs_beatmap` is true, and the bytes the account's other unexpired
reservations still expect (each digest once). The same check runs again when
the bytes arrive (`429 daily_upload_quota_exceeded` /
`retention_quota_exceeded`, retryable), except for bytes already committed, so
an identical retry is never refused. The daily budget reads its own ledger
(`companella_upload_ledger`, two days kept), not the stored objects, so
deleting a play does not give the day's bytes back.

The site's proxy caps what it carries before any of this: 64 KiB for token,
revoke and the reservation, 32 MiB for each file upload, no body on the other
routes. With the defaults above those caps never bind; a backend limit set
above them is cut at the proxy. An upload must also finish within 4 minutes:
the proxy's upload hop stays under Node's 5-minute request timeout, which both
the frontend server (not configurable under Nitro's node-server entry) and the
backend apply, so a slow upload gets the proxy's own `504` instead of a cut
socket.

These are starting values to tune from measurement, not claims about what a
player needs or what the server can take.

## Testing

`live-backend/tests/companella-*.test.ts`, with generated fixtures in
`companella-fixtures.ts`. The LZMA fixture is one real encoder's stream so the
decoder is exercised against a genuine encoder; everything else is synthetic, so
no real player's replay is committed.

**Synthetic fixtures prove protocol, parser and matcher behaviour. They do not
prove compatibility with what the Companella client actually writes.** That
needs a capture sample from the app; see `companella-operations.md`.
