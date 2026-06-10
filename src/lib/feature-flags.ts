function envFlagEnabled(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value !== "string") return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export function isPacksFeatureEnabled(): boolean {
  return envFlagEnabled(import.meta.env.VITE_DEV_MODE);
}
