import { createServer } from "node:http";
import { readConfig } from "./config.js";
import { errorContext, logInfo, logWarn } from "./logger.js";
import { ensurePinnedCountries, getIndexedCountryCodes, getMapsWarmCountryCodes, getRosterRefreshCountryCodes } from "./countries.js";
import { createDb, exec, getSqliteBusyRetryStats, logApiCall, migrate, SQLITE_MIGRATION_TOTAL_BUSY_WAIT_MS, withWriteGate } from "./db.js";
import { AnalyticsStore } from "./features/analytics.js";
import { routeHttp, sendNotFound, warmGlobalMapsFarmedBoard, warmStatusBodyCache } from "./http/snapshots.js";
import { ScoreIngestor } from "./ingest/score-ingestor.js";
import { JobQueue } from "./jobs/queue.js";
import { LiveEventLog } from "./live/event-log.js";
import { startRuntimeStatusMirror } from "./live/runtime-status.js";
import { enqueueGlobalFarmedBoardRepack, enqueueGlobalMapsRefreshIfDue, enqueueMapsRefreshIfDue, registerGlobalFarmedBoardDiskCache, registerGlobalFarmedBoardRepackDelegation } from "./features/maps.js";
import { cleanupBogusLnPatternTags, ensureMapSearchIndexSeeded, pruneMapSearchPlaceholderRows, reconcileMapSearchIndexPlayCounts, reconcileMapSearchIndexStatuses } from "./features/map-search.js";
import { enqueueQualifiedMapsWatchIfDue } from "./features/qualified-maps-watch.js";
import { enqueueSettledSetsReconcileIfDue } from "./features/settled-sets-reconcile.js";
import { ensureBracketContentRecomputeSeeded, ensureBracketTagRecomputeSeeded, ensureChordjackTagRecomputeSeeded, ensureCompanellaRecomputeSeeded, ensureDanEligibilityRecomputeSeeded, ensureDanFloorPinRecomputeSeeded, ensureDtRateAnalysisSeeded, ensureHtRateAnalysisSeeded, ensureInverseClusterBpmRecoverySeeded, ensureJackDemandRecomputeSeeded, ensureNkeyMsdSeeded, ensureJackTagRecomputeSeeded, ensureMotionFeaturesRecomputeSeeded, ensureLnMsdSweepSeeded, ensureLnLeoblackRecomputeSeeded, ensureLn7PrimaryRepinSeeded, ensureLnPrimaryRepinSeeded, ensureLnSourceRecomputeSeeded, ensureLnSubtypeRecomputeSeeded, ensureMsdPoisonRecoverySeeded, ensureNegativeTimeMsdRecoverySeeded, ensureNoteBpmRecomputeSeeded, ensureOsuFileRepairSeeded, ensureLeoblackRepinDtRecomputeSeeded, ensureLeoblackRepinRecomputeSeeded, ensureSunnyRepinDtRecomputeSeeded, ensureSunnyRepinRecomputeSeeded, ensureVibroRecomputeSeeded } from "./features/chart-analysis.js";
import { enqueueMapCollectionsRebuildIfDue } from "./features/map-collections.js";
import { startGoalUserIndexRefresh } from "./features/goals.js";
import { startFarmHelperFeedbackUserIndexRefresh } from "./features/farm-helper-feedback.js";
import { registerPackCommunitySnapshots, startPackCommunitySnapshotRefresh } from "./features/pack-community.js";
import { ensurePackCommunityRollupTriggers } from "./features/pack-community-rollups.js";
import { enqueueProfilePoolWarmIfIdle } from "./features/profile-pool-warm.js";
import { warmSkillLeaderboardBoard } from "./features/skill-leaderboards.js";
import { enqueuePlayerSkills, ensurePlayerSkillDanSweepSeeded, ensurePlayerSkillFloorSweepSeeded, ensurePlayerSkillMsdCapSweepSeeded, ensurePlayerSkillPatternSweepSeeded, ensurePlayerSkillPoisonRecoverySeeded, ensurePlayerSkillVibroSweepSeeded, PLAYER_SKILLS_JOB, PLAYER_SKILLS_VERSION } from "./features/player-skills.js";
import { enqueueSkillBaselineIfDue } from "./features/skill-baseline.js";
import { ensureTopScoresBackfillSeeded } from "./features/top-scores-backfill.js";
import { ensureActivityModsBackfillSeeded } from "./features/activity-mods-backfill.js";
import { ensureActivityComboBackfillSeeded } from "./features/activity-combo-backfill.js";
import { backfillActivityPlayDetails, trackActivityPlayDetailsBackfill } from "./features/activity-play-details-backfill.js";
import { ensureSkillVectorBackfillSeeded } from "./features/skill-vector-backfill.js";
import { backfillPackCardSerials } from "./features/pack-pulls.js";
import { ensurePackCardCatalog, ensurePackCardVariantKeys, ensurePackCollectionCardKeys } from "./features/pack-wallets.js";
import { backfillSkinNoteShapes, backfillSkinSlugs, backfillSkinViewCounts } from "./features/skins.js";
import { isSkinStorageConfigured, readSkinObject, skinObjectDeletesEnabled } from "./skins/r2.js";
import { backfillSkinArchiveMeta } from "./skins/archive-meta.js";
import { backfillSkinSpecialKeymodes } from "./skins/special-backfill.js";
import { backfillSkinVisualSignatures } from "./skins/visual-signature.js";
import { ensureArchivedPlayers } from "./archived-players.js";
import { AbuseGuard } from "./http/abuse-guard.js";
import { isAdmin } from "./http/request.js";
import { CountryClientTracker } from "./live/country-clients.js";
import { GhostHub, handleGhost } from "./live/ghost.js";
import { handleReplayPresence } from "./live/replay-presence.js";
import { handleSse } from "./live/sse.js";
import { enqueueOscBackfill } from "./osc/backfill.js";
import { OscSocketClient } from "./osc/client.js";
import { startScoresFallbackScheduler } from "./osc/scores-fallback.js";
import { OsuApiClient } from "./osu/client.js";
import { SqliteSharedRateLimiter } from "./osu/shared-rate-limiter.js";
import { enqueueRosterRefreshes } from "./rosters/country-rosters.js";
import { assertMigrationDiskHeadroom, startRetentionScheduler } from "./retention.js";
import { startCommunityInviteScheduler } from "./communities/refresh.js";
import { readProcessMemory } from "./shared/process-memory.js";
import { packGlobalBoard } from "./features/global-rankings.js";
import { startWalCheckpointer } from "./wal-checkpointer.js";
import { WorkerRunner } from "./workers.js";
import { createDiscordRuntime } from "./discord/index.js";

// Serving routes touch these tables; a server-role process must not start until
// the worker/all process has migrated all of them, or it would 500 on a
// partially-migrated DB (e.g. country_registry exists but live_event_log does
// not). Add any new table a hot route depends on so split boots stay safe.
// Declared above the entrypoint block so it is initialized before createApp()
// runs during module evaluation (avoids a temporal-dead-zone reference).
const REQUIRED_SCHEMA_TABLES = [
  "country_registry",
  "live_event_log",
  "live_meta",
  "jobs",
  "users",
  "beatmaps",
  "beatmapsets",
  "country_beatmap_scores",
  "country_beatmap_score_pbs",
  "country_beatmap_score_pb_state",
  "country_maps_snapshots",
  "top_play_events",
  "profile_snapshots",
  "profile_section_cache",
  "player_activity_days",
  "pack_collection_cards",
  "api_rate_limit_reservations",
  "user_goals",
  "farm_helper_feedback",
  "beatmap_osu_files",
  "map_search_index",
  "map_collections",
  "map_collection_members",
  "skins",
  "user_replay_skins",
];

