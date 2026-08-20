import { defineConfig } from "@lingui/cli";
import { formatter } from "@lingui/format-po";

// English is the source language and lives inline in the components; catalogs
// are extracted from the macros with `npm run i18n:extract` and compiled to
// TypeScript with `npm run i18n:compile`. Both the .po files and the compiled
// messages.ts are committed (same convention as regions.generated.ts) so tsc,
// vitest and vite build all work without an extra build step.
export default defineConfig({
  sourceLocale: "en",
  locales: ["en", "zh-CN"],
  catalogs: [
    {
      path: "<rootDir>/src/locales/{locale}/messages",
      include: ["src"],
      // Admin surfaces stay English (the two public pages under /admin,
      // dan-classifier and og-preview, get re-included when translation
      // reaches them). Exclusion is belt-and-braces: extract only sees
      // macro usage, so untouched files contribute nothing either way.
      exclude: ["**/*.test.*", "**/node_modules/**", "src/routes/admin/**", "src/locales/**"],
    },
  ],
  // Line numbers churn every extract at this codebase's edit rate; file
  // origins alone are enough to find a message.
  format: formatter({ origins: true, lineNumbers: false }),
  compileNamespace: "ts",
});
