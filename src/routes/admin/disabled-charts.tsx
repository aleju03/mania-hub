import { createFileRoute, notFound } from "@tanstack/react-router";
import { Ban, RotateCcw, Search, X } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { PageHeader } from "../../components/layout/PageHeader";
import { ConfirmModal } from "../../components/ui/ConfirmModal";
import { StarRatingBadge } from "../../components/ui/StarRating";
import { beatmapStatusPill } from "../../lib/beatmap-status";
import { canUseAdminFeatures } from "../../lib/auth-shared";
import { formatNumber, formatTimeAgo } from "../../lib/format";
import {
  disableRatingChart,
  enableRatingChart,
  listRatingDisabledCharts,
  lookupRatingDisabledChart,
  parseBeatmapIdInput,
  searchRatingDisabledCharts,
  type RatingDisabledChartLookup,
  type RatingDisabledChartSearchResult,
  type RatingDisabledChartMember,
  type RatingDisabledChartsView,
} from "../../lib/rating-disabled-charts";

/* Turning a chart off for skill ratings while a fix is worked on, and back on
 * once it ships. The backend (features/rating-disabled-charts.ts) covers the
 * chart's whole family and refolds every player's stored rating on each
 * toggle; this page shows that walk until it finishes. */

export const Route = createFileRoute("/admin/disabled-charts")({
  head: () => ({
    meta: [
      { title: "Disabled charts - admin" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  beforeLoad: ({ context }) => {
    if (!canUseAdminFeatures(context.auth)) throw notFound();
    return undefined as never;
  },
  component: DisabledChartsPage,
});

const BUTTON_CLASS =
  "inline-flex items-center justify-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[12px] transition-colors duration-[120ms] disabled:opacity-50 disabled:cursor-default cursor-pointer";
const ACTION_CLASS = `${BUTTON_CLASS} border-osu-b3/30 bg-osu-b4/60 text-osu-l2 hover:bg-osu-b3/60 hover:text-white`;
const DANGER_CLASS = `${BUTTON_CLASS} border-osu-red/40 bg-osu-red/10 text-osu-red-light hover:bg-osu-red/20`;
const INPUT_CLASS =
  "rounded-md bg-osu-b4/60 border border-osu-b3/30 px-3 py-2 text-[14px] text-white placeholder:text-osu-f1 outline-none focus:border-osu-b3";

function chartLabel(member: RatingDisabledChartMember | undefined, beatmapId: number): string {
  if (!member?.title) return `Beatmap ${beatmapId}`;
  return `${member.artist ? `${member.artist} - ` : ""}${member.title}${member.version ? ` [${member.version}]` : ""}`;
}

function osuLink(member: Pick<RatingDisabledChartMember, "beatmapId" | "beatmapsetId">): string {
  return member.beatmapsetId
    ? `https://osu.ppy.sh/beatmapsets/${member.beatmapsetId}#mania/${member.beatmapId}`
    : `https://osu.ppy.sh/beatmaps/${member.beatmapId}`;
}

function Hairline() {
  return <span aria-hidden className="h-3 w-px shrink-0 bg-white/15" />;
}

function ChartCover({ beatmapsetId, small = false }: { beatmapsetId: number | null; small?: boolean }) {
  const [failed, setFailed] = useState(false);
  const size = small ? "h-[34px] w-[54px]" : "h-[56px] w-[88px]";
  if (beatmapsetId == null || failed) return <div className={`${size} shrink-0 rounded-md bg-osu-b4`} />;
  return (
    <img
      src={`https://assets.ppy.sh/beatmaps/${beatmapsetId}/covers/list@2x.jpg`}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
      className={`${size} shrink-0 rounded-md bg-osu-b4 object-cover`}
    />
  );
}

function StatusPill({ status }: { status: string | null }) {
  const pill = status ? beatmapStatusPill(status) : null;
  if (!pill || !status) return null;
  return (
    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-extrabold uppercase leading-none ${pill.className}`}>
      {status === "approved" ? "ranked" : status}
    </span>
  );
}

function ChartRow({ chart, meta, right }: { chart: RatingDisabledChartMember; meta?: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-center gap-3.5 min-w-0">
      <ChartCover beatmapsetId={chart.beatmapsetId} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[15px] font-medium leading-tight text-white">{chart.title || `Beatmap ${chart.beatmapId}`}</div>
        <div className="mt-1 flex min-w-0 items-center gap-2">
          {chart.stars != null ? <StarRatingBadge stars={chart.stars} size={1.1} /> : null}
          {chart.keyCount ? <span className="shrink-0 text-[12px] font-semibold text-osu-l2">{chart.keyCount}K</span> : null}
          <span className="truncate text-[13px] text-osu-l2">{chart.version}</span>
          <StatusPill status={chart.status} />
        </div>
        <div className="mt-1 flex min-w-0 items-center gap-2 text-[11px] text-osu-f1">
          {chart.artist ? <span className="truncate">{chart.artist}</span> : null}
          {chart.creator ? <><Hairline /><span className="shrink-0">mapped by {chart.creator}</span></> : null}
          {meta}
        </div>
      </div>
      {right}
    </div>
  );
}

function MemberLine({ member }: { member: RatingDisabledChartMember }) {
  return (
    <div className="flex items-center gap-2.5 py-1.5 border-t border-white/[0.07] text-[12px] text-osu-f1">
      <ChartCover beatmapsetId={member.beatmapsetId} small />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] text-osu-l2">{chartLabel(member, member.beatmapId)}</div>
        <div className="flex items-center gap-2">
          <a href={osuLink(member)} target="_blank" rel="noreferrer" className="tabular-nums hover:text-white hover:underline">
            {member.beatmapId}
          </a>
          {member.keyCount ? <><Hairline /><span>{member.keyCount}K</span></> : null}
          {member.stars != null ? <><Hairline /><span className="tabular-nums">{member.stars.toFixed(2)}*</span></> : null}
          {member.creator ? <><Hairline /><span className="truncate">{member.creator}</span></> : null}
        </div>
      </div>
      <StatusPill status={member.status} />
    </div>
  );
}

function Reuploads({ members }: { members: RatingDisabledChartMember[] }) {
  const [open, setOpen] = useState(false);
  const others = members.slice(1);
  if (others.length === 0) return null;
  return (
    <div>
      <button onClick={() => setOpen((value) => !value)} className="text-[12px] text-osu-f1 hover:text-white cursor-pointer">
        {open ? "Hide" : "Show"} {others.length} other {others.length === 1 ? "beatmap" : "beatmaps"} with the same notes
      </button>
      {open ? <div className="mt-1.5">{others.map((member) => <MemberLine key={member.beatmapId} member={member} />)}</div> : null}
    </div>
  );
}

function WalkLine({ walk }: { walk: RatingDisabledChartsView["walk"] }) {
  if (!walk) return null;
  return (
    <p className="flex items-center gap-2 text-[12px] text-osu-f1">
      <span className={walk.finishedAt ? "" : "text-osu-l2"}>
        {walk.finishedAt ? `Ratings updated ${formatTimeAgo(walk.finishedAt)}` : "Updating ratings"}
      </span>
      <Hairline />
      <span className="tabular-nums">{formatNumber(walk.scanned)} checked</span>
      <Hairline />
      <span className="tabular-nums">{formatNumber(walk.rewritten)} changed</span>
    </p>
  );
}

function DisabledChartsPage() {
  const [view, setView] = useState<RatingDisabledChartsView | null>(null);
  const [input, setInput] = useState("");
  const [note, setNote] = useState("");
  const [lookup, setLookup] = useState<RatingDisabledChartLookup | null>(null);
  const [results, setResults] = useState<RatingDisabledChartSearchResult[] | null>(null);
  const [ask, setAsk] = useState<{ kind: "disable" | "enable"; beatmapId: number; label: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setView(await listRatingDisabledCharts());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // Poll while the walk over stored ratings is still going.
  const walking = view?.walk != null && view.walk.finishedAt == null;
  useEffect(() => {
    if (!walking) return;
    const timer = setInterval(() => { void refresh(); }, 3000);
    return () => clearInterval(timer);
  }, [walking, refresh]);

  // Names search as you type; an id or a difficulty link opens that chart.
  useEffect(() => {
    const q = input.trim();
    if (q.length < 2 || parseBeatmapIdInput(q) != null) {
      setResults(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void searchRatingDisabledCharts({ data: { q } })
        .then((next) => { if (!cancelled) setResults(next); })
        .catch(() => { if (!cancelled) setResults([]); });
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [input]);

  const open = async (beatmapId: number) => {
    setError(null);
    setBusy(true);
    try {
      setLookup(await lookupRatingDisabledChart({ data: { beatmapId } }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const find = () => {
    const beatmapId = parseBeatmapIdInput(input);
    if (beatmapId != null) void open(beatmapId);
    else if (results?.length) void open(results[0].beatmapId);
  };

  const confirm = async () => {
    if (!ask) return;
    const { kind, beatmapId } = ask;
    setAsk(null);
    setBusy(true);
    setError(null);
    try {
      setView(kind === "disable"
        ? await disableRatingChart({ data: { beatmapId, note } })
        : await enableRatingChart({ data: { beatmapId } }));
      if (kind === "disable") {
        setLookup(null);
        setInput("");
        setNote("");
      } else if (lookup) {
        setLookup(await lookupRatingDisabledChart({ data: { beatmapId: lookup.beatmapId } }));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const found = lookup?.members[0];
  const showResults = results != null && lookup == null;

  return (
    <div className="flex-1 bg-osu-b5">
      <PageHeader iconSrc="/images/icons/beatmapsets.svg" title="Disabled charts" />
      <div className="max-w-[1000px] mx-auto px-3 sm:px-5 py-4 sm:py-5 space-y-6">
        <div className="space-y-2">
          <form className="relative" onSubmit={(event) => { event.preventDefault(); find(); }}>
            <Search size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-osu-f1" />
            <input
              value={input}
              onChange={(event) => { setInput(event.target.value); setLookup(null); }}
              placeholder="search a map, or paste a link or id..."
              className={`${INPUT_CLASS} w-full pl-10 py-2.5 text-[15px]`}
            />
          </form>
          {error ? <p className="text-[13px] text-osu-red-light">{error}</p> : null}
        </div>

        {showResults ? (
          results.length === 0 ? (
            <p className="py-4 text-center text-[13px] text-osu-f1">No played charts match.</p>
          ) : (
            <div className="-mt-2">
              {results.map((result) => (
                <button
                  key={result.beatmapId}
                  onClick={() => void open(result.beatmapId)}
                  className="block w-full rounded-md px-2 py-2.5 text-left transition-colors duration-[120ms] hover:bg-white/[0.04] cursor-pointer"
                >
                  <ChartRow
                    chart={result}
                    meta={result.sameNotes > 0 ? <><Hairline /><span className="shrink-0">{result.sameNotes} more with the same notes</span></> : null}
                    right={(
                      <div className="flex shrink-0 items-center gap-4">
                        {result.disabled ? <span className="text-[12px] font-medium text-osu-red-light">Disabled</span> : null}
                        <div className="w-[64px] text-right">
                          <div className="text-[15px] tabular-nums text-white">{formatNumber(result.playCount)}</div>
                          <div className="text-[11px] text-osu-f1">plays</div>
                        </div>
                      </div>
                    )}
                  />
                </button>
              ))}
            </div>
          )
        ) : null}

        {lookup && found ? (
          <section className="rounded-lg bg-osu-b4/40 px-4 py-4 space-y-3">
            <ChartRow
              chart={found}
              meta={<><Hairline /><a href={osuLink(found)} target="_blank" rel="noreferrer" className="shrink-0 tabular-nums hover:text-white hover:underline">{found.beatmapId}</a></>}
              right={(
                <button onClick={() => setLookup(null)} aria-label="Close" className="shrink-0 self-start rounded p-1 text-osu-f1 hover:text-white cursor-pointer">
                  <X size={16} />
                </button>
              )}
            />
            {!lookup.fingerprinted ? (
              <p className="text-[12px] text-osu-f1">No fingerprint yet, so only this beatmap id is covered.</p>
            ) : null}
            <Reuploads members={lookup.members} />
            <div className="border-t border-white/[0.07] pt-3">
              {lookup.disabled ? (
                <div className="flex items-center gap-3">
                  <span className="flex-1 text-[13px] text-osu-red-light">Disabled</span>
                  <button
                    disabled={busy}
                    onClick={() => setAsk({ kind: "enable", beatmapId: lookup.beatmapId, label: chartLabel(found, lookup.beatmapId) })}
                    className={ACTION_CLASS}
                  >
                    <RotateCcw size={13} />
                    Enable
                  </button>
                </div>
              ) : lookup.coveredBy != null ? (
                <p className="text-[13px] text-osu-l2">Already disabled through beatmap {lookup.coveredBy}.</p>
              ) : (
                <div className="flex gap-2">
                  <input
                    value={note}
                    onChange={(event) => setNote(event.target.value)}
                    placeholder="note (optional)"
                    maxLength={300}
                    className={`${INPUT_CLASS} flex-1 min-w-0 py-1.5 text-[13px]`}
                  />
                  <button
                    disabled={busy}
                    onClick={() => setAsk({ kind: "disable", beatmapId: lookup.beatmapId, label: chartLabel(found, lookup.beatmapId) })}
                    className={DANGER_CLASS}
                  >
                    <Ban size={13} />
                    Disable
                  </button>
                </div>
              )}
            </div>
          </section>
        ) : null}

        <section>
          <div className="mb-1 flex items-baseline justify-between gap-3">
            <h3 className="text-[14px] font-medium text-osu-c2">
              Disabled{view ? <span className="ml-1.5 tabular-nums text-osu-f1">{view.charts.length}</span> : null}
            </h3>
            <WalkLine walk={view?.walk ?? null} />
          </div>
          {view && view.charts.length === 0 ? (
            <p className="py-6 text-center text-[13px] text-osu-f1">No charts are disabled.</p>
          ) : view?.charts.map((chart) => {
            const named = chart.members[0];
            return (
              <div key={chart.beatmapId} className="space-y-2 border-t border-white/[0.07] px-2 py-3">
                {named ? (
                  <ChartRow
                    chart={named}
                    meta={<><Hairline /><span className="shrink-0">disabled {formatTimeAgo(chart.disabledAt)}</span></>}
                    right={(
                      <button
                        disabled={busy}
                        onClick={() => setAsk({ kind: "enable", beatmapId: chart.beatmapId, label: chartLabel(named, chart.beatmapId) })}
                        className={`${ACTION_CLASS} shrink-0`}
                      >
                        <RotateCcw size={13} />
                        Enable
                      </button>
                    )}
                  />
                ) : null}
                {chart.note ? <p className="pl-[102px] text-[13px] text-osu-l2">{chart.note}</p> : null}
                <div className="pl-[102px]"><Reuploads members={chart.members} /></div>
              </div>
            );
          })}
        </section>
      </div>

      {ask ? (
        <ConfirmModal
          title={ask.kind === "disable" ? `Disable ${ask.label}?` : `Enable ${ask.label}?`}
          body={ask.kind === "disable"
            ? "Plays on it and on beatmaps with the same notes stop counting toward skill ratings and dan."
            : "Plays on it count toward skill ratings and dan again."}
          confirmLabel={ask.kind === "disable" ? "Disable" : "Enable"}
          danger={ask.kind === "disable"}
          onConfirm={() => void confirm()}
          onClose={() => setAsk(null)}
        />
      ) : null}
    </div>
  );
}
