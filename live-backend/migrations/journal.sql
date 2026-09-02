-- The journal database: the hot append-only tables that used to share the
-- main file's write lock. Every process opens it (server, worker, maintenance
-- scripts) because the osu! budget and the SSE event log are shared between
-- them; the schema is idempotent and applied by every boot (journal.ts).

create table if not exists journal_meta (
  key text primary key,
  value_json text not null,
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
create index if not exists idx_live_event_country_sequence on live_event_log(country, sequence);
create index if not exists idx_live_event_log_created_at on live_event_log(created_at);

create table if not exists api_call_targets (
  id integer primary key autoincrement,
  provider text not null,
  caller text not null,
  path text not null,
  unique(provider, caller, path)
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
create index if not exists idx_api_call_log_provider_time on api_call_log(provider, started_at desc);
create index if not exists idx_api_call_log_target_time on api_call_log(target_id, started_at desc);

create table if not exists api_rate_limit_reservations (
  id integer primary key autoincrement,
  provider text not null,
  started_at_ms integer not null,
  caller text not null,
  path text not null,
  lane text not null,
  created_at_ms integer not null
);
create index if not exists idx_api_rate_limit_reservations_provider_time on api_rate_limit_reservations(provider, started_at_ms);
