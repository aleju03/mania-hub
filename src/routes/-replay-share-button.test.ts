import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("replay share button", () => {
  it("hands the canonical link to both the controls and the info card", () => {
    const routeSource = fs.readFileSync(path.resolve(__dirname, "replay.tsx"), "utf8");

    expect(routeSource).toContain("const replayShareUrl = useMemo(");
    expect(routeSource).toContain("buildReplayShareUrl({");
    expect(routeSource).toContain("scoreId: uploaded ? undefined : scoreId");
    expect(routeSource).toContain("shareUrl={replayShareUrl ?? undefined}");
    expect(routeSource).toContain("shareUrl={replayShareUrl}");
    expect(routeSource).toContain("shareUrl={shareUrl ?? null}");
  });

  it("offers copy, an optional timestamp, and the share sheet on phones only", () => {
    const controlsSource = fs.readFileSync(
      path.resolve(__dirname, "../components/replay/ReplayControls.tsx"),
      "utf8",
    );

    expect(controlsSource).toContain('aria-label="Share this replay"');
    expect(controlsSource).toContain("withReplayShareTime(replayShareUrl, shareAtTimestamp ? sharePlayheadWallMs / 1000 : null)");
    expect(controlsSource).toContain("Start at {formatReplayMs(sharePlayheadWallMs)}");
    expect(controlsSource).toContain("navigator.share?.({ url: shareLink");
    // Desktop Chrome supports navigator.share and answers it with a QR-code
    // window, so the sheet stays behind a touch pointer.
    expect(controlsSource).toContain("const canNativeShare = nativeShareSupported && isCoarsePointer;");

    const infoSource = fs.readFileSync(path.resolve(__dirname, "../components/replay/ReplayInfo.tsx"), "utf8");
    expect(infoSource).not.toContain("navigator.share");
    // The right-click-a-timestamp popover shares the same canonical link.
    expect(controlsSource).toContain("withReplayShareTime(replayShareUrl ?? window.location.href, wallMs / 1000)");
  });

  it("queues autoplay after seeking a timestamped share link", () => {
    const routeSource = fs.readFileSync(path.resolve(__dirname, "replay.tsx"), "utf8");
    const timestampSeek = routeSource.indexOf("renderer.seek(gameTimeMs);");
    const timestampAutoplay = routeSource.indexOf("timestampAutoplayPendingRef.current = true;", timestampSeek);
    const queuedPlay = routeSource.indexOf("setPendingPlay(true);", timestampAutoplay);

    expect(timestampSeek).toBeGreaterThan(-1);
    expect(timestampAutoplay).toBeGreaterThan(timestampSeek);
    expect(queuedPlay).toBeGreaterThan(timestampAutoplay);
    expect(routeSource).toContain("startPlayback(isTimestampAutoplay);");
  });

  it("keeps a browser-blocked timestamp paused until one audible play click", () => {
    const routeSource = fs.readFileSync(path.resolve(__dirname, "replay.tsx"), "utf8");

    expect(routeSource).toContain("setTimestampAutoplayBlocked(true);");
    expect(routeSource).toContain("Play from {formatReplayStartTime(initialTime)}");
    expect(routeSource).toContain("Start with sound");
    expect(routeSource).toContain('aria-label={`Play replay from ${formatReplayStartTime(initialTime)} with sound`}');
  });
});
