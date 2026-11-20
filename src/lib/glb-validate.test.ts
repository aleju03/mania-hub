import { describe, expect, it } from "vitest";
import { checkGlb, GLB_MAX_TRIANGLES } from "./glb-validate";

/* A binary glTF with this JSON and an 8-byte BIN chunk. */
function glb(json: object): Uint8Array {
  let text = JSON.stringify(json);
  while (text.length % 4) text += " ";
  const jsonBytes = new TextEncoder().encode(text);
  const total = 12 + 8 + jsonBytes.length + 8 + 8;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonBytes.length, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.set(jsonBytes, 20);
  view.setUint32(20 + jsonBytes.length, 8, true);
  view.setUint32(24 + jsonBytes.length, 0x004e4942, true);
  return out;
}

const mesh = (count: number) => ({
  asset: { version: "2.0" },
  buffers: [{ byteLength: 8 }],
  accessors: [{ count }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 0 }] }],
  nodes: [{ mesh: 0 }],
});

describe("checkGlb", () => {
  it("keys a model by its geometry and source, not its textures or names", () => {
    const shaped = {
      ...mesh(300),
      asset: { version: "2.0", extras: { source: "https://sketchfab.com/3d-models/thing-123/" } },
      accessors: [{ count: 300, min: [-1.23456, 0, -1], max: [1, 2.00001, 1] }],
    };
    const first = checkGlb(glb(shaped));
    const renamed = checkGlb(glb({ ...shaped, nodes: [{ mesh: 0, name: "other" }], images: [] }));
    const moved = checkGlb(glb({ ...shaped, accessors: [{ count: 300, min: [-1.3, 0, -1], max: [1, 2, 1] }] }));
    expect(first).toMatchObject({ ok: true, source: "https://sketchfab.com/3d-models/thing-123" });
    expect(renamed.ok && first.ok && renamed.geometry === first.geometry).toBe(true);
    expect(moved.ok && first.ok && moved.geometry !== first.geometry).toBe(true);
  });

  it("passes a self-contained model and counts its triangles", () => {
    expect(checkGlb(glb(mesh(300)))).toMatchObject({ ok: true, triangles: 100 });
  });

  it("counts a mesh once for every node that places it", () => {
    expect(checkGlb(glb({ ...mesh(300), nodes: [{ mesh: 0 }, { mesh: 0 }] }))).toMatchObject({ ok: true, triangles: 200 });
  });

  it("refuses anything that is not binary glTF 2.0", () => {
    expect(checkGlb(new TextEncoder().encode("hello world, not a model"))).toEqual({ ok: false, error: "not_glb" });
    const wrongLength = glb(mesh(3));
    new DataView(wrongLength.buffer).setUint32(8, wrongLength.length + 4, true);
    expect(checkGlb(wrongLength)).toEqual({ ok: false, error: "not_glb" });
    expect(checkGlb(glb({ ...mesh(3), asset: { version: "1.0" } }))).toEqual({ ok: false, error: "not_glb" });
  });

  it("refuses a model that would fetch files or URLs", () => {
    expect(checkGlb(glb({ ...mesh(3), buffers: [{ uri: "https://example.com/x.bin", byteLength: 8 }] }))).toEqual({ ok: false, error: "external_files" });
    expect(checkGlb(glb({ ...mesh(3), images: [{ uri: "texture.png" }] }))).toEqual({ ok: false, error: "external_files" });
    expect(checkGlb(glb({ ...mesh(3), images: [{ bufferView: 0, mimeType: "image/png" }] }))).toMatchObject({ ok: true, triangles: 1 });
  });

  it("refuses compression the site has no decoder for", () => {
    expect(checkGlb(glb({ ...mesh(3), extensionsRequired: ["KHR_draco_mesh_compression"] }))).toEqual({ ok: false, error: "unsupported_extension" });
    expect(checkGlb(glb({ ...mesh(3), extensionsRequired: ["KHR_texture_transform"] }))).toMatchObject({ ok: true, triangles: 1 });
  });

  it("refuses a model past the triangle cap", () => {
    expect(checkGlb(glb(mesh((GLB_MAX_TRIANGLES + 1) * 3)))).toEqual({ ok: false, error: "too_many_triangles" });
  });
});
