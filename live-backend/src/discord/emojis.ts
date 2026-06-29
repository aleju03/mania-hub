// Custom application emojis: the osu! grade pills and mod icons the bot renders
// inline in its embeds, the way owo-bot and friends do. Discord application
// emojis are uploaded once (admin "register emojis" action), usable anywhere the
// app posts, and referenced in text as `<:name:id>`.
//
// The whole layer degrades gracefully: until the emojis are registered (or if a
// name is missing), every render helper falls back to the plain-text glyph the
// bot used before, so a fresh deploy reads exactly as it did and lights up the
// moment the assets are uploaded. The PNG assets live under
// public/images/discord/emojis/ (built by scripts/build-discord-emojis.mjs) and
// are fetched over HTTP from the site origin at registration time.

import type { Db } from "../db.js";
import { exec } from "../db.js";
import { nowIso } from "../shared/score.js";
import { logInfo, logWarn } from "../logger.js";
import type { DiscordRest } from "./rest.js";
import { mapWithConcurrency } from "./util.js";

// Grade pill names (emoji name = `grade_<x>`). Mirrors the displayed-rank set in
// shared/score.ts (XH/X/SH/S/A/B/C/D/F).
const GRADE_KEYS = ["xh", "x", "sh", "s", "a", "b", "c", "d", "f"];

// Mod icon names (emoji name = `mod_<acr>`). Curated to the mods that show up on
// osu!mania scores plus the key-conversion mods. Keep in sync with the MODS map
// in scripts/build-discord-emojis.mjs (every name here must have a built PNG).
const MOD_KEYS = [
  "dt", "nc", "hd", "fi", "hr", "fl", "sd", "pf", "ac", "mu",
  "ez", "nf", "ht", "dc", "nr", "ho",
  "mr", "rd", "in", "cs", "as", "wu", "wd", "sy", "da",
  "sv2", "cl",
  "1k", "2k", "3k", "4k", "5k", "6k", "7k", "8k", "9k", "10k",
];

/** Every emoji name the bot wants registered, grades first then mods. */
export function emojiCatalog(): string[] {
  return [...GRADE_KEYS.map((g) => `grade_${g}`), ...MOD_KEYS.map((m) => `mod_${m}`)];
}

// In-memory name -> "<:name:id>" reference. Empty until loadEmojiRegistry / a
// registration populates it, in which case all helpers below use the text fallback.
const registry = new Map<string, string>();

interface EmojiRow {
  name: string;
  emojiId: string;
  animated: boolean;
}

export function setEmojiRegistry(entries: EmojiRow[]): void {
  registry.clear();
  for (const entry of entries) {
    if (!entry.name || !entry.emojiId) continue;
    registry.set(entry.name, `<${entry.animated ? "a" : ""}:${entry.name}:${entry.emojiId}>`);
  }
}

/** The `<:name:id>` reference for an emoji name, or null when not registered. */
export function emojiRef(name: string): string | null {
  return registry.get(name) ?? null;
}

export function hasEmojis(): boolean {
  return registry.size > 0;
}

// ---------------------------------------------------------------------------
// Render helpers (used by embeds.ts). Each one returns a Discord emoji when the
// asset is registered and a plain-text glyph otherwise.
// ---------------------------------------------------------------------------

/** Grade pill (XH/X/SH/S/A/B/C/D/F), falling back to the `X`-in-backticks glyph. */
export function gradeEmoji(grade: string | null | undefined): string {
  const label = (grade ?? "?").toUpperCase();
  return emojiRef(`grade_${label.toLowerCase()}`) ?? `\`${label}\``;
}

/** Plain-text mod label, e.g. `+HDDT` or `NM`. The historical bot format. */
export function modsLabel(acronyms: string[]): string {
  return acronyms.length ? `+${acronyms.join("")}` : "NM";
}

/**
 * Mod icons for a score's mods. All-or-nothing: when every mod has a registered
 * emoji they render as a tight run of icons (the owo look); if any is missing it
 * falls back to the full `+HDDT` text so the line never mixes icons and letters.
 */
export function modsEmoji(acronyms: string[]): string {
  if (!acronyms.length) return "NM";
  const refs = acronyms.map((acr) => emojiRef(`mod_${acr.toLowerCase()}`));
  if (refs.every((ref): ref is string => Boolean(ref))) return refs.join("");
  return modsLabel(acronyms);
}

// ---------------------------------------------------------------------------
// Persistence + registration
// ---------------------------------------------------------------------------

