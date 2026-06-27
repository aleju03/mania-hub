import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, migrate, type Db } from "../src/db.js";
import type { Config } from "../src/config.js";
import { handleAutocomplete } from "../src/discord/autocomplete.js";
import { setUserLink } from "../src/discord/identity.js";
import type { DiscordInteraction } from "../src/discord/commands.js";

// getCountryRegistry only reads trackedCountries and countryWarmTtlMs.
const config = { trackedCountries: ["CR", "US"], countryWarmTtlMs: 86_400_000 } as unknown as Config;

let dir = "";
let db: Db;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mania-discord-ac-"));
  db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function commandInteraction(name: string, options: NonNullable<DiscordInteraction["data"]>["options"], invoker = "u1"): DiscordInteraction {
  return { id: "1", application_id: "app", type: 4, token: "t", member: { user: { id: invoker } }, data: { name, options } };
}

describe("country autocomplete", () => {
  it("always offers Global plus tracked countries and filters by typed text", async () => {
    const all = await handleAutocomplete({ db, config }, commandInteraction("rankings", [
      { name: "country", type: 3, value: "", focused: true },
    ]));
    const values = all.map((c) => c.value);
    expect(values).toContain("GLOBAL");
    expect(values).toContain("CR");
    expect(values).toContain("US");

    const filtered = await handleAutocomplete({ db, config }, commandInteraction("rankings", [
      { name: "country", type: 3, value: "u", focused: true },
    ]));
    expect(filtered.map((c) => c.value)).toContain("US");
    expect(filtered.map((c) => c.value)).not.toContain("CR");
  });
});

describe("username autocomplete", () => {
  it("suggests the caller's linked account and the typed value", async () => {
    await setUserLink(db, { discordUserId: "u1", osuUserId: 124493, osuUsername: "Kalkai", countryCode: "KR" });
    const choices = await handleAutocomplete({ db, config }, commandInteraction("recent", [
      { name: "username", type: 3, value: "", focused: true },
    ]));
    expect(choices.some((c) => c.value === "Kalkai")).toBe(true);

    const typed = await handleAutocomplete({ db, config }, commandInteraction("recent", [
      { name: "username", type: 3, value: "rrtyui", focused: true },
    ]));
    expect(typed.some((c) => c.value === "rrtyui")).toBe(true);
  });

  it("returns nothing special when there is no link and no text", async () => {
    const choices = await handleAutocomplete({ db, config }, commandInteraction("recent", [
      { name: "username", type: 3, value: "", focused: true },
    ], "nolink"));
    expect(choices).toEqual([]);
  });

  it("suggests the linked account for the /vs player options too", async () => {
    await setUserLink(db, { discordUserId: "u1", osuUserId: 124493, osuUsername: "Kalkai", countryCode: "KR" });
    const choices = await handleAutocomplete({ db, config }, commandInteraction("vs", [
      { name: "player1", type: 3, value: "", focused: true },
    ]));
    expect(choices.some((c) => c.value === "Kalkai")).toBe(true);
  });
});
