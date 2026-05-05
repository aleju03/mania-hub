import { createContext, useContext } from "react";
import { ANONYMOUS_AUTH_STATE } from "./auth-shared";
import type { AuthState } from "./auth-shared";

export const AuthContext = createContext<AuthState>(ANONYMOUS_AUTH_STATE);

export function useAuth(): AuthState {
  return useContext(AuthContext);
}
