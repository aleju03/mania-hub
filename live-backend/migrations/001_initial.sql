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

create table if not exists country_registry (
  country text primary key,
  status text not null default 'warm',
  pinned integer not null default 0,
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
  score_id integer primary key,
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
  source text not null
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

create table if not exists replay_video_exports (
  id text primary key,
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
  started_at text not null
);

create index if not exists idx_score_events_country_time on score_events(country, ended_at desc);
create index if not exists idx_country_registry_status_request on country_registry(status, last_requested_at desc);
create index if not exists idx_score_events_user_time on score_events(user_id, ended_at desc);
create index if not exists idx_score_events_beatmap_time on score_events(beatmap_id, ended_at desc);
create index if not exists idx_country_beatmap_scores_rank on country_beatmap_scores(country, beatmap_id, lane_key, total_score desc);
create index if not exists idx_top_play_events_country_time on top_play_events(country, detected_at desc);
create index if not exists idx_top_play_events_country_pp on top_play_events(country, pp desc, detected_at desc);
create index if not exists idx_snipe_events_country_time on snipe_events(country, detected_at desc);
create index if not exists idx_country_maps_snapshots_refreshed on country_maps_snapshots(refreshed_at desc);
create index if not exists idx_replay_video_exports_status_time on replay_video_exports(status, updated_at desc);
create index if not exists idx_jobs_ready on jobs(status, run_after, priority desc);
create index if not exists idx_live_event_country_sequence on live_event_log(country, sequence);
create index if not exists idx_api_call_log_provider_time on api_call_log(provider, started_at desc);