// Same temporal-dead-zone hazard as REQUIRED_SCHEMA_TABLES above, and a sharper
// one: waitForSchema reads SCHEMA_WAIT_TIMEOUT_MS as a *default parameter*, so
// it is evaluated when createApp() calls it — on the microtask queue, while
// module evaluation is still suspended at `await createApp()` in the entrypoint
// block below. Declared under that block, this would throw "Cannot access
// 'SCHEMA_WAIT_TIMEOUT_MS' before initialization" on every server-role boot,
// before listen(), with nothing to catch it. Keep both consts above it.
//
// The two budgets must stay coherent, or a worker that is legitimately waiting
// out a deploy's contention would take the serving process down with it:
//   - migrate() (db.ts) may lose at most SQLITE_MIGRATION_TOTAL_BUSY_WAIT_MS
//     (300s) to SQLITE_BUSY — the passes it has to throw away plus the backoff
//     between them — then fails loudly. Add up to one in-flight busy_timeout
//     (10s) of overshoot.
//   - This poll must outlast that: 300s of contention + 120s of slack for the
//     uncontended part of a fresh-database migration (106 schema statements plus
//     32 helpers, including the big index batch) = 420s (7 min).
// On an existing database this is a no-op: all 25 required tables already exist,
// so the first poll returns in milliseconds no matter what the worker is doing.
// It only bites on a first boot, where the server genuinely must wait for the
// worker to reach migrateUserReplaySkins (step 22 of 32).
export const SCHEMA_WAIT_TIMEOUT_MS = SQLITE_MIGRATION_TOTAL_BUSY_WAIT_MS + 120_000;
const SCHEMA_WAIT_LOG_INTERVAL_MS = 15_000;

const IDLE_COUNTRY_ROSTER_REFRESH_INTERVAL_MS = 3 * 24 * 60 * 60 * 1000;

