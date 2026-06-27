import { describe, expect, it } from "vitest";
import {
  ALWAYS_EPHEMERAL_COMMANDS,
  booleanOption,
  DISCORD_COMMANDS,
  focusedOption,
  hasManageGuild,
  invokerId,
  isEphemeralCommand,
  MANAGE_GUILD_COMMANDS,
  numberOption,
  stringOption,
  subcommandName,
  type DiscordInteraction,
} from "../src/discord/commands.js";
import { COMMAND_HANDLERS } from "../src/discord/handlers.js";

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
    const i = interaction([{ name: "username", value: "  kalkai  " }, { name: "min_pp", value: 500 }]);
    expect(stringOption(i, "username")).toBe("kalkai");
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

  it("registers a handler for every command and vice versa", () => {
    const names = new Set(DISCORD_COMMANDS.map((c) => c.name));
    for (const name of names) expect(COMMAND_HANDLERS[name], `handler for /${name}`).toBeTypeOf("function");
    for (const name of Object.keys(COMMAND_HANDLERS)) expect(names.has(name), `command for handler ${name}`).toBe(true);
  });

  it("gates and ephemeral sets reference real commands", () => {
    const names = new Set(DISCORD_COMMANDS.map((c) => c.name));
    for (const name of MANAGE_GUILD_COMMANDS) expect(names.has(name)).toBe(true);
    for (const name of ALWAYS_EPHEMERAL_COMMANDS) expect(names.has(name)).toBe(true);
  });

  it("puts the Manage Server gate on the feed commands", () => {
    for (const name of ["subscribe", "unsubscribe"]) {
      const command = DISCORD_COMMANDS.find((c) => c.name === name);
      expect(command?.default_member_permissions).toBe("32");
    }
  });

  it("never declares both choices and autocomplete on one option", () => {
    const walk = (options: unknown[] | undefined): void => {
      for (const option of options ?? []) {
        const o = option as { type?: number; choices?: unknown; autocomplete?: unknown; options?: unknown[] };
        if (o.choices && o.autocomplete) throw new Error("option has both choices and autocomplete");
        if (o.type === 1 || o.type === 2) walk(o.options);
      }
    };
    for (const command of DISCORD_COMMANDS) walk(command.options as unknown[]);
  });

  it("keeps all copy free of emojis and em dashes", () => {
    const emojiOrDash = /[—–]|\p{Extended_Pictographic}/u;
    const check = (text: string) => expect(emojiOrDash.test(text), text).toBe(false);
    const walk = (options: unknown[] | undefined): void => {
      for (const option of options ?? []) {
        const o = option as { name?: string; description?: string; options?: unknown[]; choices?: Array<{ name: string }> };
        if (o.description) check(o.description);
        for (const choice of o.choices ?? []) check(choice.name);
        walk(o.options);
      }
    };
    for (const command of DISCORD_COMMANDS) {
      check(command.description);
      walk(command.options as unknown[]);
    }
  });
});

describe("subcommands and option helpers", () => {
  const watchUser: DiscordInteraction = {
    id: "1",
    application_id: "app",
    type: 2,
    token: "t",
    data: {
      name: "watch",
      options: [{ name: "user", type: 1, options: [{ name: "username", type: 3, value: "Jakads" }, { name: "min_pp", type: 10, value: 500 }] }],
    },
  };

  it("reads the subcommand name and descends into nested options", () => {
    expect(subcommandName(watchUser)).toBe("user");
    expect(stringOption(watchUser, "username")).toBe("Jakads");
    expect(numberOption(watchUser, "min_pp")).toBe(500);
  });

  it("returns no subcommand for a flat command", () => {
    expect(subcommandName(interaction([{ name: "username", value: "x" }]))).toBeUndefined();
  });

  it("reads booleans and the focused option", () => {
    const hidden = interaction([{ name: "username", value: "x" }]);
    hidden.data!.options!.push({ name: "hidden", type: 5, value: true });
    expect(booleanOption(hidden, "hidden")).toBe(true);
    expect(booleanOption(interaction([{ name: "username", value: "x" }]), "hidden")).toBe(false);

    const focusedInteraction = interaction([{ name: "country", value: "u" }]);
    focusedInteraction.data!.options![0].focused = true;
    expect(focusedOption(focusedInteraction)?.name).toBe("country");
  });
});

describe("ephemeral resolution", () => {
  it("always-ephemeral commands are private regardless of options", () => {
    const link: DiscordInteraction = { id: "1", application_id: "a", type: 2, token: "t", data: { name: "link", options: [] } };
    expect(isEphemeralCommand(link)).toBe(true);
  });

  it("public commands are private only when hidden is set", () => {
    const player = interaction([{ name: "username", value: "x" }]);
    player.data!.name = "player";
    expect(isEphemeralCommand(player)).toBe(false);
    player.data!.options!.push({ name: "hidden", type: 5, value: true });
    expect(isEphemeralCommand(player)).toBe(true);
  });
});
