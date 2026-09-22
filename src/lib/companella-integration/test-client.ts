/*
 * The browser test client.
 *
 * It exists so the page can be exercised before any native client ships, and
 * it is deliberately held to the SAME public contract: authorization code +
 * PKCE, a DPoP-bound key, the same upload endpoints, the same receipts. There
 * is no privileged shortcut, and the server marks everything it submits as
 * test evidence based on its registered client id, not on a label it sends.
 *
 * Key handling: a non-extractable WebCrypto key in IndexedDB, only so it can
 * survive the authorization redirect. Credentials stay in memory and are gone
 * on refresh. Nothing here goes into the app's persisted store, and no private
 * key material is ever displayed.
 */

import { md5Hex } from "../md5";
import { COMPANELLA_API_PREFIX } from "./shared";

const DB_NAME = "mania-hub-companella-test";
const STORE = "keys";
const KEY_ID = "dpop";
const TRANSACTION_KEY = "companella-test-transaction";

export interface TestKeyPair {
  privateKey: CryptoKey;
  publicJwk: JsonWebKey;
  thumbprint: string;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readStoredKey(): Promise<CryptoKeyPair | null> {
  const db = await openDatabase();
  return new Promise((resolve) => {
    const transaction = db.transaction(STORE, "readonly");
    const request = transaction.objectStore(STORE).get(KEY_ID);
    request.onsuccess = () => resolve((request.result as CryptoKeyPair | undefined) ?? null);
    request.onerror = () => resolve(null);
  });
}

async function writeStoredKey(pair: CryptoKeyPair): Promise<void> {
  const db = await openDatabase();
  await new Promise<void>((resolve) => {
    const transaction = db.transaction(STORE, "readwrite");
    transaction.objectStore(STORE).put(pair, KEY_ID);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => resolve();
  });
}

export async function clearTestKey(): Promise<void> {
  const db = await openDatabase();
  await new Promise<void>((resolve) => {
    const transaction = db.transaction(STORE, "readwrite");
    transaction.objectStore(STORE).delete(KEY_ID);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => resolve();
  });
  sessionStorage.removeItem(TRANSACTION_KEY);
}

function base64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function jwkThumbprint(jwk: JsonWebKey): Promise<string> {
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  return base64Url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)));
}

/** The installation key. Non-extractable: the page can sign with it and never read it. */
export async function getOrCreateTestKey(): Promise<TestKeyPair> {
  let pair = await readStoredKey();
  if (!pair) {
    pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]) as CryptoKeyPair;
    await writeStoredKey(pair);
  }
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  // Only the public half is ever serialised, and `d` cannot appear on it.
  delete (publicJwk as Record<string, unknown>).d;
  return { privateKey: pair.privateKey, publicJwk, thumbprint: await jwkThumbprint(publicJwk) };
}

export interface ProofRequest {
  method: string;
  url: string;
  accessToken?: string;
  nonce?: string;
}

/** A fresh proof per request. WebCrypto's ECDSA output is already raw r||s. */
export async function createProof(key: TestKeyPair, request: ProofRequest): Promise<string> {
  const header = {
    typ: "dpop+jwt",
    alg: "ES256",
    jwk: { kty: key.publicJwk.kty, crv: key.publicJwk.crv, x: key.publicJwk.x, y: key.publicJwk.y },
  };
  const payload: Record<string, unknown> = {
    jti: crypto.randomUUID(),
    htm: request.method.toUpperCase(),
    htu: request.url,
    iat: Math.floor(Date.now() / 1000),
  };
  if (request.nonce) payload.nonce = request.nonce;
  if (request.accessToken) {
    payload.ath = base64Url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(request.accessToken)));
  }
  const encoder = new TextEncoder();
  const signingInput = `${base64Url(encoder.encode(JSON.stringify(header)))}.${base64Url(encoder.encode(JSON.stringify(payload)))}`;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key.privateKey,
    encoder.encode(signingInput),
  );
  return `${signingInput}.${base64Url(signature)}`;
}

