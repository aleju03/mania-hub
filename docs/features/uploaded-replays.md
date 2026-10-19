# Uploaded replays

Replays players upload as `.osr` files on `/replay`'s Upload tab. Uploads are **unlisted, not private**: the share link is public by design, and the `.osr` in R2 names no uploader. Listing or deleting one always goes through the owner index (`src/lib/uploaded-replays.ts`), never the R2 key.

## Storage

- **File**: R2 `replay-cache/uploaded-replays/<id>.osr`, written by `/api/replay-upload`, never lifecycle-expired.
- **Description**: everything human-readable is derived on demand into `replay-cache/uploaded-replay-desc/<id>.json.gz`.
- **Owner index** (backend): `uploaded_replays` (id, `owner_user_id`, `owner_username`, `original_filename`, `uploaded_at`). It lists "Your uploads" (`/replay/uploads`) and authorizes deletes. Routes `/api/uploaded-replays/{list,get,record,delete}` take the admin-token bridge with the osu!-verified viewer id; `asAdmin=1&all=1` is the admin's every-uploader view. Never pruned by retention.
- **Delete** removes the row first, then the R2 objects, so a half-failure leaves an orphan file `/admin/r2` can see rather than a live share link.
- `backfillUploadedReplayOwners` (admin button on `/replay/uploads`) rebuilds rows for uploads older than the index from the `uploaderid` metadata on each object.
- **Development** never writes uploads to R2 (`uploadedReplaysUseR2()` in `src/lib/uploaded-replay-store.ts`), because the local `.env` points at the production bucket and the community list is an R2 listing. Dev saves to `data/replay-uploads/` (gitignored), still reads through to R2 so prod share links open, and merges a read-only listing of the prod bucket into the community lists. `REPLAY_UPLOADS_TO_R2=1` opts back in.

## Community gallery

`/replay/community`, previewed by the nine newest on the Upload tab. Each card names its uploader from the owner index (`uploadedBy`, batched through `/api/uploaded-replays/rows`), because the uploader and the player in the replay are not always the same person.

- Search across map/player/uploader/mod metadata, key and grade filters, a star range, newest/oldest sort; all controls live in the URL. Rate-changing plays use a star rating computed at their rate when available; a mismatched chart revision is never used for it.
- 24-card cursor pages, prefetched one ahead. Covers missing artwork draw `ReplayCoverFallback` with no image request.
- The metadata catalog (`uploaded-replay-community-server.ts`) is a best-effort JSON cache under `data/replay-uploads/`. R2 stays authoritative: a background listing reconciles every two minutes or after an upload/delete, a failed listing keeps the previous catalog, and a generation guard stops an in-flight hydration from resurrecting a deleted upload. Gallery requests never wait on replay decoding or osu! lookups.

## Opening an upload

- The server parses the `.osr` once into the packed frame shape (`packUploadedReplay` in `src/lib/uploaded-replay-open.ts`, artifact `replay-cache/parsed/uploads/v<n>/<id>.json.gz`, seeded by the upload POST) and resolves the chart in the same call (`resolveUploadedReplayBeatmap`), so opening is one round trip. The browser never downloads the raw `.osr`; `/api/replay-upload?id=` is only the file download.
- Playback uses the **uploader's** replay skin, even when an embedded score id belongs to someone else: most uploads are the uploader's own plays.
- Checksum lookups use the API limiter's interactive lane, with checksum metadata (including confirmed 404s) cached five minutes per instance and concurrent lookups coalesced.

## Community beatmaps

When osu! cannot serve the replay's map (unsubmitted, deleted, or a locally edited revision), the viewer asks whoever opened it for the `.osz`.

- The matched `.osu` goes to `replay-cache/community-beatmaps/<md5>.osu` (`src/lib/community-beatmap-store.ts`, content-addressed, never evicted). Community copies are checked on every unresolved open, with a three-second deadline for the chart and a separate one for assets.
- **Audio and background** are posted to `/api/community-beatmap-asset` and stored beside it. A file is accepted only when the stored `.osu` names it, its bytes sniff as audio or an image, and it fits the cap (48 MB audio, 16 MB image). First write wins, so nobody can swap the song later. Audio streams with Range passthrough; the background redirects to signed storage like `/api/background`.
- **Stand-in**: for a silent copy of a map osu! does not know, `/api/uploaded-replays/chart-stand-in` (`backend/src/features/chart-stand-in.ts`) looks for a strict `compareCharts` match (time scale 1, offset at most 2 ms) by `beatmap_chart_families.topology_key`, preferring ranked/loved/approved. The viewer then streams that set's audio and background while still judging on the community chart. Cached 30 minutes per checksum and recorded as `replay_stand_in_beatmap_id`.
- Covers fall back to the contributed background, then the stand-in set's cover (`resolveUnknownMapCover`).
