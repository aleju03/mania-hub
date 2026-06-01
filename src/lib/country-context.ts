import { createContext } from "react";
import { DEFAULT_INITIAL_SCOPE } from "./country";

// React context that carries the SSR-resolved country (from the request cookie)
// down to client components. The useSelectedCountry hook in src/store.ts prefers
// this context until Zustand persist has rehydrated from localStorage, which
// eliminates the country flash on hard reloads.
export const InitialCountryContext = createContext<string>(DEFAULT_INITIAL_SCOPE);
