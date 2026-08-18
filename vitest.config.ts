import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

// Without this file vitest loads vite.config.ts, and the tanstackStart plugin
// breaks react-dom rendering in component tests (hooks dispatcher resolves to
// null). Tests only need the source aliases; "#/*" already resolves through
// the package.json imports field, "@/*" only exists as a tsconfig path.
//
// "#dan/*" and "#leoblack/*" reach the dan estimator and the vendored LeoBlack
// tree, which are single copies owned by live-backend (the backend compiles
// with rootDir "src", so shared sources cannot live outside it without moving
// the dist layout prod runs from). vite.config.ts picks these up through
// vite-tsconfig-paths; this file has to spell them out because it deliberately
// does not load that config.
const src = fileURLToPath(new URL("./src", import.meta.url));
const dan = fileURLToPath(new URL("./live-backend/src/dan", import.meta.url));
const leoblack = fileURLToPath(new URL("./live-backend/vendor/leoblack", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^#dan\//, replacement: `${dan}/` },
      { find: /^#leoblack\//, replacement: `${leoblack}/` },
      { find: /^#\//, replacement: `${src}/` },
      { find: /^@\//, replacement: `${src}/` },
    ],
  },
});
