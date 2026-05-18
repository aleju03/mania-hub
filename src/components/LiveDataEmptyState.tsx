import { getCountryName } from "../lib/country";

type LiveEmptyKind = "scores" | "top-plays";

const COPY: Record<LiveEmptyKind, { title: string; body: string }> = {
  scores: {
    title: "Waiting for new scores",
    body: "The rankings are here, but this country was added recently. New plays will start showing up once players submit them.",
  },
  "top-plays": {
    title: "Waiting for new top plays",
    body: "The rankings are here, but top plays start filling in after this country has been watched for a bit.",
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

  return (
    <div className={`mx-auto max-w-md text-center ${compact ? "px-4 py-6" : "px-4 py-16"}`}>
      <div className="text-xs font-semibold text-osu-l2">{name} is ready</div>
      <div className="mt-1 text-sm font-bold text-white">{copy.title}</div>
      <p className="mt-2 text-[12px] leading-relaxed text-osu-f1">{copy.body}</p>
    </div>
  );
}
