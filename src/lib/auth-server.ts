import { getCookie, getRequest, setResponseHeader } from "@tanstack/react-start/server";
import {
  AUTH_COOKIE_MAX_AGE_SECONDS,
  AUTH_COOKIE_NAME,
  AUTH_STATE_COOKIE_MAX_AGE_SECONDS,
  AUTH_STATE_COOKIE_NAME,
  ANONYMOUS_AUTH_STATE,
} from "./auth-shared";
import type { AuthState, AuthViewer } from "./auth-shared";

const DEFAULT_DEV_OSU_USER_IDS = [19230890];
const DEFAULT_ADMIN_OSU_USER_IDS = [7095193];
const OSU_API_VERSION = "20220705";
const OSU_OAUTH_TIMEOUT_MS = 10_000;
const COOKIE_PATH = "/";

interface AuthCookiePayload extends AuthViewer {
  issuedAt: number;
  expiresAt: number;
}

interface OAuthStatePayload {
  state: string;
  next: string;
  redirectUri: string;
  issuedAt: number;
}

interface OsuTokenResponse {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
}

interface OsuMeResponse {
  id?: number;
  username?: string;
  avatar_url?: string;
  country_code?: string;
}

type SameSite = "lax" | "strict" | "none";

interface CookieOptions {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: SameSite;
  path?: string;
  maxAge?: number;
  expires?: Date;
}

function getAuthSecret(): string {
  const secret = process.env.AUTH_SESSION_SECRET ?? process.env.OSU_CLIENT_SECRET ?? "";
  if (secret.length < 32) {
    throw new Error("Set AUTH_SESSION_SECRET or OSU_CLIENT_SECRET to at least 32 characters.");
  }
  return secret;
}

function parseUserIdSet(raw: string | undefined, defaults: number[]): Set<number> {
  const ids = new Set(defaults);
  for (const part of (raw ?? "").split(",")) {
    const id = Number(part.trim());
    if (Number.isSafeInteger(id) && id > 0) ids.add(id);
  }
  return ids;
}

function getDevUserIds(): Set<number> {
  return parseUserIdSet(process.env.DEV_ACCESS_OSU_USER_IDS, DEFAULT_DEV_OSU_USER_IDS);
}

function getAdminUserIds(): Set<number> {
  return parseUserIdSet(process.env.ADMIN_OSU_USER_IDS, DEFAULT_ADMIN_OSU_USER_IDS);
}

function isLocalDevRequest(): boolean {
  return process.env.NODE_ENV !== "production";
}

