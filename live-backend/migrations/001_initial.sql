pragma journal_mode = WAL;

create table if not exists live_meta (
  key text primary key,
  value_json text not null,
  updated_at text not null
);

create table if not exists users (
  user_id integer primary key,
  username text not null,
  avatar_url text not null,
  country_code text,
  is_active integer not null default 1,
  pp real,
  global_rank integer,
  country_rank integer,
  profile_json text,
  top_play_min_pp real,
  top_scores_refreshed_at text,
  maps_farmed_min_pp real,
  maps_farmed_scores_refreshed_at text,
  updated_at text not null
);

create table if not exists country_rosters (
  country text not null,
  user_id integer not null,
  rank integer,
  source text not null,
  is_tracked integer not null default 1,
  refreshed_at text not null,
  primary key (country, user_id)
);

create table if not exists country_rank_snapshots (
  id integer primary key autoincrement,
  country text not null,
  user_id integer not null,
  country_rank integer,
  global_rank integer,
  pp real,
  captured_at text not null
);

create index if not exists idx_country_rank_snapshots_lookup
  on country_rank_snapshots(country, user_id, captured_at);

create index if not exists idx_country_rank_snapshots_captured
  on country_rank_snapshots(captured_at);

create index if not exists idx_users_pp
  on users(pp);

create table if not exists country_registry (
  country text primary key,
  status text not null default 'warm',
  feature_tier text not null default 'indexed',
  pinned integer not null default 0,
  keep_warm integer not null default 0,
  first_requested_at text not null,
  last_requested_at text not null,
  last_roster_refresh_at text,
  last_score_at text,
  updated_at text not null
);

create table if not exists beatmapsets (
  beatmapset_id integer primary key,
  title text not null,
  artist text not null,
  creator text,
  status text,
  covers_json text,
  metadata_json text,
  updated_at text not null
);

create table if not exists beatmaps (
  beatmap_id integer primary key,
  beatmapset_id integer not null,
  mode text not null,
  status text,
  cs real,
  difficulty_rating real,
  bpm real,
  max_combo integer,
  version text not null,
  url text,
  metadata_json text,
  updated_at text not null
);

create table if not exists score_events (
  id integer primary key autoincrement,
  score_id integer not null,
  score_identity text not null,
  legacy_score_id integer,
  user_id integer not null,
  country text,
  beatmap_id integer not null,
  ruleset_id integer not null,
  score_json text not null,
  pp real,
  total_score integer,
  accuracy real,
  rank text,
  passed integer not null,
  processed integer not null default 0,
  is_lazer integer not null,
  has_replay integer not null,
  ended_at text not null,
  received_at text not null,
  source text not null,
  unique(country, score_identity)
);

create table if not exists country_beatmap_scores (
  country text not null,
  beatmap_id integer not null,
  lane_key text not null,
  user_id integer not null,
  score_id integer not null,
  total_score integer not null,
  pp real,
  accuracy real,
  rank text,
  mods_json text not null,
  is_lazer integer not null,
  has_replay integer not null,
  ended_at text not null,
  updated_at text not null,
  primary key (country, beatmap_id, lane_key, user_id)
);

create table if not exists country_beatmap_score_pbs (
  country text not null,
  beatmap_id integer not null,
  lane_key text not null,
  user_id integer not null,
  score_identity text not null,
  score_id integer not null,
  total_score integer not null,
  pp real,
  accuracy real,
  rank text,
  mods_json text not null,
  is_lazer integer not null,
  has_replay integer not null,
  ended_at text not null,
  updated_at text not null,
  primary key (country, beatmap_id, lane_key, user_id, score_identity)
);

create table if not exists country_beatmap_score_pb_state (
  country text not null,
  beatmap_id integer not null,
  lane_key text not null,
  user_id integer not null,
  verified_at text not null,
  primary key (country, beatmap_id, lane_key, user_id)
);

create table if not exists user_top_scores (
  user_id integer not null,
  score_id integer not null,
  position integer not null,
  score_json text not null,
  pp real,
  weighted_pp real,
  ended_at text,
  refreshed_at text not null,
  primary key (user_id, score_id)
);

create table if not exists profile_snapshots (
  user_id integer primary key,
  username_key text not null unique,
  user_json text not null,
  best_scores_json text not null,
  best_scores_limit integer not null,
  fetched_at text not null,
  user_fetched_at text not null,
  updated_at text not null,
  refresh_error text
);

create index if not exists idx_profile_snapshots_username_key
  on profile_snapshots(username_key);

create table if not exists profile_section_cache (
  cache_key text primary key,
  user_id integer not null,
  section text not null,
  payload_json text not null,
  fetched_at text not null,
  updated_at text not null
);

create index if not exists idx_profile_section_cache_user_section
  on profile_section_cache(user_id, section);

create table if not exists top_play_events (
  country text not null,
  score_id integer not null,
  user_id integer not null,
  pp real not null,
  weighted_pp real not null,
  pp_gain real not null,
  payload_json text not null,
  detected_at text not null,
  primary key (country, score_id)
);

