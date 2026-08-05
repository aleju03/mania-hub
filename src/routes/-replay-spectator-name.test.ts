import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/* The setting is one switch, but the name it publishes crosses three files and
   two servers, so the wiring is pinned here: opt-in only, signed only, and
   drawn under the counter the room already sees. */

describe("show my name under spectators", () => {
  it("is a settings switch that writes the preference", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "../components/settings/SettingsPanel.tsx"), "utf8");

    expect(source).toContain("Show my name under spectators when watching a replay");
    expect(source).toContain("writeReplaySpectatorNameShown");
    // Reset all puts the viewer back to watching anonymously.
    expect(source).toMatch(/resetReplaySettings[\s\S]*writeReplaySpectatorNameShown\(false\)/);
  });

  it("only ever sends the name as a signed ticket", () => {
    const routeSource = fs.readFileSync(path.resolve(__dirname, "replay.tsx"), "utf8");
    const clientSource = fs.readFileSync(path.resolve(__dirname, "../lib/live-backend.ts"), "utf8");

    // The presence stream takes an identity object, never a raw username: an
    // unsigned name would be whoever edited the query string.
    expect(routeSource).toContain("getReplaySpectatorTicket");
    expect(routeSource).toContain("identity: spectatorIdentity.ticket");
    expect(clientSource).toContain('query.set("sig", identity.signature)');
  });

  it("draws the named watchers under the spectator counter", () => {
    const canvasSource = fs.readFileSync(path.resolve(__dirname, "../components/replay/ReplayCanvas.ts"), "utf8");

    expect(canvasSource).toContain("setSpectatorNames");
    expect(canvasSource).toContain("MAX_SPECTATOR_NAMES_DRAWN");
    // The block grows upward, so its last line stays where the counter alone
    // used to sit: names must never push the scoreboard off its anchor.
    expect(canvasSource).toContain("anchorY - height - lines * nameHeight");
    // How many lines is decided by the room above the anchor, never by the
    // name count alone, or a short stage draws the list over the scoreboard.
    expect(canvasSource).toContain("Math.floor((anchorY - height - gap) / nameHeight)");
    expect(canvasSource).toContain("`+${remainder} more`");
  });
});
