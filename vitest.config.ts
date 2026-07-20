import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

// Without this file vitest loads vite.config.ts, and the tanstackStart plugin
// breaks react-dom rendering in component tests (hooks dispatcher resolves to
// null). Tests only need the source aliases; "#/*" already resolves through
// the package.json imports field, "@/*" only exists as a tsconfig path.
const src = fileURLToPath(new URL("./src", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^#\//, replacement: `${src}/` },
      { find: /^@\//, replacement: `${src}/` },
    ],
  },
});
