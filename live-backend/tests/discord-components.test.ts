import { describe, expect, it } from "vitest";
import {
  componentToCommandInteraction,
  decodeComponentId,
  encodeComponentId,
  FLAG_IS_COMPONENTS_V2,
  paginationRow,
  refreshRow,
  toComponentsV2Body,
  withNavRow,
} from "../src/discord/components.js";
import type { DiscordInteraction } from "../src/discord/commands.js";
import type { DiscordMessageBody } from "../src/discord/rest.js";

describe("component id codec", () => {
  it("round-trips a command, action, page and params", () => {
    const id = encodeComponentId("rankings", "p", 3, { country: "US", sort: "7d" });
    const decoded = decodeComponentId(id);
    expect(decoded).toEqual({ cmd: "rankings", action: "p", page: 3, params: { country: "US", sort: "7d" } });
  });

  it("stays within Discord's 100-char custom_id limit for realistic input", () => {
    const id = encodeComponentId("recent", "p", 4, { username: "a-very-long-osu-name" });
    expect(id.length).toBeLessThanOrEqual(100);
  });

  it("rejects ids without the prefix or for unknown commands", () => {
    expect(decodeComponentId(undefined)).toBeNull();
    expect(decodeComponentId("other|rankings|p|1|")).toBeNull();
    expect(decodeComponentId("mh|notacommand|p|1|")).toBeNull();
  });

  it("clamps a bad page to 1 and defaults action to page", () => {
    const decoded = decodeComponentId("mh|top|x|0|country=CR");
    expect(decoded?.page).toBe(1);
    expect(decoded?.action).toBe("p");
    expect(decoded?.params).toEqual({ country: "CR" });
  });
});

describe("pagination row", () => {
  it("disables Prev on page 1 and Next when there is no next page", () => {
    const row = paginationRow("maps", 1, false, { country: "CR", tab: "farmed" });
    const [prev, next, refresh] = row.components ?? [];
    expect(prev.disabled).toBe(true);
    expect(next.disabled).toBe(true);
    expect(refresh.disabled).toBe(false);
  });

  it("gives every button a unique custom_id even on page 1", () => {
    const row = paginationRow("rankings", 1, true, { country: "GLOBAL" });
    const ids = (row.components ?? []).map((c) => c.custom_id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("Next targets the following page", () => {
    const row = paginationRow("top", 2, true, { country: "CR" });
    const next = decodeComponentId(row.components?.[1].custom_id);
    expect(next?.page).toBe(3);
    const prev = decodeComponentId(row.components?.[0].custom_id);
    expect(prev?.page).toBe(1);
  });
});

describe("refresh row", () => {
  it("builds a single refresh button", () => {
    const row = refreshRow("player", { username: "kalkai" });
    expect(row.components).toHaveLength(1);
    const decoded = decodeComponentId(row.components?.[0].custom_id);
    expect(decoded).toEqual({ cmd: "player", action: "r", page: 1, params: { username: "kalkai" } });
  });
});

describe("withNavRow", () => {
  it("puts the nav row above existing link buttons and caps at five rows", () => {
    const body: DiscordMessageBody = { embeds: [{}], components: [{ type: 1, components: [] }] };
    const nav = paginationRow("tracker", 1, true, { country: "CR" });
    const merged = withNavRow(body, nav);
    expect(merged.components?.[0]).toBe(nav);
    expect(merged.components).toHaveLength(2);
  });
});

describe("componentToCommandInteraction", () => {
  it("rebuilds an application-command interaction with options and a page", () => {
    const click: DiscordInteraction = {
      id: "1",
      application_id: "app",
      type: 3,
      token: "tok",
      member: { user: { id: "u1" } },
      data: { custom_id: "mh|rankings|p|2|country=US&sort=7d" },
    };
    const decoded = decodeComponentId(click.data?.custom_id);
    expect(decoded).not.toBeNull();
    const synthetic = componentToCommandInteraction(click, decoded!);
    expect(synthetic.type).toBe(2);
    expect(synthetic.data?.name).toBe("rankings");
    expect(synthetic.token).toBe("tok");
    expect(synthetic.member?.user?.id).toBe("u1");
    const byName = Object.fromEntries((synthetic.data?.options ?? []).map((o) => [o.name, o.value]));
    expect(byName.country).toBe("US");
    expect(byName.sort).toBe("7d");
    expect(byName.page).toBe(2);
  });
});

describe("components v2 body conversion", () => {
  function textContent(component: NonNullable<DiscordMessageBody["components"]>[number]): string {
    let result = typeof component.content === "string" ? component.content : "";
    for (const child of component.components ?? []) result += textContent(child);
    return result;
  }

  it("converts content and embeds into v2 components with the required flag", () => {
    const nav = paginationRow("rankings", 1, true, { country: "GLOBAL" });
    const body = toComponentsV2Body({
      content: "A small notice",
      embeds: [{
        title: "Global mania rankings",
        url: "https://mania-tracker.com/rankings",
        description: "`#1` **Kalkai** • 13,204pp",
        color: 0xff66ab,
        thumbnail: { url: "https://img/avatar.png" },
        image: { url: "https://img/cover.jpg" },
        footer: { text: "maniabot" },
      }],
      components: [nav],
    });

    expect((body.flags ?? 0) & FLAG_IS_COMPONENTS_V2).toBe(FLAG_IS_COMPONENTS_V2);
    expect(body.content).toBeUndefined();
    expect(body.embeds).toBeUndefined();
    expect(JSON.stringify(body.components)).toContain("Global mania rankings");
    expect(JSON.stringify(body.components)).toContain("https://img/cover.jpg");
    expect(body.components?.some((component) => component.type === 1)).toBe(true);
  });

  it("clears legacy content and embeds for edit payloads", () => {
    const body = toComponentsV2Body({ content: "Edited", embeds: [{ title: "Old embed" }] }, { clearLegacy: true });
    expect(body.content).toBeNull();
    expect(body.embeds).toBeNull();
    expect((body.flags ?? 0) & FLAG_IS_COMPONENTS_V2).toBe(FLAG_IS_COMPONENTS_V2);
  });

  it("preserves existing v2 bodies", () => {
    const original: DiscordMessageBody = {
      flags: FLAG_IS_COMPONENTS_V2,
      components: [{ type: 10, content: "already v2" }],
    };
    expect(toComponentsV2Body(original)).toBe(original);
  });

  it("keeps text displays inside Discord's v2 text budget", () => {
    const body = toComponentsV2Body({ content: "x".repeat(5000) });
    const total = (body.components ?? []).map(textContent).join("").length;
    expect(total).toBeLessThanOrEqual(3900);
    expect(JSON.stringify(body.components)).toContain("...");
  });
});
