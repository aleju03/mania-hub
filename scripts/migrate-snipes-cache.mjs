#!/usr/bin/env node
// Migrates historical snipes cache rows into the current v5/v3 keys while
// repairing victim fields from the merged country-board snapshot.
//
// Usage:
//   node --env-file-if-exists=.env scripts/migrate-snipes-cache.mjs
//   node --env-file-if-exists=.env scripts/migrate-snipes-cache.mjs CR
//   node --env-file-if-exists=.env scripts/migrate-snipes-cache.mjs --dry-run

import { createClient } from "@libsql/client";
import { gzipSync, gunzipSync } from "node:zlib";

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;

if (!url || !authToken) {
  console.error("Missing TURSO_DATABASE_URL / TURSO_AUTH_TOKEN.");
  process.exit(1);
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const countriesArg = args
  .filter((arg) => arg !== "--dry-run")
  .map((arg) => arg.trim().toUpperCase())
  .filter(Boolean);

const db = createClient({ url, authToken });

const CACHE_ENVELOPE_MARKER = "__mania_hub_cache_v1";
const CACHE_COMPRESS_THRESHOLD_BYTES = 4096;
const SNIPES_CACHE_TTL = 6 * 60 * 60 * 1000;
const SNIPES_LOG_TTL = 30 * 24 * 60 * 60 * 1000;
const SNIPES_SNAPSHOT_TTL = 90 * 24 * 60 * 60 * 1000;
const SNIPES_LOG_CAP = 500;

const SNAPSHOT_SOURCES = ["country-board-snapshot:v3", "country-board-snapshot:v4"];
const LOG_SOURCES = ["country-snipes-log:v1", "country-snipes-log:v2"];
const RESPONSE_SOURCES = ["country-snipes-response:v4"];

const TARGET_SNAPSHOT_PREFIX = "country-board-snapshot:v5";
const TARGET_LOG_PREFIX = "country-snipes-log:v3";
const TARGET_RESPONSE_PREFIX = "country-snipes-response:v5";

function cachePrefix(key) {
  const separatorIndex = key.indexOf(":");
  return separatorIndex >= 0 ? key.slice(0, separatorIndex) : key;
}

function decodeCacheValue(raw) {
  let json;
  if (raw.startsWith("Z:")) {
    json = gunzipSync(Buffer.from(raw.slice(2), "base64")).toString("utf8");
  } else if (raw.startsWith("P:")) {
    json = raw.slice(2);
  } else {
    json = raw;
  }

  const parsed = JSON.parse(json);
  if (
    parsed &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    parsed[CACHE_ENVELOPE_MARKER] &&
    "value" in parsed
  ) {
    return parsed.value;
  }
  return parsed;
}

function encodeCacheValue(data) {
  const json = JSON.stringify({
    [CACHE_ENVELOPE_MARKER]: true,
    value: data,
  });
  if (json.length < CACHE_COMPRESS_THRESHOLD_BYTES) {
    return `P:${json}`;
  }
  return `Z:${gzipSync(Buffer.from(json, "utf8")).toString("base64")}`;
}

function countryFromKey(key) {
  const parts = String(key).split(":");
  return parts[parts.length - 1]?.toUpperCase() ?? "";
}

async function loadRows() {
  const prefixes = [...SNAPSHOT_SOURCES, ...LOG_SOURCES, ...RESPONSE_SOURCES];
  const conditions = prefixes.map(() => "cache_key LIKE ?").join(" OR ");
  const result = await db.execute({
    sql: `
      SELECT cache_key, cache_value, expires_at, updated_at
      FROM cache_entries
      WHERE ${conditions}
      ORDER BY updated_at ASC
    `,
    args: prefixes.map((prefix) => `${prefix}:%`),
  });

  return result.rows
    .map((row) => ({
      key: String(row.cache_key),
      value: decodeCacheValue(String(row.cache_value)),
      expiresAt: Number(row.expires_at),
      updatedAt: Number(row.updated_at),
      country: countryFromKey(row.cache_key),
    }))
    .filter((row) => countriesArg.length === 0 || countriesArg.includes(row.country));
}

function scoreTimeMs(score) {
  const ms = new Date(score?.endedAt ?? 0).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function betterScore(a, b) {
  if (!a) return b;
  if (!b) return a;
  const aTotal = Number(a.totalScore) || 0;
  const bTotal = Number(b.totalScore) || 0;
  if (bTotal !== aTotal) return bTotal > aTotal ? b : a;
  return scoreTimeMs(b) > scoreTimeMs(a) ? b : a;
}

function mergeSnapshotInto(target, source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return { maps: 0, lanes: 0, scores: 0 };
  }

  const stats = { maps: 0, lanes: 0, scores: 0 };
  for (const [beatmapId, lanes] of Object.entries(source)) {
    if (!lanes || typeof lanes !== "object" || Array.isArray(lanes)) continue;
    stats.maps += 1;
    if (!target[beatmapId]) target[beatmapId] = {};

    for (const [lane, entry] of Object.entries(lanes)) {
      if (!entry || typeof entry !== "object" || !Array.isArray(entry.scores)) continue;
      stats.lanes += 1;
      stats.scores += entry.scores.length;

      const existing = target[beatmapId][lane];
      const byUser = new Map();
      for (const score of existing?.scores ?? []) {
        byUser.set(score.userId, betterScore(byUser.get(score.userId), score));
      }
      for (const score of entry.scores) {
        byUser.set(score.userId, betterScore(byUser.get(score.userId), score));
      }

      const scores = [...byUser.values()].sort(
        (a, b) => (Number(b.totalScore) || 0) - (Number(a.totalScore) || 0),
      );
      target[beatmapId][lane] = {
        beatmap: entry.beatmap ?? existing?.beatmap,
        beatmapset: entry.beatmapset ?? existing?.beatmapset,
        scores,
        lastTouchedAt: Math.max(
          Number(existing?.lastTouchedAt) || 0,
          Number(entry.lastTouchedAt) || 0,
        ),
      };
    }
  }
  return stats;
}

function getScoreSpeedBucket(mods) {
  for (const mod of mods ?? []) {
    if (mod === "DT" || mod === "NC") return "dt";
    if (mod === "HT" || mod === "DC") return "ht";
  }
  return "normal";
}

function laneKeyForEvent(event) {
  return `${getScoreSpeedBucket(event.mods)}:${event.isLazer ? "lazer" : "stable"}`;
}

function repairEventFromSnapshot(event, snapshot) {
  const lane = snapshot?.[event.beatmap_id]?.[laneKeyForEvent(event)];
  const scores = Array.isArray(lane?.scores) ? lane.scores : [];
  if (scores.length === 0) return { event, fixed: false, dropped: false };

  const sniperIndex = scores.findIndex((score) => score.userId === event.sniper?.id);
  const victim = scores.find((score) => score.userId === event.victim?.id);
  if (!victim) return { event, fixed: false, dropped: false };

  const victimTotalScore = Number(victim.totalScore) || 0;
  const eventTotalScore = Number(event.totalScore) || 0;
  if (victimTotalScore > 0 && eventTotalScore > 0 && eventTotalScore <= victimTotalScore) {
    return { event, fixed: false, dropped: true };
  }

  const fixedEvent = {
    ...event,
    victimTimestamp: victim.endedAt ?? event.victimTimestamp,
    victimTotalScore: victim.totalScore ?? event.victimTotalScore,
    victimPp: victim.pp ?? event.victimPp ?? null,
    ...(sniperIndex >= 0 ? { boardRank: sniperIndex + 1 } : {}),
  };

  const fixed =
    fixedEvent.victimTimestamp !== event.victimTimestamp ||
    fixedEvent.victimTotalScore !== event.victimTotalScore ||
    fixedEvent.victimPp !== event.victimPp ||
    fixedEvent.boardRank !== event.boardRank;

  return { event: fixedEvent, fixed, dropped: false };
}

function eventTimeMs(event) {
  const ms = new Date(event?.timestamp ?? 0).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function mergeAndRepairEvents(events, snapshot) {
  const byEvent = new Map();
  let repaired = 0;
  let dropped = 0;

  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    const { event: fixedEvent, fixed, dropped: shouldDrop } = repairEventFromSnapshot(event, snapshot);
    if (shouldDrop) {
      dropped += 1;
      continue;
    }
    if (fixed) repaired += 1;
    byEvent.set(`${fixedEvent.beatmap_id}:${fixedEvent.score_id}`, fixedEvent);
  }

  return {
    events: [...byEvent.values()]
      .sort((a, b) => eventTimeMs(b) - eventTimeMs(a))
      .slice(0, SNIPES_LOG_CAP),
    repaired,
    dropped,
  };
}

async function upsertCache(key, value, ttlMs) {
  const now = Date.now();
  const encoded = encodeCacheValue(value);
  await db.execute({
    sql: `
      INSERT INTO cache_entries (cache_key, cache_prefix, cache_value, expires_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET
        cache_prefix = excluded.cache_prefix,
        cache_value = excluded.cache_value,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at
    `,
    args: [key, cachePrefix(key), encoded, now + ttlMs, now],
  });
}

function countSnapshot(snapshot) {
  const counts = { maps: 0, lanes: 0, scores: 0 };
  for (const lanes of Object.values(snapshot)) {
    counts.maps += 1;
    for (const entry of Object.values(lanes ?? {})) {
      counts.lanes += 1;
      counts.scores += Array.isArray(entry?.scores) ? entry.scores.length : 0;
    }
  }
  return counts;
}

const rows = await loadRows();
const countries = [...new Set(rows.map((row) => row.country))].sort();

if (countries.length === 0) {
  console.log("No matching snipes cache rows found.");
  process.exit(0);
}

let migrated = 0;
for (const country of countries) {
  const countryRows = rows.filter((row) => row.country === country);
  const snapshot = {};
  const rawEvents = [];
  let scannedAt = 0;

  for (const row of countryRows) {
    if (row.key.startsWith("country-board-snapshot:")) {
      mergeSnapshotInto(snapshot, row.value);
    } else if (row.key.startsWith("country-snipes-log:") && Array.isArray(row.value)) {
      rawEvents.push(...row.value);
    } else if (row.key.startsWith("country-snipes-response:") && row.value?.events) {
      rawEvents.push(...row.value.events);
      scannedAt = Math.max(scannedAt, Number(row.value.scannedAt) || 0);
    }
    scannedAt = Math.max(scannedAt, row.updatedAt || 0);
  }

  const { events, repaired, dropped } = mergeAndRepairEvents(rawEvents, snapshot);
  const counts = countSnapshot(snapshot);
  const response = { events, scannedAt: scannedAt || Date.now() };

  const snapshotKey = `${TARGET_SNAPSHOT_PREFIX}:${country}`;
  const logKey = `${TARGET_LOG_PREFIX}:${country}`;
  const responseKey = `${TARGET_RESPONSE_PREFIX}:${country}`;

  if (!dryRun) {
    await upsertCache(snapshotKey, snapshot, SNIPES_SNAPSHOT_TTL);
    await upsertCache(logKey, events, SNIPES_LOG_TTL);
    await upsertCache(responseKey, response, SNIPES_CACHE_TTL);
  }

  migrated += 1;
  console.log(
    `${dryRun ? "Would migrate" : "Migrated"} ${country}: ` +
      `${counts.maps} maps, ${counts.lanes} lanes, ${counts.scores} scores, ` +
      `${events.length} events (${repaired} repaired, ${dropped} dropped)`,
  );
}

console.log(`\n${dryRun ? "Dry run complete" : "Done"}. ${migrated} countr${migrated === 1 ? "y" : "ies"} processed.`);
