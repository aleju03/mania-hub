import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { HttpContext } from "./context.js";

export function isAdmin(req: IncomingMessage, ctx: HttpContext): boolean {
  // Fail closed: no configured token means no admin access in any NODE_ENV.
  const token = ctx.config.liveAdminToken;
  if (!token) return false;
  const header = req.headers.authorization;
  if (typeof header !== "string") return false;
  const expected = Buffer.from(`Bearer ${token}`);
  const provided = Buffer.from(header);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export const DEFAULT_BODY_LIMIT_BYTES = 1024 * 1024;

export class HttpRequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export async function readBodyBuffer(req: IncomingMessage, limitBytes = DEFAULT_BODY_LIMIT_BYTES): Promise<Buffer> {
  const limit = Math.max(1, Math.floor(limitBytes));
  const rawLength = Array.isArray(req.headers["content-length"]) ? req.headers["content-length"][0] : req.headers["content-length"];
  if (rawLength != null) {
    const length = Number(rawLength);
    if (!Number.isFinite(length) || length < 0) {
      throw new HttpRequestError(400, "invalid_content_length", "Invalid Content-Length header.");
    }
    if (length > limit) {
      throw new HttpRequestError(413, "payload_too_large", "Request body is too large.");
    }
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > limit) {
      throw new HttpRequestError(413, "payload_too_large", "Request body is too large.");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total);
}

export async function readBody(req: IncomingMessage): Promise<string> {
  return (await readBodyBuffer(req)).toString("utf8");
}

export function clampLimit(raw: string | null, fallback: number, max: number): number {
  const value = Number(raw ?? fallback);
  return Number.isFinite(value) ? Math.max(1, Math.min(max, Math.floor(value))) : fallback;
}

export function clampInteger(raw: string | null, min: number, max: number, fallback: number): number {
  const value = Number(raw ?? fallback);
  return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value))) : fallback;
}

export function parseUserIds(raw: string | null): number[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((id) => Number.isInteger(id) && id > 0)
    .slice(0, 100);
}

export function parseModAcronyms(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((part) => part.trim().toUpperCase())
    .filter((mod) => /^[A-Z0-9]{2,4}$/.test(mod))
    .slice(0, 20);
}

export function normalizeIdList(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const out: number[] = [];
  for (const entry of value) {
    const id = Math.floor(Number(entry));
    if (Number.isFinite(id) && id > 0) out.push(id);
  }
  return out;
}
