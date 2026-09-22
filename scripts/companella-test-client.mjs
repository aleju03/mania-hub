#!/usr/bin/env node
/*
 * A reference client for the Companella integration.
 *
 * It exercises the PUBLIC HTTP contract and nothing else: no backend imports,
 * no bridge token, no database access, no privileged bypass. If this can
 * connect and submit a play, so can a native client written from the guide in
 * docs/companella-client-guide.md.
 *
 * It is test tooling, not a model of production key storage. The signing key
 * is a plain file under a gitignored directory; a real client owns that part
 * (see the guide's note on native key protection).
 *
 * Usage:
 *   npm run companella:test-client -- connect --origin http://localhost:3000 --profile windows-test
 *   npm run companella:test-client -- me --profile windows-test
 *   npm run companella:test-client -- submit --profile windows-test --replay play.osr --beatmap chart.osu
 *   npm run companella:test-client -- status --profile windows-test --submission <id>
 *   npm run companella:test-client -- disconnect --profile windows-test
 */

import { createHash, createSign, generateKeyPairSync, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
// Gitignored, and per-profile so two "installations" can coexist on one
// machine the way a dual boot would.
const PROFILE_ROOT = resolve(HERE, "..", "local-notes", "companella-test-client");
const API_PREFIX = "/api/integrations/companella/v1";
const CLIENT_ID = process.env.COMPANELLA_TEST_CLIENT_ID || "companella-test";
const CALLBACK_PATH = "/companella/callback";

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = rest[i + 1];
    if (next && !next.startsWith("--")) {
      options[key] = next;
      i += 1;
    } else {
      options[key] = "true";
    }
  }
  return { command, options };
}

function base64Url(buffer) {
  return Buffer.from(buffer).toString("base64url");
}

function profilePath(profile) {
  return join(PROFILE_ROOT, `${profile.replace(/[^a-zA-Z0-9_-]/g, "")}.json`);
}

async function readProfile(profile) {
  try {
    return JSON.parse(await readFile(profilePath(profile), "utf8"));
  } catch {
    return null;
  }
}

async function writeProfile(profile, data) {
  await mkdir(PROFILE_ROOT, { recursive: true });
  // 0600 where the platform honours it. This is a key file, even a test one.
  await writeFile(profilePath(profile), JSON.stringify(data, null, 2), { mode: 0o600 });
}

function createKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwkFull = publicKey.export({ format: "jwk" });
  const jwk = { kty: "EC", crv: "P-256", x: jwkFull.x, y: jwkFull.y };
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  return {
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    jwk,
    thumbprint: base64Url(createHash("sha256").update(canonical, "utf8").digest()),
  };
}

/** node signs DER; the DPoP ES256 signature is raw r||s. */
function derToRaw(der) {
  let offset = 2;
  if (der[1] & 0x80) offset += der[1] & 0x7f;
  const readInt = () => {
    if (der[offset] !== 0x02) throw new Error("Unexpected DER signature shape.");
    const length = der[offset + 1];
    const start = offset + 2;
    offset = start + length;
    let value = der.subarray(start, start + length);
    while (value.length > 32 && value[0] === 0) value = value.subarray(1);
    return Buffer.concat([Buffer.alloc(32 - value.length), value]);
  };
  return Buffer.concat([readInt(), readInt()]);
}

function signProof(key, { method, url, accessToken, nonce }) {
  const header = { typ: "dpop+jwt", alg: "ES256", jwk: key.jwk };
  const payload = {
    jti: randomUUID(),
    htm: method.toUpperCase(),
    htu: url,
    iat: Math.floor(Date.now() / 1000),
  };
  if (nonce) payload.nonce = nonce;
  if (accessToken) payload.ath = base64Url(createHash("sha256").update(accessToken, "ascii").digest());
  const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  const signer = createSign("SHA256");
  signer.update(signingInput);
  return `${signingInput}.${base64Url(derToRaw(signer.sign(key.privateKeyPem)))}`;
}

/**
 * Every request carries a FRESH proof. A retry after a nonce challenge re-signs
 * rather than reusing the proof: the proof id is single-use, the nonce is not.
 */
async function call(state, path, init = {}) {
  const url = `${state.origin}${API_PREFIX}${path}`;
  const method = init.method ?? "GET";
  const send = async (nonce) => fetch(url, {
    method,
    headers: {
      ...(state.accessToken ? { authorization: `DPoP ${state.accessToken}` } : {}),
      dpop: signProof(state.key, { method, url, accessToken: state.accessToken, nonce }),
      ...(init.headers ?? {}),
    },
    body: init.body,
    redirect: "manual",
  });
  let response = await send(state.nonce);
  const challenge = response.headers.get("dpop-nonce");
  if (challenge) state.nonce = challenge;
  if (response.status === 401 && challenge) response = await send(challenge);
  return response;
}

