import { existsSync } from "node:fs";
// Type-only: playwright-core's runtime (and its module graph) must never load
// at boot. It is imported dynamically inside renderReplayVideoInChrome, which
// only runs where ENABLE_REPLAY_VIDEO is on (the owner's local environment).
import type { Browser, Page } from "playwright-core";
import type { Config } from "../config.js";

export type ServerReplayRenderRequest = {
  scoreId: number;
  beatmapsetId?: number | null;
  kind: "custom" | "full";
  startTimeMs?: number;
  endTimeMs?: number;
  resolution: "720p" | "1080p";
  fps: 30 | 48 | 60;
  bgDim?: number;
  blackPlayfield?: boolean;
  scrollSpeed?: number;
  showInputOverlay?: boolean;
  inputOverlayOnly?: boolean;
  inputOverlayColor?: string;
  inputOverlayKeyHistory?: boolean;
  skinSettings?: unknown;
  overlaySettings?: unknown;
  // "left" | "right": which hand owns the middle lane in the L/R miss split.
  missThumbHand?: unknown;
};

export type ServerReplayRenderResult = {
  url: string;
  signed: boolean;
  id?: string;
  sizeBytes?: number | null;
  mimeType?: string | null;
  encodedWith?: string | null;
  hasAudio?: boolean | null;
};

const DEFAULT_CHROME_PATHS = [
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

export async function renderReplayVideoInChrome(config: Config, request: ServerReplayRenderRequest): Promise<ServerReplayRenderResult> {
  if (!config.enableReplayVideo) {
    throw new Error("Replay video rendering is disabled (set ENABLE_REPLAY_VIDEO=true).");
  }
  const executablePath = findChromePath(config);
  const { chromium } = await import("playwright-core");
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({
      executablePath,
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--autoplay-policy=no-user-gesture-required",
        "--enable-features=VaapiVideoEncoder",
      ],
    });
    const page = await browser.newPage({
      viewport: request.resolution === "1080p"
        ? { width: 1920, height: 1080 }
        : { width: 1280, height: 720 },
    });
    page.setDefaultTimeout(120_000);
    const url = new URL("/replay", config.replayVideoRenderBaseUrl.replace(/\/+$/, ""));
    url.searchParams.set("scoreId", String(request.scoreId));
    if (request.beatmapsetId) url.searchParams.set("beatmapsetId", String(request.beatmapsetId));
    await page.goto(url.toString(), { waitUntil: "domcontentloaded" });
    const result = await evaluateReplayExport(page, request);
    if (!result?.url) throw new Error("Headless replay export did not return a URL.");
    return result;
  } finally {
    await browser?.close().catch(() => {});
  }
}

async function evaluateReplayExport(page: Page, request: ServerReplayRenderRequest): Promise<ServerReplayRenderResult | null> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await page.waitForLoadState("domcontentloaded", { timeout: 120_000 }).catch(() => {});
      await page.waitForFunction(() => typeof (window as any).__maniaHubExportReplayVideo === "function", null, { timeout: 120_000 });
      return await page.evaluate((input) => (window as any).__maniaHubExportReplayVideo(input), request) as ServerReplayRenderResult | null;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      const canRetry = message.includes("Execution context was destroyed") || message.includes("navigation");
      if (!canRetry || attempt === 2) break;
      await page.waitForTimeout(1_000);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "Headless replay export failed."));
}

function findChromePath(config: Config): string {
  if (config.replayVideoChromePath && existsSync(config.replayVideoChromePath)) return config.replayVideoChromePath;
  for (const path of DEFAULT_CHROME_PATHS) {
    if (existsSync(path)) return path;
  }
  throw new Error("Chrome is not installed. Set REPLAY_VIDEO_CHROME_PATH to a Chromium/Chrome executable.");
}
