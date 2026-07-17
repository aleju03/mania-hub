import { getCountryName, isGlobalScope } from "../lib/country";

type LiveEmptyKind = "scores" | "top-plays";

const COPY: Record<LiveEmptyKind, { eyebrow: (countryName: string) => string; title: string; body: string }> = {
  scores: {
    eyebrow: (countryName) => `${countryName} is ready`,
    title: "Waiting for new scores",
    body: "The rankings are here, but this country was added recently. New plays will start showing up once players submit them.",
  },
  "top-plays": {
    eyebrow: () => "",
    title: "No top plays found",
    body: "Try a wider range or check back later.",
  },
};

// Rendered when no live backend is configured. The live surfaces have no other
// data source: the osu!-API fallback scans were removed with the Turso exit,
// so a missing VITE_LIVE_BACKEND_URL is a deployment error, not a degraded mode.
export function LiveBackendRequired() {
  return (
    <div className="mx-auto max-w-md px-4 py-16 text-center">
      <div className="text-sm font-bold text-white">Live data is unavailable</div>
      <p className="mt-2 text-[12px] leading-relaxed text-osu-f1">
        This page needs the live backend and none is configured
        (VITE_LIVE_BACKEND_URL is not set).
      </p>
    </div>
  );
}

export function LiveDataEmptyState({
  country,
  kind,
  compact = false,
}: {
  country: string;
  kind: LiveEmptyKind;
  compact?: boolean;
}) {
  const copy = COPY[kind];
  const name = getCountryName(country);
  const globalScores = kind === "scores" && isGlobalScope(country);
  const eyebrow = globalScores ? "Global tracker is ready" : copy.eyebrow(name);
  const body = globalScores
    ? "The live feed is connected. New plays will start showing up as players submit them."
    : copy.body;

  return (
    <div className={`mx-auto max-w-md text-center ${compact ? "px-4 py-6" : "px-4 py-16"}`}>
      {eyebrow ? (
        <div className="text-xs font-semibold text-osu-l2">{eyebrow}</div>
      ) : null}
      <div className="mt-1 text-sm font-bold text-white">{copy.title}</div>
      <p className="mt-2 text-[12px] leading-relaxed text-osu-f1">{body}</p>
    </div>
  );
}
