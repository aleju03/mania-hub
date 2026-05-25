import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("replay upload mode", () => {
  it("adds an upload tab that saves .osr files and opens them through the shared viewer", () => {
    const routeSource = fs.readFileSync(path.resolve(__dirname, "replay.tsx"), "utf8");
    const browseSource = fs.readFileSync(path.resolve(__dirname, "../components/replay/ReplayBrowseView.tsx"), "utf8");
    const uploadSource = fs.readFileSync(path.resolve(__dirname, "../lib/replay-upload.ts"), "utf8");
    const apiSource = fs.readFileSync(path.resolve(__dirname, "api/replay-upload.ts"), "utf8");

    expect(browseSource).toContain('export type ReplayBrowseMode = "player" | "beatmap" | "upload"');
    expect(browseSource).toContain('(["player", "upload"] as const)');
    expect(browseSource).toContain("<UploadReplayBrowser");
    expect(browseSource).toContain('accept=".osr,application/octet-stream"');
    expect(browseSource).toContain("Uploading gives you a share link");
    expect(routeSource).toContain('tab: s.tab === "beatmap" || s.tab === "upload" ? s.tab : undefined');
    expect(routeSource).toContain("uploadId: typeof s.uploadId");
    expect(routeSource).toContain("postUploadedReplay(buffer, file.name)");
    expect(routeSource).toContain("fetchUploadedReplayBuffer(id)");
    expect(routeSource).toContain("parseUploadedReplayBuffer(buffer");
    expect(routeSource).toContain("extractReplayScoreIdFromFilename(options.filename)");
    expect(routeSource).toContain('"X-Replay-Filename": encodeURIComponent(filename)');
    expect(routeSource).toContain("uploaded.scoreId");
    expect(routeSource).toContain('getScore({ data: { scoreId, mode: "mania" } })');
    expect(routeSource).toContain("setUploadedReplayMods(uploadedScore?.mods ?? uploaded.mods)");
    expect(routeSource).toContain("lookupBeatmapByChecksum({ data: { checksum } })");
    expect(routeSource).toContain("replayMods={uploadedReplayMods}");
    expect(routeSource).toContain("shareUrl={uploadedReplayShareUrl");
    expect(apiSource).toContain('createFileRoute("/api/replay-upload")');
    expect(apiSource).toContain("saveUploadedReplay(buffer, originalFilename)");
    expect(apiSource).toContain("readUploadedReplay(id)");
    expect(apiSource).toContain('"X-Replay-Filename": encodeURIComponent(stored.originalFilename)');
    expect(uploadSource).toContain("extractReplayScoreIdFromFilename");
    expect(uploadSource).toContain("scoreId: Number.isSafeInteger(scoreId)");
    expect(uploadSource).toContain('await import("osu-parsers")');
    expect(uploadSource).toContain("stableModBitmaskToMods");
    expect(uploadSource).toContain("getStableManiaReplayScrollSpeedScale");
    expect(routeSource).toContain("stableScrollSpeedScale: parsed.stableScrollSpeedScale");
  });
});