export async function createApp() {
  const config = readConfig();
  if (!config.liveAdminToken) {
    logWarn("live_admin_token_missing", {
      role: config.role,
      detail: "LIVE_ADMIN_TOKEN is not set; admin and user-scoped endpoints fail closed (401). Public endpoints are unaffected.",
    });
  }
  // The skins bucket is shared with production, so a non-production process
  // (dev build or loopback LIVE_PUBLIC_ORIGIN) never deletes or moves skin
  // objects: rows still update, the objects just stay in the bucket.
  if (isSkinStorageConfigured(config) && !skinObjectDeletesEnabled(config)) {
    logWarn("skin_r2_deletes_disabled", {
      role: config.role,
      nodeEnv: config.nodeEnv,
      origin: config.livePublicOrigin,
    });
  }
  const db = await createDb(config);
  // The GLOBAL farmed board normally lives on the maps snapshot thread (which
  // registers its own connection); this covers the inline fallback path, e.g.
  // source-mode dev where the thread is disabled.
  registerGlobalFarmedBoardDiskCache(db, config.databaseUrl);
  // The /packs/collections economy roll-up: opts this connection into its own
  // worker thread (the group-bys behind it are seconds of synchronous libsql,
  // which would otherwise freeze the whole process) and into the disk cache
  // that lets a restart start warm instead of making the first visitor wait
  // out a cold scan.
  registerPackCommunitySnapshots(db, config);
  // Exactly one process owns schema DDL. A "server"-role process attaches to a
  // DB the worker process migrates, so it waits for readiness instead of racing
  // the worker on concurrent ALTER/CREATE (which would throw duplicate-column).
  const isServerRole = config.role === "server";
  if (isServerRole) {
    await waitForSchema(db);
  } else {
    // A migration that builds an index needs transient room well beyond the
    // rows it covers, and a half-applied migration on a full disk is worse
    // than a refused boot. Warns above the hard floor, throws below it.
    await assertMigrationDiskHeadroom(config);
    // Migrate on a throwaway connection with a much larger busy_timeout than the
    // serving/ingest default (10s vs 2s). A deploy restarts this process while
    // the previous one is still writing, so every DDL statement races a live
    // writer; absorbing that wait inside SQLite is by far the cheapest outcome,
    // because a statement that gives up and returns SQLITE_BUSY costs the whole
    // migration pass plus a connection reopen (db.ts explains why). Blocking
    // this long is safe only here: nothing else in this process exists yet — no
    // worker, no timer, no listener needs the event loop during migrate().
    // Closed immediately after, so the process does not carry a second
    // connection (and its page-cache/mmap window) for the rest of its life.
    // Only for an on-disk database: with a ":memory:" URL a second connection is
    // a second, private database (and nothing can contend with it anyway).
    const migrationDb = usesSharedDbFile(config.databaseUrl)
      ? await createDb({ ...config, sqliteBusyTimeoutMs: config.sqliteMigrationBusyTimeoutMs })
      : null;
    try {
      await migrate(migrationDb ?? db);
    } finally {
      migrationDb?.close();
    }
    // Data backfill rides with schema ownership: assign slugs to skins
    // published before the slug column existed.
    await bootWrite("backfill_skin_slugs", () => backfillSkinSlugs(db));
    // The note-art digest already contains every per-keymode shape, so this
    // fills the mixed-shape filter column without re-downloading any .osk.
    await bootWrite("backfill_skin_note_shapes", () => backfillSkinNoteShapes(db));
    // Classify skins uploaded before 7K+1 detection existed by re-reading each
    // stored .osk's skin.ini (metadata only; the uploads themselves stay as
    // they are). One-shot like the slug backfill, but it downloads the whole
    // catalog from R2, so it runs behind boot instead of holding it up.
    if (isSkinStorageConfigured(config)) {
      void backfillSkinSpecialKeymodes(db, (key) => readSkinObject(config, key, config.skinOskMaxBytes))
        .then((updated) => {
          if (updated > 0) logInfo("skin_special_keymodes_backfilled", { updated });
        })
        .catch((error) => logWarn("skin_special_keymodes_backfill_failed", errorContext(error)))
        // Note-art signatures for skins uploaded before similar-skins scoring
        // existed. Chained behind the keymode scan so the two catalog sweeps
        // never hold two .osk buffers at once; same one-shot marker pattern.
        .then(() => backfillSkinVisualSignatures(db, (key) => readSkinObject(config, key, config.skinOskMaxBytes)))
        .then((updated) => {
          if (updated > 0) logInfo("skin_visual_signatures_backfilled", { updated });
        })
        .catch((error) => logWarn("skin_visual_signatures_backfill_failed", errorContext(error)))
        // Lane-cover / stage / lazer flags and the note-shape label for skins
        // uploaded before the filter columns existed. Chained for the same
        // reason: one .osk buffer in memory at a time. Runs after the visual
        // sweep on purpose - the shape label is classified from visual_json.
        .then(() => backfillSkinArchiveMeta(db, (key) => readSkinObject(config, key, config.skinOskMaxBytes)))
        .then((updated) => {
          if (updated > 0) logInfo("skin_archive_meta_backfilled", { updated });
        })
        .catch((error) => logWarn("skin_archive_meta_backfill_failed", errorContext(error)));
    }
    // Combo and replay availability for activity rows written before those
    // columns existed, re-derived from payloads the database still holds. One
    // sweep over a million rows, so it runs behind boot rather than holding it
    // up, and it marks itself done so every later boot is a single lookup.
    // Tracked, not just fired: the capped combo sweep seeds later in boot and
    // must not spend its slots on rows this pass is about to fill for free.
    trackActivityPlayDetailsBackfill(
      backfillActivityPlayDetails(db)
        .then((result) => {
          if (!result.skipped) {
            logInfo("activity_play_details_backfilled", { candidates: result.candidates, healed: result.healed, updated: result.updated });
          }
        })
        .catch((error) => logWarn("activity_play_details_backfill_failed", errorContext(error))),
    );
    // GOAT cards split off from their player's ordinary card, so collection
    // rows are keyed (owner, card_key) now. Rebuilds the table once on a
    // database created before that; a no-op on every boot after.
    await bootWrite("rekey_pack_collection_cards", () => ensurePackCollectionCardKeys(db));
    // Card faces (name, avatar, skills snapshot, mint stats) moved to one row
    // per variant in pack_cards; ownership rows keep only copies, tier and
    // stamps. Seeds the catalog and rebuilds the table slim once on a database
    // from before the split; a no-op on every boot after.
    await bootWrite("split_pack_card_catalog", () => ensurePackCardCatalog(db));
    // Card serials arrived after people had been collecting for months. Every
    // holding writer now mints one transactionally; this one final legacy pass
    // seeds rows created before that invariant, then never scans again.
    await bootRepairOnce(db, "backfill_pack_card_serials", "pack_card_serials_backfill:v2", () => backfillPackCardSerials(db));
    // Cards handed out from /admin/collections used to share their player's
    // ordinary key, which made a one-off indistinguishable from a pulled card
    // by anything but its columns. Admin edits now move customized derived
    // cards transactionally; this final legacy pass moves the old rows once.
    await bootRepairOnce(db, "variant_pack_card_keys", "pack_card_variant_keys:v2", () => ensurePackCardVariantKeys(db));
    // Pack duels were dropped as a mode, so the prototype's table and its share
    // of the arcade ledger go with it. A no-op on every boot after the first,
    // and on any database created since the schema stopped declaring it.
    await bootWrite("drop_pack_duels", async () => {
      await exec(db, "drop table if exists pack_duels");
      await exec(db, "delete from pack_game_rewards where source = 'duel'");
    });
    // Seeds the checked-in archived-player profiles (deleted osu! accounts we
    // reconstructed from the Wayback Machine). Content-addressed, so this is a
    // no-op on every boot after the first that sees a given file.
    await bootWrite("seed_archived_players", () => ensureArchivedPlayers(db));
    /* Arms the community roll-up's dirty-row triggers. Deliberately after the
       two rebuilds above rather than in the migration: both drop and rename
       pack_collection_cards, and a trigger on a dropped table goes with it.
       Re-running three `if not exists` statements every boot is what makes that
       self-healing. */
    await bootWrite("pack_community_rollup_triggers", () => ensurePackCommunityRollupTriggers(db));
  }
  // The shared osu! limiter only touches api_rate_limit_reservations (a few
  // hundred rows, pruned to a 60s window) and one live_meta key. Inheriting the
  // main connection's SQLITE_CACHE_MB/SQLITE_MMAP_MB would map a 256 MiB window
  // of a multi-GB database in every process for that, so pin it small — same
  // shape as serveWriteDb below.
  const rateLimitDb = await createDb({ ...config, sqliteCacheMb: 2, sqliteMmapMb: 0 });
  // A tiny dedicated write connection (+ its own queue) for the page-serving
  // path's best-effort bookkeeping (country touch, refresh scheduling). Keeping
  // those writes off the `db` connection that serves page-load reads is the
  // invariant that stops a busy single WAL writer from freezing the whole site:
  // a stuck write here can never queue in front of a read. Small cache/mmap — it
  // only runs a handful of one-row writes. The pure worker role never serves
  // HTTP, so it does not need one.
  // Gated and on a short busy_timeout: request-path writes queue in JS (async,
  // shed-able) instead of each blocking the event loop inside SQLite's busy
  // wait — the 2026-08-29 saturation freeze mechanism. See withWriteGate.
  const serveWriteDb = config.role === "worker"
    ? null
    : withWriteGate(await createDb({ ...config, sqliteBusyTimeoutMs: config.sqliteServeWriteBusyTimeoutMs, sqliteCacheMb: 2, sqliteMmapMb: 0 }));
  const serveWriteQueue = serveWriteDb ? new JobQueue(serveWriteDb) : null;
  // Two-process split only: the serving process never runs the ~1.4GB full
  // GLOBAL board pack itself — it asks the worker process (via the dedicated
  // write connection, never the serving one) and adopts the resulting disk
  // snapshot. Covers the main-isolate fallback board; the maps snapshot
  // thread registers its own delegation (maps-snapshot-thread-worker.ts).
  if (isServerRole && serveWriteQueue) {
    registerGlobalFarmedBoardRepackDelegation(db, () => enqueueGlobalFarmedBoardRepack(serveWriteQueue));
  }
  // In-house analytics lives in its own SQLite file on its own connection,
  // owned by the HTTP-serving process (capture posts, admin queries, live
  // SSE); a pure worker process never opens it.
  const analytics = config.role === "worker" ? null : new AnalyticsStore(
    await createDb({
      databaseUrl: config.analyticsDatabaseUrl,
      sqliteBusyTimeoutMs: config.sqliteBusyTimeoutMs,
      sqliteSynchronous: config.sqliteSynchronous,
      sqliteCacheMb: 8,
      sqliteMmapMb: 0,
    }),
    {
      retentionDays: config.analyticsRetentionDays,
      databaseUrl: config.analyticsDatabaseUrl,
      // Outside production there is no live-site host to allowlist; show
      // local traffic in the feed instead of filtering everything out.
      feedHosts: config.nodeEnv === "production" ? undefined : null,
      feedExcludedViewer: config.nodeEnv === "production" ? undefined : null,
    },
  );
  if (analytics) {
    await analytics.ensureSchema();
    analytics.start();
    // Seeds view counts for skins published before the counter existed, from
    // the page opens and download clicks analytics has been recording for
    // them all along (floored at each skin's download count). It has to
    // live here rather than beside the other skin backfills: those run under
    // schema ownership, and the analytics database only exists in a process
    // that serves HTTP. Groups over the whole events table, so it runs behind
    // boot rather than holding it up, and writes on the serving process's own
    // write connection like every other serving-side write.
    if (serveWriteDb) {
      // Waits for the column first. This process does not migrate, and
      // waitForSchema only proves the tables exist - skins has existed for
      // months, so on a deploy that restarts both units together this would
      // otherwise race the worker's "alter table skins add column view_count"
      // and fail the whole seed until someone restarted it again.
      void waitForSkinsViewCountColumn(db)
        .then(() => backfillSkinViewCounts(serveWriteDb, () => analytics.getSkinViewCounts()))
        .then((seeded) => {
          if (seeded > 0) logInfo("skin_view_counts_backfilled", { seeded, retention_days: config.analyticsRetentionDays });
        })
        .catch((error) => logWarn("skin_view_count_backfill_failed", errorContext(error)));
    }
  }
  const queue = new JobQueue(db);
  const events = new LiveEventLog(db);
  // Startup writes belong to the ingest/worker side; a serving process stays
  // read-mostly so it never contends with the worker on these at boot.
  if (!isServerRole) {
    await bootWrite("queue_shed_pressure", () => queue.shedPressure());
    await bootWrite("ensure_pinned_countries", () => ensurePinnedCountries(db, config));
    // Keep the in-memory "who has open goals" filter warm in the process that ingests scores, so
    // the ingest hot path skips a DB lookup for players with no goals (and learns of goals created
    // by a separate server-role process within a refresh interval).
    startGoalUserIndexRefresh(db);
    // Same shape for farm-helper feedback marks: the ingest hot path's
    // auto-resolution skips a table lookup for players with no active marks.
    startFarmHelperFeedbackUserIndexRefresh(db);
  } else if (serveWriteDb) {
    // A server-role process must not write on its serving connection, but the
    // registry read path (/api/countries/features, /api/status) needs the pinned
    // countries to exist. Seed them once on the dedicated write connection at
    // boot so getCountryRegistry can read them with { ensure: false } and never
    // issue ensurePinnedCountries upserts on ctx.db.
    await ensurePinnedCountries(serveWriteDb, config).catch(() => undefined);
  }
  const logOsuCall = (entry: { caller: string; path: string; startedAt: number; durationMs?: number | null; status?: number | null }) => {
    // Never the serving connection: every osu! call logs, including the ones a
    // page load triggered through the proxy, and libsql runs one connection's
    // operations serially — a call-log write that lands mid-contention would
    // stall every read queued behind it (3cc0638). The worker role has no
    // serving connection to protect and keeps using its own.
    void logApiCall(serveWriteDb ?? db, {
      provider: "osu",
      caller: entry.caller,
      path: entry.path,
      startedAt: new Date(entry.startedAt).toISOString(),
      durationMs: entry.durationMs,
      status: entry.status,
    }).catch(() => {});
  };
  const sharedOsuLimiter = new SqliteSharedRateLimiter(rateLimitDb, {
    provider: "osu",
    targetPerMinute: config.osuApiTargetPerMinute,
    hardPerMinute: config.osuApiHardPerMinute,
  });
  const osu = new OsuApiClient(config, fetch, logOsuCall, { sharedLimiter: sharedOsuLimiter });
  const scoresFallbackOsu = new OsuApiClient(getScoresFallbackOsuConfig(config), fetch, logOsuCall, { sharedLimiter: sharedOsuLimiter });
  const ingestor = new ScoreIngestor(db, queue, events, config, osu.hasCredentials() ? osu : undefined);
  const abuse = new AbuseGuard();
  const countryClients = new CountryClientTracker();
  // Serving-process only, like replay presence: in-memory sessions and streams
  // that a worker process would never see a client for.
  const ghost = config.role === "worker" || !config.enableGhost
    ? null
    : new GhostHub({ maxClients: config.ghostMaxClients, maxClientsPerIp: config.ghostMaxClientsPerIp });
  const osc = new OscSocketClient(
    config,
    ingestor,
    config.enableOscBackfill ? () => enqueueOscBackfill(queue, db, config) : undefined,
  );
  if (!isServerRole && config.enableOsuApiJobs && config.enableStartupRosterRefresh && osu.hasCredentials()) {
    const startupRosterCountries = new Set(await getIndexedCountryCodes(db, config));
    for (const country of await getRosterRefreshCountryCodes(db, config, {
      warmIntervalMs: config.rosterRefreshIntervalMs,
      idleIntervalMs: IDLE_COUNTRY_ROSTER_REFRESH_INTERVAL_MS,
    })) {
      startupRosterCountries.add(country);
    }
    await bootWrite("enqueue_startup_roster_refreshes", () => enqueueRosterRefreshes(queue, [...startupRosterCountries]));
  }
  const worker = new WorkerRunner(db, queue, events, osu, ingestor);
  const discord = createDiscordRuntime({ db, osu, queue, config });
  const ctx = {
    db,
    // HTTP handlers enqueue follow-up jobs (maps/roster refresh, rankings stat
    // repair, player-skill recompute, replay-video, ...) via ctx.queue. Bind it
    // to the dedicated write connection so NONE of those enqueue writes land on
    // the connection that serves page-load reads — otherwise a stuck enqueue on
    // ctx.db (while a worker holds the WAL writer) blocks every read queued
    // behind it and freezes the site. The worker/schedulers keep using the
    // db-bound `queue` variable directly (they run in the worker process).
    queue: serveWriteQueue ?? queue,
    serveWriteDb: serveWriteDb ?? undefined,
    serveWriteQueue: serveWriteQueue ?? undefined,
    events,
    config,
    abuse,
    countryClients,
    osu,
    scoresFallbackOsu,
    oscStatus: () => osc.status(),
    workerStatus: () => worker.status(),
    pauseWorkers: () => worker.pause(),
    resumeWorkers: () => worker.resume(),
    discord: discord ?? undefined,
    analytics: analytics ?? undefined,
    ghost: ghost ?? undefined,
  };
  const server = createServer(async (req, res) => {
    try {
      if (await handleSse(req, res, ctx)) return;
      if (handleReplayPresence(req, res, ctx)) return;
      if (await handleGhost(req, res, ctx)) return;
      if (await routeHttp(req, res, ctx)) return;
      sendNotFound(res);
    } catch (error) {
      // The message is often a raw libsql/driver string naming tables and
      // columns, so it goes to the log rather than to the caller. Admin
      // requests still get it: the admin UI is where these are read.
      logWarn("http_unhandled_error", {
        method: req.method,
        path: (req.url ?? "").split("?")[0],
        ...errorContext(error),
      });
      res.statusCode = 500;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify({
        error: isAdmin(req, ctx) ? (error instanceof Error ? error.message : String(error)) : "internal_error",
      }));
    }
  });
  // Caddy fronts this server and reuses upstream connections. Node's default
  // 5s idle timeout closes sockets the proxy still considers live, which
  // surfaces as instant ECONNRESET on the next proxied request (seen as
  // sporadic SSR loader failures). Keep ours above the proxy's idle window.
  server.keepAliveTimeout = 75_000;
  server.headersTimeout = 80_000;
  if (config.role !== "worker") {
    warmStatusBodyCache(ctx);
    warmGlobalMapsFarmedBoard(ctx);
    warmSkillLeaderboardBoard(db);
    startPackCommunitySnapshotRefresh(db);
  }
  return { server, db, rateLimitDb, serveWriteDb, serveWriteQueue, queue, events, osu, scoresFallbackOsu, osc, worker, ingestor, config, countryClients, discord, analytics, ghost };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = await createApp();
  const role = app.config.role;
  // "server" serves HTTP only; "worker" runs ingest/jobs only; "all" does both.
  const runWorkers = role !== "server";
  const runServing = role !== "worker";

  if (runWorkers) {
    if (app.config.enableWorkers) {
      app.worker.start();
      // Pure background work (no osu! API): kick off / resume the global map
      // search index build so Search and Collections have data to serve, and
      // the one-shot vibro recompute sweep over stored chart analyses.
      void ensureMapSearchIndexSeeded(app.db, app.queue).catch((error) => console.warn("[map-search] seed failed", error));
      void ensureVibroRecomputeSeeded(app.db, app.queue).catch((error) => console.warn("[vibro-recompute] seed failed", error));
      // Structural chart integrity: patch suspicious legacy analyses before
      // the v9 player-dan sweep rebuilds stored verdicts without abusive
      // same-column head stacks. Pure cached-.osu work, no API budget.
      void ensureDanEligibilityRecomputeSeeded(app.db, app.queue).catch((error) => {
        logWarn("dan_eligibility_seed_failed", errorContext(error));
      });
      void ensureDanFloorPinRecomputeSeeded(app.db, app.queue).catch((error) => console.warn("[dan-floor-pin] seed failed", error));
      void ensureLnSubtypeRecomputeSeeded(app.db, app.queue).catch((error) => console.warn("[ln-subtype] seed failed", error));
      void ensureJackTagRecomputeSeeded(app.db, app.queue).catch((error) => console.warn("[jack-tag] seed failed", error));
      void ensureJackDemandRecomputeSeeded(app.db, app.queue).catch((error) => console.warn("[jack-demand] seed failed", error));
      void ensureMotionFeaturesRecomputeSeeded(app.db, app.queue).catch((error) => console.warn("[motion-features] seed failed", error));
      void ensureChordjackTagRecomputeSeeded(app.db, app.queue).catch((error) => console.warn("[chordjack-tag] seed failed", error));
      void ensureBracketTagRecomputeSeeded(app.db, app.queue).catch((error) => console.warn("[bracket-tag] seed failed", error));
      void ensureBracketContentRecomputeSeeded(app.db, app.queue).catch((error) => console.warn("[bracket-content] seed failed", error));
      void ensureCompanellaRecomputeSeeded(app.db, app.queue).catch((error) => console.warn("[companella-recompute] seed failed", error));
      void ensureLnSourceRecomputeSeeded(app.db, app.queue).catch((error) => console.warn("[ln-source] seed failed", error));
      void ensureLnLeoblackRecomputeSeeded(app.db, app.queue).catch((error) => console.warn("[ln-leoblack] seed failed", error));
      void ensureSunnyRepinRecomputeSeeded(app.db, app.queue).catch((error) => console.warn("[sunny-repin] seed failed", error));
      void ensureSunnyRepinDtRecomputeSeeded(app.db, app.queue).catch((error) => console.warn("[sunny-repin-dt] seed failed", error));
      void ensureLeoblackRepinRecomputeSeeded(app.db, app.queue).catch((error) => console.warn("[leoblack-repin] seed failed", error));
      void ensureLeoblackRepinDtRecomputeSeeded(app.db, app.queue).catch((error) => console.warn("[leoblack-repin-dt] seed failed", error));
      void ensureDtRateAnalysisSeeded(app.db, app.queue).catch((error) => console.warn("[dt-rate-analysis] seed failed", error));
      void ensureLnMsdSweepSeeded(app.db, app.queue).catch((error) => console.warn("[ln-msd-sweep] seed failed", error));
      void ensureLnPrimaryRepinSeeded(app.db, app.queue).catch((error) => console.warn("[ln-primary-repin] seed failed", error));
      void ensureLn7PrimaryRepinSeeded(app.db, app.queue).catch((error) => console.warn("[ln7-primary-repin] seed failed", error));
      void ensureNoteBpmRecomputeSeeded(app.db, app.queue).catch((error) => console.warn("[note-bpm-recompute] seed failed", error));
      void ensureMsdPoisonRecoverySeeded(app.db, app.queue).catch((error) => console.warn("[msd-poison-recovery] seed failed", error));
      void ensureInverseClusterBpmRecoverySeeded(app.db, app.queue).catch((error) => console.warn("[inverse-cluster-bpm] seed failed", error));
      void ensureNkeyMsdSeeded(app.db, app.queue).catch((error) => console.warn("[nkey-msd] seed failed", error));
      void ensureNegativeTimeMsdRecoverySeeded(app.db, app.queue).catch((error) => console.warn("[negative-time-msd] seed failed", error));
      // Unlike the sweeps above this one spends osu! API budget, but only for
      // charts whose cached .osu is filed under a different difficulty; the
      // job caps refetches per chunk and the shared limiter paces the chain.
      if (app.config.enableOsuApiJobs) {
        void ensureOsuFileRepairSeeded(app.db, app.queue).catch((error) => {
          logWarn("osu_file_repair_seed_failed", errorContext(error));
        });
      }
      // Player-side leftovers of the same incident: the chart repair healed
      // the charts, but per-play SSRs stored against them are copies and do
      // not follow. Local DB work only, no osu! API budget.
      void ensurePlayerSkillPoisonRecoverySeeded(app.db, app.queue).catch((error) => console.warn("[player-skill-poison] seed failed", error));
      // Sub-floor exclusion rollout: queue a recompute for every row still
      // holding a floor-rated play so inflated ratings heal at deploy time
      // instead of waiting on a profile view. Local DB work only.
      void ensurePlayerSkillFloorSweepSeeded(app.db, app.queue).catch((error) => console.warn("[player-skill-floor-sweep] seed failed", error));
      // Player-side companion of the skill-cap lift: stored plays with a
      // skillset pinned at the old 40 clamp purge and re-rate lazily. Local
      // DB work only.
      void ensurePlayerSkillMsdCapSweepSeeded(app.db, app.queue).catch((error) => console.warn("[player-skill-msd-cap] seed failed", error));
      void ensurePlayerSkillVibroSweepSeeded(app.db, app.queue).catch((error) => console.warn("[player-skill-vibro] seed failed", error));
      // Course-rule dan bars: the stored verdicts predate them, but the plays
      // behind them do not, so the dan block rewrites in place instead of
      // costing the corpus a full re-rate. Local DB work only.
      // 0.75x verdicts, so an HT clear is credited what the chart is worth at
      // that rate instead of being dropped. Seeded before the dan sweep on
      // purpose: the sweep re-runs itself once this one stamps done.
      void ensureHtRateAnalysisSeeded(app.db, app.queue).catch((error) => console.warn("[ht-rate-analysis] seed failed", error));
      void ensurePlayerSkillDanSweepSeeded(app.db, app.queue).catch((error) => console.warn("[player-skill-dan-sweep] seed failed", error));
      // Player-side companion of the 6K/7K jack re-tag: re-fold stored
      // pattern ratings over the refreshed tags, then force the baseline so
      // the pattern:jack percentile curve exists without waiting a week. Its
      // seeder no-ops until the chart-side sweep stamps done. Local DB only.
      void ensurePlayerSkillPatternSweepSeeded(app.db, app.queue).catch((error) => console.warn("[player-skill-pattern-sweep] seed failed", error));
      // Unlike the sweeps above this one consumes osu! API budget (one best-
      // scores call per user), so it also requires osu! API jobs to be enabled.
      // Guarded by its done key: post-completion boots schedule nothing.
      if (app.config.enableOsuApiJobs) {
        void ensureTopScoresBackfillSeeded(app.db, app.queue).catch((error) => console.warn("[top-scores-backfill] seed failed", error));
        void ensureActivityModsBackfillSeeded(app.db, app.queue).catch((error) => console.warn("[activity-mods-backfill] seed failed", error));
        void ensureActivityComboBackfillSeeded(app.db, app.queue).catch((error) => console.warn("[activity-combo-backfill] seed failed", error));
        // Skill-vector version backfill: almost entirely local CPU over the
        // cached .osu corpus, but the shared compute path can fall through to
        // an osu! download on a cache miss, so it takes the same gate.
        void ensureSkillVectorBackfillSeeded(app.db, app.queue).catch((error) => console.warn("[skill-vector-backfill] seed failed", error));
      }
    }
    if (app.config.enableScheduledRefreshes && app.config.enableOsuApiJobs) {
      startRosterScheduler(app.db, app.queue, app.config);
      startMapsScheduler(app.db, app.queue, app.config);
      startMapCollectionsScheduler(app.db, app.queue, app.config);
      startQualifiedMapsWatchScheduler(app.db, app.queue, app.config);
      startSettledSetsReconcileScheduler(app.db, app.queue, app.config);
      startProfilePoolWarmScheduler(app.db, app.queue);
      startVariantPpDripScheduler(app.db, app.queue);
      startPlayerSkillsDripScheduler(app.db, app.queue);
    }
    startRetentionScheduler(app.db, app.config);
    // /communities invite health: pure Discord lookups, no osu! API budget, so
    // it sits with retention rather than behind the scheduled-refresh gate.
    startCommunityInviteScheduler(app.db, app.config);
    // Skill percentile baseline: pure DB/CPU (approximate SSRs over stored top
    // plays), so it runs whenever workers do, like retention.
    if (app.config.enableWorkers) {
      startSkillBaselineScheduler(app.db, app.queue);
    }
    // Global rankings board: built here (yielding batches) and packed into
    // live_meta so the serving process answers pages from one small read and
    // never scans the roster on its own event loop.
    startGlobalBoardPackScheduler(app.db);
    // Active WAL brake: keeps the -wal file bounded so it can never grow into the
    // read-pin death-spiral. Worker/all role only (never the serving process).
    startWalCheckpointer(app.config);
    startMapSearchStatusReconciler(app.db);
    startQueuePressureScheduler(app.queue);
    if (app.config.enableOscBackfill) {
      enqueueOscBackfill(app.queue, app.db, app.config).catch((error) => console.warn("[osc] backfill enqueue failed", error));
    }
    if (app.config.enableOscSocket) {
      app.osc.start().catch((error) => console.warn("[osc] socket failed", error));
    }
    if (app.config.enableWorkers && app.config.enableOsuScoresFallback && app.osu.hasCredentials()) {
      startScoresFallbackScheduler(app.db, app.config, app.scoresFallbackOsu, app.ingestor, () => app.osc.status());
    }
  }

  // When workers run in a separate process, mirror their live status to the DB
  // so the serving process's admin dashboard can read it.
  if (role === "worker") {
    startRuntimeStatusMirror(
      app.db,
      () => ({
        worker: app.worker.status(),
        osc: app.osc.status(),
        osuRate: app.osu.limiter.state(),
        scoresFallbackRate: app.scoresFallbackOsu.limiter.state(),
        sqliteBusy: getSqliteBusyRetryStats(),
        // The serving process answers /api/admin/status and cannot read this
        // process's RSS any other way.
        memory: readProcessMemory("worker"),
      }),
      5_000,
    );
  }

  // A serving process that does not ingest learns about new live events by
  // tailing live_event_log (written by the worker process).
  if (app.config.enableEventLogTail) {
    app.events.startTail(app.config.eventLogTailIntervalMs);
  }

  // Post Discord live feeds from the serving process only, so a given event is
  // never posted twice, whether it arrives via append-dispatch (all role) or the
  // event-log tail (server role); the headless worker never posts. Delivery is
  // at-most-once: the tail starts at the current head, so events appended while
  // the serving process is down are not back-filled to Discord (by design, so a
  // restart never floods channels with stale plays).
  if (runServing && app.discord) {
    app.events.subscribe(app.discord.feedSink);
  }

  if (runServing) {
    const socketFd = systemdSocketFd();
    if (socketFd != null) {
      // systemd socket activation: pid 1 owns the listening socket, so it
      // stays open (and the kernel keeps queueing connections) across a
      // service restart - a deploy becomes a pause instead of refused
      // connections, including for the frontend's loopback server fns that
      // skip Caddy. Falls back to a plain port bind below whenever the
      // socket unit is absent, so this path can never make boot worse.
      app.server.listen({ fd: socketFd }, () => {
        console.log(`[live-backend] listening on ${app.config.livePublicOrigin} (systemd socket, role ${role})`);
      });
    } else {
      app.server.listen(app.config.port, () => {
        console.log(`[live-backend] listening on ${app.config.livePublicOrigin} (port ${app.config.port}, role ${role})`);
      });
    }
    installServingDrain(app.server);
  } else if (app.config.workerHttpPort != null) {
    // Optional internal-only listener so the worker process can be health-checked.
    app.server.listen(app.config.workerHttpPort, "127.0.0.1", () => {
      console.log(`[live-backend] worker internal http on 127.0.0.1:${app.config.workerHttpPort} (role ${role})`);
    });
  } else {
    // Headless worker: no HTTP listener, and every worker/scheduler/mirror timer
    // is unref()'d (so tests tear down cleanly). Without a ref'd handle the event
    // loop would drain and the process would exit the moment it went idle (e.g.
    // OSC disabled). Hold it open explicitly; SIGTERM still stops it normally.
    setInterval(() => {}, 1 << 30);
    console.log(`[live-backend] worker process started (role ${role}, no http listener)`);
  }
}

