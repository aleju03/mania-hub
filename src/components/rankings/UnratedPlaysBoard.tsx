import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Trans, useLingui } from "@lingui/react/macro";
import { Pagination } from "../ui/Pagination";
import { SegmentedControl } from "../ui/SegmentedControl";
import { Avatar } from "../ui/Avatar";
import { CountryFlag } from "../ui/CountryFlag";
import { UsernameText } from "../ui/UsernameText";
import { ModBadge } from "../ui/ModBadge";
import { Skeleton } from "../ui/LoadingSkeleton";
import { DanMark } from "../player/DanMark";
import { rateModFor } from "../player/SkillPlaysModal";
import { loadUnratedBoard, peekUnratedBoard } from "../../lib/skill-leaderboard-cache";
import { beatmapStatusPill } from "../../lib/beatmap-status";
import { formatAccuracy, formatPP, formatTimeAgo, formatTimeAgoTooltip } from "../../lib/format";
import { useLocale } from "../../lib/locale-context";
import { SM_MEDIA_QUERY, useMediaQuery } from "../../lib/use-media-query";
import { useHiddenUserIds } from "../../store";
import { LEADERBOARD_PAGE_SIZE, type LeaderboardKeyCount } from "../../lib/skill-leaderboards";
import type { UnratedPlayEntry, UnratedPlaysKeys, UnratedPlaysRange, UnratedPlaysSnapshot, UnratedPlaysSort } from "../../lib/unrated-plays";

// The board for the plays every other rating leaves out. Rows are plays, not
// players: a map and the player who set it, with the three numbers the play
// is worth on its own terms, and the sort decides which of a player's plays
// on a chart is the one that shows.