function requestHostname(request = getRequest()): string {
  try {
    return new URL(request.url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function isLoginSuggestedHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "ninja.mania-tracker.com" ||
    hostname.endsWith(".mania-tracker.com")
  );
}

function buildAuthState(viewer: AuthViewer | null, request = getRequest()): AuthState {
  const devUserIds = getDevUserIds();
  const adminUserIds = getAdminUserIds();
  const isLocalDev = isLocalDevRequest();
  const isAdmin = !!viewer && adminUserIds.has(viewer.id);
  const isAllowedDevUser = !!viewer && (devUserIds.has(viewer.id) || isAdmin);
  const loginAvailable = Boolean(process.env.OSU_CLIENT_ID && process.env.OSU_CLIENT_SECRET);
  const hostname = requestHostname(request);

  return {
    viewer,
    canUseDevFeatures: isLocalDev || isAllowedDevUser,
    canUseAdminFeatures: isLocalDev || isAdmin,
    loginAvailable,
    loginSuggested: loginAvailable && (Boolean(viewer) || isLocalDev || process.env.VITE_DEV_MODE === "1" || isLoginSuggestedHost(hostname)),
  };
}

function base64UrlEncode(value: string | Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function base64UrlDecode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

async function hmac(value: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(getAuthSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return base64UrlEncode(new Uint8Array(signature));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function signJson(value: unknown): Promise<string> {
  const payload = base64UrlEncode(JSON.stringify(value));
  const signature = await hmac(payload);
  return `${payload}.${signature}`;
}

async function verifySignedJson<T>(raw: string | undefined): Promise<T | null> {
  if (!raw) return null;
  const [payload, signature, extra] = raw.split(".");
  if (!payload || !signature || extra != null) return null;
  const expected = await hmac(payload);
  if (!timingSafeEqual(signature, expected)) return null;
  try {
    return JSON.parse(base64UrlDecode(payload)) as T;
  } catch {
    return null;
  }
}

function isAuthCookiePayload(value: unknown): value is AuthCookiePayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const payload = value as Partial<AuthCookiePayload>;
  return (
    Number.isSafeInteger(payload.id) &&
    typeof payload.username === "string" &&
    payload.username.length > 0 &&
    typeof payload.avatarUrl === "string" &&
    (payload.countryCode === null || typeof payload.countryCode === "string") &&
    typeof payload.issuedAt === "number" &&
    typeof payload.expiresAt === "number"
  );
}

async function readViewerFromCookie(raw = getCookie(AUTH_COOKIE_NAME)): Promise<AuthViewer | null> {
  const payload = await verifySignedJson<unknown>(raw);
  if (!isAuthCookiePayload(payload)) return null;
  if (payload.expiresAt <= Date.now()) return null;
  return {
    id: payload.id,
    username: payload.username,
    avatarUrl: payload.avatarUrl,
    countryCode: payload.countryCode,
  };
}

export async function readCurrentAuth(): Promise<AuthState> {
  const request = getRequest();
  try {
    return buildAuthState(await readViewerFromCookie(), request);
  } catch {
    return { ...ANONYMOUS_AUTH_STATE, loginAvailable: Boolean(process.env.OSU_CLIENT_ID && process.env.OSU_CLIENT_SECRET) };
  }
}

export async function getCurrentAuthHandler(): Promise<AuthState> {
  setResponseHeader("Cache-Control", "private, no-store");
  return readCurrentAuth();
}

export async function requireDevFeatureAccess(action: string): Promise<void> {
  const auth = await readCurrentAuth();
  if (!auth.canUseDevFeatures) {
    throw new Error(`${action} is only available to authorized dev users.`);
  }
}

export async function requireAdminAccess(action: string): Promise<void> {
  const auth = await readCurrentAuth();
  if (!auth.canUseAdminFeatures) {
    throw new Error(`${action} is only available to admins.`);
  }
}

function serializeCookie(name: string, value: string, options: CookieOptions): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (options.maxAge != null) parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
  if (options.path) parts.push(`Path=${options.path}`);
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  if (options.sameSite) {
    const sameSite = options.sameSite.charAt(0).toUpperCase() + options.sameSite.slice(1);
    parts.push(`SameSite=${sameSite}`);
  }
  return parts.join("; ");
}

function shouldUseSecureCookie(request: Request): boolean {
  try {
    return new URL(request.url).protocol === "https:" || process.env.NODE_ENV === "production";
  } catch {
    return process.env.NODE_ENV === "production";
  }
}

function authCookieOptions(request: Request, maxAge: number): CookieOptions {
  return {
    httpOnly: true,
    secure: shouldUseSecureCookie(request),
    sameSite: "lax",
    path: COOKIE_PATH,
    maxAge,
  };
}

export async function createAuthCookieHeader(viewer: AuthViewer, request: Request): Promise<string> {
  const now = Date.now();
  const payload: AuthCookiePayload = {
    ...viewer,
    issuedAt: now,
    expiresAt: now + AUTH_COOKIE_MAX_AGE_SECONDS * 1000,
  };
  return serializeCookie(
    AUTH_COOKIE_NAME,
    await signJson(payload),
    authCookieOptions(request, AUTH_COOKIE_MAX_AGE_SECONDS),
  );
}

export function clearAuthCookieHeader(request: Request): string {
  return serializeCookie(AUTH_COOKIE_NAME, "", {
    ...authCookieOptions(request, 0),
    expires: new Date(0),
  });
}

export async function createOAuthStateCookieHeader(payload: OAuthStatePayload, request: Request): Promise<string> {
  return serializeCookie(
    AUTH_STATE_COOKIE_NAME,
    await signJson(payload),
    authCookieOptions(request, AUTH_STATE_COOKIE_MAX_AGE_SECONDS),
  );
}

export async function readOAuthStateCookie(raw: string | undefined): Promise<OAuthStatePayload | null> {
  const payload = await verifySignedJson<unknown>(raw);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const state = payload as Partial<OAuthStatePayload>;
  if (
    typeof state.state !== "string" ||
    typeof state.next !== "string" ||
    typeof state.redirectUri !== "string" ||
    typeof state.issuedAt !== "number"
  ) {
    return null;
  }
  if (Date.now() - state.issuedAt > AUTH_STATE_COOKIE_MAX_AGE_SECONDS * 1000) return null;
  return {
    state: state.state,
    next: state.next,
    redirectUri: state.redirectUri,
    issuedAt: state.issuedAt,
  };
}

export function clearOAuthStateCookieHeader(request: Request): string {
  return serializeCookie(AUTH_STATE_COOKIE_NAME, "", {
    ...authCookieOptions(request, 0),
    expires: new Date(0),
  });
}

export function getAuthRedirectUri(request: Request): string {
  const url = new URL(request.url);
  return `${url.origin}/api/auth/osu/callback`;
}

export function normalizeAuthNext(value: string | null | undefined, request: Request): string {
  if (!value) return "/";
  try {
    const url = new URL(value, new URL(request.url).origin);
    if (url.origin !== new URL(request.url).origin) return "/";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}

function fetchWithTimeout(input: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(input, { ...init, signal: controller.signal }).finally(() => {
    clearTimeout(timeout);
  });
}

export async function exchangeOsuCodeForViewer(code: string, redirectUri: string): Promise<AuthViewer> {
  const tokenResponse = await fetchWithTimeout(
    "https://osu.ppy.sh/oauth/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_id: Number(process.env.OSU_CLIENT_ID),
        client_secret: process.env.OSU_CLIENT_SECRET,
        code,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      }),
    },
    OSU_OAUTH_TIMEOUT_MS,
  );

  if (!tokenResponse.ok) {
    const text = await tokenResponse.text().catch(() => "");
    throw new Error(`osu! OAuth token exchange failed (${tokenResponse.status}): ${text.slice(0, 240)}`);
  }

  const token = (await tokenResponse.json()) as OsuTokenResponse;
  if (!token.access_token) {
    throw new Error("osu! OAuth token response did not include an access token.");
  }

  const meResponse = await fetchWithTimeout(
    "https://osu.ppy.sh/api/v2/me/mania",
    {
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        Accept: "application/json",
        "x-api-version": OSU_API_VERSION,
      },
    },
    OSU_OAUTH_TIMEOUT_MS,
  );

  if (!meResponse.ok) {
    const text = await meResponse.text().catch(() => "");
    throw new Error(`osu! profile fetch failed (${meResponse.status}): ${text.slice(0, 240)}`);
  }

  const me = (await meResponse.json()) as OsuMeResponse;
  const id = Number(me.id);
  if (!Number.isSafeInteger(id) || !me.username) {
    throw new Error("osu! profile response was missing an id or username.");
  }

  return {
    id,
    username: me.username,
    avatarUrl: me.avatar_url ?? "",
    countryCode: me.country_code ?? null,
  };
}
