# Maps

The `/maps` browser, map collections and the farm helper (`/recommendations`). Per-chart analysis (MSD, dan, LN, note BPM) is in [chart-analysis.md](chart-analysis.md).

## Farmed, Most Played and Favourites

- `refresh_user_maps_farmed_scores` pulls a roster user's top 200 and extracts the scores that entered their top plays; `refresh_country_maps` aggregates them into `country_maps_snapshots`; `refresh_global_maps` rolls countries into a global snapshot. Progress is in `live_meta`, served by `/api/snapshots/maps-progress`.
- **Regions store nothing**. Farmed is GLOBAL's packed board narrowed on the maps thread to players whose osu! country is in the region, aggregates recomputed and cached per GLOBAL board revision. Most Played and Favourites fold the member countries' snapshots with `foldCountryMapsSnapshots`. Random and the map modals filter per-country tables with `mapsScopeMatch`.

## Search index

`/maps` search reads `map_search_index`, materialized from `beatmap_skill_vectors` plus beatmap/set metadata.

- **Status**: the zero-API reconciler in `map-search.ts` (`reconcileMapSearchIndexStatuses`, event-driven plus hourly) only moves in-flux -> settled, which shields against stale score payloads. The hourly `refresh_qualified_maps` watch (`features/qualified-maps-watch.ts`) is the only writer allowed to move a row backwards (qualified -> pending), because its osu! read is current. It skips converts and queues `analyze_beatmap_chart` for newly qualified diffs.
- **Ranked dates**: score payloads carry no `ranked_date` and ingest never overwrites `metadata_json`, so the hourly tick copies dates the set row has since gained (`reconcileMapSearchIndexRankedDates`) and sends dateless sets to `enrich_beatmap` (`enqueueRankedDateEnrichment`, 50 sets per tick). When a qualified set settles, osu! moves `ranked_date` to that moment; the flip stamps the index date to now and routes the set through enrich for the real date, so Newest surfaces it like a new map.
- `SOURCE_SELECT` excludes sub-0.2* in-flux placeholder diffs; `pruneMapSearchPlaceholderRows` clears indexed ones.
- **Skill tiles** (`dan_tiles`, from `chartDanTiles` in `player-skills.ts`): the chart filed at 1.0x by the same `bucketsForClear` rules a clear on it gets, with its own MSD standing in for SSRs. A shared chart matches either tile.
- **MSD filter**: `msd_shown_*` columns, the value the card shows (LN-adjusted where the chart has a tail pass); format `msd=key:min-max` (`lib/map-search-msd.ts`).
- **LN share slider** (`lnMin`/`lnMax`): `map_search_index.ln_share`, the hold share from osu!'s counts.
- Index columns are copied at upsert, so a change to the tile rules or LN blend weights needs a `BUILD_REVISION` bump.

**Text search**: terms of 3+ characters go through `map_search_fts` (FTS5 trigram over `search_text`, trigger-synced in `db.ts`); shorter terms use LIKE and lone ASCII characters are dropped. Counts stop at `MAP_SEARCH_COUNT_CAP` (5,000), and `/api/snapshots/maps-search` sits on the `publicCostly` bucket behind a 30s prepared-response cache. In production with a local DB, cache misses run on the maps snapshot worker thread; a worker failure returns an uncached 503 with `Retry-After`, never a synchronous retry on the serving connection (`MAPS_SNAPSHOT_THREAD=0` keeps the inline path).

## Map collections

The `/maps` Collections tab holds two kinds, switched by `cSrc`.

