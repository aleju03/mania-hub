// Local-dev admin/dev-feature access must be opted into explicitly via
// ENABLE_LOCAL_DEV_ADMIN and only ever applies to loopback requests;
// NODE_ENV alone must never grant access.
export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]" ||
    normalized.endsWith(".localhost")
  );
}

export interface LocalDevAccessInput {
  nodeEnv: string | undefined;
  localDevSwitch: string | undefined;
  hostname: string;
}

export function isLocalDevAccessGranted(input: LocalDevAccessInput): boolean {
  if (input.nodeEnv === "production") return false;
  const flag = (input.localDevSwitch ?? "").trim().toLowerCase();
  if (flag !== "1" && flag !== "true") return false;
  return isLoopbackHostname(input.hostname);
}
