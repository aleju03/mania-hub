import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, migrate } from "../src/db.js";
import { adoptJournalFromMain, ensureJournalSchema } from "../src/journal.js";

// Booting src/server.ts *as an entrypoint* is the only way to exercise its
// top-level-await block: `import.meta.url === file://${process.argv[1]}` is
// false under vitest (argv[1] is the vitest worker), so importing the module
// from a test runs createApp() never — and, worse, initializes every
// module-level const before anything can read it. A const declared BELOW that
// block but read from inside createApp() (waitForSchema's default parameter is
// exactly that shape) therefore throws "Cannot access X before initialization"
// in production only: module evaluation suspends at `await createApp()`, so it
// never reaches the declaration, and the reference is evaluated on the microtask
// queue while the binding is still in its temporal dead zone. Nothing catches
// it, so the process exits 1 before listen() — the site is down and systemd
// crash-loops it while the worker role (which never calls waitForSchema) keeps
// ingesting, so every dashboard looks healthy. This test is the only guard.
describe("server entrypoint boot", () => {
  it("reaches listen() in the server role instead of dying in module evaluation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mania-live-boot-"));
    const port = await freePort();
    let child: ReturnType<typeof spawn> | null = null;
    try {
      // The server role waits for a worker to create the schema, so migrate the
      // scratch database here: the child must get past waitForSchema and listen.
      const db = await createDb({ databaseUrl: `file:${join(dir, "boot.db")}`, sqliteCacheMb: 2, sqliteMmapMb: 0 });
      await migrate(db);
      // Same for the journal: a server-role process waits for the worker's
      // one-time adoption too.
      const journal = await createDb({ databaseUrl: `file:${join(dir, "journal.db")}`, sqliteCacheMb: 2, sqliteMmapMb: 0 });
      await ensureJournalSchema(journal);
      await adoptJournalFromMain(db, journal);
      journal.close();
      db.close();

      child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          // No --env-file: the child must not pick up the developer's .env (and
          // its DATABASE_URL pointing at the real, dev-server-held database).
          DATABASE_URL: `file:${join(dir, "boot.db")}`,
          ANALYTICS_DATABASE_URL: `file:${join(dir, "analytics.db")}`,
          JOURNAL_DATABASE_URL: `file:${join(dir, "journal.db")}`,
          LIVE_BACKEND_ROLE: "server",
          PORT: String(port),
          NODE_ENV: "test",
          LIVE_ADMIN_TOKEN: "entrypoint-boot-test-token",
          ENABLE_WORKERS: "0",
          ENABLE_SCHEDULED_REFRESHES: "0",
          ENABLE_OSC_SOCKET: "0",
          ENABLE_OSC_BACKFILL: "0",
          ENABLE_OSU_SCORES_FALLBACK: "0",
          ENABLE_DISCORD_BOT: "0",
          ENABLE_DISCORD_FEEDS: "0",
          ENABLE_EVENT_LOG_TAIL: "0",
        },
      });

      const { output, exitCode } = await waitForListening(child, 60_000);
      // A ReferenceError here is the temporal-dead-zone regression above; any
      // other non-zero exit is still a boot the deploy could not survive.
      expect(output).not.toMatch(/ReferenceError/);
      expect(exitCode).toBeNull();
      expect(output).toContain(`listening on`);
      expect(output).toContain(`role server`);
    } finally {
      if (child) await killChild(child);
      await rm(dir, { recursive: true, force: true });
    }
  }, 90_000);
});

// Resolves as soon as the child says it is listening, or as soon as it exits
// (which is the failure this test exists to catch), or on timeout.
function waitForListening(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<{ output: string; exitCode: number | null }> {
  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ output, exitCode });
    };
    const timer = setTimeout(() => finish(child.exitCode), timeoutMs);
    const onChunk = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("listening on")) finish(null);
    };
    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);
    // exitCode is null while the process runs; capture the real code here so a
    // crash-on-boot is reported as an exit, not as "still running".
    child.on("exit", (code) => finish(code ?? 1));
    child.on("error", () => finish(child.exitCode ?? 1));
  });
}

async function killChild(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGKILL");
  await exited;
}

// A port the OS just handed out and released: close enough to "unused" for a
// single short-lived child, and never a port the developer's servers hold.
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => (port > 0 ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}
