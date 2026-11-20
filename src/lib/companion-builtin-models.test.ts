import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUILT_IN_COMPANION_GEOMETRY, BUILT_IN_COMPANION_SOURCES } from "./companion-builtin-models";
import { checkGlb } from "./glb-validate";
import { isBuiltInModel } from "./supporter-companion-upload-server";

const DIR = join(process.cwd(), "public/models/companions");

describe("built-in companion model keys", () => {
  it("match the models in public/models/companions", () => {
    const geometry = new Set<string>();
    const sources = new Set<string>();
    for (const file of readdirSync(DIR).filter((name) => name.endsWith(".glb"))) {
      const check = checkGlb(readFileSync(join(DIR, file)));
      expect(check.ok, file).toBe(true);
      if (!check.ok) continue;
      geometry.add(createHash("sha256").update(check.geometry).digest("hex").slice(0, 16));
      if (check.source) sources.add(check.source);
    }
    expect([...BUILT_IN_COMPANION_GEOMETRY].sort()).toEqual([...geometry].sort());
    expect([...BUILT_IN_COMPANION_SOURCES].sort()).toEqual([...sources].sort());
  });

  it("turns away a site model re-saved with other textures and no source", () => {
    const bytes = readFileSync(join(DIR, "fumo-cirno.glb"));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const jsonLength = view.getUint32(12, true);
    const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)));
    delete json.asset.extras;
    json.asset.generator = "Sketchfab-12.68.0";
    for (const image of json.images ?? []) image.mimeType = "image/png";
    let text = JSON.stringify(json);
    while (text.length % 4) text += " ";
    const head = new TextEncoder().encode(text);
    const rest = bytes.subarray(20 + jsonLength);
    const out = new Uint8Array(20 + head.length + rest.length);
    const outView = new DataView(out.buffer);
    outView.setUint32(0, 0x46546c67, true);
    outView.setUint32(4, 2, true);
    outView.setUint32(8, out.length, true);
    outView.setUint32(12, head.length, true);
    outView.setUint32(16, 0x4e4f534a, true);
    out.set(head, 20);
    out.set(rest, 20 + head.length);
    const check = checkGlb(out);
    expect(check).toMatchObject({ ok: true, source: null });
    expect(check.ok && isBuiltInModel(check)).toBe(true);
  });
});
