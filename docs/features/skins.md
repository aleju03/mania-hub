# Skins

Skin uploads on `/skins`: visibility, dates, likes, the trait filters and previews.

## Private skins

Skins carry a `visibility` (`public`/`private`) beside `status`.

- A private skin is off `/skins` and the duplicate guard, counts no downloads or views, and 404s for anyone but its uploader. A true admin can read it for moderation; their private-skins shelf lists every uploader's (`allPrivate=1` on `/api/skins/list`).
- Its R2 objects live under a `p-<secret>` key segment, never get a public bucket URL, and only answer to `?t=<secret>`, which `toSkinSummary(row, { asOwner })` attaches for owner-scoped reads only. **Any endpoint that serves a skin must go through that serializer, never the raw row.**
- Replay viewers never receive a private `.osk`: `/api/replay-skin/bundle` (`backend/src/skins/replay-bundle.ts`) zips only the assets the player's stored settings draw. This protects the file and the page, not the pixels a replay shows.

## Dates

- `published_at`: when the `.osk` was uploaded. Shown as "Uploaded" on the skin page.
- `listed_at`: when the skin first became public, stamped by `finishSkin` for a public upload or by `setSkinVisibility` the first time a private one goes public. Only the first listing stamps, so toggling visibility cannot bump a skin to the top.
- Every `/skins` sort and the relative times use `coalesce(listed_at, published_at)`.

## Likes

- Accounts: `skin_likes`, one row per account per skin, with `like_count` recomputed in the same batch as the write (`setSkinLike`). Only published public skins take likes, never from their uploader.
- The public list and get stay cacheable and carry only the count. The viewer's own likes come from `/api/skins/liked-ids` (once per tab, `useLikedSkinIds`) and `liked` on a bridge-token `/api/skins/get`. `POST /api/skins/like` and the "liked by you" filter (`liked=1`) go through server fns in `src/lib/skins.ts`.
- **Signed out**, a like belongs to the browser: a random guest id in localStorage (`mania-hub-skin-guest-id`), stored in `skin_guest_likes` with `ip_key`, an HMAC of the network (full IPv4, or IPv6 /64) under a per-database salt in `live_meta`, so no address is stored. `like_count` counts accounts plus distinct guest networks, so clearing the id or a private window adds nothing. Guest routes go browser-direct (`POST /api/skins/guest-like` on `publicCostly`, `GET /api/skins/guest-liked-ids`, `liked=1&guest=<id>` served `no-store`) so the backend sees the visitor's address.
- On sign-in, the next liked-ids read sends the guest id and the bridge-only `POST /api/skins/claim-guest-likes` moves those likes to the account (dropping any on the account's own skins).
- Deleting a skin drops its likes; nothing else prunes them.

## Trait filters

Columns derived from each `.osk` at upload or replacement (`backend/src/skins/archive-meta.ts`, backfilled at boot by `backfillSkinArchiveMeta`):

- `lane_cover`: a `lanecover` file, an oversized stage hint, or a `StageBottom` canvas that covers part of the top lanes (the two community cover tricks).
- `mania_stage`: the skin draws its own stage rails (`StageLeft`/`StageRight` resolved per keymode, with visible pixels). Hidden or transparent stage art does not count, and `StageBottom`/`StageHint` are not rail evidence.
- `lazer`: lazer editor files (`skininfo.json`, `MainHUDComponents.json`, ...) or the skin.ini comment older lazer builds add. "Stable" is the complement and includes unanalyzed rows.
- `note_shape` (`circle`/`arrow`/`bar`/`other`, `classifySkinNoteShape`): classified per keymode from the trimmed aspect and an 8x8 alpha mask; the skin label is the majority (ties to the lowest keymode). `note_shapes_json` holds every shape a keymode uses, so a mixed skin appears under each, and summaries expose `noteShapes`. A keymode with no resolvable tap sprites counts as a fallback bar, because stable draws a flat default there. A shape-filtered list returns `filterKeys` so the card shows a preview whose keymode has that shape.
- `resolution`: the uploader's optional "made for" answer, normalized to `WxH` (`normalizeSkinResolution`). Its chips are a facet of the current query; `SKIN_RESOLUTION_PRESETS` is only the input's datalist.
- Screenshots: `screenshots_json` non-empty.

## Previews and animation

- Catalog previews use the same per-keymode layout as replay playback: receptors anchored at `HitPosition`, `KeysUnderNotes`, `ColourJudgementLine` (invisible black included), `ScorePosition`/`ComboPosition`.
- Animated note art (`name-0.png`, `name-1.png`, ...) imports as the first frame plus `frames`, outranking a static copy as in game. Mania note animations run at a fixed 60 FPS, ignoring `AnimationFramerate`, as osu!'s legacy mania loader does. Each note's clock starts when it would cross the hit line. Keys never animate and hold bodies stay on their first frame. Frames are included in a stored skin's replay bundle.