create table if not exists snipe_events (
  country text not null,
  beatmap_id integer not null,
  lane_key text not null,
  score_id integer not null,
  sniper_id integer not null,
  victim_id integer not null,
  board_rank integer,
  payload_json text not null,
  detected_at text not null,
  primary key (country, beatmap_id, lane_key, score_id)
);

create table if not exists country_maps_snapshots (
  country text primary key,
  payload_json text not null,
  generated_at text not null,
  refreshed_at text not null
);

create table if not exists maps_beatmapsets (
  beatmapset_id integer primary key,
  title text not null,
  artist text not null,
  creator text,
  status text,
  covers_json text,
  global_play_count integer,
  global_favourite_count integer,
  preview_url text,
  bpm real,
  mania_keys_json text,
  patterns_json text,
  updated_at text not null
);

create table if not exists maps_beatmaps (
  beatmap_id integer primary key,
  beatmapset_id integer not null,
  mode text not null,
  status text,
  cs real,
  difficulty_rating real,
  bpm real,
  total_length integer,
  version text not null,
  url text,
  updated_at text not null
);

create table if not exists country_maps_farmed_scores (
  country text not null,
  user_id integer not null,
  beatmap_id integer not null,
  score_id integer not null,
  pp real not null,
  score_json text not null,
  mods_json text,
  score_url text,
  played_at text,
  detected_at text not null,
  updated_at text not null,
  -- Peer accuracy survives score_json compaction via these dedicated columns.
  -- accuracy is the 320-weighted mania pp accuracy (0..1, see
  -- getStoredScoreAccuracy) and note_count is the total judged objects of the
  -- play. Both are null on rows written before these columns existed until a
  -- refresh re-fetches the score.
  accuracy real,
  note_count integer,
  -- Farm-helper lane columns, stored at write time so the peer aggregation
  -- can filter by keymode in SQL and skip per-row mods_json / played_at
  -- re-derivation. -1 / null mean "unknown" and readers fall back.
  key_count integer not null default -1,
  speed_bucket text,
  mods_key text,
  primary key (country, user_id, beatmap_id)
);

-- GLOBAL's farmed board is derived from every non-GLOBAL country row, but is
-- stored at the same (beatmap, player) granularity as its source.  The old
-- country_maps_snapshots GLOBAL blob remains the compatibility/readiness row;
-- live farmed pages read this projection so one changed player never requires
-- re-folding and re-serialising the entire world.
create table if not exists global_maps_farmed_scores (
  beatmap_id integer not null,
  user_id integer not null,
  pp real not null,
  mods_json text,
  speed_mod text,
  score_url text,
  played_at text,
  detected_at text not null,
  source_country text not null,
  source_updated_at text not null,
  -- Mirrors country_maps_farmed_scores.accuracy / note_count. Nullable, since
  -- the legacy snapshot backfill path has no per-score statistics to derive
  -- them from.
  accuracy real,
  note_count integer,
  primary key (beatmap_id, user_id)
);

create table if not exists global_maps_farmed_aggregates (
  beatmap_id integer primary key,
  player_count integer not null,
  pp_sum real not null,
  avg_pp real not null,
  max_pp real not null,
  dominant_mod text,
  revision integer not null,
  updated_at text not null
);

-- One latest change per beatmap is enough for a serving process to patch its
-- packed in-memory board after a worker-process write.  This table is bounded
-- by the number of farmed beatmaps rather than by the number of updates.
create table if not exists global_maps_farmed_changes (
  beatmap_id integer primary key,
  revision integer not null,
  updated_at text not null
);

create table if not exists global_maps_farmed_state (
  singleton integer primary key check (singleton = 1),
  initialized integer not null default 0,
  revision integer not null default 0,
  seed_epoch integer not null default 0,
  updated_at text not null
);

create table if not exists country_maps_most_played (
  country text not null,
  user_id integer not null,
  beatmap_id integer not null,
  play_count integer not null,
  updated_at text not null,
  primary key (country, user_id, beatmap_id)
);

create table if not exists country_maps_favourite_sets (
  country text not null,
  user_id integer not null,
  beatmapset_id integer not null,
  updated_at text not null,
  primary key (country, user_id, beatmapset_id)
);

create table if not exists farm_helper_user_key_stats (
  key_count integer not null,
  user_id integer not null,
  weighted_pp real not null,
  score_count integer not null,
  source_updated_at text not null,
  updated_at text not null,
  primary key (key_count, user_id)
);

-- Per-player farm-helper feedback marks (too hard / too easy on one rec lane)
-- Epoch-ms timestamps, a null resolved_at means the mark is active
create table if not exists farm_helper_feedback (
  user_id integer not null,
  beatmap_id integer not null,
  speed_bucket text not null,
  verdict text not null,
  created_at integer not null,
  updated_at integer not null,
  resolved_at integer,
  resolved_pp real,
  primary key (user_id, beatmap_id, speed_bucket)
);

-- Skillboost ("push") suggestion memory: one row per lane a served gain board
-- suggested as a push target, frozen at first sight (subject_pp/target_pp are
-- the values the first suggestion quoted). achieved_at is stamped once the
-- player's score on the lane reaches the target or covers most of the gap to
-- it; any achieved row unlocks the skillboost reason in the UI's default view.
-- Epoch-ms timestamps. Never pruned by retention.
create table if not exists farm_helper_push_targets (
  user_id integer not null,
  beatmap_id integer not null,
  speed_bucket text not null,
  target_pp real not null,
  subject_pp real not null,
  suggested_at integer not null,
  achieved_at integer,
  achieved_pp real,
  primary key (user_id, beatmap_id, speed_bucket)
);