/* sd_listen_fds contract: LISTEN_PID names the process the fds were passed to
   and numbering starts at 3 (SD_LISTEN_FDS_START). Anything else - direct
   `node dist/server.js`, tests, the worker role, a box without the socket
   unit - returns null and the server binds its port itself. */
function systemdSocketFd(): number | null {
  if (process.env.LISTEN_PID !== String(process.pid)) return null;
  const count = Number(process.env.LISTEN_FDS ?? "");
  return Number.isInteger(count) && count >= 1 ? 3 : null;
}

// SIGTERM used to kill in-flight responses mid-write on every deploy. Drain
// instead: stop accepting (under socket activation the kernel keeps queueing
// for the next process), let in-flight requests finish, then cut the
// long-lived streams (SSE clients reconnect via Last-Event-ID). The hard exit
// stays well inside the unit's TimeoutStopSec=30 so a drain bug can only ever
// cost seconds, never stretch a deploy.
const DRAIN_STREAM_CUTOFF_MS = 4_000;
const DRAIN_HARD_EXIT_MS = 8_000;

function installServingDrain(server: ReturnType<typeof createServer>): void {
  let draining = false;
  process.on("SIGTERM", () => {
    if (draining) return;
    draining = true;
    console.log("[live-backend] SIGTERM: draining in-flight requests");
    server.close(() => process.exit(0));
    server.closeIdleConnections();
    setTimeout(() => server.closeAllConnections(), DRAIN_STREAM_CUTOFF_MS).unref();
    setTimeout(() => process.exit(0), DRAIN_HARD_EXIT_MS).unref();
  });
}