function openBrowser(url) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    spawn(command, [url], { detached: true, stdio: "ignore" }).unref();
  } catch {
    // Opening is a convenience; the URL is printed either way.
  }
}

/**
 * Binds an ephemeral loopback port and resolves with the authorization code.
 * Returns the port immediately so the redirect_uri can name it, and the
 * listener closes as soon as it has an answer or the timeout fires.
 */
async function startCallbackListener(expectedState) {
  const server = createServer();
  let settle;
  const code = new Promise((resolvePromise, rejectPromise) => {
    settle = { resolve: resolvePromise, reject: rejectPromise };
  });
  server.on("request", (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== CALLBACK_PATH) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    res.statusCode = 200;
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end("Connected. You can close this tab and go back to the terminal.");
    const received = url.searchParams.get("code") ?? "";
    const state = url.searchParams.get("state") ?? "";
    server.close();
    if (!received || state !== expectedState) {
      settle.reject(new Error("The callback did not match this connection attempt."));
      return;
    }
    settle.resolve(received);
  });
  const port = await new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolvePromise(typeof address === "object" && address ? address.port : 0);
    });
  });
  const timer = setTimeout(() => {
    server.close();
    settle.reject(new Error("Timed out waiting for the browser to come back."));
  }, 10 * 60_000);
  timer.unref();
  return { port, code: code.finally(() => clearTimeout(timer)) };
}

