import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Source-level guards for the boundaries the local exporter is defined by.
// The rendering itself needs WebGL and WebCodecs, so it is verified in a real
// browser; what can be asserted here is that the ordinary export path has no
// way to reach the backend, and that the job does not live on this route.

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

const routeSource = read("./replay.tsx");
const rootSource = read("./__root.tsx");
const managerSource = read("../lib/replay-export/manager.ts");
const runnerSource = read("../lib/replay-export/runners/local.ts");
const snapshotSource = read("../lib/replay-export/snapshot.ts");
const flagSource = read("../lib/replay-export/feature-flag.ts");

const exportModules = [managerSource, runnerSource, snapshotSource];

describe("backend isolation", () => {
  it("leaves no replay-video job endpoint in the export flow", () => {
    for (const source of [routeSource, ...exportModules]) {
      expect(source).not.toContain("/api/replay-video-job");
      expect(source).not.toContain("server-render");
      expect(source).not.toContain("upload-video");
    }
  });

  it("no longer carries the server-render switch or its polling", () => {
    expect(routeSource).not.toContain("VITE_REPLAY_VIDEO_SERVER_RENDER");
    expect(routeSource).not.toContain("waitForReplayVideoJob");
    expect(routeSource).not.toContain("getRecentReplayVideoJob");
    expect(routeSource).not.toContain("ReplayVideoJobPayload");
  });

  it("produces a local result, never a URL to fetch back", () => {
    expect(runnerSource).toContain("ReplayExportOutputResult");
    expect(runnerSource).not.toContain("signed");
  });

  it("gates the button on its own client flag", () => {
    expect(flagSource).toContain("VITE_ENABLE_LOCAL_REPLAY_VIDEO_EXPORT");
    expect(routeSource).toContain("isLocalReplayVideoExportEnabled()");
  });

  it("keeps the automation hook development-only", () => {
    const hook = routeSource.slice(routeSource.indexOf("__maniaHubExportReplayVideo = "));
    expect(routeSource).toContain("if (!import.meta.env.DEV) return;");
    expect(hook).not.toContain("forceClientRender");
  });
});

describe("job ownership", () => {
  it("mounts the progress panel in the app shell, not on the replay route", () => {
    expect(rootSource).toContain("<ReplayExportPanel />");
    expect(routeSource).not.toContain("<ReplayExportPanel");
  });

  it("starts the job through the app-level manager", () => {
    expect(routeSource).toContain("getReplayExportManager()");
    expect(routeSource).toContain("manager.start({ spec, capture, target, title })");
  });

  it("opens the save dialog before anything awaited", () => {
    const handler = routeSource.slice(
      routeSource.indexOf("const startReplayVideoExport"),
      routeSource.indexOf("useEffect(() => {\n    // Development-only automation hook."),
    );
    // No await before the picker: the click's transient activation has to
    // still be live when it opens.
    expect(handler).not.toContain("await ");
    expect(handler).toContain("requestExportFileHandle(spec.filename");
  });

  it("keeps the manager out of the server bundle and the encoder out of the shell", () => {
    expect(managerSource).toContain("The replay export manager is browser-only.");
    // The runner, and with it mediabunny and its WASM, loads on demand.
    expect(managerSource).toContain('await import("./runners/local")');
    expect(managerSource).not.toMatch(/^import .*from "mediabunny"/m);
  });
});

describe("privacy", () => {
  it("never uploads the replay, the video, or the assets", () => {
    for (const source of exportModules) {
      expect(source).not.toMatch(/method:\s*"POST"/);
      expect(source).not.toContain("FormData");
    }
  });
});
