import { Link, createFileRoute, notFound } from "@tanstack/react-router";
import { RotateCcw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { ConfirmModal } from "../../components/ui/ConfirmModal";
import { CountryFlag } from "../../components/ui/CountryFlag";
import { GradeImg } from "../../components/ui/GradeImg";
import { ModBadge } from "../../components/ui/ModBadge";
import { SearchInput } from "../../components/ui/SearchInput";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import {
  lookupAdminScoreRemoval,
  removeAdminScores,
  restoreAdminScores,
  type AdminScoreRemovalView,
  type AdminScoreRow,
} from "../../lib/admin-score-removal";
import { canUseAdminFeatures } from "../../lib/auth-shared";
import { listCompanellaAccountPlays, type CompanellaAccountPlay } from "../../lib/companella-accounts";
import { removeCompanellaPlay, setRateFlagHeld } from "../../lib/companella-rate-flags";
import { formatAccuracy, formatTimeAgo } from "../../lib/format";
import { searchPlayers, searchPlayersOnOsu } from "../../lib/player-search";

/* Removing specific plays of one player, such as cheated scores osu! still
 * serves. Official plays go through backend features/admin-score-removal.ts,
 * which deletes them everywhere and keeps every refresh from writing them back;
 * Restore lifts that, and the play returns as surfaces refresh from osu!.
 * Hashi plays use the same Exclude and Remove as /admin/bridgers.
 */

export const Route = createFileRoute("/admin/scores")({
  head: () => ({
    meta: [
      { title: "Remove plays - admin" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  beforeLoad: ({ context }) => {
    if (!canUseAdminFeatures(context.auth)) {
      throw notFound();
    }
    return undefined as never;
  },
  component: AdminScoresPage,
});

type PlayList = "top" | "recent";

const BUTTON_CLASS =
  "inline-flex items-center justify-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[12px] transition-colors duration-[120ms] disabled:opacity-50 disabled:cursor-default cursor-pointer";
const ACTION_CLASS = `${BUTTON_CLASS} border-osu-b3/30 bg-osu-b4/60 text-osu-l2 hover:bg-osu-b3/60 hover:text-white`;
const DANGER_CLASS = `${BUTTON_CLASS} border-osu-red/40 bg-osu-red/10 text-osu-red-light hover:bg-osu-red/20`;

/** Score ids from pasted osu! score links or bare ids. */
function parseScoreIds(text: string): number[] {
  const ids = text.split(/[\s,]+/).flatMap((part) => {
    const match = /(\d+)\/?$/.exec(part.trim());
    const id = match ? Number(match[1]) : NaN;
    return Number.isSafeInteger(id) && id > 0 ? [id] : [];
  });
  return [...new Set(ids)];
}

function chartLabel(row: { artist: string | null; title: string | null; version: string | null; beatmapId: number | null }): string {
  if (!row.title) return row.beatmapId ? `Beatmap ${row.beatmapId}` : "Unknown beatmap";
  return `${row.artist ? `${row.artist} - ` : ""}${row.title}${row.version ? ` [${row.version}]` : ""}`;
}

function AdminScoresPage() {
  const [view, setView] = useState<AdminScoreRemovalView | null>(null);
  const [hashiPlays, setHashiPlays] = useState<CompanellaAccountPlay[]>([]);
  const [list, setList] = useState<PlayList>("top");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [pasted, setPasted] = useState("");
  const [playQuery, setPlayQuery] = useState("");
  const [ask, setAsk] = useState<{ kind: "remove"; ids: number[] } | { kind: "hashi"; play: CompanellaAccountPlay } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async (lookup: string) => {
    setBusy(true);
    setError(null);
    try {
      const next = await lookupAdminScoreRemoval({ data: { query: lookup } });
      setView(next);
      setSelected(new Set());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, []);

  const lookup = (value: string) => {
    setMessage(null);
    void load(value);
  };

  const hashiUserId = view?.user.userId;
  const [hashiReload, setHashiReload] = useState(0);
  // Hashi plays are searched on the server: a player can have thousands.
  useEffect(() => {
    if (hashiUserId == null) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void listCompanellaAccountPlays({ data: { userId: hashiUserId, limit: 50, query: playQuery.trim(), sort: "pp" } })
        .then((page) => { if (!cancelled) setHashiPlays(page.entries.filter((play) => !play.removed)); })
        .catch(() => { if (!cancelled) setHashiPlays([]); });
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [hashiUserId, playQuery, hashiReload]);

  const needle = playQuery.trim().toLowerCase();
  const rows = (view ? (list === "top" ? view.topPlays : view.recentPlays) : [])
    .filter((row) => !needle || chartLabel(row).toLowerCase().includes(needle));
  const pastedIds = useMemo(() => parseScoreIds(pasted), [pasted]);
  const toRemove = useMemo(() => [...new Set([...selected, ...pastedIds])], [selected, pastedIds]);

  useEffect(() => { setSelected(new Set()); }, [view?.user.userId]);

  const toggle = (scoreId: number) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(scoreId)) next.delete(scoreId);
      else next.add(scoreId);
      return next;
    });
  };

  const run = async (action: () => Promise<string>) => {
    if (!view) return;
    setBusy(true);
    setError(null);
    try {
      setMessage(await action());
      setPasted("");
      setHashiReload((count) => count + 1);
      await load(`#${view.user.userId}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  };

  const confirm = () => {
    if (!view || !ask) return;
    const userId = view.user.userId;
    setAsk(null);
    if (ask.kind === "remove") {
      void run(async () => {
        const { removed } = await removeAdminScores({ data: { userId, scoreIds: ask.ids } });
        return `Removed ${removed} ${removed === 1 ? "play" : "plays"}. Skill ratings recompute shortly.`;
      });
    } else {
      void run(async () => {
        await setRateFlagHeld({ data: { scoreId: ask.play.scoreId, held: true } });
        await removeCompanellaPlay({ data: { scoreId: ask.play.scoreId } });
        return "Removed the Hashi play.";
      });
    }
  };

  const restore = (scoreId: number) => {
    if (!view) return;
    const userId = view.user.userId;
    void run(async () => {
      await restoreAdminScores({ data: { userId, scoreIds: [scoreId] } });
      return "Restored. The play returns as each surface refreshes from osu!.";
    });
  };

  return (
    <div className="flex-1">
      <div className="bg-osu-d5 border-b border-osu-b3/40">
        <div className="max-w-[1000px] mx-auto px-4 sm:px-5 py-3 flex items-center gap-3">
          <span className="block w-2.5 h-2.5 rounded-full bg-osu-red-light flex-shrink-0" />
          <h2 className="text-[13px] sm:text-[15px] font-medium text-osu-c2">Remove plays</h2>
        </div>
      </div>

      <div className="bg-osu-b5 min-h-[calc(100vh-60px)]">
        <div className="max-w-[1000px] mx-auto px-3 sm:px-5 py-4 sm:py-5 space-y-4">
          <SearchInput
            className="w-full"
            placeholder="find player..."
            onSearch={(q) => searchPlayers(q)}
            onSearchOsu={searchPlayersOnOsu}
            onSelect={(user) => lookup(`#${user.id}`)}
            onSubmit={(q) => lookup(q)}
          />

          {error ? <p className="text-[13px] text-osu-red-light">{error}</p> : null}
          {message ? <p className="text-[13px] text-osu-l2">{message}</p> : null}

          {view ? (
            <>
              <div className="flex items-center gap-3">
                {view.user.avatarUrl ? <img src={view.user.avatarUrl} alt="" className="h-10 w-10 rounded-full" /> : null}
                <Link to="/player/$username" params={{ username: view.user.username }} className="text-[17px] font-medium text-white hover:underline">
                  {view.user.username}
                </Link>
                {view.user.countryCode ? <CountryFlag code={view.user.countryCode} size="xs" decorative /> : null}
                <span className="text-[12px] text-osu-f1">#{view.user.userId}</span>
              </div>

              <input
                value={playQuery}
                onChange={(event) => setPlayQuery(event.target.value)}
                placeholder="search their plays by map..."
                className="w-full rounded-md bg-osu-b4/60 border border-osu-b3/30 px-3 py-2 text-[14px] text-white placeholder:text-osu-f1 outline-none focus:border-osu-b3"
              />

              <div className="flex flex-wrap items-center gap-2">
                <SegmentedControl
                  id="admin-scores-list"
                  value={list}
                  options={[
                    { value: "top", label: `Top plays (${view.topPlays.length})` },
                    { value: "recent", label: `Recent tracked (${view.recentPlays.length})` },
                  ]}
                  onChange={setList}
                />
                <input
                  value={pasted}
                  onChange={(event) => setPasted(event.target.value)}
                  placeholder="Or paste score links or ids"
                  className="flex-1 min-w-[220px] rounded-md bg-osu-b4/60 border border-osu-b3/30 px-3 py-1.5 text-[13px] text-white placeholder:text-osu-f1 outline-none focus:border-osu-b3"
                />
                <button
                  disabled={busy || toRemove.length === 0}
                  onClick={() => setAsk({ kind: "remove", ids: toRemove })}
                  className={DANGER_CLASS}
                >
                  <Trash2 size={13} />
                  Remove {toRemove.length || ""} {toRemove.length === 1 ? "play" : "plays"}
                </button>
              </div>

              <div>
                {rows.length === 0 ? (
                  <p className="py-6 text-center text-[13px] text-osu-f1">{needle ? "No plays match." : "No osu! plays stored for this player."}</p>
                ) : rows.map((row) => (
                  <ScoreRow key={row.scoreId} row={row} checked={selected.has(row.scoreId)} onToggle={() => toggle(row.scoreId)} />
                ))}
              </div>

              {view.removed.length > 0 ? (
                <section className="space-y-1">
                  <h3 className="text-[13px] font-medium text-osu-c2">Removed</h3>
                  {view.removed.map((row) => (
                    <div key={row.scoreId} className="flex items-center gap-3 py-2 border-t border-white/[0.07]">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[14px] text-osu-l2">{chartLabel(row)}</div>
                        <div className="text-[11px] text-osu-f1">
                          Score {row.scoreId}{row.legacyScoreId ? ` / ${row.legacyScoreId}` : ""}, removed {formatTimeAgo(row.removedAt)}
                        </div>
                      </div>
                      <button disabled={busy} onClick={() => restore(row.scoreId)} className={ACTION_CLASS}>
                        <RotateCcw size={13} />
                        Restore
                      </button>
                    </div>
                  ))}
                </section>
              ) : null}

              {hashiPlays.length > 0 ? (
                <section className="space-y-1">
                  <h3 className="text-[13px] font-medium text-osu-c2">Hashi plays</h3>
                  {hashiPlays.map((play) => (
                    <div key={play.scoreId} className="flex items-center gap-3 py-2 border-t border-white/[0.07]">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[14px] text-white">
                          {chartLabel({ ...play.chart, beatmapId: null })}
                        </div>
                        <div className="flex items-center gap-2 text-[11px] text-osu-f1">
                          {play.mods.map((mod) => <ModBadge key={mod} mod={mod} size={0.6} />)}
                          {play.accuracy != null ? <span>{formatAccuracy(play.accuracy)}</span> : null}
                          {play.playedAt ? <span>{formatTimeAgo(play.playedAt)}</span> : null}
                          {play.reviewState !== "clear" ? <span className="text-osu-red-light">Excluded</span> : null}
                        </div>
                      </div>
                      <span className="text-[15px] font-medium tabular-nums text-osu-l2">
                        {play.pp != null ? `${Math.round(play.pp)}pp` : ""}
                      </span>
                      <button disabled={busy} onClick={() => setAsk({ kind: "hashi", play })} className={DANGER_CLASS}>
                        <Trash2 size={13} />
                        Remove
                      </button>
                    </div>
                  ))}
                </section>
              ) : null}
            </>
          ) : null}
        </div>
      </div>

      {ask ? (
        <ConfirmModal
          title={ask.kind === "remove"
            ? `Remove ${ask.ids.length} ${ask.ids.length === 1 ? "play" : "plays"} from ${view?.user.username ?? "this player"}?`
            : "Remove this Hashi play?"}
          body={ask.kind === "remove"
            ? "They leave every surface and stay out when osu! serves them again."
            : "Its replay is deleted and the same replay is refused if sent again."}
          confirmLabel="Remove"
          danger
          onConfirm={confirm}
          onClose={() => setAsk(null)}
        />
      ) : null}
    </div>
  );
}

function ScoreRow({ row, checked, onToggle }: { row: AdminScoreRow; checked: boolean; onToggle: () => void }) {
  return (
    <label className={`flex items-center gap-3 py-2 border-t border-white/[0.07] cursor-pointer ${checked ? "bg-osu-red/10" : "hover:bg-white/[0.03]"}`}>
      <input type="checkbox" checked={checked} onChange={onToggle} className="ml-1 h-4 w-4 accent-[#ff6666]" />
      {row.rank ? <GradeImg grade={row.rank} size={20} /> : null}
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14px] text-white">{chartLabel(row)}</div>
        <div className="flex items-center gap-2 text-[11px] text-osu-f1">
          {row.mods.map((mod) => <ModBadge key={mod} mod={mod} size={0.6} />)}
          {row.accuracy != null ? <span>{formatAccuracy(row.accuracy)}</span> : null}
          {row.endedAt ? <span>{formatTimeAgo(row.endedAt)}</span> : null}
          <a
            href={`https://osu.ppy.sh/scores/${row.scoreId}`}
            target="_blank"
            rel="noreferrer"
            onClick={(event) => event.stopPropagation()}
            className="hover:text-white hover:underline"
          >
            {row.scoreId}
          </a>
        </div>
      </div>
      <span className="pr-2 text-[15px] font-medium tabular-nums text-osu-l2">
        {row.pp != null ? `${Math.round(row.pp)}pp` : ""}
      </span>
    </label>
  );
}
