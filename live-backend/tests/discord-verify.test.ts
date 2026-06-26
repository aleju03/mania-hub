import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import { resetDiscordKeyCacheForTests, verifyDiscordSignature } from "../src/discord/verify.js";

// Derives the raw 32-byte Ed25519 public key as hex (the form Discord exposes
// in the Developer Portal) from a generated keypair.
function rawPublicKeyHex(publicKey: KeyObject): string {
  const spki = publicKey.export({ format: "der", type: "spki" });
  return spki.subarray(spki.length - 32).toString("hex");
}

function signRequest(privateKey: KeyObject, timestamp: string, body: Buffer): string {
  const message = Buffer.concat([Buffer.from(timestamp, "utf8"), body]);
  return cryptoSign(null, message, privateKey).toString("hex");
}

describe("verifyDiscordSignature", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyHex = rawPublicKeyHex(publicKey);
  const timestamp = "1700000000";
  const body = Buffer.from(JSON.stringify({ type: 1 }), "utf8");
  const signature = signRequest(privateKey, timestamp, body);

  it("accepts a valid signature", () => {
    resetDiscordKeyCacheForTests();
    expect(verifyDiscordSignature(publicKeyHex, signature, timestamp, body)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const tampered = Buffer.from(JSON.stringify({ type: 2 }), "utf8");
    expect(verifyDiscordSignature(publicKeyHex, signature, timestamp, tampered)).toBe(false);
  });

  it("rejects a mismatched timestamp", () => {
    expect(verifyDiscordSignature(publicKeyHex, signature, "1700000001", body)).toBe(false);
  });

  it("rejects a signature of the wrong length", () => {
    expect(verifyDiscordSignature(publicKeyHex, "abcd", timestamp, body)).toBe(false);
  });

  it("rejects missing signature or timestamp", () => {
    expect(verifyDiscordSignature(publicKeyHex, undefined, timestamp, body)).toBe(false);
    expect(verifyDiscordSignature(publicKeyHex, signature, undefined, body)).toBe(false);
  });

  it("rejects when the public key is empty or malformed", () => {
    resetDiscordKeyCacheForTests();
    expect(verifyDiscordSignature("", signature, timestamp, body)).toBe(false);
    expect(verifyDiscordSignature("zz", signature, timestamp, body)).toBe(false);
  });

  it("rejects a signature made with a different key", () => {
    const other = generateKeyPairSync("ed25519");
    const otherSig = signRequest(other.privateKey, timestamp, body);
    expect(verifyDiscordSignature(publicKeyHex, otherSig, timestamp, body)).toBe(false);
  });
});