create table if not exists replay_video_exports (
  id text primary key,
  score_id integer,
  filename text not null,
  status text not null,
  fps integer not null,
  width integer not null,
  height integer not null,
  audio_url text,
  audio_start_seconds real not null default 0,
  source_duration_seconds real not null default 1,
  effective_rate real not null default 1,
  storage_key text,
  url text,
  signed integer not null default 0,
  size_bytes integer,
  mime_type text,
  encoded_with text,
  has_audio integer,
  error text,
  created_at text not null,
  updated_at text not null,
  completed_at text
);

create table if not exists dan_estimates (
  estimator_version integer not null,
  beatmap_id integer not null,
  rate_percent integer not null,
  status text not null,
  label text,
  variant text,
  display_name text,
  raw_dan real,
  family text,
  confidence real,
  star_rating real,
  error text,
  computed_at text not null,
  updated_at text not null,
  primary key (estimator_version, beatmap_id, rate_percent)
);

create table if not exists beatmap_skill_vectors (
  beatmap_id integer not null,
  analysis_version integer not null,
  status text not null,
  stream_score real not null default 0,
  jack_score real not null default 0,
  bracket_score real not null default 0,
  ln_score real not null default 0,
  ln_general_score real not null default 0,
  ln_release_score real not null default 0,
  ln_inverse_score real not null default 0,
  ln_tech_score real not null default 0,
  skills_json text,
  error text,
  computed_at text,
  updated_at text not null,
  primary key (beatmap_id, analysis_version)
);

create table if not exists player_activity_score_refs (
  country text not null,
  score_identity text not null,
  user_id integer not null,
  day text not null,
  beatmap_id integer not null,
  passed integer not null,
  ended_at text not null,
  created_at text not null,
  primary key (country, score_identity)
);

create table if not exists player_activity_days (
  country text not null,
  user_id integer not null,
  day text not null,
  score_count integer not null default 0,
  passed_count integer not null default 0,
  session_count integer not null default 0,
  first_score_at text,
  last_score_at text,
  updated_at text not null,
  primary key (country, user_id, day)
);

create table if not exists player_activity_maps (
  country text not null,
  user_id integer not null,
  day text not null,
  beatmap_id integer not null,
  play_count integer not null default 0,
  best_score_id integer,
  best_pp real,
  best_accuracy real,
  best_rank text,
  best_mods_json text,
  best_statistics_json text,
  first_played_at text,
  last_played_at text,
  updated_at text not null,
  primary key (country, user_id, day, beatmap_id)
);

create table if not exists player_activity_backfill_cursors (
  country text not null,
  user_id integer not null,
  last_event_id integer not null default 0,
  updated_at text not null,
  primary key (country, user_id)
);

create table if not exists jobs (
  id integer primary key autoincrement,
  type text not null,
  dedupe_key text not null unique,
  status text not null,
  priority integer not null default 0,
  run_after text not null,
  attempts integer not null default 0,
  payload_json text not null,
  locked_by text,
  locked_until text,
  last_error text,
  created_at text not null,
  updated_at text not null
);

create table if not exists live_event_log (
  sequence integer primary key autoincrement,
  event_id text not null unique,
  type text not null,
  country text,
  payload_json text not null,
  created_at text not null
);

create table if not exists api_call_log (
  id integer primary key autoincrement,
  provider text not null,
  caller text not null,
  path text not null,
  target_id integer,
  started_at text not null,
  duration_ms integer,
  status integer
);

create table if not exists api_call_targets (
  id integer primary key autoincrement,
  provider text not null,
  caller text not null,
  path text not null,
  unique(provider, caller, path)
);

create table if not exists api_rate_limit_reservations (
  id integer primary key autoincrement,
  provider text not null,
  started_at_ms integer not null,
  caller text not null,
  path text not null,
  lane text not null,
  created_at_ms integer not null
);

