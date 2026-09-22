import { Trans } from "@lingui/react/macro";
import { useEffect, useState } from "react";

import { formatAccuracy, formatTimeAgo } from "#/lib/format";
import { fetchCompanellaPublicProfileDirect, type CompanellaPublicProfile } from "#/lib/live-backend";
import { useLocale } from "#/lib/locale-context";

/*
 * A restricted player's Companella imports, on their profile's Recent tab.
 *
 * osu! stopped serving these accounts, so nothing else can add a play to their
 * page. Only plays that passed every check the rating preview requires come
 * back from the backend; chart names are read from the uploaded file.
 */

export function ProfileImportedPlays({ userId }: { userId: number }) {
  const locale = useLocale();
  const [profile, setProfile] = useState<CompanellaPublicProfile | null>(null);
  const [state, setState] = useState<"loading" | "loaded" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    setState("loading");
    fetchCompanellaPublicProfileDirect(userId)
      .then((result) => {
        if (cancelled) return;
        setProfile(result);
        setState("loaded");
      })
      .catch(() => {
        if (!cancelled) setState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  if (state === "loading") {
    return <div className="py-8 text-center text-sm text-osu-f1"><Trans>Loading...</Trans></div>;
  }
  if (state === "error") {
    return <div className="py-8 text-center text-sm text-osu-f1"><Trans>Couldn't load imported plays right now.</Trans></div>;
  }
  const plays = profile?.plays ?? [];
  const ratings = (profile?.ratings ?? []).filter((rating) => rating.overall != null && rating.localPlays > 0);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 px-1">
        <h2 className="text-sm font-semibold text-white">
          <Trans>Plays sent through Companella</Trans>
        </h2>
        {ratings.length > 0 && (
          <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
            {ratings.map((rating) => (
              <span key={rating.keyCount} className="text-xs text-osu-f1">
                {rating.keyCount}K{" "}
                <span className="text-lg font-bold tabular-nums text-white">{rating.overall!.toFixed(2)}</span>
              </span>
            ))}
          </div>
        )}
      </div>
      {plays.length === 0 ? (
        <div className="py-8 text-center text-sm text-osu-f1">
          <Trans>No plays sent through Companella yet.</Trans>
        </div>
      ) : (
        <div className="space-y-1.5">
          {plays.map((play) => {
            const speed = Number(play.runtimeRate.toFixed(2));
            const mods = play.mods.filter((mod) => mod !== "NM");
            return (
              <div key={play.id} className="flex items-center gap-4 rounded-lg bg-osu-b4 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold text-white">
                    {play.title ?? <Trans>Untitled chart</Trans>}
                    {play.version ? <span className="font-normal text-osu-l2"> [{play.version}]</span> : null}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-xs text-osu-f1">
                    {play.artist ? <span className="truncate">{play.artist}</span> : null}
                    {play.keyCount ? <span>{play.keyCount}K</span> : null}
                    {mods.length > 0 ? <span>{mods.join(", ")}</span> : null}
                    {speed !== 1 ? <span>{speed}x</span> : null}
                    {play.chartLabel ? <span>{play.chartLabel}</span> : null}
                    {play.playedAt ? <span>{formatTimeAgo(play.playedAt, locale)}</span> : null}
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  {play.ssr != null ? (
                    <div className="text-lg font-bold tabular-nums text-white">{play.ssr.toFixed(2)}</div>
                  ) : null}
                  <div className="text-xs tabular-nums text-osu-f1">
                    {play.accuracy != null ? formatAccuracy(play.accuracy) : null}
                    {play.countMiss > 0 ? <span className="ml-2">{play.countMiss}x</span> : null}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
