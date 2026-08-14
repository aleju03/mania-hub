type ClientIpEnvironment = { TRUST_PROXY_HEADERS?: string };

/* A fetch Request has no socket peer address, so forwarded client identity is
   usable only when the deployment explicitly says its origin is protected by
   a proxy that overwrites cf-connecting-ip. Defaulting this off makes a direct
   origin request share the conservative "unknown" bucket instead of letting a
   caller mint buckets with a forged header. */
export function getAppRateLimitClientIp(
  request: Request,
  environment: ClientIpEnvironment = process.env,
): string {
  if (!/^(1|true|yes|on)$/i.test(environment.TRUST_PROXY_HEADERS?.trim() ?? "")) {
    return "unknown";
  }
  const edgeIp = request.headers.get("cf-connecting-ip");
  if (!edgeIp?.trim()) return "unknown";
  return normalizeIp(edgeIp);
}

function normalizeIp(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("::ffff:") ? trimmed.slice(7) : trimmed || "unknown";
}
