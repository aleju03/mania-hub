import { StrictMode, startTransition } from "react";
import { hydrateRoot } from "react-dom/client";
import { StartClient } from "@tanstack/react-start/client";
import { track } from "./lib/posthog";
import { reapplyThemeToDom } from "./store";

// Mirrors @tanstack/react-start's default client entry
// (node_modules/@tanstack/react-start/src/default-entry/client.tsx), plus an
// onRecoverableError hook. When hydration mismatches force React to fall back
// to client rendering, it re-acquires the <html> singleton and resets its
// attributes, stripping the theme vars the pre-hydration script painted (see
// reapplyThemeToDom in store.ts). The mismatch only reproduces in production,
// so the component stack reported here is the signal for which node caused it.
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
