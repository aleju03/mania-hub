import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { createInterface } from "node:readline";
import { ensureDevCert } from "./dev-certs.mjs";

// `--host` (or `--lan`) exposes the stack on the local network so phones and
// other devices can open it. That needs three things, not just vite --host:
// the backend origin the browser talks to must be the LAN IP, and the backend
// has to accept that origin for CORS/SSE.
const args = process.argv.slice(2);
const lanMode = args.some((arg) => arg === "--host" || arg === "--lan");

// LAN mode serves https by default: http://192.168.x.x is not a secure context,
// so browsers there hide crypto.randomUUID, crypto.subtle, WebCodecs, service
// workers and the clipboard API, and the app dies on the first of those it
// touches. `--no-https` opts back out.
const httpsMode = lanMode && !args.includes("--no-https");

// The backend is reverse-proxied under this path on the frontend origin so the
// https page is not making blocked plain-http requests to :7227.
const backendProxyPrefix = "/__live";

function readEnvFile(path) {
  const values = {};

  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!match) continue;
      values[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
    }
  } catch {
    // no .env is fine, defaults below cover it
  }

  return values;
}

function lanAddress() {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== "IPv4" || address.internal) continue;
      if (address.address.startsWith("169.254.")) continue;
      return address.address;
    }
  }

  return null;
}

const rootEnv = readEnvFile(new URL("../../.env", import.meta.url));
const backendEnv = readEnvFile(new URL("../../live-backend/.env", import.meta.url));
const frontendPort = process.env.PORT ?? "3000";
const backendPort = process.env.LIVE_BACKEND_PORT ?? backendEnv.PORT ?? "7227";

const lanIp = lanMode ? lanAddress() : null;

if (lanMode && !lanIp) {
  process.stderr.write("no non-internal IPv4 address found, cannot expose on the LAN\n");
  process.exit(1);
}

const frontendEnvOverrides = {};
const backendEnvOverrides = {};
const frontendOrigin = lanIp ? `${httpsMode ? "https" : "http"}://${lanIp}:${frontendPort}` : null;
let devCert = null;

if (lanIp) {
  // Only rewrite a loopback backend URL; a tunnel/remote value is left alone.
  const backendUrl = process.env.VITE_LIVE_BACKEND_URL ?? rootEnv.VITE_LIVE_BACKEND_URL ?? "";
  const backendIsLocal = !backendUrl || /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(backendUrl);

  if (httpsMode) {
    devCert = ensureDevCert(["localhost", "127.0.0.1", lanIp]);
    frontendEnvOverrides.DEV_HTTPS_KEY = devCert.keyPath;
    frontendEnvOverrides.DEV_HTTPS_CERT = devCert.certPath;
  }

  if (backendIsLocal && httpsMode) {
    // The browser reaches the backend through the frontend origin, so there is
    // no mixed content and no second cert to accept. SSR keeps talking to the
    // backend directly over loopback.
    frontendEnvOverrides.DEV_LIVE_BACKEND_PROXY = `http://127.0.0.1:${backendPort}`;
    frontendEnvOverrides.DEV_LIVE_BACKEND_PROXY_PREFIX = backendProxyPrefix;
    frontendEnvOverrides.VITE_LIVE_BACKEND_URL = `${frontendOrigin}${backendProxyPrefix}`;
    frontendEnvOverrides.LIVE_BACKEND_URL = `http://127.0.0.1:${backendPort}`;
  } else if (backendIsLocal) {
    frontendEnvOverrides.VITE_LIVE_BACKEND_URL = `http://${lanIp}:${backendPort}`;
  }

  const configuredOrigins = (
    process.env.ALLOWED_ORIGINS ??
    backendEnv.ALLOWED_ORIGINS ??
    `http://localhost:${frontendPort}`
  )
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  backendEnvOverrides.ALLOWED_ORIGINS = [
    ...new Set([
      ...configuredOrigins,
      `http://localhost:${frontendPort}`,
      `http://127.0.0.1:${frontendPort}`,
      frontendOrigin,
    ]),
  ].join(",");
}

const commands = [
  {
    name: "frontend",
    color: "\x1b[36m",
    command: "npm",
    args: lanIp ? ["run", "dev", "--", "--host"] : ["run", "dev"],
    env: frontendEnvOverrides,
  },
  {
    name: "backend",
    color: "\x1b[35m",
    command: "npm",
    args: ["--prefix", "live-backend", "run", "dev:watch"],
    env: backendEnvOverrides,
  },
];

if (lanIp) {
  const banner = "\x1b[32m[dev:all]\x1b[0m";
  const backendNote = frontendEnvOverrides.DEV_LIVE_BACKEND_PROXY
    ? `backend proxied at ${frontendOrigin}${backendProxyPrefix}`
    : `backend http://${lanIp}:${backendPort}`;
  process.stdout.write(`${banner} network: frontend ${frontendOrigin} | ${backendNote}\n`);

  if (devCert?.tool === "openssl") {
    process.stdout.write(
      `${banner} self-signed cert: the phone shows a warning once, tap Advanced -> Proceed. ` +
        `Install mkcert for warning-free https.\n`,
    );
  } else if (devCert?.tool === "mkcert") {
    process.stdout.write(
      `${banner} mkcert cert: install the root CA (mkcert -CAROOT) on the phone once for warning-free https.\n`,
    );
  }
}

const reset = "\x1b[0m";
const children = new Set();
let shuttingDown = false;

function prefixOutput(child, streamName, command) {
  const lineReader = createInterface({ input: child[streamName] });

  lineReader.on("line", (line) => {
    const output = streamName === "stderr" ? process.stderr : process.stdout;
    output.write(`${command.color}[${command.name}]${reset} ${line}\n`);
  });
}

function stopAll(signal = "SIGTERM") {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  for (const child of children) {
    if (!child.killed) {
      child.kill(signal);
    }
  }
}

for (const command of commands) {
  const child = spawn(command.command, command.args, {
    cwd: process.cwd(),
    env: { ...process.env, ...command.env },
    stdio: ["inherit", "pipe", "pipe"],
  });

  children.add(child);
  prefixOutput(child, "stdout", command);
  prefixOutput(child, "stderr", command);

  child.on("exit", (code, signal) => {
    children.delete(child);

    if (!shuttingDown) {
      const reason = signal ? `signal ${signal}` : `exit code ${code}`;
      const output = code === 0 ? process.stdout : process.stderr;
      output.write(`${command.color}[${command.name}]${reset} stopped with ${reason}\n`);
      stopAll();
      process.exitCode = code ?? 1;
    }

    if (children.size === 0) {
      process.exit(process.exitCode);
    }
  });
}

process.on("SIGINT", () => stopAll("SIGINT"));
process.on("SIGTERM", () => stopAll("SIGTERM"));
