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
  primary key (country, user_id, beatmap_id)
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
  started_at text not null
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
create index if not exists idx_top_play_events_country_time on top_play_events(country, detected_at desc);
create index if not exists idx_top_play_events_country_pp on top_play_events(country, pp desc, detected_at desc);
create index if not exists idx_top_play_events_user_time on top_play_events(user_id, detected_at);
create index if not exists idx_top_play_events_user_pp on top_play_events(user_id, pp desc);
create index if not exists idx_top_play_events_score on top_play_events(score_id);
create index if not exists idx_snipe_events_country_time on snipe_events(country, detected_at desc);
create index if not exists idx_country_maps_snapshots_refreshed on country_maps_snapshots(refreshed_at desc);
create index if not exists idx_maps_beatmaps_beatmapset on maps_beatmaps(beatmapset_id);
create index if not exists idx_country_maps_farmed_scores_country_updated on country_maps_farmed_scores(country, updated_at desc);
create index if not exists idx_country_maps_farmed_scores_country_beatmap on country_maps_farmed_scores(country, beatmap_id);
create index if not exists idx_country_maps_farmed_scores_user on country_maps_farmed_scores(user_id, beatmap_id, pp);
create index if not exists idx_country_maps_farmed_scores_beatmap_user on country_maps_farmed_scores(beatmap_id, user_id, pp desc);
create index if not exists idx_country_maps_most_played_country_beatmap on country_maps_most_played(country, beatmap_id);
create index if not exists idx_country_maps_favourite_sets_country_set on country_maps_favourite_sets(country, beatmapset_id);
create index if not exists idx_farm_helper_user_key_stats_weighted on farm_helper_user_key_stats(key_count, weighted_pp);
create index if not exists idx_farm_helper_user_key_stats_user on farm_helper_user_key_stats(user_id);
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
create index if not exists idx_live_event_country_sequence on live_event_log(country, sequence);
create index if not exists idx_api_call_log_provider_time on api_call_log(provider, started_at desc);
create index if not exists idx_api_rate_limit_reservations_provider_time on api_rate_limit_reservations(provider, started_at_ms);

create table if not exists pack_wallets (
  user_id integer primary key,
  payload text not null,
  rev integer not null,
  updated_at integer not null
);

create table if not exists pack_collection_cards (
  owner_user_id integer not null,
  card_user_id integer not null,
  username text not null,
  avatar_url text not null,
  country_code text not null,
  tier text,
  tier_label text,
  skills_json text,
  pp real not null,
  global_rank integer not null,
  copies integer not null,
  recycled_copies integer not null,
  first_pulled_at integer not null,
  last_pulled_at integer not null,
  updated_at integer not null,
  primary key(owner_user_id, card_user_id)
);
create index if not exists idx_pack_collection_owner_rank
  on pack_collection_cards(owner_user_id, copies, global_rank);
create index if not exists idx_pack_collection_owner_tier
  on pack_collection_cards(owner_user_id, tier, copies, pp desc);
create index if not exists idx_pack_collection_owner_username
  on pack_collection_cards(owner_user_id, username);

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
