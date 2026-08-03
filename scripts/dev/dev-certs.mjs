import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Dev-only TLS material for `dev:all:host`. Phones reach the stack over a LAN
// IP, and http://192.168.x.x is not a secure context, so crypto.randomUUID,
// crypto.subtle, WebCodecs and friends are simply missing there. Serving dev
// over https fixes the whole class at once.
const certDir = fileURLToPath(new URL("../../.dev-certs/", import.meta.url));
const keyPath = `${certDir}dev-key.pem`;
const certPath = `${certDir}dev-cert.pem`;
const metaPath = `${certDir}meta.json`;

// Well under the 825-day cap Safari enforces, and short enough that a stale
// cert rotates on its own.
const CERT_DAYS = 365;
const MAX_AGE_MS = 300 * 24 * 60 * 60 * 1000;

function hasMkcert() {
  try {
    execFileSync("mkcert", ["-CAROOT"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function readMeta() {
  try {
    return JSON.parse(readFileSync(metaPath, "utf8"));
  } catch {
    return null;
  }
}

function isReusable(meta, hosts, tool) {
  if (!meta || meta.tool !== tool) return false;
  if (!Array.isArray(meta.hosts) || meta.hosts.join(",") !== hosts.join(",")) return false;
  if (typeof meta.createdAt !== "number" || Date.now() - meta.createdAt > MAX_AGE_MS) return false;
  return existsSync(keyPath) && existsSync(certPath);
}

// Both generators are chatty on stderr even when they succeed (openssl prints
// key-generation progress dots), so output is only surfaced on failure.
function run(command, commandArgs) {
  try {
    execFileSync(command, commandArgs, { stdio: ["ignore", "ignore", "pipe"] });
  } catch (error) {
    const details = error?.stderr?.toString().trim();
    throw new Error(`${command} failed generating the dev cert${details ? `: ${details}` : ""}`);
  }
}

function generateWithMkcert(hosts) {
  run("mkcert", ["-key-file", keyPath, "-cert-file", certPath, ...hosts]);
}

function generateWithOpenssl(hosts) {
  const sans = hosts
    .map((host) => (/^[0-9.]+$/.test(host) || host.includes(":") ? `IP:${host}` : `DNS:${host}`))
    .join(",");

  run("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-sha256",
    "-days",
    String(CERT_DAYS),
    "-nodes",
    "-keyout",
    keyPath,
    "-out",
    certPath,
    "-subj",
    "/CN=mania-hub dev",
    // iOS/Android only accept a cert for a host listed in the SAN, and only
    // with an explicit serverAuth usage. A bare CN is not enough.
    "-addext",
    `subjectAltName=${sans}`,
    "-addext",
    "basicConstraints=critical,CA:FALSE",
    "-addext",
    "keyUsage=critical,digitalSignature,keyEncipherment",
    "-addext",
    "extendedKeyUsage=serverAuth",
  ]);
}

/**
 * Returns paths to a key/cert pair covering `hosts`, generating one if the
 * cached pair is missing, stale, or covers a different set of hosts.
 *
 * Uses mkcert when it is on PATH (its CA can be installed on the phone once for
 * warning-free https) and falls back to a self-signed openssl cert otherwise,
 * which still yields a secure context after clicking through the interstitial.
 */
export function ensureDevCert(hosts) {
  const tool = hasMkcert() ? "mkcert" : "openssl";
  const meta = readMeta();

  if (isReusable(meta, hosts, tool)) {
    return { keyPath, certPath, tool, created: false };
  }

  mkdirSync(certDir, { recursive: true });

  if (tool === "mkcert") generateWithMkcert(hosts);
  else generateWithOpenssl(hosts);

  writeFileSync(metaPath, `${JSON.stringify({ tool, hosts, createdAt: Date.now() }, null, 2)}\n`);

  return { keyPath, certPath, tool, created: true };
}