async function connect(options) {
  const profile = options.profile ?? "default";
  const origin = (options.origin ?? "http://localhost:3000").replace(/\/+$/, "");
  if (/mania-tracker\.com$/.test(new URL(origin).hostname) && options.confirmProduction !== "true") {
    throw new Error("Refusing to connect to production without --confirmProduction true.");
  }
  const key = createKey();
  const verifier = base64Url(createHash("sha256").update(randomUUID()).digest());
  const challenge = base64Url(createHash("sha256").update(verifier, "ascii").digest());
  const state = base64Url(randomUUID());

  // The listener binds first so the redirect_uri can name its real port.
  const listener = await startCallbackListener(state);
  const redirectUri = `http://127.0.0.1:${listener.port}${CALLBACK_PATH}`;

  const authorizeUrl = new URL(`${origin}/companella/authorize`);
  authorizeUrl.searchParams.set("client_id", CLIENT_ID);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("scope", "companella:scores:submit companella:submissions:read companella:charts:upload companella:installation:read");
  authorizeUrl.searchParams.set("dpop_jkt", key.thumbprint);

  console.log(`Open this to approve:\n  ${authorizeUrl}`);
  openBrowser(authorizeUrl.toString());
  const code = await listener.code;

  const tokenState = { origin, key, accessToken: null, nonce: null };
  const response = await call(tokenState, "/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: CLIENT_ID,
      redirect_uri: redirectUri,
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Token exchange failed (${response.status}): ${payload.error ?? "unknown"}`);

  await writeProfile(profile, {
    origin,
    clientId: CLIENT_ID,
    key,
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    accessExpiresAt: Date.now() + (payload.expires_in ?? 300) * 1000,
    installationId: payload.installation_id,
    username: payload.username,
    userId: payload.user_id,
    queue: [],
  });
  console.log(`Connected as ${payload.username} (installation ${payload.installation_id}).`);
}

async function loadState(profile) {
  const stored = await readProfile(profile);
  if (!stored) throw new Error(`No profile "${profile}". Run connect first.`);
  const state = {
    origin: stored.origin,
    key: stored.key,
    accessToken: stored.accessToken,
    nonce: null,
    stored,
    profile,
  };
  // Refresh a little early rather than discovering expiry mid-upload.
  if (Date.now() > stored.accessExpiresAt - 30_000) await refresh(state);
  return state;
}

async function refresh(state) {
  const previous = state.accessToken;
  state.accessToken = null;
  const response = await call(state, "/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ grant_type: "refresh_token", refresh_token: state.stored.refreshToken }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    state.accessToken = previous;
    throw new Error(`Refresh failed (${response.status}): ${payload.error ?? "unknown"}`);
  }
  state.accessToken = payload.access_token;
  state.stored.accessToken = payload.access_token;
  state.stored.accessExpiresAt = Date.now() + (payload.expires_in ?? 300) * 1000;
  // The refresh credential is sender-constrained and not rotated, so the
  // stored one stays valid; re-saving keeps the access token fresh on disk.
  await writeProfile(state.profile, state.stored);
}

async function me(options) {
  const state = await loadState(options.profile ?? "default");
  const response = await call(state, "/me");
  console.log(response.status, JSON.stringify(await response.json().catch(() => ({})), null, 2));
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function md5Hex(bytes) {
  return createHash("md5").update(bytes).digest("hex");
}

async function submit(options) {
  const profile = options.profile ?? "default";
  const state = await loadState(profile);
  if (!options.replay || !options.beatmap) throw new Error("Pass --replay <file.osr> and --beatmap <file.osu>.");
  const replay = await readFile(resolve(options.replay));
  const chart = await readFile(resolve(options.beatmap));

  // The queue entry is written BEFORE the first request and is bound to the
  // account and origin that authorized it. A later connect under a different
  // account must never retarget it.
  const idempotencyKey = options.key ?? `cli-${randomUUID()}`;
  state.stored.queue = [
    ...(state.stored.queue ?? []).filter((item) => item.idempotencyKey !== idempotencyKey),
    {
      idempotencyKey,
      userId: state.stored.userId,
      installationId: state.stored.installationId,
      origin: state.origin,
      replay: resolve(options.replay),
      beatmap: resolve(options.beatmap),
      createdAt: new Date().toISOString(),
    },
  ];
  await writeProfile(profile, state.stored);

  const manifest = {
    protocol_version: 1,
    client_version: "reference-cli-1",
    game_client: "stable",
    capture_kind: "manual_import",
    replay: { sha256: sha256Hex(replay), byte_length: replay.length },
    chart: { md5: md5Hex(chart), sha256: sha256Hex(chart), byte_length: chart.length },
  };

  const reserve = await call(state, "/submissions", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
    body: JSON.stringify(manifest),
  });
  const reservation = await reserve.json().catch(() => ({}));
  if (!reserve.ok) {
    console.error(`Reservation refused (${reserve.status}):`, JSON.stringify(reservation, null, 2));
    process.exitCode = 1;
    return;
  }
  console.log(`Submission ${reservation.submission_id} (${reservation.created ? "new" : "existing"}).`);

  if (reservation.needs_replay) {
    const response = await call(state, `/submissions/${reservation.submission_id}/replay`, {
      method: "PUT", headers: { "content-type": "application/octet-stream" }, body: replay,
    });
    if (!response.ok) {
      console.error(`Replay upload refused (${response.status}):`, await response.text());
      process.exitCode = 1;
      return;
    }
    console.log("Replay uploaded.");
  }
  if (reservation.needs_beatmap) {
    const response = await call(state, `/submissions/${reservation.submission_id}/beatmap`, {
      method: "PUT", headers: { "content-type": "application/octet-stream" }, body: chart,
    });
    if (!response.ok) {
      console.error(`Chart upload refused (${response.status}):`, await response.text());
      process.exitCode = 1;
      return;
    }
    console.log("Chart uploaded.");
  } else {
    console.log("Chart already stored; no transfer needed.");
  }

  const complete = await call(state, `/submissions/${reservation.submission_id}/complete`, { method: "POST" });
  if (!complete.ok) {
    console.error(`Complete refused (${complete.status}):`, await complete.text());
    process.exitCode = 1;
    return;
  }
  console.log("Queued for processing.");
  await poll(state, reservation.submission_id);

  state.stored.queue = (state.stored.queue ?? []).filter((item) => item.idempotencyKey !== idempotencyKey);
  await writeProfile(profile, state.stored);
}

async function poll(state, submissionId) {
  let delay = 1_000;
  for (let attempt = 0; attempt < 15; attempt += 1) {
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.6, 10_000);
    const response = await call(state, `/submissions/${submissionId}`);
    if (!response.ok) continue;
    const receipt = await response.json();
    console.log(`  state: ${receipt.state}`);
    if (["accepted", "rejected", "expired", "deleted"].includes(receipt.state)) {
      console.log(JSON.stringify(receipt, null, 2));
      return;
    }
  }
  console.log("Still processing; check again with the status command.");
}

async function status(options) {
  const state = await loadState(options.profile ?? "default");
  if (!options.submission) throw new Error("Pass --submission <id>.");
  const response = await call(state, `/submissions/${options.submission}`);
  console.log(response.status, JSON.stringify(await response.json().catch(() => ({})), null, 2));
}

async function disconnect(options) {
  const profile = options.profile ?? "default";
  const state = await loadState(profile);
  const response = await call(state, "/oauth/revoke", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: state.stored.refreshToken }),
  });
  console.log(`Revoke: ${response.status}`);
  await writeProfile(profile, { ...state.stored, accessToken: null, refreshToken: null, revoked: true });
}

async function capabilities(options) {
  const origin = (options.origin ?? "http://localhost:3000").replace(/\/+$/, "");
  const response = await fetch(`${origin}${API_PREFIX}/capabilities`);
  console.log(response.status, JSON.stringify(await response.json().catch(() => ({})), null, 2));
}

const { command, options } = parseArgs(process.argv.slice(2));
const commands = { connect, me, submit, status, disconnect, capabilities };
if (!command || !commands[command]) {
  console.log("Commands: connect | me | submit | status | disconnect | capabilities");
  process.exit(command ? 1 : 0);
}
try {
  await commands[command](options);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