create index if not exists idx_score_events_country_time on score_events(country, ended_at desc);
create index if not exists idx_country_registry_status_request on country_registry(status, last_requested_at desc);
create index if not exists idx_score_events_user_time on score_events(user_id, ended_at desc);
create index if not exists idx_score_events_beatmap_time on score_events(beatmap_id, ended_at desc);
create index if not exists idx_score_events_passed_time on score_events(ended_at desc) where passed = 1;
create index if not exists idx_country_beatmap_scores_rank on country_beatmap_scores(country, beatmap_id, lane_key, total_score desc);
create index if not exists idx_country_beatmap_score_pbs_lookup on country_beatmap_score_pbs(country, beatmap_id, lane_key, user_id, ended_at desc, total_score desc);
create index if not exists idx_country_beatmap_score_pb_state_lookup on country_beatmap_score_pb_state(country, beatmap_id, lane_key, user_id);
create index if not exists idx_top_play_events_country_time on top_play_events(country, detected_at desc);
create index if not exists idx_top_play_events_country_pp on top_play_events(country, pp desc, detected_at desc);
create index if not exists idx_top_play_events_time on top_play_events(detected_at desc);
create index if not exists idx_top_play_events_user_time on top_play_events(user_id, detected_at);
create index if not exists idx_top_play_events_user_pp on top_play_events(user_id, pp desc);
create index if not exists idx_top_play_events_score on top_play_events(score_id);
create index if not exists idx_snipe_events_country_time on snipe_events(country, detected_at desc);
create index if not exists idx_country_maps_snapshots_refreshed on country_maps_snapshots(refreshed_at desc);
create index if not exists idx_maps_beatmaps_beatmapset on maps_beatmaps(beatmapset_id);
create index if not exists idx_country_maps_farmed_scores_country_updated on country_maps_farmed_scores(country, updated_at desc);
create index if not exists idx_country_maps_farmed_scores_country_beatmap on country_maps_farmed_scores(country, beatmap_id);
-- The old (user_id, beatmap_id, pp) index was superseded by the farm-helper
-- covering index idx_country_maps_farmed_scores_user_lane, which db.ts creates
-- (it must come after the lane-column ALTERs and the one-time backfill, both
-- of which run after this file).
create index if not exists idx_country_maps_farmed_scores_beatmap_user on country_maps_farmed_scores(beatmap_id, user_id, pp desc);
create index if not exists idx_global_maps_farmed_scores_beatmap_pp on global_maps_farmed_scores(beatmap_id, pp desc, user_id);
create index if not exists idx_global_maps_farmed_aggregates_players on global_maps_farmed_aggregates(player_count desc, avg_pp desc, beatmap_id);
create index if not exists idx_global_maps_farmed_changes_revision on global_maps_farmed_changes(revision, beatmap_id);
create index if not exists idx_country_maps_most_played_country_beatmap on country_maps_most_played(country, beatmap_id);
create index if not exists idx_country_maps_favourite_sets_country_set on country_maps_favourite_sets(country, beatmapset_id);
-- Beatmap(set)-first covering indexes for the per-map player boards: the GLOBAL
-- modal filters on country != 'GLOBAL', so the country-first indexes above
-- cannot serve it. user_id follows the equality column so the per-user
-- group-by/distinct streams in index order.
create index if not exists idx_country_maps_most_played_beatmap_user on country_maps_most_played(beatmap_id, user_id, country, play_count);
create index if not exists idx_country_maps_favourite_sets_beatmapset_user on country_maps_favourite_sets(beatmapset_id, user_id, country);
-- User-first mirror of the index above, for the Random draw: the eligible
-- (player, set) pairs and the per-player favourite totals both stream in
-- index order instead of building a temp b-tree for the DISTINCT / GROUP BY.
-- Measured on prod-size data: a GLOBAL players-weighted draw 190 ms -> 70 ms,
-- an unfiltered favourites-weighted draw 88 ms -> 56 ms.
create index if not exists idx_country_maps_favourite_sets_user_set on country_maps_favourite_sets(user_id, beatmapset_id, country);
create index if not exists idx_farm_helper_user_key_stats_weighted on farm_helper_user_key_stats(key_count, weighted_pp);
create index if not exists idx_farm_helper_user_key_stats_user on farm_helper_user_key_stats(user_id);
create index if not exists idx_farm_helper_feedback_user_resolved on farm_helper_feedback(user_id, resolved_at);
create index if not exists idx_replay_video_exports_status_time on replay_video_exports(status, updated_at desc);
create index if not exists idx_dan_estimates_updated on dan_estimates(updated_at desc);
create index if not exists idx_beatmap_skill_vectors_status_updated on beatmap_skill_vectors(status, updated_at desc);
create index if not exists idx_player_activity_refs_user_day on player_activity_score_refs(country, user_id, day, ended_at);
create index if not exists idx_player_activity_refs_user_time on player_activity_score_refs(user_id, ended_at desc);
create index if not exists idx_player_activity_refs_day on player_activity_score_refs(day);
create index if not exists idx_player_activity_days_user_day on player_activity_days(country, user_id, day);
create index if not exists idx_player_activity_days_user_day_all on player_activity_days(user_id, day);
create index if not exists idx_player_activity_days_user_year on player_activity_days(country, user_id, substr(day, 1, 4));
create index if not exists idx_player_activity_days_day on player_activity_days(day);
create index if not exists idx_player_activity_maps_user_day on player_activity_maps(country, user_id, day, play_count desc);
create index if not exists idx_player_activity_maps_user_beatmap on player_activity_maps(user_id, beatmap_id);
create index if not exists idx_player_activity_maps_beatmap on player_activity_maps(beatmap_id);
create index if not exists idx_player_activity_maps_day on player_activity_maps(day);
create index if not exists idx_jobs_ready on jobs(status, run_after, priority desc);
-- Covers the per-type queue reads (activeDepth, lane defer/reactivate): they all
-- narrow by status AND type, and shedPressure runs one such count per reserved
-- lane on every enqueue -- including enqueues on the serving process's small-cache
-- write connection, where idx_jobs_ready alone left a rowid lookup per candidate.
create index if not exists idx_jobs_status_type on jobs(status, type, run_after);
create index if not exists idx_live_event_country_sequence on live_event_log(country, sequence);
-- Retention prunes this table by created_at, and no index covered that predicate:
-- the hourly pass full-scanned all ~2.2M rows to find the ~2.3k it deletes, and
-- because that scan runs inside a DELETE it held the write lock for the whole
-- thing. Measured at 32.5s on prod (the rows are scattered by constant insert
-- and delete churn, so the scan is random I/O), which is long enough that every
-- concurrent writer burned its full SQLITE_BUSY_RETRY_MS budget and reopened its
-- connection -- the hourly site-wide stall of 2026-08-10. Covering the prune
-- predicate turns it into a range seek over index pages only.
create index if not exists idx_live_event_log_created_at on live_event_log(created_at);
create index if not exists idx_api_call_log_provider_time on api_call_log(provider, started_at desc);
create index if not exists idx_api_rate_limit_reservations_provider_time on api_rate_limit_reservations(provider, started_at_ms);

