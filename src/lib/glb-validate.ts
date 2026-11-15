/* Checks a supporter's 3D companion before it is stored: binary glTF 2.0
   carrying everything inside it (no file or URL it would fetch), no
   compression the site has no decoder for, and few enough triangles that a
   profile draws it without a stutter. The bytes are stored as sent once they
   pass; nothing here rewrites them. */

export const GLB_MAX_TRIANGLES = 100_000;

/* Extensions a model may require and three.js's GLTFLoader reads unaided. */
const ALLOWED_REQUIRED_EXTENSIONS = new Set([
  "KHR_materials_unlit",
  "KHR_materials_emissive_strength",
  "KHR_texture_transform",
  "KHR_mesh_quantization",
  "EXT_texture_webp",
]);
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const TRIANGLES = 4;

export type GlbCheck =
  | { ok: true; triangles: number }
  | { ok: false; error: "not_glb" | "external_files" | "unsupported_extension" | "too_many_triangles" };

interface GltfJson {
  asset?: { version?: unknown };
  buffers?: Array<{ uri?: unknown }>;
  images?: Array<{ uri?: unknown; mimeType?: unknown }>;
  extensionsRequired?: unknown[];
  accessors?: Array<{ count?: unknown }>;
  meshes?: Array<{ primitives?: Array<{ mode?: unknown; indices?: unknown; attributes?: { POSITION?: unknown } }> }>;
  nodes?: Array<{ mesh?: unknown }>;
}

function primitiveTriangles(json: GltfJson, primitive: NonNullable<NonNullable<GltfJson["meshes"]>[number]["primitives"]>[number]): number {
  const accessor = typeof primitive.indices === "number" ? primitive.indices : primitive.attributes?.POSITION;
  const count = typeof accessor === "number" ? Number(json.accessors?.[accessor]?.count) || 0 : 0;
  // strips and fans still draw about one triangle per vertex
  return (primitive.mode ?? TRIANGLES) === TRIANGLES ? Math.floor(count / 3) : count;
}

export function checkGlb(bytes: Uint8Array): GlbCheck {
  if (bytes.length < 20) return { ok: false, error: "not_glb" };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC || view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== bytes.length) {
    return { ok: false, error: "not_glb" };
  }
  const jsonLength = view.getUint32(12, true);
  if (view.getUint32(16, true) !== CHUNK_JSON || 20 + jsonLength > bytes.length) return { ok: false, error: "not_glb" };
  let json: GltfJson;
  try {
    json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength))) as GltfJson;
  } catch {
    return { ok: false, error: "not_glb" };
  }
  if (!json || typeof json !== "object" || !String(json.asset?.version ?? "").startsWith("2")) return { ok: false, error: "not_glb" };
  if ((json.buffers ?? []).some((buffer) => buffer.uri !== undefined)) return { ok: false, error: "external_files" };
  if ((json.images ?? []).some((image) => image.uri !== undefined || !IMAGE_TYPES.has(String(image.mimeType)))) {
    return { ok: false, error: "external_files" };
  }
  if ((json.extensionsRequired ?? []).some((name) => !ALLOWED_REQUIRED_EXTENSIONS.has(String(name)))) {
    return { ok: false, error: "unsupported_extension" };
  }
  const meshes = json.meshes ?? [];
  const meshTriangles = meshes.map((mesh) => (mesh.primitives ?? []).reduce((sum, primitive) => sum + primitiveTriangles(json, primitive), 0));
  // each node that places a mesh draws it again
  const placed = (json.nodes ?? []).filter((node) => typeof node.mesh === "number");
  const triangles = placed.length > 0
    ? placed.reduce((sum, node) => sum + (meshTriangles[node.mesh as number] ?? 0), 0)
    : meshTriangles.reduce((sum, count) => sum + count, 0);
  if (triangles > GLB_MAX_TRIANGLES) return { ok: false, error: "too_many_triangles" };
  return { ok: true, triangles };
}