// ── PKCE transaction ──────────────────────────────────────────────────────

export interface TestTransaction {
  state: string;
  verifier: string;
  startedAt: number;
}

function randomVerifier(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function startTransaction(): Promise<{ state: string; challenge: string }> {
  const transaction: TestTransaction = {
    state: base64Url(crypto.getRandomValues(new Uint8Array(16))),
    verifier: randomVerifier(),
    startedAt: Date.now(),
  };
  // Session storage, not the app's persisted store: this is one transaction,
  // not a preference, and it must not survive the tab.
  sessionStorage.setItem(TRANSACTION_KEY, JSON.stringify(transaction));
  const challenge = base64Url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(transaction.verifier)));
  return { state: transaction.state, challenge };
}

export function readTransaction(): TestTransaction | null {
  try {
    const raw = sessionStorage.getItem(TRANSACTION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as TestTransaction;
    // Abandoned transactions are cleaned up rather than left to be reused.
    if (Date.now() - parsed.startedAt > 15 * 60 * 1000) {
      sessionStorage.removeItem(TRANSACTION_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function clearTransaction(): void {
  sessionStorage.removeItem(TRANSACTION_KEY);
}

// ── Protocol calls ────────────────────────────────────────────────────────

export interface TestCredentials {
  accessToken: string;
  refreshToken: string;
  installationId: string;
  username: string;
  userId: number;
  expiresAt: number;
}

function endpoint(path: string): string {
  return `${window.location.origin}${COMPANELLA_API_PREFIX}${path}`;
}

async function call(
  key: TestKeyPair,
  path: string,
  init: { method: string; body?: BodyInit | null; accessToken?: string; headers?: Record<string, string> },
): Promise<Response> {
  const url = endpoint(path);
  const send = async (nonce?: string) => fetch(url, {
    method: init.method,
    headers: {
      ...(init.accessToken ? { authorization: `DPoP ${init.accessToken}` } : {}),
      dpop: await createProof(key, { method: init.method, url, accessToken: init.accessToken, nonce }),
      ...(init.headers ?? {}),
    },
    body: init.body ?? undefined,
  });
  const response = await send();
  // A nonce challenge is answered once with a fresh proof; the queue is not
  // rebuilt and nothing is retried beyond that.
  const nonce = response.headers.get("dpop-nonce");
  if (response.status === 401 && nonce) return send(nonce);
  return response;
}

export async function exchangeCode(key: TestKeyPair, code: string, verifier: string, redirectUri: string, clientId: string): Promise<TestCredentials | null> {
  const response = await call(key, "/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: redirectUri,
    }),
  });
  if (!response.ok) return null;
  const payload = await response.json() as {
    access_token: string; refresh_token: string; expires_in: number;
    installation_id: string; username: string; user_id: number;
  };
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    installationId: payload.installation_id,
    username: payload.username,
    userId: payload.user_id,
    expiresAt: Date.now() + payload.expires_in * 1000,
  };
}

export async function fetchIdentity(key: TestKeyPair, credentials: TestCredentials): Promise<Record<string, unknown> | null> {
  const response = await call(key, "/me", { method: "GET", accessToken: credentials.accessToken });
  return response.ok ? await response.json() as Record<string, unknown> : null;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface SubmitProgress {
  step: string;
  detail?: string;
}

export interface SubmitResult {
  ok: boolean;
  submissionId?: string;
  status?: number;
  error?: string;
  receipt?: Record<string, unknown>;
}

/**
 * The full submission flow, exactly as a native client would run it: reserve,
 * upload only what the server asked for, complete, then read the receipt.
 */
export async function submitPlay(
  key: TestKeyPair,
  credentials: TestCredentials,
  files: { replay: Uint8Array; chart: Uint8Array },
  idempotencyKey: string,
  onProgress: (progress: SubmitProgress) => void,
): Promise<SubmitResult> {
  onProgress({ step: "hashing" });
  const manifest = {
    protocol_version: 1,
    client_version: "browser-test-1",
    game_client: "stable",
    capture_kind: "beta_test",
    replay: { sha256: await sha256Hex(files.replay), byte_length: files.replay.length },
    chart: {
      md5: md5Hex(files.chart),
      sha256: await sha256Hex(files.chart),
      byte_length: files.chart.length,
    },
  };

  onProgress({ step: "reserving" });
  const reserve = await call(key, "/submissions", {
    method: "POST",
    accessToken: credentials.accessToken,
    headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
    body: JSON.stringify(manifest),
  });
  if (!reserve.ok) {
    const body = await reserve.json().catch(() => ({})) as { error?: { code?: string; message?: string } };
    return { ok: false, status: reserve.status, error: body.error?.message ?? body.error?.code ?? "reserve_failed" };
  }
  const reservation = await reserve.json() as {
    submission_id: string; needs_replay: boolean; needs_beatmap: boolean;
  };

  if (reservation.needs_replay) {
    onProgress({ step: "uploading replay" });
    const response = await call(key, `/submissions/${reservation.submission_id}/replay`, {
      method: "PUT",
      accessToken: credentials.accessToken,
      headers: { "content-type": "application/octet-stream" },
      body: files.replay as unknown as BodyInit,
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: { message?: string; code?: string } };
      return { ok: false, status: response.status, submissionId: reservation.submission_id, error: body.error?.message ?? "replay_upload_failed" };
    }
  }
  if (reservation.needs_beatmap) {
    onProgress({ step: "uploading chart" });
    const response = await call(key, `/submissions/${reservation.submission_id}/beatmap`, {
      method: "PUT",
      accessToken: credentials.accessToken,
      headers: { "content-type": "application/octet-stream" },
      body: files.chart as unknown as BodyInit,
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: { message?: string; code?: string } };
      return { ok: false, status: response.status, submissionId: reservation.submission_id, error: body.error?.message ?? "chart_upload_failed" };
    }
  } else {
    onProgress({ step: "chart already stored", detail: "no transfer needed" });
  }

  onProgress({ step: "completing" });
  const complete = await call(key, `/submissions/${reservation.submission_id}/complete`, {
    method: "POST",
    accessToken: credentials.accessToken,
  });
  if (!complete.ok) {
    const body = await complete.json().catch(() => ({})) as { error?: { message?: string; code?: string } };
    return { ok: false, status: complete.status, submissionId: reservation.submission_id, error: body.error?.message ?? "complete_failed" };
  }

  onProgress({ step: "waiting for the receipt" });
  const receipt = await pollReceipt(key, credentials, reservation.submission_id, onProgress);
  return { ok: true, submissionId: reservation.submission_id, receipt: receipt ?? undefined };
}

async function pollReceipt(
  key: TestKeyPair,
  credentials: TestCredentials,
  submissionId: string,
  onProgress: (progress: SubmitProgress) => void,
): Promise<Record<string, unknown> | null> {
  let delay = 800;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, delay));
    // Backoff, not a tight loop: processing is queued work, not a request.
    delay = Math.min(delay * 1.6, 8_000);
    const response = await call(key, `/submissions/${submissionId}`, { method: "GET", accessToken: credentials.accessToken });
    if (!response.ok) continue;
    const receipt = await response.json() as Record<string, unknown>;
    onProgress({ step: String(receipt.state ?? "processing") });
    const state = String(receipt.state ?? "");
    if (state === "accepted" || state === "rejected" || state === "expired" || state === "deleted") return receipt;
  }
  return null;
}

/** A redacted one-line summary, for the diagnostics list. Never a credential. */
export function redactedSummary(method: string, path: string, status: number): string {
  return `${method} ${path} → ${status}`;
}