// True only when every connection this process opens sees the same database on
// disk — the case that both allows a dedicated migration connection and creates
// the write-lock contention it exists to survive.
function usesSharedDbFile(databaseUrl: string): boolean {
  return databaseUrl.startsWith("file:") && databaseUrl.slice("file:".length).length > 0 && !databaseUrl.endsWith(":memory:");
}

// Boot-time bookkeeping writes (not schema). On a deploy these land in exactly
// the contention window that used to kill migrate(), and none of them is worth a
// crash-loop: pressure shedding re-runs every 60s, the pinned-country registry is
// re-ensured on demand, and roster refreshes are re-enqueued by the roster
// scheduler. The skin-slug backfill has no scheduler — it runs only here — but it
// records its one-shot marker *after* it succeeds, so a boot that loses it simply
// re-runs it on the next boot rather than leaving pre-slug skins slugless.
// Crashing the worker over any of these would take score ingest down for the
// whole restart loop, so log loudly and carry on — the server role already does
// exactly this for ensurePinnedCountries.
async function bootWrite(step: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (error) {
    logWarn("boot_write_failed", { step, detail: "non-fatal boot write failed; continuing", ...errorContext(error) });
  }
}

// A final full-table repair for rows written before a new invariant existed.
// The live write paths now maintain both invariants transactionally, so these
// are true one-shot migrations rather than maintenance coupled to restarts.
// The marker lands only after success: SQLITE_BUSY is nonfatal through
// bootWrite, leaves it absent, and the next boot retries.
async function bootRepairOnce(
  db: Awaited<ReturnType<typeof createDb>>,
  step: string,
  metaKey: string,
  run: () => Promise<number>,
): Promise<void> {
  await bootWrite(step, async () => {
    const done = (await exec(db, "select 1 from live_meta where key = ? limit 1", [metaKey])).rows[0];
    if (done) return;
    const repaired = await run();
    await exec(db, "insert or replace into live_meta (key, value_json, updated_at) values (?, ?, ?)", [
      metaKey,
      JSON.stringify({ repaired }),
      new Date().toISOString(),
    ]);
    if (repaired > 0) logInfo("boot_legacy_repair_done", { step, repaired });
  });
}

