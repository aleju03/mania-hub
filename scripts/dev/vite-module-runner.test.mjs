import { afterEach, describe, expect, it } from "vitest";
import { ModuleRunner } from "vite/module-runner";

// Exercise the installed runner used by Nitro, without starting a dev server.
// Gates reproduce the concurrent module evaluations behind Vite #22369/#23009.
// Adapted from Vite's regression fixtures (MIT); see VITE-LICENSE.txt.
const runners = [];
afterEach(async () => {
  await Promise.all(runners.splice(0).map((runner) => runner.close()));
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function createRunner(modules) {
  const runner = new ModuleRunner({
    hmr: false,
    sourcemapInterceptor: false,
    transport: {
      async invoke({ data: { name, data } }) {
        if (name === "getBuiltins") return { result: [] };
        const [id] = data;
        if (!modules[id]) throw new Error(`Unknown fixture ${id}`);
        return { result: { id, url: id, file: id, code: id, invalidate: false } };
      },
    },
  }, {
    async runInlinedModule(context, id) {
      await modules[id]({
        load: context.__vite_ssr_import__,
        exports: context.__vite_ssr_exports__,
        exportAll: context.__vite_ssr_exportAll__,
      });
    },
    async runExternalModule(id) { throw new Error(`Unexpected external module ${id}`); },
  });
  runners.push(runner);
  return runner;
}

function invalidate(runner, ...ids) {
  for (const id of ids) {
    runner.evaluatedModules.invalidateModule(runner.evaluatedModules.getModuleById(id));
  }
}

async function waitForImport(runner, from, to) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (runner.evaluatedModules.getModuleById(from)?.imports.has(to)) return;
    await new Promise(setImmediate);
  }
  throw new Error(`Fixture never imported ${to} from ${from}`);
}

describe("Vite SSR hot reload", () => {
  it("keeps re-exported functions callable across concurrent reloads and real cycles", async () => {
    let wait = async () => {};
    const runner = createRunner({
      "/core": async ({ exports }) => {
        await wait();
        exports.createThing = (value) => value;
      },
      "/shared": async ({ load, exportAll }) => {
        await load("/a"); // A real cycle still needs partial exports to avoid deadlock.
        exportAll(await load("/core"));
      },
      "/a": async ({ load, exports }) => {
        exports.result = (await load("/shared")).createThing("a");
      },
      "/b": async ({ load, exports }) => {
        exports.result = (await load("/shared")).createThing("b");
      },
    });
    expect((await runner.import("/a")).result).toBe("a");
    expect((await runner.import("/b")).result).toBe("b");

    for (let round = 0; round < 10; round++) {
      const started = deferred();
      const release = deferred();
      wait = () => { started.resolve(); return release.promise; };
      invalidate(runner, "/a", "/b", "/shared", "/core");
      const a = runner.import("/a");
      await started.promise;
      const b = runner.import("/b");
      const results = Promise.allSettled([a, b]);
      try {
        await waitForImport(runner, "/b", "/shared");
      } finally {
        release.resolve();
      }
      expect(await results).toEqual([
        { status: "fulfilled", value: expect.objectContaining({ result: "a" }) },
        { status: "fulfilled", value: expect.objectContaining({ result: "b" }) },
      ]);
    }
  });

  it("waits for named exports when a completed dependency remains in an older callstack", async () => {
    let wait = async () => {};
    let importShared = async () => false;
    const runner = createRunner({
      "/evaluated": async ({ load, exports }) => {
        exports.value = await importShared() ? (await load("/shared")).value : undefined;
      },
      "/shared": async ({ load, exports }) => {
        await load("/evaluated");
        await wait();
        exports.value = "ready";
      },
    });
    await runner.import("/shared");
    const sharedStarted = deferred();
    const releaseShared = deferred();
    const olderStarted = deferred();
    const releaseOlder = deferred();
    wait = () => { sharedStarted.resolve(); return releaseShared.promise; };
    let calls = 0;
    importShared = async () => {
      if (calls++ > 0) return false;
      olderStarted.resolve();
      await releaseOlder.promise;
      return true;
    };
    invalidate(runner, "/shared");
    const shared = runner.import("/shared");
    await sharedStarted.promise;
    invalidate(runner, "/evaluated");
    const older = runner.import("/evaluated");
    await olderStarted.promise;
    // Another HMR pass finishes this dependency while the earlier one is paused.
    invalidate(runner, "/evaluated");
    await runner.import("/evaluated");
    releaseOlder.resolve();
    try {
      await waitForImport(runner, "/evaluated", "/shared");
      await new Promise(setImmediate);
    } finally {
      releaseShared.resolve();
    }
    expect((await shared).value).toBe("ready");
    expect((await older).value).toBe("ready");
  });
});