export function UnratedPlaysBoard({
  country,
  keys,
  sort,
  range,
  page,
  onNavigate,
}: {
  country: string;
  keys: UnratedPlaysKeys;
  sort: UnratedPlaysSort;
  range: UnratedPlaysRange;
  page: number;
  onNavigate: (next: { keys?: UnratedPlaysKeys; sort?: UnratedPlaysSort; range?: UnratedPlaysRange; page?: number }) => void;
}) {
  const { t } = useLingui();
  const hiddenUserIds = useHiddenUserIds();
  const request = useMemo(() => ({ country, keys, sort, range, page }), [country, keys, sort, range, page]);
  // A board already in the cache is read during render, so a flip to it is
  // the same commit that moves the control's highlight. Reading it in an
  // effect instead costs a second render of a hundred rows, which on top of
  // the router's own turnaround was the lag a click on these controls had.
  const cached = useMemo(() => peekUnratedBoard(request), [request]);
  const [fetched, setFetched] = useState<{ request: typeof request; snapshot: UnratedPlaysSnapshot } | null>(null);
  const snapshot = cached ?? (fetched?.request === request ? fetched.snapshot : null);
  const [error, setError] = useState<{ request: typeof request; message: string } | null>(null);
  const loading = !snapshot && error?.request !== request;
  // The keymodes this scope has plays on, kept from the last board that
  // landed: the picker must not collapse to "All" for the length of a fetch,
  // or every flip re-lays the whole control row out.
  const lastKeyCounts = useRef<LeaderboardKeyCount[]>([]);
  if (snapshot?.keyCounts && snapshot.keyCounts.length > 0) lastKeyCounts.current = snapshot.keyCounts;
  // How tall the last page was, so the skeleton that replaces it holds the
  // same ground instead of collapsing to ten rows and back.
  const lastRowCount = useRef(10);
  if (snapshot) lastRowCount.current = Math.max(1, snapshot.ranking.length);

  useEffect(() => {
    let cancelled = false;
    const landed = (next: UnratedPlaysSnapshot) => {
      // A keymode this scope has no plays on lands on the mixed board rather
      // than on an empty table.
      if (typeof keys === "number" && next.keyCounts && !next.keyCounts.includes(keys)) {
        onNavigate({ keys: "all", page: 1 });
        return;
      }
      // The flips a reader makes next are the other range and the other two
      // sorts of this same board; warm them so the click is a cache swap
      // rather than a skeleton. The backend serves each from its own cache.
      const siblings = [
        { ...request, range: range === "all" ? "week" as const : "all" as const, page: 1 },
        ...(["pp", "msd", "dan"] as const).filter((other) => other !== sort).map((other) => ({ ...request, sort: other, page: 1 })),
      ];
      for (const sibling of siblings) void loadUnratedBoard(sibling).catch(() => {});
    };
    if (cached) {
      landed(cached);
      return;
    }
    // A board nobody has fetched yet: the outgoing rows come down, since
    // showing them under the new heading reads as the wrong answer flashing
    // before the right one, and the skeleton holds their height.
    loadUnratedBoard(request)
      .then((next) => {
        if (cancelled) return;
        setFetched({ request, snapshot: next });
        landed(next);
      })
      .catch(() => {
        if (cancelled) return;
        setError({ request, message: t`Could not load this leaderboard.` });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request, cached]);

  // While a board is in flight the headers follow the click; once it lands
  // they follow what arrived, so a header and its numbers always agree.
  const servedSort = snapshot?.sort ?? sort;
  const rows = useMemo(
    () => (snapshot?.ranking ?? []).filter((entry) => !hiddenUserIds.has(entry.user.id)),
    [snapshot, hiddenUserIds],
  );
  const totalPages = Math.max(1, Math.ceil((snapshot?.total ?? 0) / LEADERBOARD_PAGE_SIZE));
  const keyCounts = lastKeyCounts.current;
  const availableKeyCounts: LeaderboardKeyCount[] = keyCounts.length > 0 ? keyCounts : (typeof keys === "number" ? [keys] : []);
  const body = error?.request === request ? "error" : loading ? "loading" : rows.length === 0 ? "empty" : "rows";
  const errorMessage = error?.request === request ? error.message : null;
  const skeletonRows = Math.min(LEADERBOARD_PAGE_SIZE, lastRowCount.current);
  // Both layouts render until the browser says which one is on screen; after
  // that only the visible one does, which is half the rows per flip.
  const wide = useMediaQuery(SM_MEDIA_QUERY);
  // The controls move on the click itself. The URL is what drives the board,
  // and the router's turnaround is long enough to read as a stall on a fill
  // that should slide the moment a finger lands; the pending choice is
  // remembered against the request it was made from and forgotten the moment
  // the props move on, whether or not they moved where it pointed.
  const [pending, setPending] = useState<{ from: typeof request; next: Partial<Pick<typeof request, "keys" | "sort" | "range">> } | null>(null);
  const shown = pending?.from === request ? { ...request, ...pending.next } : request;
  const choose = (next: Partial<Pick<typeof request, "keys" | "sort" | "range">>) => {
    setPending({ from: request, next });
    onNavigate({ ...next, page: 1 });
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        {/* "All" leads: this is a list of plays, and a keymode is a way to
            narrow it, not what it is of. The rest are the keymodes with a
            play in this scope, like the other boards' pickers. */}
        <div className="max-w-full overflow-x-auto scrollbar-hide" role="group" aria-label={t`Key mode`}>
          <SegmentedControl
            id="unrated-plays-keys"
            value={String(shown.keys)}
            options={[
              { value: "all", label: t`All` },
              ...availableKeyCounts.map((keyCount) => ({ value: String(keyCount), label: `${keyCount}K` })),
            ]}
            onChange={(next) => choose({ keys: next === "all" ? "all" : (Number(next) as LeaderboardKeyCount) })}
          />
        </div>
        <SegmentedControl
          id="unrated-plays-range"
          value={shown.range}
          options={[
            { value: "all" as const, label: t`All time` },
            { value: "week" as const, label: t`This week` },
          ]}
          onChange={(next) => choose({ range: next })}
        />
        <SegmentedControl
          id="unrated-plays-sort"
          value={shown.sort}
          options={[
            { value: "pp" as const, label: "PP" },
            { value: "msd" as const, label: "MSD" },
            { value: "dan" as const, label: t`Dan` },
          ]}
          onChange={(next) => choose({ sort: next })}
        />
      </div>

      <p className="text-[11px] text-osu-f1">
        <Trans>Plays the skill ratings leave out: vibro charts and charts that cannot be rated. One play per player per chart.</Trans>
      </p>

      {/* Mobile cards */}
      {wide !== true && (
      <div className="sm:hidden space-y-2" aria-busy={loading}>
        {body === "error" ? (
          <div className="px-4 py-8 text-center text-sm text-osu-f1">{errorMessage}</div>
        ) : body === "empty" ? (
          <div className="px-4 py-8 text-center text-sm text-osu-f1"><Trans>No unrated plays here yet.</Trans></div>
        ) : body === "loading" ? (
          Array.from({ length: skeletonRows }).map((_, index) => (
            <div key={index} className="rounded-lg bg-osu-b4/50 p-3">
              <div className="flex items-center gap-3">
                <Skeleton className="w-8 h-4" />
                <Skeleton className="w-9 h-9 rounded-full" />
                <Skeleton className="h-4 flex-1" />
                <Skeleton className="h-4 w-12" />
              </div>
            </div>
          ))
        ) : (
          rows.map((entry) => <UnratedPlayCard key={`${entry.user.id}:${entry.beatmapId}:${entry.rate}`} entry={entry} sort={servedSort} />)
        )}
      </div>
      )}

      {/* Desktop table */}
      {wide !== false && (
      <div
        className="hidden sm:block rounded-xl overflow-hidden border border-osu-b3/30"
        aria-busy={loading}
      >
        <table className="w-full table-fixed">
          <colgroup>
            <col className="w-[5%]" />
            <col className="w-[22%]" />
            <col />
            <col className="w-[10%]" />
            <col className="w-[10%]" />
            <col className="w-[11%]" />
          </colgroup>
          <thead>
            <tr className="bg-osu-b4 text-[10px] uppercase tracking-wider text-osu-f1 font-semibold">
              <th className="py-2.5 px-3 text-left">#</th>
              <th className="py-2.5 px-3 text-left">{t`Player`}</th>
              <th className="py-2.5 px-3 text-left">{t`Map`}</th>
              <th className={`py-2.5 px-3 text-right ${servedSort === "pp" ? "text-osu-l2" : ""}`}>PP</th>
              <th className={`py-2.5 px-3 text-right ${servedSort === "msd" ? "text-osu-l2" : ""}`}>MSD</th>
              <th className={`py-2.5 px-3 text-right ${servedSort === "dan" ? "text-osu-l2" : ""}`}>{t`Dan`}</th>
            </tr>
          </thead>
          <tbody>
            {body === "error" ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-sm text-osu-f1">{errorMessage}</td>
              </tr>
            ) : body === "empty" ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-sm text-osu-f1"><Trans>No unrated plays here yet.</Trans></td>
              </tr>
            ) : body === "loading" ? (
              Array.from({ length: skeletonRows }).map((_, index) => (
                <tr key={index} className="border-t border-osu-b3/20">
                  <td className="py-2.5 px-3"><Skeleton className="w-8 h-4" /></td>
                  <td className="py-2.5 px-3">
                    <div className="flex items-center gap-3">
                      <Skeleton className="w-[30px] h-[30px] rounded-full" />
                      <Skeleton className="h-4 w-28" />
                    </div>
                  </td>
                  <td className="py-2.5 px-3">
                    <div className="flex items-center gap-3">
                      <Skeleton className="h-10 w-16 rounded-md" />
                      <Skeleton className="h-4 w-48" />
                    </div>
                  </td>
                  <td className="py-2.5 px-3"><Skeleton className="h-4 w-12 ml-auto" /></td>
                  <td className="py-2.5 px-3"><Skeleton className="h-4 w-12 ml-auto" /></td>
                  <td className="py-2.5 px-3"><Skeleton className="h-8 w-8 ml-auto" /></td>
                </tr>
              ))
            ) : (
              rows.map((entry, index) => (
                <UnratedPlayTableRow key={`${entry.user.id}:${entry.beatmapId}:${entry.rate}`} entry={entry} sort={servedSort} striped={index % 2 === 1} />
              ))
            )}
          </tbody>
        </table>
      </div>
      )}

      {totalPages > 1 && (
        <Pagination
          page={page - 1}
          totalPages={totalPages}
          onPageChange={(next) => onNavigate({ page: next + 1 })}
        />
      )}
    </div>
  );
}

