import { brotliCompress, constants as zlibConstants, gzip } from "node:zlib";

// Below this size compression costs more than it saves (sub-MTU payloads).
export const COMPRESSIBLE_MIN_BYTES = 1400;

// A JSON response that has already been serialized (and possibly compressed),
// so it can be stored and replayed without redoing that work. Lives in its own
// module (rather than snapshots.ts) so the maps snapshot worker thread can
// build responses without importing the whole HTTP layer.
export interface PreparedJsonResponse {
  status: number;
  encoding: "br" | "gzip" | null;
  vary: boolean;
  body: Buffer;
}

export function compressJsonBuffer(encoding: "br" | "gzip", json: Buffer): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const finish = (error: Error | null, compressed: Buffer): void => {
      resolve(error ? null : compressed);
    };
    if (encoding === "br") {
      brotliCompress(json, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } }, finish);
    } else {
      gzip(json, { level: 6 }, finish);
    }
  });
}

export async function prepareJsonResponse(
  status: number,
  body: unknown,
  encoding: "br" | "gzip" | null,
): Promise<PreparedJsonResponse> {
  const json = Buffer.from(JSON.stringify(body), "utf8");
  if (json.length < COMPRESSIBLE_MIN_BYTES) {
    return { status, encoding: null, vary: false, body: json };
  }
  if (!encoding) {
    return { status, encoding: null, vary: true, body: json };
  }
  const compressed = await compressJsonBuffer(encoding, json);
  return compressed
    ? { status, encoding, vary: true, body: compressed }
    : { status, encoding: null, vary: true, body: json };
}
