import { createContext, useContext } from "react";
import { ANONYMOUS_AUTH_STATE } from "./auth-shared";
import type { AuthState } from "./auth-shared";

export const AuthContext = createContext<AuthState>(ANONYMOUS_AUTH_STATE);

// The provider's value is the root route context's `auth`, which can arrive
// undefined (a stale tab whose getCurrentAuth server-fn call resolved to
// nothing, a dehydrated payload without the key). Every caller reads a field
// straight off this, so an undefined here is a hard "Something broke" page --
// fall back to anonymous and let the page render.
export function useAuth(): AuthState {
  return useContext(AuthContext) ?? ANONYMOUS_AUTH_STATE;
}