create table if not exists pack_wallets (
  user_id integer primary key,
  payload text not null,
  rev integer not null,
  updated_at integer not null,
  -- The last username this wallet's pulls were recorded under: the durable
  -- name fallback for collectors with no users row (pull events are pruned).
  owner_username text
);

-- One durable, database-enforced claim per collector for the completion
-- reward. The claim row and the Eternal holding are written in the same
-- transaction, with a random token gating every statement in that batch, so
-- concurrent pack opens cannot both mint the bonus and a crashed transaction
-- cannot consume it without creating the card.
create table if not exists pack_eternal_rewards (
  owner_user_id integer primary key,
  claim_token text not null,
  dealt_at integer not null
);

-- One row per card held, and a card is (player, GOAT-or-not) rather than just
-- player: GOAT is awarded by honorary-roster membership instead of card power,
-- and several roster members are live ranked players, so the same player can be
-- held both as the card the ranked pool dealt and as the GOAT the honorary slot
-- dealt. card_key mirrors the browser wallet's key exactly ("<id>" or
-- "<id>:goat"), so the two sides address the same card the same way.
--
-- The card's identity (name, avatar, country, tier label) is the same for
-- every owner, so it lives once per variant in pack_cards. Its skills snapshot
-- is not: it is frozen per owner at the pull that minted it, and only a better
-- tier replaces it. There are two orders of magnitude fewer distinct snapshots
-- than holdings, though, so the row points at an interned one in
-- pack_card_skills rather than carrying its own copy of the JSON. pp and
-- global_rank stay here because the wallet sync rewrites them in place.
create table if not exists pack_collection_cards (
  owner_user_id integer not null,
  card_user_id integer not null,
  card_key text not null,
  tier text,
  skills_id integer,
  pp real not null,
  global_rank integer not null,
  copies integer not null,
  -- A row at copies 0 with recycled_copies above it is not a tombstone and
  -- must not be reaped: it is the recycling history, and its first_pulled_at
  -- is still the date the collector found that card. Every read that shows a
  -- card filters on copies > 0, so it falls off the shelf on its own. About
  -- one holding in six is in this state.
  recycled_copies integer not null,
  first_pulled_at integer not null,
  last_pulled_at integer not null,
  updated_at integer not null,
  -- This collector's own name for their copy, overriding the variant's shared
  -- label in pack_cards. Only /admin/collections writes it; a pulled card
  -- leaves it null and reads the catalog's.
  tier_label text,
  -- The image this holding floats in its card background in place of the
  -- tier's triangle flecks or starfield, as bounded JSON (src/lib/card-motif.ts).
  -- Written from /admin/collections only, never by a wallet sync.
  motif text,
  -- When /admin/collections handed this holding out, for the holdings it did.
  -- Null on an ordinary pulled card; a positive value is when it was given.
  -- Zero is an internal "known pulled" sentinel for a pulled card an admin
  -- edit moved onto a variant key while the final legacy scan might still be
  -- running. Readers expose both null and zero as pulled. This is set once:
  -- editing a pull cannot claim it was given, or clear a real grant's stamp.
  granted_at integer,
  -- Client-authored first-login imports are valid collection holdings, but
  -- they are not proof for the one-time completion reward. Existing rows and
  -- every server/admin mint default eligible; the import writer explicitly
  -- stores zero and a later server deal upgrades it to one.
  completion_eligible integer not null default 1,
  primary key(owner_user_id, card_key)
);
-- Both this table and pack_card_serials are pure key-value: the primary key is
-- a separate autoindex (58 MB and 65 MB), so every lookup seeks the index and
-- then fetches the row. WITHOUT ROWID would delete both autoindexes, and it is
-- deliberately not used. It cannot be added in place - it needs a rebuild of
-- 5.4M rows under the write lock - and it would give part of the saving back,
-- because the secondary indexes below would then carry the full text card_key
-- instead of a four-byte rowid. src/retention.ts also pages the admin table
-- browser with "order by rowid desc", which these two tables would no longer
-- have. 123 MB out of a 10.9 GB database is not worth any of that.
create index if not exists idx_pack_collection_owner_tier
  on pack_collection_cards(owner_user_id, tier, copies, pp desc);
