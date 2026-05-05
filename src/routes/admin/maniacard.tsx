import { Link, createFileRoute, notFound, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { CssManiaCardPanel, ManiaCardPanel } from "../../components/player/ManiaCard";
import { SearchInput } from "../../components/ui/SearchInput";
import { getUser, getUserScoresBestWindow, searchUsers } from "../../lib/osu";
import type { OsuScore, OsuUser } from "../../lib/types";
import { canUseDevFeatures } from "../../lib/auth-shared";

const DEFAULT_PLAYER = "Anthony2308";
const BEST_SCORES_WINDOW_SIZE = 200;

type ManiacardSearch = {
  player: string;
};

export const Route = createFileRoute("/admin/maniacard")({
  validateSearch: (search: Record<string, unknown>): ManiacardSearch => ({
    player: typeof search.player === "string" && search.player.trim()
      ? search.player.trim()
      : DEFAULT_PLAYER,
  }),
  head: () => ({
    meta: [
      { title: "Maniacard - dev" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  beforeLoad: ({ context }) => {
    if (!canUseDevFeatures(context.auth)) {
      throw notFound();
    }
    return undefined as never;
  },
  component: ManiacardAdminPage,
});

function ManiacardAdminPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const [user, setUser] = useState<OsuUser | null>(null);
  const [scores, setScores] = useState<OsuScore[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const player = search.player || DEFAULT_PLAYER;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setUser(null);
    setScores([]);

    async function loadCard() {
      try {
        const loadedUser = await getUser({ data: { key: player } });
        const loadedScores = await getUserScoresBestWindow({
          data: { userId: loadedUser.id, totalLimit: BEST_SCORES_WINDOW_SIZE },
        });
        if (cancelled) return;
        setUser(loadedUser);
        setScores(loadedScores);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Could not load that player.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadCard();
    return () => {
      cancelled = true;
    };
  }, [player]);

  const handleSearch = useCallback(async (query: string) => {
    const res = await searchUsers({ data: { query } });
    return (res.user?.data ?? []).slice(0, 6).map((u: { id: number; username: string; avatar_url: string; country_code: string }) => ({
      id: u.id,
      username: u.username,
      avatar_url: u.avatar_url,
      country_code: u.country_code,
    }));
  }, []);

  const selectPlayer = useCallback((username: string) => {
    navigate({
      to: "/admin/maniacard",
      search: { player: username },
    });
  }, [navigate]);

  return (
    <main className="min-h-screen bg-osu-b5 text-osu-c1">
      <div className="max-w-[1200px] mx-auto px-5 py-7 sm:py-10">
        <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4 pb-6 border-b border-osu-b3/30">
          <div>
            <div className="text-[11px] uppercase tracking-[0.16em] text-osu-yellow font-bold">
              Admin
            </div>
            <h1 className="mt-1 text-2xl sm:text-3xl font-black text-white">
              Maniacard
            </h1>
            <div className="mt-2 text-sm text-osu-f1">
              Dedicated preview surface for the current card design.
            </div>
          </div>

          <div className="w-full lg:w-[360px]">
            <SearchInput
              className="w-full"
              placeholder="search player..."
              onSearch={handleSearch}
              onSelect={(result) => selectPlayer(result.username)}
            />
          </div>
        </div>

        <div className="mt-6 grid lg:grid-cols-[minmax(0,1fr)_280px] gap-6 items-start">
          <section className="rounded-lg border border-osu-b3/30 bg-osu-b4/35 px-3 py-5 sm:px-5">
            {error ? (
              <div className="py-16 text-center">
                <div className="text-sm font-bold text-osu-red">Could not load maniacard</div>
                <div className="mt-2 text-sm text-osu-f1">{error}</div>
              </div>
            ) : user ? (
              <div className="grid gap-5 xl:grid-cols-2">
                <div>
                  <div className="mb-3 text-[11px] uppercase tracking-[0.14em] text-osu-f1 font-bold">
                    CSS reference
                  </div>
                  <CssManiaCardPanel user={user} scores={scores} loading={loading} />
                </div>
                <div>
                  <div className="mb-3 text-[11px] uppercase tracking-[0.14em] text-osu-yellow font-bold">
                    ThreeJS production
                  </div>
                  <ManiaCardPanel user={user} scores={scores} loading={loading} />
                </div>
              </div>
            ) : (
              <div className="grid gap-5 xl:grid-cols-2">
                <div>
                  <div className="mb-3 text-[11px] uppercase tracking-[0.14em] text-osu-f1 font-bold">
                    CSS reference
                  </div>
                  <CssManiaCardPanel
                    user={{
                      id: 0,
                      username: player,
                    } as OsuUser}
                    scores={[]}
                    loading
                  />
                </div>
                <div>
                  <div className="mb-3 text-[11px] uppercase tracking-[0.14em] text-osu-yellow font-bold">
                    ThreeJS production
                  </div>
                  <ManiaCardPanel
                    user={{
                      id: 0,
                      username: player,
                    } as OsuUser}
                    scores={[]}
                    loading
                  />
                </div>
              </div>
            )}
          </section>

          <aside className="rounded-lg border border-osu-b3/30 bg-osu-b4/35 p-4">
            <div className="text-[11px] uppercase tracking-[0.14em] text-osu-f1 font-bold">
              Previewing
            </div>
            <div className="mt-2 text-xl font-black text-white">
              {user?.username ?? player}
            </div>
            {user && (
              <>
                <div className="mt-2 flex items-center gap-2 text-sm text-osu-f1">
                  {user.country_code && (
                    <img
                      src={`https://osu.ppy.sh/images/flags/${user.country_code}.png`}
                      alt={user.country_code}
                      className="w-[22px] h-[15px] object-cover rounded-[2px]"
                    />
                  )}
                  <span>#{user.statistics?.global_rank?.toLocaleString() ?? "unranked"}</span>
                </div>
                <Link
                  to="/player/$username"
                  params={{ username: user.username }}
                  className="mt-4 inline-flex px-3 py-2 rounded-lg bg-osu-pink/15 text-xs font-bold text-osu-pink-light hover:bg-osu-pink/25 transition-colors"
                >
                  Open profile
                </Link>
              </>
            )}
            <div className="mt-5 border-t border-osu-b3/30 pt-4 text-xs leading-relaxed text-osu-f1">
              The ThreeJS column is the same shared <code>ManiaCardPanel</code> used by profile pages. The CSS column is only a reference while tuning the new renderer.
            </div>
          </aside>
        </div>
      </div>
    </main>
  );
}
