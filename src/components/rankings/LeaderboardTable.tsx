import type { ReactNode } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { Trans, useLingui } from "@lingui/react/macro";
import { Avatar } from "../ui/Avatar";
import { CountryFlag } from "../ui/CountryFlag";
import { UsernameText } from "../ui/UsernameText";
import { Skeleton } from "../ui/LoadingSkeleton";
import type { LeaderboardUser } from "../../lib/skill-leaderboards";

// The row shape both leaderboard boards share. The value column is a render
// prop because a skill board prints a number and a dan board prints a course
// badge, but everything left of it (rank, avatar, name, flag) is identical and
// should stay that way.

export interface LeaderboardRow {
  key: string | number;
  rank: number;
  user: LeaderboardUser;
  /** The headline number or badge, right-aligned and the largest thing in the row. */
  value: ReactNode;
  /** One muted line under the name: evidence counts, mostly. */
  detail: ReactNode;
  /** What clicking the row opens instead of the profile (the clears board's
   *  score card). The name still links to the profile. */
  onOpen?: () => void;
}

function playerPath(username: string): string {
  return `/player/${encodeURIComponent(username)}`;
}

export function LeaderboardTable({
  rows,
  loading,
  error,
  emptyMessage,
  valueHeader,
  detailHeader,
  wideDetail = false,
}: {
  rows: LeaderboardRow[];
  loading: boolean;
  error: string | null;
  emptyMessage: ReactNode;
  valueHeader: string;
  detailHeader: string;
  /** Room for a name in the detail column (the clears board's chart) rather than a count. */
  wideDetail?: boolean;
}) {
  const { t } = useLingui();
  const navigate = useNavigate();

  const openPlayer = (username: string) => {
    navigate({ to: "/player/$username", params: { username } });
  };

  // A refetch keeps the rows it already has, dimmed, instead of blanking to a
  // skeleton: switching axis is a re-sort of the same board, and tearing the
  // table down for the length of a round trip is what made a fast request feel
  // like a slow one. The skeleton is for a board with nothing to show yet.
  const stale = loading && rows.length > 0;
  const body = (() => {
    if (error) return "error" as const;
    if (loading && rows.length === 0) return "loading" as const;
    if (rows.length === 0) return "empty" as const;
    return "rows" as const;
  })();
  const staleClass = stale ? " opacity-40" : "";

  return (
    <>
      {/* Mobile cards */}
      <div className={`sm:hidden space-y-2 transition-opacity duration-150${staleClass}`} aria-busy={loading}>
        {body === "error" ? (
          <div className="px-4 py-8 text-center text-sm text-osu-f1">{error}</div>
        ) : body === "empty" ? (
          <div className="px-4 py-8 text-center text-sm text-osu-f1">{emptyMessage}</div>
        ) : body === "loading" ? (
          Array.from({ length: 10 }).map((_, index) => (
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
          rows.map((row) => {
            const identity = (
              <>
                <Avatar url={row.user.avatar_url} userId={row.user.id} size={36} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <CountryFlag code={row.user.country_code} size="sm" className="flex-shrink-0" />
                    {row.onOpen ? (
                      <Link
                        to="/player/$username"
                        params={{ username: row.user.username }}
                        onClick={(event) => event.stopPropagation()}
                        className="min-w-0 truncate"
                      >
                        <UsernameText
                          username={row.user.username}
                          avatarUrl={row.user.avatar_url}
                          className="text-sm font-semibold truncate min-w-0"
                        />
                      </Link>
                    ) : (
                      <UsernameText
                        username={row.user.username}
                        avatarUrl={row.user.avatar_url}
                        className="text-sm font-semibold truncate min-w-0"
                      />
                    )}
                  </div>
                  <div className="mt-0.5 text-[11px] text-osu-f1">{row.detail}</div>
                </div>
              </>
            );
            const cardClass = "block w-full rounded-lg bg-osu-b4/50 p-3 text-left cursor-pointer hover:bg-osu-b4 transition-colors";
            if (row.onOpen) {
              return (
                <div
                  key={row.key}
                  role="button"
                  tabIndex={0}
                  onClick={row.onOpen}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    row.onOpen?.();
                  }}
                  className={cardClass}
                >
                  <div className="flex items-center gap-3">
                    <span className="w-8 text-sm font-bold text-osu-f1">#{row.rank}</span>
                    {identity}
                    <span className="flex-shrink-0 text-right">{row.value}</span>
                  </div>
                </div>
              );
            }
            return (
              <Link
                key={row.key}
                to="/player/$username"
                params={{ username: row.user.username }}
                className={cardClass}
              >
                <div className="flex items-center gap-3">
                  <span className="w-8 text-sm font-bold text-osu-f1">#{row.rank}</span>
                  {identity}
                  <span className="flex-shrink-0 text-right">{row.value}</span>
                </div>
              </Link>
            );
          })
        )}
      </div>

      {/* Desktop table */}
      <div
        className={`hidden sm:block rounded-xl overflow-hidden border border-osu-b3/30 transition-opacity duration-150${staleClass}`}
        aria-busy={loading}
      >
        <table className="w-full table-fixed">
          <colgroup>
            <col className="w-[6%]" />
            <col />
            <col className={wideDetail ? "w-[38%]" : "w-[18%]"} />
            <col className={wideDetail ? "w-[20%]" : "w-[16%]"} />
          </colgroup>
          <thead>
            <tr className="bg-osu-b4 text-[10px] uppercase tracking-wider text-osu-f1 font-semibold">
              <th className="py-2.5 px-3 text-left">#</th>
              <th className="py-2.5 px-3 text-left">{t`Player`}</th>
              <th className="py-2.5 px-3 text-right">{detailHeader}</th>
              <th className="py-2.5 px-3 text-right">{valueHeader}</th>
            </tr>
          </thead>
          <tbody>
            {body === "error" ? (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-sm text-osu-f1">{error}</td>
              </tr>
            ) : body === "empty" ? (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-sm text-osu-f1">{emptyMessage}</td>
              </tr>
            ) : body === "loading" ? (
              Array.from({ length: 10 }).map((_, index) => (
                <tr key={index} className="border-t border-osu-b3/20">
                  <td className="py-2.5 px-3"><Skeleton className="w-8 h-4" /></td>
                  <td className="py-2.5 px-3">
                    <div className="flex items-center gap-3">
                      <Skeleton className="w-[30px] h-[30px] rounded-full" />
                      <Skeleton className="h-4 w-40" />
                    </div>
                  </td>
                  <td className="py-2.5 px-3"><Skeleton className="h-4 w-16 ml-auto" /></td>
                  <td className="py-2.5 px-3"><Skeleton className="h-5 w-14 ml-auto" /></td>
                </tr>
              ))
            ) : (
              rows.map((row, index) => (
                <tr
                  key={row.key}
                  className="border-t border-osu-b3/20 hover:bg-osu-b4/80 transition-colors duration-[120ms] cursor-pointer"
                  style={{ background: index % 2 ? "rgba(255,255,255,0.015)" : "transparent" }}
                  onClick={() => (row.onOpen ? row.onOpen() : openPlayer(row.user.username))}
                  onAuxClick={(event) => {
                    if (event.button !== 1 || row.onOpen) return;
                    if ((event.target as Element | null)?.closest("a")) return;
                    window.open(playerPath(row.user.username), "_blank", "noopener,noreferrer");
                  }}
                >
                  <td className="py-2.5 px-3 text-sm font-bold text-osu-f1">#{row.rank}</td>
                  <td className="py-2.5 px-3">
                    <Link
                      to="/player/$username"
                      params={{ username: row.user.username }}
                      onClick={(event) => event.stopPropagation()}
                      // Only as wide as the avatar and name: a full-width link
                      // swallowed clicks meant for a row that opens something else.
                      className="inline-flex max-w-full items-center gap-3 min-w-0 align-middle"
                    >
                      <Avatar url={row.user.avatar_url} userId={row.user.id} size={30} />
                      <CountryFlag code={row.user.country_code} size="sm" className="flex-shrink-0" />
                      <UsernameText
                        username={row.user.username}
                        avatarUrl={row.user.avatar_url}
                        className="text-sm font-medium truncate min-w-0"
                      />
                    </Link>
                  </td>
                  <td className="py-2.5 px-3 text-right text-[11px] text-osu-f1">{row.detail}</td>
                  <td className="py-2.5 px-3 text-right">{row.value}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function LeaderboardEmpty() {
  return <Trans>No rated players here yet.</Trans>;
}
