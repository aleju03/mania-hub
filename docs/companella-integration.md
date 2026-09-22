# Companella integration

The Companella score-import beta: a native osu! companion app sends completed
osu!stable mania plays to Mania Hub over an authenticated HTTPS API, and the
owner of the account sees them, and their effect on an experimental rating
preview, on `/companella`.

**Status: off by default.** `COMPANELLA_MODE` is `disabled` unless a deployment
sets it, and nothing in this integration affects public rankings, pp, snipes,
packs, goals or any official projection. See `companella-operations.md` for the
rollout switch and `companella-client-guide.md` for the client contract.

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
| `artifacts.ts` | Staged/committed object registry, refcounts, orphan reconcile. |
| `charts.ts` | Exact chart bytes, parsed facts, shared-pool consent. |
| `chart-matching.ts` | Read-only relationship lookup and the directional rate. |
| `lzma.ts`, `replay-file.ts` | Bounded LZMA1 and `.osr` parsing. |
| `validation.ts` | Identity, completion and the mod capability matrix. |
| `replay-timing.ts` | Judges the replay's key presses: the Wife3 goals the rating runs at, and the header check. |
| `analysis.ts` | Per-play MSD / SSR / LN / chart-dan through the existing engines. |
| `preview.ts` | The experimental aggregate, and its deduplication. |
| `process.ts` | The job body: validate, store, match, analyze, recompute. |
| `security-events.ts` | What the server observed. Not a cheating score. |
| `lifecycle.ts` | One self-chaining maintenance job. |
| `public-profile.ts` | A restricted player's imports, for their public profile. |

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
   `dpop_jkt`.
2. The page validates those, creates a short-lived request row, and sends an
   unauthenticated browser through the ordinary osu! login with a `next` that
   points back at this same request (normalized to a path on this site).
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
   rather than a second installation.

Reconnecting an already-approved key reuses its row (partial unique index on
`environment, user_id, key_thumbprint` where active), so a reinstall does not
leave a graveyard. Two different keys on one account are two installations,
which is what dual boot looks like.

Lifetimes: consent request 10 minutes, code 2 minutes, access token 5 minutes,
refresh 90 days absolute / 30 days idle. Refresh credentials are
sender-constrained and **not** rotated: RFC 9700 allows either, and doing both
means a lost response burns a credential the client never received.

## Submitting a play

Metadata first, files second, completion third.

`POST /submissions` reserves an idempotent submission from a manifest carrying
only digests and lengths. Identity-setting fields (`user_id`, `username`,
`accuracy`, `msd`, `beatmap_id`, `mods`, …) are **rejected**, not ignored: a
field we would have to distrust is better refused than silently accepted.

The response says which assets the server still needs. `needs_beatmap: false`
is answered only when the exact bytes are verified to exist and are reusable by
this account. A metadata row, a matching family, or a beatmap id is not a file.

`PUT …/replay` and `PUT …/beatmap` take raw bytes. No base64, no gzip, no line
ending or BOM rewriting: the digests were taken over exactly these bytes, and
the `.osr` header's MD5 is over the chart's original bytes.

`POST …/complete` transitions the row durably and then enqueues. If the enqueue
is lost to a crash the row stays `queued` with `enqueued = 0`, and the
maintenance sweep picks it up. A completion never means "analyzed".

Three separate deduplications:

1. **Delivery**: same owner + idempotency key + manifest returns the same
   submission. A conflicting manifest under one key is `409`.
2. **Same play**: a versioned fingerprint over parsed score facts and the
   canonicalised input timeline, enforced by a partial unique index. Its
   limitation is the mirror image (two genuinely different plays sharing every
   fact would collide), which is why it gates credit and never deletes data.
   The replay's own stored hash is untrusted metadata and is not used.
3. **Rating evidence**: see the preview section.

## Validation

`process.ts` runs as a queued job, never on the request path.

- Raw replay bytes match the manifest's length and SHA-256.
- The `.osr` header's beatmap MD5 matches the manifest and the **raw bytes** of
  the stored chart.
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
awards one judgement per mania object, holds included. A count *above* the
object total is `unknown`, not a pass.

Identity compares the replay's player name to the account's, through a
conservative normalization (case folding plus osu!'s space/underscore
equivalence). A mismatch is quarantined and explained privately; it is never
silently credited to whoever holds the token, and the original header is kept.
The comparison reads the cached `users` row, never an osu! API call per upload.

Mods:

| Class | Mods | Outcome |
|---|---|---|
| Rejected | AT, CN, RX, AP, TP | submission refused |
| Stored unrated | MR, RD, key conversion, CO, unknown bits | accepted, explicit reason |
| Supported | NF, EZ, HD, HR, SD, PF, DT, NC, HT, FL, FI, V2, TD, SO | analyzed |

