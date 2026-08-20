import { StrictMode, startTransition } from "react";
import { hydrateRoot } from "react-dom/client";
import { StartClient } from "@tanstack/react-start/client";
import { track } from "./lib/analytics";
import { installDomTranslateGuard } from "./lib/dom-translate-guard";
import { loadLocaleCatalog } from "./lib/i18n";
import { readLocaleCookieClient } from "./lib/locale-cookie";
import { DEFAULT_LOCALE, normalizeLocale } from "./lib/locale";
import { reapplyThemeToDom } from "./store";

// Must run before hydration so every React commit goes through the patched
// removeChild/insertBefore (see dom-translate-guard.ts).
installDomTranslateGuard();

// The visitor's catalog has to be registered before hydration: the server
// rendered translated text, and hydrating over it with source strings would
// mismatch. Cookie first, then the server-rendered lang attribute
// (cookies-disabled fallback), same resolution order as __root.tsx.
const initialLocale =
  readLocaleCookieClient() ?? normalizeLocale(document.documentElement.lang) ?? DEFAULT_LOCALE;

// Mirrors @tanstack/react-start's default client entry
// (node_modules/@tanstack/react-start/src/default-entry/client.tsx), plus an
// onRecoverableError hook. When hydration mismatches force React to fall back
// to client rendering, it re-acquires the <html> singleton and resets its
// attributes, stripping the theme vars the pre-hydration script painted (see
// reapplyThemeToDom in store.ts). The mismatch only reproduces in production,
// so the component stack reported here is the signal for which node caused it.
// finally, not then: a failed catalog fetch (flaky network, stale chunk) must
// still hydrate the page - it just hydrates with source-English strings, which
// for a zh visitor mismatches and recovers via the client render below.
void loadLocaleCatalog(initialLocale).finally(() => {
  startTransition(() => {
    hydrateRoot(
      document,
      <StrictMode>
        <StartClient />
      </StrictMode>,
      {
        onRecoverableError(error, errorInfo) {
          const message =
            error instanceof Error ? error.message : String(error);
          console.error("[recoverable]", error, errorInfo.componentStack);
          track("react_recoverable_error", {
            message: message.slice(0, 500),
            component_stack: errorInfo.componentStack?.slice(0, 3000) ?? null,
          });
          reapplyThemeToDom();
        },
      },
    );
  });
});