-- The card side of the same table: ownership counts, "your card got pulled"
-- stats and the collector list all read by card, oldest holding first.
create index if not exists idx_pack_collection_card_pulled
  on pack_collection_cards(card_user_id, first_pulled_at);

-- One row per card variant (card_key plus the tier it was minted at, where
-- tier '' is an unrated card), shared by every owner. First write wins, so a
-- later forged wallet sync cannot repaint a card every other collector already
-- holds. These columns are the fallback for players with no users row
-- (honoraries, deleted accounts). Reads overlay the live users row first,
-- exactly as they always have.
create table if not exists pack_cards (
  card_key text not null,
  tier text not null default '',
  card_user_id integer not null,
  username text not null default '',
  avatar_url text not null default '',
  country_code text not null default '',
  tier_label text,
  updated_at integer not null,
  primary key(card_key, tier)
);

-- Interned skills snapshots. The same handful of numbers is minted for every
-- collector who pulls a player around the same time, so the JSON is stored
-- once and referenced by id. Rows are never rewritten (a snapshot is
-- immutable), which is what makes sharing them safe.
--
-- Nothing reaps the rows no holding points at any more, and nothing should.
-- The unique index on skills_json is what makes this a content-addressed
-- store: a later pull that freezes the identical snapshot is handed the row
-- that is already there, so an unreferenced row is a snapshot waiting to be
-- adopted again, not garbage. A sweeper would also be racing that
-- insert-or-ignore. They are a four-figure row count and a couple of hundred
-- KB, against millions of holdings.
create table if not exists pack_card_skills (
  id integer primary key autoincrement,
  skills_json text not null unique
);

-- The showcase shelf: up to five cards a collector pins to their public
-- profile. Keys reference pack_collection_cards by (owner, card_key). A pin
-- whose card was fully recycled simply stops rendering (the read joins on
-- copies > 0), so no cleanup pass is needed.
create table if not exists pack_showcase_cards (
  owner_user_id integer not null,
  position integer not null,
  card_key text not null,
  updated_at integer not null,
  primary key(owner_user_id, position)
);

-- Append-only pack pull log: the community layer (live feed, per-card
-- ownership counts, "your card got pulled" stats). Self-reported by clients,
-- so it never feeds the economy. Usernames are frozen at pull time and
-- overlaid with the live users row at read time.
create table if not exists pack_pull_events (
  id integer primary key autoincrement,
  owner_user_id integer not null,
  owner_username text not null,
  card_user_id integer not null,
  card_username text not null,
  card_country_code text not null default '',
  tier text,
  pack_type text not null,
  is_new integer not null default 0,
  is_first_global integer not null default 0,
  notable integer not null default 0,
  pulled_at integer not null
);
create index if not exists idx_pack_pull_events_card_time
  on pack_pull_events(card_user_id, pulled_at desc);
create index if not exists idx_pack_pull_events_owner_time
  on pack_pull_events(owner_user_id, pulled_at desc);
create index if not exists idx_pack_pull_events_time
  on pack_pull_events(pulled_at);
create index if not exists idx_pack_pull_events_notable_time
  on pack_pull_events(pulled_at desc) where notable = 1;

-- Mint registry: the serial number a collector holds a card at. #1 is whoever
-- pulled that card first, anywhere. One row per (card, owner), written once on
-- the owner's first pull and never renumbered, so a serial survives duplicates,
-- recycling and pull-event retention alike. card_key mirrors the wallet key, so
-- a player's GOAT is serialled separately from their ordinary card.
create table if not exists pack_card_serials (
  card_key text not null,
  card_user_id integer not null,
  owner_user_id integer not null,
  serial integer not null,
  minted_at integer not null,
  -- A server draw owns the serial immediately, before the browser reports the
  -- client-computed tier to the community pull log. The pending bit lets that
  -- later report still determine first-global correctly. Imports, grants and
  -- pre-column rows have no report coming and stay at the settled default.
  pull_report_pending integer not null default 0,
  primary key(card_key, owner_user_id)
);
create index if not exists idx_pack_card_serials_card
  on pack_card_serials(card_key, serial);
-- There is deliberately no (owner_user_id, minted_at desc) index. It existed
-- for a "this collector's mints, newest first" read that was never written:
-- minted_at is only ever inserted, never selected or ordered by, and every
-- serial read goes through the primary key, the card index above or the
-- first-finds one below. It was 50.8 MB of b-tree that also cost an insert on
-- every mint; db.ts drops it on the databases that still carry it.
-- Whoever found a card first, anywhere: one row per card key ever minted, which
-- is thousands where the table itself is hundreds of thousands. Without this the
-- first-finds board reads every serial ever handed out to count a few of them.
create index if not exists idx_pack_card_serials_first_finds
  on pack_card_serials(owner_user_id) where serial = 1;