// A "server"-role process does not migrate; it waits for the worker/all process
// to create the schema. Polls sqlite_master so a fresh deploy where both
// processes restart together does not fail the window before migration.
async function waitForSchema(db: Awaited<ReturnType<typeof createDb>>, timeoutMs = SCHEMA_WAIT_TIMEOUT_MS): Promise<void> {
  const startedAt = Date.now();
  let loggedAt = 0;
  for (;;) {
    let missing: string[] = REQUIRED_SCHEMA_TABLES;
    try {
      const present = new Set(
        (await db.execute("select name from sqlite_master where type = 'table'")).rows.map((row) => String(row.name)),
      );
      missing = REQUIRED_SCHEMA_TABLES.filter((table) => !present.has(table));
      if (missing.length === 0) return;
    } catch {
      // sqlite_master should always be readable; treat a failure as not-ready.
    }
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs > timeoutMs) {
      throw new Error(`schema not ready after ${timeoutMs}ms (is a worker/all-role process running to migrate it?); missing: ${missing.join(", ")}`);
    }
    // Waiting minutes for a migrating worker is now legitimate, so say so
    // instead of sitting silent until the throw.
    if (elapsedMs - loggedAt >= SCHEMA_WAIT_LOG_INTERVAL_MS) {
      loggedAt = elapsedMs;
      logWarn("schema_wait_pending", {
        detail: "waiting for a worker/all-role process to finish migrating",
        elapsed_ms: elapsedMs,
        timeout_ms: timeoutMs,
        missing_tables: missing.length,
        missing: missing.slice(0, 5).join(", "),
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

// The column half of waitForSchema, for the one boot step that needs a column
// the migrating process may not have added yet. Same polling shape and budget;
// a timeout throws into the caller's catch, which logs and leaves the seed's
// one-shot marker unwritten so the next boot tries again.
async function waitForSkinsViewCountColumn(
  db: Awaited<ReturnType<typeof createDb>>,
  timeoutMs = SCHEMA_WAIT_TIMEOUT_MS,
): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    try {
      const columns = (await db.execute("pragma table_info(skins)")).rows.map((row) => String(row.name));
      if (columns.includes("view_count")) return;
    } catch {
      // Treat an unreadable table as not-ready, same as waitForSchema does.
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`skins.view_count not present after ${timeoutMs}ms; view-count seed skipped this boot`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

function getScoresFallbackOsuConfig(config: ReturnType<typeof readConfig>): Pick<ReturnType<typeof readConfig>, "osuClientId" | "osuClientSecret" | "osuApiTargetPerMinute" | "osuApiHardPerMinute"> {
  const intervalMs = Math.max(10_000, config.osuScoresFallbackIntervalMs);
  const targetPerMinute = Math.max(1, Math.ceil(60_000 / intervalMs));
  return {
    osuClientId: config.osuClientId,
    osuClientSecret: config.osuClientSecret,
    osuApiTargetPerMinute: targetPerMinute,
    osuApiHardPerMinute: Math.max(targetPerMinute + 2, targetPerMinute * 2),
  };
}

// Enqueues also trigger shedPressure, but during quiet hours nothing is
// enqueued, so this tick is what lets parked jobs flow back into the queue.
function startQueuePressureScheduler(queue: JobQueue): void {
  const tick = async () => {
    await queue.shedPressure().catch((error) => console.warn("[queue] pressure rebalance failed", error));
    setTimeout(tick, 60_000).unref();
  };
  setTimeout(tick, 60_000).unref();
}

const GLOBAL_BOARD_PACK_INTERVAL_MS = 60_000;

function startGlobalBoardPackScheduler(db: Awaited<ReturnType<typeof createDb>>): void {
  const tick = async () => {
    try {
      await packGlobalBoard(db);
    } catch (error) {
      console.warn("[global-board] pack failed", error);
    }
    setTimeout(tick, GLOBAL_BOARD_PACK_INTERVAL_MS).unref();
  };
  setTimeout(tick, 5_000).unref();
}

function startRosterScheduler(db: Awaited<ReturnType<typeof createDb>>, queue: JobQueue, config: ReturnType<typeof readConfig>): void {
  const tick = async () => {
    const countries = await getRosterRefreshCountryCodes(db, config, {
      warmIntervalMs: config.rosterRefreshIntervalMs,
      idleIntervalMs: IDLE_COUNTRY_ROSTER_REFRESH_INTERVAL_MS,
    });
    await enqueueRosterRefreshes(queue, countries).catch((error) => {
      console.warn("[roster] scheduled refresh failed", error);
    });
    setTimeout(tick, config.rosterRefreshIntervalMs).unref();
  };
  setTimeout(tick, config.rosterRefreshIntervalMs).unref();
}

// Slow trickle that fills the real users.pp_4k / pp_7k columns for roster
// members whose stored profile never carried statistics.variants (older
// enrichments, rankings-only rows). Reuses enrich_user (which fetches
// /users/{id}/mania and, via the Stage 1 write rule, now fills the columns), so
// no new job type. Enqueued at low priority behind organic enrichment: enrich_user
// is never pressure-deferred or shed, and the fast lane claims it in priority
// order, so a small batch drains without crowding out user-facing work. Dedupe
// key user:{id} coalesces with organic enrichment (priority max wins). ~roster
// size / 8 per 15 min to full coverage; Stage 2's calibration covers the interim.
const VARIANT_PP_DRIP_BATCH = 8;
const VARIANT_PP_DRIP_INTERVAL_MS = 15 * 60_000;
const VARIANT_PP_DRIP_PRIORITY = 10;

function startVariantPpDripScheduler(db: Awaited<ReturnType<typeof createDb>>, queue: JobQueue): void {
  const tick = async () => {
    try {
      const rows = (await exec(
        db,
        `select user_id from users
         where is_active = 1 and pp is not null and pp > 0
           and pp_4k is null and pp_7k is null
           and (profile_json is null or profile_json not like '%"variants"%')
         order by pp desc
         limit ?`,
        [VARIANT_PP_DRIP_BATCH],
      )).rows;
      for (const row of rows) {
        const userId = Number(row.user_id);
        if (!Number.isSafeInteger(userId) || userId <= 0) continue;
        await queue.enqueue("enrich_user", `user:${userId}`, { userId }, { priority: VARIANT_PP_DRIP_PRIORITY });
      }
    } catch (error) {
      console.warn("[variant-pp-drip] scheduled enqueue failed", error);
    }
    setTimeout(tick, VARIANT_PP_DRIP_INTERVAL_MS).unref();
  };
  setTimeout(tick, 90_000).unref();
}

// Version-stale player-skills drip: after a PLAYER_SKILLS_VERSION bump every
// stored rating is stale, and outside the drip recomputes only happen for
// players someone views or who set a new top play, so the inactive rest of
// the roster would never converge on its own. The drip
// tops up the MinaCalc lane only while its waiting pool is nearly empty and
// enqueues at bottom priority, so view-triggered computes (priority 50) and
// dan estimates always jump ahead and the drip drains at whatever pace the
// lane has spare. Strongest players first: their profiles get viewed most.
//
// Batch size is a write-path budget, not a CPU one: a compute is ~0.5s median
// (measured over 237 runs, most of them drip work) but rewrites a ~54KB
// plays_json blob, and this DB's repeated failure mode is write-lock
// saturation rather than a busy core. 32 puts the roster inside ~2 days at
// ~385 computes/h; raising it further wants the sqlite_batch_busy /
// sqlite_wedged reopen counters checked against their ~5/h baseline first.
const SKILLS_DRIP_BATCH = 32;
const SKILLS_DRIP_INTERVAL_MS = 5 * 60_000;
const SKILLS_DRIP_PRIORITY = 5;

function startPlayerSkillsDripScheduler(db: Awaited<ReturnType<typeof createDb>>, queue: JobQueue): void {
  const tick = async () => {
    try {
      // Due jobs only: session-debounced recomputes sit queued with a future
      // run_after while their player keeps playing, and counting them would
      // starve the drip whenever anyone is mid-session.
      const waiting = Number((await exec(
        db,
        "select count(*) as cnt from jobs where type = ? and status in ('queued', 'failed') and run_after <= ?",
        [PLAYER_SKILLS_JOB, new Date().toISOString()],
      )).rows[0]?.cnt ?? 0);
      if (waiting < 2) {
        const rows = (await exec(
          db,
          `select cr.user_id from (select distinct user_id from country_rosters) cr
           left join users u on u.user_id = cr.user_id
           where not exists (
             select 1 from player_skill_ratings psr
             where psr.user_id = cr.user_id and psr.analysis_version = ?
           )
           order by coalesce(u.pp, 0) desc
           limit ?`,
          [PLAYER_SKILLS_VERSION, SKILLS_DRIP_BATCH],
        )).rows;
        for (const row of rows) {
          const userId = Number(row.user_id);
          if (!Number.isSafeInteger(userId) || userId <= 0) continue;
          await enqueuePlayerSkills(queue, userId, { priority: SKILLS_DRIP_PRIORITY });
        }
      }
    } catch (error) {
      console.warn("[player-skills-drip] scheduled enqueue failed", error);
    }
    setTimeout(tick, SKILLS_DRIP_INTERVAL_MS).unref();
  };
  setTimeout(tick, 3 * 60_000).unref();
}

// Weekly skill-baseline refresh: the due-check owns the cadence (stale or
// missing curves enqueue a fresh chunked run), so this tick only has to fire
// often enough to notice staleness and restart a chain that died.
function startSkillBaselineScheduler(db: Awaited<ReturnType<typeof createDb>>, queue: JobQueue): void {
  const tick = async () => {
    await enqueueSkillBaselineIfDue(db, queue).catch((error) => {
      console.warn("[skill-baseline] scheduled refresh failed", error);
    });
    setTimeout(tick, 6 * 60 * 60_000).unref();
  };
  setTimeout(tick, 2 * 60_000).unref();
}

// Seeds and watchdogs the pack-pool snapshot warm chain: the job re-enqueues
// itself while cold pool players remain, so this tick only has to (re)start a
// chain that has never run, finished (new roster entrants went cold), or died.
function startProfilePoolWarmScheduler(db: Awaited<ReturnType<typeof createDb>>, queue: JobQueue): void {
  const tick = async () => {
    await enqueueProfilePoolWarmIfIdle(db, queue).catch((error) => {
      console.warn("[profile-pool-warm] scheduled seed failed", error);
    });
    setTimeout(tick, 30 * 60_000).unref();
  };
  setTimeout(tick, 60_000).unref();
}

function startMapsScheduler(db: Awaited<ReturnType<typeof createDb>>, queue: JobQueue, config: ReturnType<typeof readConfig>): void {
  const tick = async () => {
    const countries = await getMapsWarmCountryCodes(db, config);
    await Promise.all(countries.map((country) => enqueueMapsRefreshIfDue(db, queue, country, config.mapsRefreshIntervalMs))).catch((error) => {
      console.warn("[maps] scheduled refresh failed", error);
    });
    // Rebuild the Global aggregate after the per-country snapshots so it merges
    // their freshest data. It depends only on stored snapshots, no osu! calls.
    await enqueueGlobalMapsRefreshIfDue(db, queue, config.mapsRefreshIntervalMs).catch((error) => {
      console.warn("[maps] scheduled global refresh failed", error);
    });
    // Watchdog the global search index (resumes a build that died mid-chain).
    // No osu! API involved; it reads from the search index.
    await ensureMapSearchIndexSeeded(db, queue).catch((error) => {
      console.warn("[map-search] watchdog seed failed", error);
    });
    setTimeout(tick, config.mapsRefreshIntervalMs).unref();
  };
  setTimeout(tick, 10_000).unref();
}

// Heals /maps status labels for maps that ranked after they were indexed. The
// search index materializes status from beatmap metadata (refreshed only by the
// API-backed enrich job), but a tracked player's score on a newly-ranked map
// updates the beatmaps.status column for free; this copies that fresher status
// into the index. Piggybacked on the same tick: the play/pass-count sweep
// (metadata_json refreshes with no index write attached, so the counts froze
// at first indexing otherwise) and the bogus-ln-tag cleanup. Pure DB work, no
// osu! API, so it runs regardless of the osu!-API scheduler gating (like
// retention).
function startMapSearchStatusReconciler(db: Awaited<ReturnType<typeof createDb>>): void {
  const tick = async () => {
    const healed = await reconcileMapSearchIndexStatuses(db).catch((error) => {
      console.warn("[map-search] status reconcile failed", error);
      return 0;
    });
    if (healed > 0) console.log(`[map-search] reconciled ${healed} stale map status label(s)`);
    const pruned = await pruneMapSearchPlaceholderRows(db).catch((error) => {
      console.warn("[map-search] placeholder prune failed", error);
      return 0;
    });
    if (pruned > 0) console.log(`[map-search] pruned ${pruned} placeholder diff row(s)`);
    const counted = await reconcileMapSearchIndexPlayCounts(db).catch((error) => {
      console.warn("[map-search] play count reconcile failed", error);
      return 0;
    });
    if (counted > 0) console.log(`[map-search] refreshed play counts on ${counted} map row(s)`);
    const untagged = await cleanupBogusLnPatternTags(db).catch((error) => {
      console.warn("[map-search] ln tag cleanup failed", error);
      return 0;
    });
    if (untagged > 0) console.log(`[map-search] stripped bogus ln tag from ${untagged} zero-LN map row(s)`);
    setTimeout(tick, 60 * 60_000).unref();
  };
  setTimeout(tick, 30_000).unref();
}

// The collections rotation runs on its own (shorter) cadence than the weekly
// maps tick, so the staleness check polls hourly and enqueues once a rotation
// ages past the configured interval. Pure DB work off the search index.
function startMapCollectionsScheduler(db: Awaited<ReturnType<typeof createDb>>, queue: JobQueue, config: ReturnType<typeof readConfig>): void {
  const tick = async () => {
    await enqueueMapCollectionsRebuildIfDue(db, queue, config.mapCollectionsRefreshIntervalMs).catch((error) => {
      console.warn("[map-collections] scheduled rebuild failed", error);
    });
    setTimeout(tick, 60 * 60_000).unref();
  };
  setTimeout(tick, 20_000).unref();
}

// Pulls osu!'s current qualified mania list hourly to reconcile /maps status:
// promotes pending -> qualified, indexes brand-new sets, and (the gap the
// zero-API heals can't cover) moves ranked/dequalified sets off the qualified
// label. One API call per tick in steady state.
function startQualifiedMapsWatchScheduler(db: Awaited<ReturnType<typeof createDb>>, queue: JobQueue, config: ReturnType<typeof readConfig>): void {
  const tick = async () => {
    await enqueueQualifiedMapsWatchIfDue(db, queue, config.qualifiedMapsWatchIntervalMs).catch((error) => {
      console.warn("[qualified-maps] scheduled watch failed", error);
    });
    setTimeout(tick, config.qualifiedMapsWatchIntervalMs).unref();
  };
  setTimeout(tick, 45_000).unref();
}

// Heals /maps rows the zero-API reconcilers and the qualified watch both miss:
// revived-then-loved sets whose old rows sit at graveyard forever, including
// diffs that no longer exist upstream (re-uploaded under new ids). Candidate
// discovery is pure DB; each hit costs one /beatmapsets read, so it lives
// behind the same osu!-API scheduler gating as the qualified watch.
function startSettledSetsReconcileScheduler(db: Awaited<ReturnType<typeof createDb>>, queue: JobQueue, config: ReturnType<typeof readConfig>): void {
  const tick = async () => {
    await enqueueSettledSetsReconcileIfDue(db, queue, config.settledSetsReconcileIntervalMs).catch((error) => {
      console.warn("[settled-sets] scheduled reconcile failed", error);
    });
    setTimeout(tick, config.settledSetsReconcileIntervalMs).unref();
  };
  setTimeout(tick, 50_000).unref();
}
