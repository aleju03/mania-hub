import { afterEach, describe, expect, it, vi } from "vitest";

import { MANIA_BRIDGE_REPO, MANIA_BRIDGE_VERSION } from "./mania-bridge";

const asset = (file: string) => `https://github.com/${MANIA_BRIDGE_REPO}/releases/download/v${MANIA_BRIDGE_VERSION}/${file}`;

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    version: MANIA_BRIDGE_VERSION,
    notes: "",
    pub_date: "2026-10-02T00:00:00Z",
    platforms: {
      "windows-x86_64": { url: asset("Mania.Bridge_x64-setup.exe"), signature: "s" },
      "linux-x86_64": { url: asset("Mania.Bridge_amd64.AppImage"), signature: "s" },
      "linux-x86_64-deb": { url: asset("Mania.Bridge_amd64.deb"), signature: "s" },
      "linux-x86_64-rpm": { url: asset("Mania.Bridge.x86_64.rpm"), signature: "s" },
    },
    ...overrides,
  };
}

async function load(body: unknown, ok = true) {
  vi.resetModules();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status: ok ? 200 : 404 })));
  return import("./mania-bridge-release");
}

afterEach(() => vi.unstubAllGlobals());

describe("the Mania Bridge release file", () => {
  it("serves the release's file and its installers by system", async () => {
    const release = await load(manifest());
    const read = await release.readManiaBridgeManifest();
    expect(read?.version).toBe(MANIA_BRIDGE_VERSION);
    expect(release.maniaBridgeDownloads(read)).toEqual({
      windows: asset("Mania.Bridge_x64-setup.exe"),
      appImage: asset("Mania.Bridge_amd64.AppImage"),
      deb: asset("Mania.Bridge_amd64.deb"),
      rpm: asset("Mania.Bridge.x86_64.rpm"),
    });
  });

  it("turns away a missing release, another version, or an installer hosted elsewhere", async () => {
    expect(await (await load("Not Found", false)).readManiaBridgeManifest()).toBeNull();
    expect(await (await load(manifest({ version: "9.9.9" }))).readManiaBridgeManifest()).toBeNull();
    expect(await (await load(manifest({ platforms: { "windows-x86_64": { url: "https://example.com/x.exe", signature: "s" } } }))).readManiaBridgeManifest()).toBeNull();
    expect(await (await load("{not json")).readManiaBridgeManifest()).toBeNull();
  });
});