-- The maintained roll-up behind /packs/collections. Grouping
-- pack_collection_cards by collector and by card is two full scans of millions
-- of rows (~12 seconds against production, and libsql runs them synchronously),
-- and the answer changes only where somebody pulled or recycled something. So
-- the counts are kept here instead - one row per collector, one per carded
-- player - and the triggers in features/pack-community-rollups.ts record which
-- of them a write touched, for the reconciler to recompute owner-scoped.
--
-- Nothing durable lives here: every column is derivable from
-- pack_collection_cards, and a stale or missing table only costs the page a
-- full scan.
create table if not exists pack_community_owner_stats (
  owner_user_id integer primary key,
  -- Holdings, distinct players, and copies: a collector's GOAT and their
  -- ordinary card are two holdings of one player, so both are kept.
  cards integer not null,
  players integer not null,
  copies integer not null,
  duplicates integer not null,
  recycled integer not null,
  goats integer not null,
  joined_at integer not null,
  last_pulled_at integer not null,
  updated_at integer not null
);

-- Copies in circulation per tier, per collector. Kept apart from the row above
-- rather than as JSON on it so the site-wide tier table is one group-by over
-- ten thousand rows instead of a scan of millions.
create table if not exists pack_community_owner_tier_stats (
  owner_user_id integer not null,
  tier text not null,
  copies integer not null,
  primary key(owner_user_id, tier)
);

create table if not exists pack_community_card_stats (
  card_user_id integer primary key,
  owners integer not null,
  copies integer not null,
  updated_at integer not null
);

-- What a write touched and the reconciler has not caught up with yet. Bounded
-- by the number of collectors and carded players however busy the table gets,
-- since a second pull by the same collector re-marks the same row.
create table if not exists pack_community_dirty_owners (
  owner_user_id integer primary key
);
create table if not exists pack_community_dirty_cards (
  card_user_id integer primary key
);

-- What the pack arcade (the higher-or-lower streak game) has paid an account
-- today, which is the only thing standing between a scripted client and free
-- shards: a casual run is scored off data the client can read for itself, so
-- the daily allowance is the protection rather than the scoring.
-- One row per account per day per game, and the cap reads their sum.
create table if not exists pack_game_rewards (
  user_id integer not null,
  day text not null,
  source text not null,
  shards integer not null default 0,
  updated_at integer not null,
  primary key (user_id, day, source)
);
create index if not exists idx_pack_game_rewards_day
  on pack_game_rewards(day);

-- Ranked higher-or-lower runs. The casual game is scored in the browser and
-- always will be (the numbers it asks about are public), which is fine while
-- the only stake is a capped shard allowance. A public leaderboard is a
-- different stake, so a ranked run is dealt here instead: the server picks both
-- players and the question, keeps the face-down card's answer in round_json
-- where the client never sees it, and only counts a guess that arrived before
-- deadline_at. The streak column is therefore something the account did rather
-- than a number it reported, which is the whole reason the board can exist.
create table if not exists pack_streak_runs (
  id text primary key,
  user_id integer not null,
  username text not null,
  pool text not null,
  streak integer not null default 0,
  status text not null,
  ended_by text,
  -- The round on the table, answer included. Never sent to the client whole.
  round_json text,
  -- Everyone this run has already dealt, so it never asks the same card twice.
  seen_json text,
  dealt_at integer,
  deadline_at integer,
  -- How long each guess took, kept so an inhuman run can be told apart from a
  -- fast one after the fact. Nothing reads it during play.
  guess_ms_json text,
  created_at integer not null,
  updated_at integer not null
);
create index if not exists idx_pack_streak_runs_user
  on pack_streak_runs(user_id, pool, streak desc);
-- The hourly sweep for runs somebody walked away from. Partial on purpose:
-- only a handful of rows are live at once, so the index stays tiny and the
-- write it costs on every guess is nothing. The retention delete next to it
-- is left to scan, since indexing it would tax the same writes for a bulk
-- delete that runs once an hour and nobody waits on.
create index if not exists idx_pack_streak_runs_live
  on pack_streak_runs(deadline_at) where status = 'live';

-- What the board actually reads: one row per account per pool, holding their
-- best run and when they reached it. The runs above used to be the board's
-- source of truth (a max() over the whole history), which made the run log
-- durable by construction - it could never be pruned without deleting somebody
-- else's record - and turned every board read into a grouped scan of it. With
-- the best kept here the board is an indexed ten-row read, and a run row goes
-- back to being what it is: a transient record of one game, prunable on the
-- ordinary schedule.
create table if not exists pack_streak_bests (
  user_id integer not null,
  pool text not null,
  username text not null,
  streak integer not null,
  -- When this best was set. Ties on the board go to whoever got there first.
  achieved_at integer not null,
  run_id text,
  updated_at integer not null,
  primary key (user_id, pool)
);
create index if not exists idx_pack_streak_bests_board
  on pack_streak_bests(pool, streak desc, achieved_at asc);

-- Discord bot: live-feed channel subscriptions. A row means "post events of
-- feed_type for `country` into Discord channel_id". The unique key keeps a
-- channel from being subscribed twice to the same feed/country pair.
create table if not exists discord_subscriptions (
  id integer primary key autoincrement,
  guild_id text,
  channel_id text not null,
  country text not null,
  feed_type text not null,
  min_pp real not null default 0,
  created_by text,
  created_at text not null,
  unique(channel_id, feed_type, country)
);
create index if not exists idx_discord_subscriptions_feed
  on discord_subscriptions(feed_type, country);