function ValueCell({ entry, axis, sort }: { entry: UnratedPlayEntry; axis: UnratedPlaysSort; sort: UnratedPlaysSort }) {
  const locale = useLocale();
  const active = axis === sort;
  const tone = active ? "text-white" : "text-osu-l2";
  if (axis === "dan") {
    if (!entry.dan?.label) return <span className="text-xs text-osu-f1">-</span>;
    return (
      <span className={`inline-flex justify-end ${active ? "" : "opacity-70"}`}>
        <DanMark label={entry.dan.label} keyCount={entry.keyCount} side={entry.dan.side} />
      </span>
    );
  }
  const value = axis === "pp" ? entry.pp : entry.msd;
  if (value == null) return <span className="text-xs text-osu-f1">-</span>;
  return (
    <span className={`text-sm font-bold tabular-nums ${active ? "text-base" : ""} ${axis === "pp" && active ? "text-osu-pink-light" : tone}`}>
      {axis === "pp" ? formatPP(value, locale) : value.toFixed(2)}
    </span>
  );
}

function MapCell({ entry }: { entry: UnratedPlayEntry }) {
  const { t, i18n } = useLingui();
  const locale = useLocale();
  const status = entry.beatmapStatus ? beatmapStatusPill(entry.beatmapStatus) : null;
  const rateMod = rateModFor(entry.rate, entry.rateMod);
  const mods = entry.mods && entry.mods.length > 0 ? entry.mods : rateMod ? [rateMod.acronym] : [];
  return (
    <Link
      to="/maps"
      search={{ map: entry.beatmapId } as never}
      className="flex min-w-0 items-center gap-3"
      title={t`View map details`}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="relative h-10 w-16 shrink-0 overflow-hidden rounded-md bg-osu-b3/35">
        {entry.coverUrl ? (
          <img
            src={entry.coverUrl}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover"
            onError={(event) => { event.currentTarget.style.display = "none"; }}
          />
        ) : null}
        <div className="pointer-events-none absolute inset-0 ring-1 ring-inset ring-white/[0.06]" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-sm font-semibold text-white">{entry.title}</span>
          <span className="hidden shrink-0 truncate text-[10px] text-osu-f1 lg:inline">[{entry.version}]</span>
        </div>
        <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-osu-f1">
          <span className="max-w-44 truncate">{entry.artist}</span>
          <span className="rounded bg-osu-b3/35 px-1 py-0.5 font-bold text-osu-yellow">{entry.keyCount}K</span>
          {status ? (
            <span className={`rounded px-1 py-0.5 font-bold ${status.className}`}>{i18n._(status.label)}</span>
          ) : null}
          {mods.length > 0 ? (
            <span className="inline-flex flex-wrap items-center gap-0.5">
              {mods.map((mod) => (
                <ModBadge key={mod} mod={mod} rate={rateMod?.acronym === mod ? rateMod.rate : undefined} size={0.7} />
              ))}
            </span>
          ) : null}
          {entry.accuracy != null ? <span className="tabular-nums">{formatAccuracy(entry.accuracy)}</span> : null}
          {entry.playedAt ? (
            <span title={formatTimeAgoTooltip(entry.playedAt, locale)}>{formatTimeAgo(entry.playedAt, locale)}</span>
          ) : null}
        </div>
      </div>
    </Link>
  );
}