- **Auto packs** (`features/map-collections.ts`, `map_collections` + `map_collection_members`): code-defined recipes over `map_search_index` (pattern x keymode x difficulty bucket on dan and MSD), resampled from a quality pool on each `rebuild_map_collections` so packs rotate. Read over `/api/snapshots/map-collection{s,}`.
- **Community collections** (`features/user-map-collections.ts`, `user_map_collections` + `_items` + `_favourites`): a title, description, up to five tags and up to 100 ordered charts; 25 per account. Public immediately with no review state, since every member already passed osu!'s moderation. Owners edit or delete theirs; an admin can do either to anyone's (`asAdmin`), the only takedown path.
  - Members are validated against `map_search_index` on every write. The keymode chip, member count and cover collage are derived from the members, not typed. An edit that omits `beatmapIds` leaves the list untouched.
  - The picker falls back to `POST /api/map-search/lookup` (`features/map-search-lookup.ts`) for a pasted id or link the index lacks: one osu! call (none if `beatmaps` has it), an inline skill-vector pass, and a queued chart analysis.
  - Page `/collections/<slug>` (`src/routes/collections_.$id.tsx`), server-rendered for link previews. The slug is frozen at creation so renames never break links; ids are 10 hex characters. OG card `/api/og?kind=collection&id=` (`renderCollectionOg`), R2-cached per OG version.
  - Likes: one row per account per collection, the count denormalized and recomputed in the same batch as the write. All routes go through the bridge, because the viewer id (from the signed login cookie, via `src/lib/user-map-collections.ts`) decides which hearts are filled and which rows a write may touch.
  - Not pruned by retention.

## Recommendations (farm helper)

Lives at `/recommendations`; `/farm-helper/*` redirects there. Code, endpoints, analytics keys and the OG kind keep the `farm-helper` name.

Recommends maps by comparing a player's top 200 with a global peer pool at similar pp, from `country_maps_farmed_scores` across all countries. Per-keymode weighted pp lives in `farm_helper_user_key_stats`, seeded on first access.

- **Worker thread** (`features/farm-helper-thread.ts`): snapshot misses go to one serialized worker that selects peers, reads and scores farm rows and hydrates previews on a query-only connection. Peer farm rows come back as one `group_concat` string per peer (`readPeerFarmedPacked`), cached 5 minutes, since building a row object per score dominated the cost. Admission is capped at eight builds, with a 60s watchdog and a 30s respawn cooldown; failures return a retryable 503 (`Retry-After: 30`), never a rerun on the serving thread. Caching, coalescing and invalidation stay on the serving connection.
- **No username oracle**: the snapshot, farmers and neighbors routes only hydrate subjects with a roster row or `profile_snapshots`; other usernames 404 without touching osu!. The signed-in viewer is the one exception, forced to their own id. A server render of the viewer's own board pre-warms it (`warmOwnFarmHelperSnapshot`).
- **Lane columns**: `country_maps_farmed_scores` carries `key_count`, `speed_bucket` and `mods_key` written at insert, so the cohort read stays inside `idx_country_maps_farmed_scores_user_lane`.
- **Gain view**: the improve margin is `max(8pp, 2%)` of the subject's score; `belowGainFloorCount` explains thin boards; `practiceRecs` ("next tier") lists lanes the feasibility gate dropped that the cohort farms and the player never played, quoting the raw peer median. Sparse keymodes contribute none.
- **Skillboost** (push targets on owned lanes): capped by the personal accuracy model's prediction when it has one, with `subjectAccuracy`/`subjectMissCount`/`pushTargetAccuracy` for concrete advice. Push lanes are recorded in `farm_helper_push_targets` (frozen at first suggestion) and stamped achieved when reached or mostly closed; until `pushUnlocked` the frontend keeps them behind their tab. Never pruned.
- **Feedback** verdicts are `too_hard`, `too_easy` and `maxed` (a 60-day snooze that casts no feasibility vote).
- **Grinding**: the gain view hides every owned lane of a chart passed on 5+ separate days spanning 30+ days, the latest within 90 (`GRIND_*`, `readGrindedBeatmapIds`, from the activity archive).
- **Skills view** (`view=skills`, `farm-helper-skills.ts`) skips the peer pipeline: ranked non-vibro charts the player has not passed (plus loved/graveyard ones 10+ tracked players passed), whose value on the axis sits 0.25-1.25 above the player's **anchor**, on NM or DT. There is no HT lane: estimating 0.75x from a chart's NM-to-DT response misses the real calc by more than the band. The anchor is the median chart value of their 15 best plays on that axis, not the rating, because the rating is built from SSRs at the accuracy scored and sits well above the charts played (worst on 7K). A MinaCalc skillset's chart value counts only on charts where that skillset stands out; `pattern:ln` on 4K reads the LN tile; pattern axes read Overall on tagged charts. With no `skill`, the board opens on the player's lowest-percentile axis.