/** Loads the persisted name->id map into memory (called at boot, best-effort). */
export async function loadEmojiRegistry(db: Db): Promise<void> {
  try {
    const result = await exec(db, "select name, emoji_id, animated from discord_emojis");
    setEmojiRegistry(result.rows.map((row) => ({
      name: String(row.name),
      emojiId: String(row.emoji_id),
      animated: Number(row.animated) === 1,
    })));
    logInfo("discord_emojis_loaded", { count: registry.size });
  } catch (error) {
    logWarn("discord_emojis_load_failed", { error: error instanceof Error ? error.message : String(error) });
  }
}

export interface EmojiRegistrationResult {
  total: number;
  created: number;
  reused: number;
  failed: number;
}

/**
 * Uploads every catalog emoji that the application doesn't already have, persists
 * the resulting ids, and refreshes the in-memory registry. Idempotent: re-running
 * reuses existing emojis. Pass `force` to delete and re-upload (after changing the
 * source art). Needs the bot token; the PNGs are fetched from `siteOrigin`.
 */
export async function registerEmojis(
  rest: DiscordRest,
  db: Db,
  siteOrigin: string,
  options: { force?: boolean } = {},
): Promise<EmojiRegistrationResult> {
  if (!rest.hasBotToken()) {
    throw new Error("DISCORD_BOT_TOKEN is required to register emojis.");
  }
  const existing = await rest.listApplicationEmojis();
  const byName = new Map(existing.map((emoji) => [emoji.name, emoji]));
  const wanted = emojiCatalog();
  const persisted: EmojiRow[] = [];
  let created = 0;
  let reused = 0;
  let failed = 0;

  // Bounded concurrency keeps the one-time upload well under Discord's rate
  // budget. The increments are safe: the runtime is single-threaded, so the
  // awaits interleave but never run truly in parallel.
  await mapWithConcurrency(wanted, 4, async (name) => {
    try {
      let ref = byName.get(name);
      if (ref && options.force) {
        await rest.deleteApplicationEmoji(ref.id).catch(() => {});
        ref = undefined;
      }
      if (!ref) {
        const image = await fetchEmojiDataUri(siteOrigin, name);
        ref = await rest.createApplicationEmoji(name, image);
        created += 1;
      } else {
        reused += 1;
      }
      persisted.push({ name, emojiId: String(ref.id), animated: Boolean(ref.animated) });
    } catch (error) {
      failed += 1;
      logWarn("discord_emoji_register_failed", { name, error: error instanceof Error ? error.message : String(error) });
    }
  });

  const now = nowIso();
  for (const row of persisted) {
    await exec(
      db,
      `insert into discord_emojis (name, emoji_id, animated, updated_at)
       values (?, ?, ?, ?)
       on conflict(name) do update set emoji_id = excluded.emoji_id, animated = excluded.animated, updated_at = excluded.updated_at`,
      [row.name, row.emojiId, row.animated ? 1 : 0, now],
    ).catch((error) => logWarn("discord_emoji_persist_failed", { name: row.name, error: error instanceof Error ? error.message : String(error) }));
  }
  // Drop any catalog row we could not confirm this run (e.g. a force delete that
  // succeeded but whose re-upload then failed). This keeps the table from holding
  // an id that points at an emoji which no longer exists, which would render as a
  // broken reference on the next boot; a missing name just falls back to text.
  const persistedNames = new Set(persisted.map((row) => row.name));
  const stale = wanted.filter((name) => !persistedNames.has(name));
  if (stale.length) {
    await exec(
      db,
      `delete from discord_emojis where name in (${stale.map(() => "?").join(",")})`,
      stale,
    ).catch((error) => logWarn("discord_emoji_prune_failed", { error: error instanceof Error ? error.message : String(error) }));
  }
  setEmojiRegistry(persisted);
  logInfo("discord_emojis_registered", { total: wanted.length, created, reused, failed });
  return { total: wanted.length, created, reused, failed };
}

async function fetchEmojiDataUri(siteOrigin: string, name: string): Promise<string> {
  const url = `${siteOrigin.replace(/\/$/, "")}/images/discord/emojis/${name}.png`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`fetch ${url} -> ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  // Discord caps emoji uploads at 256KB; the built PNGs are a few KB each.
  if (buffer.length > 256 * 1024) throw new Error(`${name}.png is ${buffer.length} bytes (over Discord's 256KB cap)`);
  return `data:image/png;base64,${buffer.toString("base64")}`;
}
