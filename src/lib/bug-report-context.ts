import { UPDATES } from "../data/changelog";
import type { BugReportContext } from "./bug-reports";

/*
 * The part of a bug report nobody should have to type: where they were, what
 * they were looking at it with, and which build of the site it was. Collected
 * in the browser at submit time and shown back to the reporter before it is
 * sent, because a page that quietly reads your user agent and your window size
 * should say so.
 *
 * Nothing here identifies an account. The osu! id, when there is one, comes
 * from the login cookie on the server side instead, and is not part of this.
 */

/**
 * There is no build id in the bundle, so the newest changelog date stands in
 * for one. It ships with the frontend, moves whenever a release is written up,
 * and is enough to answer "were they on the version that had the bug".
 */
function siteVersion(): string | null {
  return UPDATES[0]?.date ?? null;
}

export function collectBugReportContext(options: { locale: string; country?: string | null }): BugReportContext {
  const context: BugReportContext = { locale: options.locale };
  if (options.country) context.country = options.country;

  const version = siteVersion();
  if (version) context.siteVersion = version;

  if (typeof window !== "undefined") {
    context.viewport = `${window.innerWidth}x${window.innerHeight}`;
    if (window.devicePixelRatio && window.devicePixelRatio !== 1) {
      context.dpr = Math.round(window.devicePixelRatio * 100) / 100;
    }
    if (typeof navigator !== "undefined" && navigator.userAgent) {
      context.userAgent = navigator.userAgent;
    }
  }
  return context;
}

/** A local source path carried by the link that opened /report. */
export function normalizeBugReportSourcePath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const path = value.trim().split("?")[0]!.split("#")[0]!.slice(0, 200);
  if (!path.startsWith("/") || path.startsWith("//") || path === "/report") return undefined;
  return path;
}

/** Field-name -> label pairs for the "what gets sent" disclosure, in a stable order. */
export function describeBugReportContext(context: BugReportContext): Array<{ key: string; value: string }> {
  const order = ["userAgent", "viewport", "dpr", "locale", "country", "siteVersion"];
  return order
    .filter((key) => context[key] != null && context[key] !== "")
    .map((key) => ({ key, value: String(context[key]) }));
}

/**
 * A readable stand-in for the user agent string, for the "what gets sent" line.
 * The full string still travels with the report; this only decides what a
 * person reads. Unknown browsers fall back to nothing rather than a guess.
 */
export function describeBrowser(userAgent: string | undefined | null): string | null {
  if (!userAgent) return null;
  const match = (pattern: RegExp): string | null => pattern.exec(userAgent)?.[1] ?? null;
  const version = (name: string, raw: string | null) => (raw ? `${name} ${raw.split(".")[0]}` : name);

  let browser: string | null = null;
  if (/Edg\//.test(userAgent)) browser = version("Edge", match(/Edg\/([\d.]+)/));
  else if (/OPR\//.test(userAgent)) browser = version("Opera", match(/OPR\/([\d.]+)/));
  else if (/Firefox\//.test(userAgent)) browser = version("Firefox", match(/Firefox\/([\d.]+)/));
  else if (/Chrome\//.test(userAgent)) browser = version("Chrome", match(/Chrome\/([\d.]+)/));
  else if (/Version\/[\d.]+ .*Safari/.test(userAgent)) browser = version("Safari", match(/Version\/([\d.]+)/));

  let platform: string | null = null;
  if (/Android/.test(userAgent)) platform = "Android";
  else if (/iPhone|iPad|iPod/.test(userAgent)) platform = "iOS";
  else if (/Windows NT/.test(userAgent)) platform = "Windows";
  else if (/Mac OS X/.test(userAgent)) platform = "macOS";
  else if (/Linux/.test(userAgent)) platform = "Linux";

  if (browser && platform) return `${browser}, ${platform}`;
  return browser ?? platform;
}

/**
 * A report filed from the Hashi app: it lands on "/hashi" with the app's own
 * details (version, OS, osu! client, tosu and account state) instead of a
 * browser's. Null for anything else, including a report written on the site's
 * /hashi page, which carries browser context and no app version.
 */
export function describeHashiReport(
  pagePath: string | null,
  context: BugReportContext | null,
): { version: string; details: string[] } | null {
  if (pagePath !== "/hashi" || !context || typeof context.hashi !== "string" || !context.hashi) return null;
  const text = (key: string) => {
    const value = context[key];
    return value == null || value === "" ? null : String(value);
  };
  const os = text("os");
  const arch = text("arch");
  const client = text("osuClient");
  const tosu = text("tosu");
  const connection = text("connection");
  const known = new Set(["hashi", "os", "arch", "osuClient", "tosu", "connection"]);
  // camelCase keys read as words: waitingReplay -> "waiting replay".
  const label = (key: string) => key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  const extra = (key: string) => {
    const value = context[key];
    if (typeof value === "boolean") return `${label(key)} ${value ? "on" : "off"}`;
    return `${label(key)} ${String(value)}`;
  };
  const details = [
    os ? [os.charAt(0).toUpperCase() + os.slice(1), arch].filter(Boolean).join(" ") : arch,
    client ? (/^(stable|lazer)$/i.test(client) ? `osu!${client.toLowerCase()}` : client) : null,
    tosu ? `tosu ${tosu}` : null,
    connection ? `Mania Tracker ${connection}` : null,
    // Anything else the app sends still shows, under its own name.
    ...Object.keys(context).filter((key) => !known.has(key) && text(key)).map(extra),
  ].filter((detail): detail is string => Boolean(detail));
  return { version: context.hashi, details };
}
