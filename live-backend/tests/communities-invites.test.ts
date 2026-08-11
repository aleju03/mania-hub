import { afterEach, describe, expect, it, vi } from "vitest";
import { parseInviteCode, resolveDiscordInvite } from "../src/discord/invites.js";

/* The invite resolver is what decides a listing's identity, so these cover both
   halves of that: what counts as an invite at all, and which resolved invites
   are refused. */

afterEach(() => {
  vi.unstubAllGlobals();
});

const GUILD = {
  id: "1520157141548273914",
  name: "Mania Hub",
  icon: "abc123",
  banner: "def456",
};

function stubInvite(payload: unknown, status = 200): void {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    clone: () => ({ json: async () => payload }),
    headers: new Headers(),
  })));
}

describe("parseInviteCode", () => {
  it("takes a bare code", () => {
    expect(parseInviteCode("maniahub")).toBe("maniahub");
    expect(parseInviteCode("  aBc-123  ")).toBe("aBc-123");
  });

  it("takes every shape of invite URL people paste", () => {
    expect(parseInviteCode("https://discord.gg/maniahub")).toBe("maniahub");
    expect(parseInviteCode("discord.gg/maniahub")).toBe("maniahub");
    expect(parseInviteCode("https://discord.com/invite/maniahub")).toBe("maniahub");
    expect(parseInviteCode("https://discordapp.com/invite/maniahub")).toBe("maniahub");
    expect(parseInviteCode("https://canary.discord.com/invite/maniahub")).toBe("maniahub");
  });

  it("refuses things that are not invites", () => {
    expect(parseInviteCode("")).toBeNull();
    expect(parseInviteCode("https://example.com/invite/maniahub")).toBeNull();
    // A channel link is on the right host but is not an invite.
    expect(parseInviteCode("https://discord.com/channels/123/456")).toBeNull();
    expect(parseInviteCode("https://discord.gg/a/b")).toBeNull();
    expect(parseInviteCode("not a code!")).toBeNull();
  });
});

describe("resolveDiscordInvite", () => {
  it("returns what Discord says about the server", async () => {
    stubInvite({
      code: "maniahub",
      expires_at: null,
      approximate_member_count: 1234,
      approximate_presence_count: 56,
      guild: GUILD,
    });
    const result = await resolveDiscordInvite("https://discord.gg/maniahub");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.invite).toMatchObject({
      code: "maniahub",
      guildId: GUILD.id,
      name: "Mania Hub",
      iconHash: "abc123",
      bannerHash: "def456",
      memberCount: 1234,
      onlineCount: 56,
    });
  });

  it("reports when an invite expires rather than refusing it", async () => {
    // It used to be refused outright. It is a worse listing, not an invalid
    // one: the refresh sweep already takes a listing off the directory when its
    // link stops resolving, so the form warns and lets it through.
    stubInvite({
      code: "maniahub",
      expires_at: "2030-01-01T00:00:00Z",
      guild: GUILD,
    });
    const result = await resolveDiscordInvite("maniahub");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.invite.expiresAt).toBe("2030-01-01T00:00:00Z");
  });

  it("reports a permanent invite as having no expiry", async () => {
    stubInvite({ code: "maniahub", expires_at: null, guild: GUILD });
    const result = await resolveDiscordInvite("maniahub");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.invite.expiresAt).toBeNull();
  });

  it("refuses an invite for a different server than the one proved", async () => {
    stubInvite({ code: "other", expires_at: null, guild: GUILD });
    const result = await resolveDiscordInvite("other", "999999999999999999");
    expect(result).toEqual({ ok: false, error: "guild_mismatch" });
  });

  it("reports an unknown invite rather than throwing", async () => {
    stubInvite({ message: "Unknown Invite" }, 404);
    const result = await resolveDiscordInvite("gone");
    expect(result).toEqual({ ok: false, error: "unknown_invite" });
  });

  it("refuses an invite with no guild behind it", async () => {
    stubInvite({ code: "groupdm", expires_at: null });
    const result = await resolveDiscordInvite("groupdm");
    expect(result).toEqual({ ok: false, error: "unknown_invite" });
  });

  it("separates our side failing from the invite being bad", async () => {
    // A 500 is no evidence about the invite, so it must not read as a dead one:
    // the refresh sweep counts these separately and never hides a listing on it.
    stubInvite({}, 500);
    const result = await resolveDiscordInvite("maniahub");
    expect(result).toEqual({ ok: false, error: "lookup_failed" });
  });

  it("does not call Discord at all for input that is not an invite", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await resolveDiscordInvite("https://example.com/nope");
    expect(result).toEqual({ ok: false, error: "invalid_url" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
