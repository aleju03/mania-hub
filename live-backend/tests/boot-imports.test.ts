import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Guards Phases 3-4 of findings/README.md: the boot module graphs of the
// serving process (http/snapshots.ts) and the worker process (workers.ts) must
// not load the heavy lazily-imported dependencies. Runs the probe script in
// child processes so this test's own module registry can't contaminate the
// measurement (other test files legitimately load jszip, sanitize-html, ...).
describe("boot import graph", () => {
  it("keeps playwright, sharp, jszip, sanitize-html, and the AWS SDK out of both boot graphs", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "src/maintenance/boot-import-probe.ts"],
      { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8", timeout: 120_000 },
    );
    expect(result.stderr).not.toContain("heavy dependencies leaked");
    expect(result.status).toBe(0);

    const reports = result.stdout.trim().split("\n").map((line) => JSON.parse(line) as { entry: string; heavyDepsLoaded: string[] });
    expect(reports.map((report) => report.entry).sort()).toEqual(["src/http/snapshots.ts", "src/workers.ts"]);
    for (const report of reports) {
      expect(report.heavyDepsLoaded).toEqual([]);
    }
  }, 120_000);
});
