import { createServerFn } from "@tanstack/react-start";
import type { AuthState } from "./auth-shared";

export const getCurrentAuth = createServerFn({ method: "GET" }).handler(async (): Promise<AuthState> => {
  const { getCurrentAuthHandler } = await import("./auth-server");
  return getCurrentAuthHandler();
});

export async function requireDevFeatureAccess(action: string): Promise<void> {
  const { requireDevFeatureAccess: requireAccess } = await import("./auth-server");
  await requireAccess(action);
}

export async function requireAdminAccess(action: string): Promise<void> {
  const { requireAdminAccess: requireAccess } = await import("./auth-server");
  await requireAccess(action);
}

export async function requireTrueAdminAccess(action: string): Promise<void> {
  const { requireTrueAdminAccess: requireAccess } = await import("./auth-server");
  await requireAccess(action);
}
