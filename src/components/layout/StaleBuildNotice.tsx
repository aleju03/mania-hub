import { Link } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { msg } from "@lingui/core/macro";
import { getI18n } from "#/lib/i18n";
import { useLocale } from "#/lib/locale-context";

/** What a stale tab sees when a deploy landed under it: the old client asked
    for a chunk or route module the new build no longer ships. Not an error
    page, since nothing is broken; the page just needs the new version.
    `reloading` is true while the guarded auto-reload is in flight, false when
    that guard tripped and the visitor has to reload by hand. */
export function StaleBuildNotice({
  reloading,
  onReload,
  detail,
}: {
  reloading: boolean;
  onReload: () => void;
  detail?: string | null;
}) {
  // getI18n rather than useLingui: this can render outside RootLayout's
  // I18nProvider and must never throw.
  const i = getI18n(useLocale());
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-5 px-6 py-24 text-center">
      <div className="flex items-center gap-3 text-base font-semibold text-white">
        {reloading ? <Loader2 aria-hidden className="h-5 w-5 animate-spin text-osu-pink" /> : null}
        {reloading
          ? i._(msg`A new update just came in. Refreshing...`)
          : i._(msg`A new update just came in. Refresh to load it.`)}
      </div>
      <div className="flex items-center gap-2">
        {reloading ? (
          <button
            type="button"
            onClick={onReload}
            className="rounded-md px-4 py-2 text-xs font-semibold text-osu-f1 hover:text-white transition-colors"
          >
            {i._(msg`Refresh now`)}
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={onReload}
              className="rounded-md bg-osu-pink/20 px-4 py-2 text-xs font-semibold text-white hover:bg-osu-pink/30 transition-colors"
            >
              {i._(msg`Refresh`)}
            </button>
            <Link
              to="/"
              search={{ country: undefined }}
              className="rounded-md px-4 py-2 text-xs font-semibold text-osu-f1 hover:text-white transition-colors"
            >
              {i._(msg`Go home`)}
            </Link>
          </>
        )}
      </div>
      {detail ? (
        <pre className="mt-2 max-w-full overflow-x-auto rounded-md bg-black/30 px-3 py-2 text-left text-[10px] text-osu-pink-light/60">
          {detail}
        </pre>
      ) : null}
    </div>
  );
}