// Rows are memoized so a re-render of the board for its controls alone (a
// keymode list landing, a hidden user) does not rebuild fifty of them.
const UnratedPlayTableRow = memo(function UnratedPlayTableRow({ entry, sort, striped }: { entry: UnratedPlayEntry; sort: UnratedPlaysSort; striped: boolean }) {
  return (
    <tr
      className="border-t border-osu-b3/20 hover:bg-osu-b4/80 transition-colors duration-[120ms]"
      style={{ background: striped ? "rgba(255,255,255,0.015)" : "transparent" }}
    >
      <td className="py-2.5 px-3 text-sm font-bold text-osu-f1">#{entry.rank}</td>
      <td className="py-2.5 px-3">
        <Link
          to="/player/$username"
          params={{ username: entry.user.username }}
          className="flex items-center gap-2.5 min-w-0"
        >
          <Avatar url={entry.user.avatar_url} userId={entry.user.id} size={30} />
          <CountryFlag code={entry.user.country_code} size="sm" className="flex-shrink-0" />
          <UsernameText
            username={entry.user.username}
            avatarUrl={entry.user.avatar_url}
            className="text-sm font-medium truncate min-w-0"
          />
        </Link>
      </td>
      <td className="py-2.5 px-3"><MapCell entry={entry} /></td>
      <td className="py-2.5 px-3 text-right"><ValueCell entry={entry} axis="pp" sort={sort} /></td>
      <td className="py-2.5 px-3 text-right"><ValueCell entry={entry} axis="msd" sort={sort} /></td>
      <td className="py-2.5 px-3 text-right"><ValueCell entry={entry} axis="dan" sort={sort} /></td>
    </tr>
  );
});

const UnratedPlayCard = memo(function UnratedPlayCard({ entry, sort }: { entry: UnratedPlayEntry; sort: UnratedPlaysSort }) {
  const others = (["pp", "msd", "dan"] as const).filter((axis) => axis !== sort);
  return (
    <div className="rounded-lg bg-osu-b4/50 p-3">
      <div className="flex items-center gap-3">
        <span className="w-8 text-sm font-bold text-osu-f1">#{entry.rank}</span>
        <Link to="/player/$username" params={{ username: entry.user.username }} className="flex min-w-0 flex-1 items-center gap-2">
          <Avatar url={entry.user.avatar_url} userId={entry.user.id} size={28} />
          <CountryFlag code={entry.user.country_code} size="sm" className="flex-shrink-0" />
          <UsernameText
            username={entry.user.username}
            avatarUrl={entry.user.avatar_url}
            className="text-sm font-semibold truncate min-w-0"
          />
        </Link>
        <span className="flex-shrink-0 text-right"><ValueCell entry={entry} axis={sort} sort={sort} /></span>
      </div>
      <div className="mt-2 flex items-center gap-3">
        <div className="min-w-0 flex-1"><MapCell entry={entry} /></div>
        <div className="flex shrink-0 flex-col items-end gap-1 text-right">
          {others.map((axis) => (
            <span key={axis} className="flex items-center gap-1.5">
              <span className="text-[8px] font-semibold uppercase tracking-wide text-osu-f1">{axis === "pp" ? "PP" : axis === "msd" ? "MSD" : "Dan"}</span>
              <ValueCell entry={entry} axis={axis} sort={sort} />
            </span>
          ))}
        </div>
      </div>
    </div>
  );
});
