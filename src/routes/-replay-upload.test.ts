import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("replay upload mode", () => {
  it("adds an upload tab that saves .osr files and opens them through the shared viewer", () => {
    const routeSource = fs.readFileSync(path.resolve(__dirname, "replay.tsx"), "utf8");
    const browseSource = fs.readFileSync(path.resolve(__dirname, "../components/replay/ReplayBrowseView.tsx"), "utf8");
    const uploadSource = fs.readFileSync(path.resolve(__dirname, "../lib/replay-upload.ts"), "utf8");
    const apiSource = fs.readFileSync(path.resolve(__dirname, "api/replay-upload.ts"), "utf8");

    expect(browseSource).toContain('export type ReplayBrowseMode = "player" | "beatmap" | "side-by-side" | "upload"');
    expect(browseSource).toContain('{ mode: "upload", label: "Upload" }');
    expect(browseSource).toContain("<UploadReplayBrowser");
    expect(browseSource).toContain('accept=".osr,application/octet-stream"');
    expect(browseSource).toContain("Uploading gives you a share link");
    expect(routeSource).toContain("tab: isReplayBrowseTab(s.tab) ? s.tab : undefined");
    expect(routeSource).toContain("uploadId: typeof s.uploadId");
    expect(routeSource).toContain("postUploadedReplay(buffer, file.name)");
    expect(routeSource).toContain("fetchUploadedReplayBuffer(id)");
    expect(routeSource).toContain("parseUploadedReplayBuffer(buffer");
    expect(routeSource).toContain("extractReplayScoreIdFromFilename(options.filename)");
    expect(routeSource).toContain('"X-Replay-Filename": encodeURIComponent(filename)');
    expect(routeSource).toContain("uploaded.scoreId");
    expect(routeSource).toContain('getScore({ data: { scoreId, mode: "mania" } })');
    // The embedded score id's namespace overlaps the unified /scores/{id} one,
    // so the fetched score only counts when it is verifiably this replay's map
    // (otherwise an unrelated play's accuracy, mods, client badge, and audio
    // beatmapset would poison the viewer).
    expect(routeSource).toContain("scoreMatchesUploadedReplay(fetchedScore, uploaded.replay.header.beatmapHash, beatmapMeta?.id)");
    expect(uploadSource).toContain("export function scoreMatchesUploadedReplay");
    expect(routeSource).toContain("const mods = uploadedScore?.mods ?? uploaded.mods");
    expect(routeSource).toContain("setUploadedReplayMods(mods)");
    expect(routeSource).toContain("lookupBeatmapByChecksum({ data: { checksum } })");
    expect(routeSource).toContain("replayMods={uploadedReplayMods}");
    expect(routeSource).toContain("uploadShareUrl: uploaded ? uploadedReplayShareUrl : null");
    const uploadServerSource = fs.readFileSync(path.resolve(__dirname, "../lib/replay-upload-server.ts"), "utf8");
    expect(apiSource).toContain('createFileRoute("/api/replay-upload")');
    expect(apiSource).toContain("handleReplayUploadPost(request)");
    expect(apiSource).toContain("handleReplayUploadGet(request)");
    expect(uploadServerSource).toContain("saveUploadedReplay(buffer, {");
    expect(uploadServerSource).toContain("readUploadedReplay(id)");
    expect(uploadServerSource).toContain('"X-Replay-Filename": encodeURIComponent(stored.originalFilename)');
    expect(uploadSource).toContain("extractReplayScoreIdFromFilename");
    expect(uploadSource).toContain("scoreId: Number.isSafeInteger(scoreId)");
    expect(uploadSource).toContain('await import("osu-parsers")');
    expect(uploadSource).toContain("stableModBitmaskToMods");
    expect(uploadSource).toContain("getStableManiaReplayScrollSpeedScale");
    expect(routeSource).toContain("stableScrollSpeedScale: parsed.stableScrollSpeedScale");
  });

  it("recovers from a missing beatmap by asking for a local .osz", () => {
    const routeSource = fs.readFileSync(path.resolve(__dirname, "replay.tsx"), "utf8");
    const browseSource = fs.readFileSync(path.resolve(__dirname, "../components/replay/ReplayBrowseView.tsx"), "utf8");
    const lookupSource = fs.readFileSync(path.resolve(__dirname, "../lib/osu/replay.ts"), "utf8");
    const localSource = fs.readFileSync(path.resolve(__dirname, "../lib/replay-local-beatmap.ts"), "utf8");

    // A checksum unknown to osu! resolves to null instead of throwing a raw
    // 404, so the route can branch into the recovery flow.
    expect(lookupSource).toContain("Promise<BeatmapChecksumLookupResult | null>");
    expect(lookupSource).toContain('error.message.includes("] 404 ")');

    // The route parks the parsed replay and asks for the map instead of
    // surfacing a fetch error, for both unlisted maps and failed chart fetches.
    expect(routeSource).toContain('enterPendingBeatmapUpload("unlisted", null)');
    expect(routeSource).toContain('enterPendingBeatmapUpload("file-unavailable", beatmapMeta)');
    expect(routeSource).toContain("matchLocalBeatmapFile(file, pending.checksum)");

    // Before asking, a community-supplied copy of the map is tried, so one user
    // dropping the .osz covers everyone who opens the replay afterwards.
    expect(routeSource).toContain("tryCommunityBeatmap(null)");
    expect(routeSource).toContain("tryCommunityBeatmap(beatmapMeta)");
    expect(routeSource).toContain("getCommunityBeatmapFile({ data: { checksum } })");
    expect(routeSource).toContain("submitCommunityBeatmap({ data: { checksum: pending.checksum, content: match.content } })");
    expect(lookupSource).toContain("export const getCommunityBeatmapFile");
    expect(lookupSource).toContain("export const submitCommunityBeatmap");
    expect(routeSource).toContain("<MissingBeatmapPanel");
    expect(routeSource).toContain("localAudioUrl={localBeatmapAssets.audioUrl}");
    expect(routeSource).toContain("localBackgroundUrl={localBeatmapAssets.backgroundUrl}");
    // Server-side export muxing can't read local blob: URLs.
    expect(routeSource).toContain("audioUrl: audioEnabled && remoteAudioUrl && !audioError");

    // The panel takes .osz archives and exact .osu files.
    expect(browseSource).toContain("export function MissingBeatmapPanel");
    expect(browseSource).toContain('accept=".osz,.osu,.zip,application/octet-stream"');

    // Matching is by the replay's beatmap MD5, and map assets come out of the
    // archive so unsubmitted maps still get audio and a background.
    expect(localSource).toContain("md5Hex(bytes)");
    expect(localSource).toContain("audioBlob");
    expect(localSource).toContain("backgroundBlob");
  });
});