An unrecognised bit is never read as NoMod.

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
judge, which is one reason only MSD-supported key counts are judged at all.

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

An exhausted comparison budget returns `deferred` with a cursor, not
`unmatched`. A missing reference file is skipped, which is why a negative result
is never described as exhaustive.

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
calibrated goal and the analysis version. A family id alone would be wrong.

`preview.ts` reads the player's stored official ratings and retained evidence
from `player_skill_ratings` and computes a second aggregate over the same
evidence plus eligible local imports, using the exported
`selectMsdRatingPlays` + `aggregateSsrs` + `SKILL_RATING_SKILLSETS`. It writes
only `companella_rating_previews`, under a generation fence so a slow older
computation cannot overwrite a newer one.

Evidence deduplication uses a versioned effective-play key:

```
keyCount | familyIdentity | (relativeRate × runtimeRate, 3dp) | sv1|sv2 | std|inv
```

so a baked 1.2× file played at NoMod collapses onto the original played at
1.2×, while two genuinely adjacent rates stay distinct. A play that already
exists in the official evidence under the same key is excluded rather than
counted twice.

Only charts the index recognises count, rate copies and padded copies included,
the way official ratings only take ranked and loved maps: a chart built to be
overrated would otherwise be the easiest way to move the number. A recognised
copy whose scroll speed differs from its original is left out too, because MSD
cannot see scroll speed and an easier-to-read copy would rate the same.
Everything else is still analyzed and shown to its owner per play.

Every ineligible play is explained: `analysis_pending`, `analysis_failed`,
`analysis_unsupported`, `under_review`, `identity_unresolved`,
`completion_unconfirmed`, `relationship_ambiguous`, `chart_match_pending`,
`chart_not_recognized`, `scroll_speed_changed`, `already_counted_officially`,
`duplicate_effective_play`. "Your import did not
move the number" and "your upload failed" are different things and the page says
which.

`ratingPolicy` is fixed at `experimental_only`. Widening it is an owner
decision, not a config flag someone can flip by accident.

## Privacy

One exception to owner scoping: a restricted or missing account (osu! no
longer serves it, see `docs/admin.md`) shows its imports on its public profile,
because nothing else can add a play to that page.
`GET /api/integrations/companella/public/players/<id>` (`public-profile.ts`,
no bridge token) answers only for such an account and only with plays that
passed every check the preview requires, read from the stored preview: identity
match, completed, clear review, supported analysis, a recognised chart. A
weaker repeat of a counted play still shows; it only lost the deduplication. It sends the play, its MSD/SSR and the preview's
per-keymode overall, never the replay, the chart bytes, the installation, or
any private explanation. An active account's imports stay owner-only.

Replays live under `integrations/companella/<environment>/replays/<owner>/…` in
the private replay-cache bucket, behind unguessable content-addressed keys, and
are read only through the owner-scoped `/api/companella/replay` route, which
authorizes before a byte moves and answers `404` for a foreign id (a `403`
would confirm the score exists). They never enter the public upload flow, the
community listing, the public SSE feed, or any shared cache: every private
response is `no-store`.

Chart files are different: they are the site's own map data, not a score. A
reservation first looks for the exact bytes in the pool, then in the site's own
`beatmap_osu_files` copy by declared md5 (re-hashed against the manifest before
it counts, `seedChartFromSiteCopy`), and only then asks the client for the
file. Contributed charts go into one shared pool: reuse is keyed by sha256, so
another account benefits only if it already holds the identical file, and the
bytes are served solely through the owner-scoped score routes. The consent
screen says the file may be sent; there is no separate opt-in.

Deletion is owner-scoped and idempotent: access and eligibility go first, then
the preview is recomputed, then the objects are released. `releaseArtifact` only
deletes an object nothing references, so a shared chart survives one owner's
deletion. A retried job cannot resurrect a deleted submission.

## Retention and quotas

| Thing | Default |
|---|---|
| Incomplete reservations | 72 hours |
| Test-client scores | 7 days |
| Accepted beta imports | kept until the owner deletes them |
| Security events | 30 days |
| Proof ids / grants | pruned on the maintenance sweep |

| Budget | Default |
|---|---:|
| Replay file | 25 MiB |
| Single `.osu` | 8 MiB |
| Manifest / token body | 16 KiB |
| Reservations | 12 per minute per account |
| Incomplete submissions | 32 per account |
| New stored bytes | 256 MiB per account per day |
| Retained replay quota | 1 GiB per account |

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