-- Discord bot: links a Discord user to an osu! account so commands like /recent
-- resolve a default player without typing a username. Trust-based (no OAuth);
-- one osu! identity per Discord user, overwritten on re-link.
create table if not exists discord_user_links (
  discord_user_id text primary key,
  osu_user_id integer not null,
  osu_username text not null,
  country_code text,
  created_at text not null,
  updated_at text not null
);
create index if not exists idx_discord_user_links_osu
  on discord_user_links(osu_user_id);

-- DEPRECATED, no longer read or written: the personal DM-alert feature (/watch)
-- was removed in favour of channel-only feeds. The table is left in place so
-- existing databases keep their schema unchanged (boot only runs create-if-not-
-- exists, never drop), but no code touches it.
create table if not exists discord_user_trackers (
  id integer primary key autoincrement,
  subscriber_id text not null,
  kind text not null,
  target_osu_user_id integer not null default 0,
  target_username text,
  min_pp real not null default 0,
  created_at text not null,
  unique(subscriber_id, kind, target_osu_user_id)
);
create index if not exists idx_discord_user_trackers_target
  on discord_user_trackers(kind, target_osu_user_id);

-- Discord bot: dedupes new-farm-map alerts so each map fires at most once
-- across all destinations. Intentionally durable (not pruned): one row per newly
-- ranked mania difficulty is negligible, and deleting a row inside the alert
-- window would re-fire the alert.
create table if not exists discord_alerted_maps (
  beatmap_id integer primary key,
  alerted_at text not null
);

-- Discord bot: remembers the last beatmap shown in a channel (from /recent, /map,
-- /dan, ...) so /pb, /c and /compare can look up a player's score on that map
-- without re-typing it. One row per channel, overwritten as new maps are shown.
-- Pruned by retention since stale rows are harmless to drop.
create table if not exists discord_channel_map_context (
  channel_id text primary key,
  beatmap_id integer not null,
  beatmapset_id integer,
  title text,
  version text,
  updated_at text not null
);

-- Discord bot: maps a custom application-emoji name (e.g. grade_x, mod_dt) to the
-- emoji id Discord assigned when it was uploaded, so embeds can render osu! grade
-- pills and mod icons inline as a reference. Populated by the admin register-emojis
-- action. Embeds fall back to plain text for any name not present here, so an empty
-- table just means the bot reads exactly as it did before emojis existed.
create table if not exists discord_emojis (
  name text primary key,
  emoji_id text not null,
  animated integer not null default 0,
  updated_at text not null
);

-- Durable cache of compressed .osu beatmap files, keyed by beatmap (difficulty)
-- id. The dan estimator and activity analyzer both parse these, so keeping the
-- chart text itself lets cache-version/algorithm bumps reprocess known maps
-- without re-downloading every chart. The content column is a legacy raw-text
-- fallback retained for older DBs. New writes use content_blob.
create table if not exists beatmap_osu_files (
  beatmap_id integer primary key,
  beatmapset_id integer,
  compression text not null default 'gzip',
  content_blob blob,
  content text not null default '',
  raw_bytes integer not null default 0,
  compressed_bytes integer not null default 0,
  source text not null default 'unknown',
  error text,
  fetched_at text not null,
  last_used_at text not null
);

-- Unified chart analysis per beatmap at 1.0x (classifier verdict + pattern
-- clusters + Etterna MSD skillsets), keyed by analysis_version so a version
-- bump reprocesses every chart from the cached .osu text
create table if not exists beatmap_chart_analysis (
  beatmap_id integer not null,
  analysis_version integer not null,
  status text not null,
  key_count integer,
  primary_label text,
  primary_family text,
  raw_dan real,
  msd_overall real,
  classification_json text,
  msd_json text,
  error text,
  computed_at text,
  updated_at text not null,
  primary key (beatmap_id, analysis_version)
);

create index if not exists idx_beatmap_chart_analysis_status_updated on beatmap_chart_analysis(status, updated_at desc);

-- Per-player Etterna-style skillset ratings aggregated from the player's osu!
-- top plays (per-play MinaCalc SSRs at the played rate), keyed by
-- analysis_version so a version bump lazily recomputes every player
create table if not exists player_skill_ratings (
  user_id integer not null,
  analysis_version integer not null,
  status text not null,
  modes_json text,
  plays_json text,
  -- Personal accuracy curve model (features/player-acc-model.ts): compact
  -- fitted parameters, written by the skills job in the same pass as the
  -- ratings. Existing DBs get the column via migratePlayerSkillAccModel.
  acc_model_json text,
  source_fetched_at text,
  error text,
  computed_at text,
  updated_at text not null,
  primary key (user_id, analysis_version)
);

-- Approximate per-user skill ratings (no wasm) backing the population
-- percentiles (the quantile curves themselves live in live_meta)
create table if not exists player_skill_baseline (
  user_id integer not null,
  key_count integer not null,
  baseline_version integer not null,
  analyzed_plays integer not null,
  ratings_json text not null,
  latest_played_at text,
  updated_at text not null,
  primary key (user_id, key_count, baseline_version)
);
