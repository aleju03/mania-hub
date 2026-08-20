import { Trans, useLingui } from "@lingui/react/macro";
import { displayCountryName, isGlobalScope } from "../lib/country";
import { useLocale } from "../lib/locale-context";

type LiveEmptyKind = "scores" | "top-plays";

// Rendered when no live backend is configured. The live surfaces have no other
// data source: the osu!-API fallback scans were removed with the Turso exit,
// so a missing VITE_LIVE_BACKEND_URL is a deployment error, not a degraded mode.
export function LiveBackendRequired() {
  return (
    <div className="mx-auto max-w-md px-4 py-16 text-center">
      <div className="text-sm font-bold text-white">
        <Trans>Live data is unavailable</Trans>
      </div>
      <p className="mt-2 text-[12px] leading-relaxed text-osu-f1">
        <Trans>Try again in a bit.</Trans>
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
  const { t } = useLingui();
  const locale = useLocale();
  const name = displayCountryName(country, locale);
  const globalScores = kind === "scores" && isGlobalScope(country);

  const eyebrow =
    kind !== "scores" ? "" : globalScores ? t`Global tracker is ready` : t`${name} is ready`;
  const title = kind === "scores" ? t`Waiting for new scores` : t`No top plays found`;
  const body = globalScores
    ? t`The live feed is connected. New plays will start showing up as players submit them.`
    : kind === "scores"
      ? t`The rankings are here, but this country was added recently. New plays will start showing up once players submit them.`
      : t`Try a wider range or check back later.`;

  return (
    <div className={`mx-auto max-w-md text-center ${compact ? "px-4 py-6" : "px-4 py-16"}`}>
      {eyebrow ? (
        <div className="text-xs font-semibold text-osu-l2">{eyebrow}</div>
      ) : null}
      <div className="mt-1 text-sm font-bold text-white">{title}</div>
      <p className="mt-2 text-[12px] leading-relaxed text-osu-f1">{body}</p>
    </div>
  );
}
