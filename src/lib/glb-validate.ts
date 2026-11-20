/* Checks a supporter's 3D companion before it is stored: binary glTF 2.0
   carrying everything inside it (no file or URL it would fetch), no
   compression the site has no decoder for, and few enough triangles that a
   profile draws it without a stutter. The bytes are stored as sent once they
   pass; nothing here rewrites them. It also reads what identifies the model
   whatever its textures were saved as (its geometry, and the page it was
   downloaded from), so a copy of a model already on the site can be turned away. */

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
  | { ok: true; triangles: number; geometry: string; source: string | null }
  | { ok: false; error: "not_glb" | "external_files" | "unsupported_extension" | "too_many_triangles" };

interface GltfJson {
  asset?: { version?: unknown; extras?: { source?: unknown } };
  buffers?: Array<{ uri?: unknown }>;
  images?: Array<{ uri?: unknown; mimeType?: unknown }>;
  extensionsRequired?: unknown[];
  accessors?: Array<{ count?: unknown; min?: unknown; max?: unknown }>;
  meshes?: Array<{ primitives?: Array<{ mode?: unknown; indices?: unknown; attributes?: { POSITION?: unknown } }> }>;
  nodes?: Array<{ mesh?: unknown }>;
}

/* Each primitive's vertex and index counts and its position bounds, sorted:
   recompressing the textures or renaming the parts leaves it unchanged. */
function geometryKey(json: GltfJson): string {
  const round = (values: unknown) => (Array.isArray(values) ? values.map((value) => Number(Number(value).toFixed(3))).join(",") : "");
  const parts: string[] = [];
  for (const mesh of json.meshes ?? []) {
    for (const primitive of mesh.primitives ?? []) {
      const position = typeof primitive.attributes?.POSITION === "number" ? json.accessors?.[primitive.attributes.POSITION] : undefined;
      const indices = typeof primitive.indices === "number" ? json.accessors?.[primitive.indices] : undefined;
      parts.push(`${Number(position?.count) || 0}/${Number(indices?.count) || 0}/${round(position?.min)}/${round(position?.max)}`);
    }
  }
  return parts.sort().join(";");
}

/* The page a model came from, as Sketchfab and similar exporters write it. */
function sourceKey(json: GltfJson): string | null {
  const source = json.asset?.extras?.source;
  return typeof source === "string" && source.trim() ? source.trim().toLowerCase().replace(/\/+$/, "") : null;
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
  return { ok: true, triangles, geometry: geometryKey(json), source: sourceKey(json) };
}
