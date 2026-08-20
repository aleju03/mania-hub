import { createContext, useContext } from "react";
import { type AppLocale, DEFAULT_LOCALE } from "./locale";

// Carries the request-resolved locale (from the mania-hub-locale cookie) down
// to client components, mirroring InitialCountryContext. Unlike country there
// is no store copy to reconcile after hydration: the cookie is the single
// source of truth and the locale only changes through a router invalidation,
// so this context is always current and needs no hydration gate.
export const LocaleContext = createContext<AppLocale>(DEFAULT_LOCALE);

export function useLocale(): AppLocale {
  return useContext(LocaleContext);
}
