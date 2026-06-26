import { describe, expect, it } from "vitest";
import {
  DISCORD_COMMANDS,
  hasManageGuild,
  invokerId,
  MANAGE_GUILD_COMMANDS,
  numberOption,
  stringOption,
  type DiscordInteraction,
} from "../src/discord/commands.js";

function interaction(options: Array<{ name: string; value: string | number }>, extra: Partial<DiscordInteraction> = {}): DiscordInteraction {
  return {
    id: "1",
    application_id: "app",
    type: 2,
    token: "tok",
    data: { name: "player", options: options.map((o) => ({ name: o.name, type: typeof o.value === "number" ? 10 : 3, value: o.value })) },
    ...extra,
  };
}

describe("command option parsing", () => {
  it("reads string and number options, trimming blanks", () => {
    const i = interaction([{ name: "username", value: "  cookiezi  " }, { name: "min_pp", value: 500 }]);
    expect(stringOption(i, "username")).toBe("cookiezi");
    expect(numberOption(i, "min_pp")).toBe(500);
    expect(stringOption(i, "missing")).toBeUndefined();
    expect(numberOption(i, "missing")).toBeUndefined();
  });

  it("treats a whitespace-only string option as absent", () => {
    expect(stringOption(interaction([{ name: "username", value: "   " }]), "username")).toBeUndefined();
  });
});

describe("permission gating", () => {
  const MANAGE_GUILD = String(1n << 5n);
  const ADMIN = String(1n << 3n);

  it("recognizes Manage Server and Administrator", () => {
    expect(hasManageGuild(interaction([], { member: { permissions: MANAGE_GUILD } }))).toBe(true);
    expect(hasManageGuild(interaction([], { member: { permissions: ADMIN } }))).toBe(true);
  });

  it("denies members without the bit and missing members", () => {
    expect(hasManageGuild(interaction([], { member: { permissions: "0" } }))).toBe(false);
    expect(hasManageGuild(interaction([]))).toBe(false);
  });

  it("subscribe/unsubscribe are the gated commands", () => {
    expect(MANAGE_GUILD_COMMANDS.has("subscribe")).toBe(true);
    expect(MANAGE_GUILD_COMMANDS.has("unsubscribe")).toBe(true);
    expect(MANAGE_GUILD_COMMANDS.has("player")).toBe(false);
  });
});

describe("invokerId", () => {
  it("prefers the guild member user id then the dm user id", () => {
    expect(invokerId(interaction([], { member: { user: { id: "111" } } }))).toBe("111");
    expect(invokerId(interaction([], { user: { id: "222" } }))).toBe("222");
  });
});

describe("command definitions", () => {
  it("are unique, lowercase and within Discord limits", () => {
    const names = DISCORD_COMMANDS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    for (const command of DISCORD_COMMANDS) {
      expect(command.name).toMatch(/^[a-z]{1,32}$/);
      expect(command.description.length).toBeGreaterThan(0);
      expect(command.description.length).toBeLessThanOrEqual(100);
      expect((command.options ?? []).length).toBeLessThanOrEqual(25);
    }
  });
});
