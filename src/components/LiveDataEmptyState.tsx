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
