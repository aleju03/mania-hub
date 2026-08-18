# Live Backend

Notes specific to `live-backend/` (the always-on service). Architecture reference: `../docs/backend.md`; per-feature models: `../docs/features.md`, `../docs/packs.md`, `../docs/discord.md`.

- Verify with `npm test` and `npx tsc --noEmit` here (or `npm run verify`).
- Schema lives in `migrations/001_initial.sql`, applied at boot; some newer tables are migrated in `src/db.ts`.
- Heavy deps (sharp, jszip, sanitize-html, @aws-sdk/client-s3, playwright-core) are lazy-imported at their point of use and must stay out of the boot module graphs (`npm run probe:boot-imports`, guarded by `tests/boot-imports.test.ts`).
- osu! API calls go through the token-bucket client in `src/osu/client.ts` (logged to `api_call_log`); never add a call path around it.
- Public endpoints are per-IP rate-limited by `src/http/abuse-guard.ts`; the general bucket applies to every `/api/` path, so a route with its own bucket spends both. `/api/admin/*` requires `LIVE_ADMIN_TOKEN`. Some per-user endpoints outside `/api/admin/*` are also token-gated and called server-to-server, with the frontend forwarding the osu!-verified viewer id so a user only touches their own data.
- Retention (`src/retention.ts`, hourly) prunes raw/transient rows only; durable projections (boards, top-play/snipe events, users, beatmaps, rosters, wallets, serials) are never auto-pruned. Per-table cutoffs in `../docs/backend.md`.
- `src/dan/` and `vendor/leoblack` hold the only copies of the dan estimator and the vendored LeoBlack engine; the frontend imports them through its `#dan/*` and `#leoblack/*` aliases, so a change here lands on both sides at once. Run the root `npx tsc --noEmit` as well as the backend's. That includes `src/dan/chart-classifier.ts`; its tests are `tests/dan-floor-pin.test.ts` and `tests/rice-vibro.test.ts`, and the shared estimator's are `tests/dan-*.test.ts`. Exception: `src/dan/companella.ts` diverges from the frontend's on purpose (MSD goes through `msd.ts` so MinaCalc stays serialized against the job lanes), so that one pair is still hand-synced.
