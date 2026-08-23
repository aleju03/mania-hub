import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("replay upload mode", () => {
  it("adds an upload tab that saves .osr files and opens them through the shared viewer", () => {
    const routeSource = fs.readFileSync(path.resolve(__dirname, "replay.tsx"), "utf8");
    const browseSource = fs.readFileSync(path.resolve(__dirname, "../components/replay/ReplayBrowseView.tsx"), "utf8");
    const uploadSource = fs.readFileSync(path.resolve(__dirname, "../lib/replay-upload.ts"), "utf8");
    const apiSource = fs.readFileSync(path.resolve(__dirname, "api/replay-upload.ts"), "utf8");
    const ogSource = fs.readFileSync(path.resolve(__dirname, "api/og.ts"), "utf8");

    expect(browseSource).toContain('export type ReplayBrowseMode = "player" | "beatmap" | "side-by-side" | "upload"');
    expect(browseSource).toContain('{ mode: "upload", label: msg`Upload` }');
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
    expect(routeSource).toContain("uploadedReplayOgImagePath(uploadId)");
    expect(ogSource).toContain('if (kind === "uploaded-replay")');
    expect(ogSource).toContain("describeUploadedReplayById(uploadId)");
    expect(ogSource).toContain("uploadedReplayOgData(description)");
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

    // The panel takes .osz archives (lazer writes .olz for the same thing) and
    // exact .osu files, and spells out where each client keeps them.
    expect(browseSource).toContain("export function MissingBeatmapPanel");
    expect(browseSource).toContain('accept=".osz,.olz,.osu,.zip,application/octet-stream"');
    expect(browseSource).toContain("File &gt; Export package");
    expect(localSource).toContain('lower.endsWith(".olz")');

    // Matching is by the replay's beatmap MD5, and map assets come out of the
    // archive so unsubmitted maps still get audio and a background.
    expect(localSource).toContain("md5Hex(bytes)");
    expect(localSource).toContain("audioBlob");
    expect(localSource).toContain("backgroundBlob");
  });

  it("indexes each upload's owner so it can be listed and deleted later", () => {
    const routeSource = fs.readFileSync(path.resolve(__dirname, "replay.tsx"), "utf8");
    const browseSource = fs.readFileSync(path.resolve(__dirname, "../components/replay/ReplayBrowseView.tsx"), "utf8");
    const uploadsPageSource = fs.readFileSync(path.resolve(__dirname, "replay_.uploads.tsx"), "utf8");
    const uploadServerSource = fs.readFileSync(path.resolve(__dirname, "../lib/replay-upload-server.ts"), "utf8");
    const uploadsSource = fs.readFileSync(path.resolve(__dirname, "../lib/uploaded-replays.ts"), "utf8");

    // The row is written before the response, because the viewer asks whether
    // it may delete the upload as soon as that response lands.
    expect(uploadServerSource).toContain("await recordUploadedReplayOwner({");

    // Ownership is the backend's call, and the file only goes after the row it
    // was authorized against.
    const deleteHandler = uploadsSource.slice(uploadsSource.indexOf("export const deleteUploadedReplay"));
    expect(deleteHandler.indexOf("deleteUploadedReplayIndexRow"))
      .toBeLessThan(deleteHandler.indexOf("deleteUploadedReplayObjects"));
    expect(uploadsSource).toContain("if (!authorized.ok) return { ok: false, error: authorized.error };");
    // A signed-out visitor has no shelf, and only an admin sees everyone's.
    expect(uploadsSource).toContain("const allOwners = data.allOwners && auth.canUseAdminFeatures;");

    // "Your uploads" lives on its own page; the Upload tab only links there.
    expect(browseSource).toContain('to="/replay/uploads"');
    expect(uploadsPageSource).toContain('createFileRoute("/replay_/uploads")');
    expect(uploadsPageSource).toContain("fetchMyUploadedReplays({ data: { page: nextPage, allOwners: owners } })");
    expect(uploadsPageSource).toContain("deleteUploadedReplay({ data: { id: upload.id } })");
    // The admin's every-uploader view names who uploaded each row.
    expect(uploadsPageSource).toContain("showUploader={allOwners}");
    // The delete button on the viewer itself waits for the ownership answer.
    expect(routeSource).toContain("fetchUploadedReplayPermissions({ data: { id: requestedUploadId } })");
    expect(routeSource).toContain("onDeleteUpload={canDeleteLoadedUpload ? handleDeleteLoadedUpload : undefined}");
  });

  it("plays uploads with the uploader's replay skin", () => {
    const routeSource = fs.readFileSync(path.resolve(__dirname, "replay.tsx"), "utf8");
    const uploadsSource = fs.readFileSync(path.resolve(__dirname, "../lib/uploaded-replays.ts"), "utf8");

    // Public share-link viewers need the uploader id too; delete permission is
    // still calculated separately against the signed-in viewer.
    expect(uploadsSource).toContain("ownerUserId: row?.ownerUserId ?? null");
    expect(uploadsSource).not.toContain("if (!auth.viewer && !auth.canUseAdminFeatures) return");
    // An upload's owner takes precedence over a coincidentally resolved score
    // player, matching the product's usual uploader-is-player assumption.
    expect(routeSource).toContain("const replaySkinOwnerUserId = loadedUploadId != null");
    expect(routeSource).toContain("uploadedReplayOwner?.uploadId === loadedUploadId");
    expect(routeSource).toContain("setUploadedReplayOwner({ uploadId: saved.id, userId: saved.ownerUserId })");
    expect(routeSource).toContain("ownerUserId={replaySkinOwnerUserId}");
  });
});
