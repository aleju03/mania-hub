import { createPublicKey, verify as cryptoVerify, type KeyObject } from "node:crypto";

// Discord signs every interaction request with Ed25519. The signed message is
// `timestamp + rawBody`; the signature arrives hex-encoded in the
// `X-Signature-Ed25519` header and the timestamp in `X-Signature-Timestamp`.
// We verify against the application's public key from the Developer Portal.
//
// Node's crypto can do Ed25519 natively, so this needs no extra dependency
// (no tweetnacl / discord-interactions). A raw 32-byte Ed25519 public key is
// wrapped into a DER SubjectPublicKeyInfo by prefixing the fixed 12-byte
// header below, which createPublicKey() then accepts as `spki`.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

// Building the KeyObject parses DER on every call; cache it per hex key since
// the public key never changes for a given deployment.
const keyCache = new Map<string, KeyObject | null>();

function publicKeyFromHex(publicKeyHex: string): KeyObject | null {
  const cached = keyCache.get(publicKeyHex);
  if (cached !== undefined) return cached;
  let key: KeyObject | null = null;
  try {
    const raw = Buffer.from(publicKeyHex, "hex");
    // A valid Ed25519 public key is exactly 32 bytes; reject anything else
    // before handing malformed input to the DER parser.
    if (raw.length === 32) {
      const der = Buffer.concat([ED25519_SPKI_PREFIX, raw]);
      key = createPublicKey({ key: der, format: "der", type: "spki" });
    }
  } catch {
    key = null;
  }
  keyCache.set(publicKeyHex, key);
  return key;
}

function isHex(value: string): boolean {
  return value.length > 0 && value.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(value);
}

export interface DiscordSignature {
  signature: string | undefined;
  timestamp: string | undefined;
}

/**
 * Verifies a Discord interaction request signature.
 *
 * @param publicKeyHex the application's hex public key (config.discordPublicKey)
 * @param signatureHex the `X-Signature-Ed25519` header value
 * @param timestamp the `X-Signature-Timestamp` header value
 * @param rawBody the EXACT raw request body bytes (must not be re-serialized)
 */
export function verifyDiscordSignature(
  publicKeyHex: string,
  signatureHex: string | undefined,
  timestamp: string | undefined,
  rawBody: Buffer,
): boolean {
  if (!publicKeyHex || !signatureHex || !timestamp) return false;
  if (!isHex(signatureHex)) return false;
  // Ed25519 signatures are 64 bytes (128 hex chars).
  if (signatureHex.length !== 128) return false;
  const key = publicKeyFromHex(publicKeyHex);
  if (!key) return false;
  try {
    const message = Buffer.concat([Buffer.from(timestamp, "utf8"), rawBody]);
    const signature = Buffer.from(signatureHex, "hex");
    return cryptoVerify(null, message, key, signature);
  } catch {
    return false;
  }
}

// Test seam: clears the cached KeyObjects so a test can swap keys.
export function resetDiscordKeyCacheForTests(): void {
  keyCache.clear();
}
