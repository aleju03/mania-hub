import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";
import { useLingui } from "@lingui/react/macro";

import { useAuth } from "../../lib/auth-context";
import {
  getMyChartLabelReport,
  submitChartLabelReport,
  withdrawChartLabelReport,
  type ChartLabelRateable,
  type ChartLabelReport,
} from "../../lib/chart-label-reports";
import { danLadderBounds, danScaleContextFor, danScaleImage, danScaleLabel, danTierColor, danTierSuffix, getDanTierImageSrc } from "../../lib/dan-images";
import { DAN_SKILLSET_META } from "../../lib/skill-axes";

/* The map card's "this chart is filed wrong" report. A flag at the corner of
   the verdict box turns the box into three taps: what the chart plays like,
   where it sits on the keymode's own dan ladder, and whether plays on it
   should count for ratings. One report per player per chart and rate; filing
   again edits it. Reports are a dataset for tuning the models (backend
   features/chart-label-reports.ts) and never change this chart's verdict. */

export interface ChartLabelContext {
  beatmapId: number;
  /** The rate the card shows the chart at. */
  rate: number;
  keyCount: number;
  /** The verdict on the card, or null where it shows none. */
  dan: { label: string; family: string; rawDan: number } | null;
  /** The tile the chart files under (its first dan tile or LN skillset). */
  filedTile: string | null;
  /** The card shows the chart as one whose plays count for nothing. */
  unrated: boolean;
}

const RICE = msg`Rice`;
// A level's five tiers, low to high, as dan labels write them.
const TIERS = ["--", "-", "", "+", "++"] as const;
const REASONS: Array<{ id: string; label: MessageDescriptor }> = [
  { id: "vibro", label: msg`Vibro / mash` },
  { id: "gimmick", label: msg`Gimmick` },
  { id: "joke", label: msg`Joke or broken` },
  { id: "rate_only", label: msg`Only at this rate` },
];

function isLnTile(tile: string | null): boolean {
  return tile != null && tile.startsWith("ln");
}

/** The dan tiles a player can pick (the backend's danSkillsetBuckets), the chart's own side first. */
function tileGroups(keyCount: number, lnChart: boolean): Array<{ side: "rice" | "ln"; tiles: string[] }> {
  const rice = keyCount === 4 ? ["speed", "stamina", "tech", "jack"] : ["stream", "speed", "jack", "tech"];
  // 4K's LN course stages and 7K's LN subtypes; other keymodes have one LN tile.
  const ln = keyCount === 4 ? ["lnhybrid", "lntechnical", "lnwalls", "lnspeed"]
    : keyCount === 7 ? ["lngeneral", "lntech", "lninverse", "lnrelease"]
    : ["ln"];
  const groups = [{ side: "rice" as const, tiles: rice }, { side: "ln" as const, tiles: ln }];
  return lnChart ? groups.reverse() : groups;
}

function FlagGlyph({ filled }: { filled: boolean }) {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden="true">
      <path d="M4 14V2.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path
        d="M4.5 3c2-1 3.6.8 5.6 0 .9-.4 1.6-.4 2.4-.2v6.4c-.8-.2-1.5-.2-2.4.2-2 .8-3.6-1-5.6 0z"
        fill={filled ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ChartLabelFlag({ open, reported, onToggle }: { open: boolean; reported: boolean; onToggle: () => void }) {
  const { t } = useLingui();
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      title={reported ? t`You reported this chart's label` : t`Report a wrong label`}
      aria-label={reported ? t`You reported this chart's label` : t`Report a wrong label`}
      className={`absolute right-1.5 top-1.5 grid h-6 w-6 cursor-pointer place-items-center rounded-md transition-colors ${
        open || reported ? "bg-osu-pink/20 text-osu-pink-light" : "text-osu-f1/40 hover:bg-white/[0.06] hover:text-osu-l1"
      }`}
    >
      <FlagGlyph filled={reported} />
    </button>
  );
}

/** Loads the viewer's report on the chart, so the flag shows it was filed. */
export function useOwnChartLabelReport(beatmapId: number | null, rate: number) {
  const viewerId = useAuth().viewer?.id ?? null;
  const [report, setReport] = useState<ChartLabelReport | null>(null);
  useEffect(() => {
    setReport(null);
    if (viewerId == null || beatmapId == null || !(beatmapId > 0)) return;
    let cancelled = false;
    void getMyChartLabelReport({ data: { beatmapId, rate } }).then((result) => {
      if (!cancelled) setReport(result.report);
    }).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [viewerId, beatmapId, rate]);
  return { signedIn: viewerId != null, report, setReport };
}

function Chip({ on, struck, dashed, onClick, children }: { on: boolean; struck?: boolean; dashed?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={`cursor-pointer rounded-full px-3 py-1 text-[11.5px] font-semibold transition-colors ${
        on ? "bg-osu-pink text-white"
          : `bg-white/[0.06] text-osu-l2 hover:bg-white/[0.1] ${dashed ? "outline-1 -outline-offset-1 outline-dashed outline-white/30" : ""}`
      } ${struck ? "line-through decoration-osu-f1/70 opacity-60" : ""}`}
    >
      {children}
    </button>
  );
}

function Question({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[10.5px] text-osu-f1/75">{title}</span>
      {children}
    </div>
  );
}

function DanLadder({ keyCount, family, filedLevel, filedTier, value, tier, onChange, onTier }: {
  keyCount: number;
  family: "dan" | "ln";
  filedLevel: number | null;
  filedTier: string;
  value: number | null;
  tier: string;
  onChange: (level: number | null) => void;
  onTier: (tier: string) => void;
}) {
  const { t } = useLingui();
  const context = danScaleContextFor(keyCount, family);
  const { min, max } = danLadderBounds(context);
  const levels = Array.from({ length: max - min + 1 }, (_, index) => min + index);
  const strip = useRef<HTMLDivElement>(null);
  const filedRef = useRef<HTMLButtonElement>(null);
  // Open on the filed level, centred, so the neighbours either side are in reach.
  useLayoutEffect(() => {
    const box = strip.current;
    const anchor = filedRef.current;
    if (!box || !anchor) return;
    box.scrollLeft = anchor.offsetLeft - box.clientWidth / 2 + anchor.clientWidth / 2;
  }, [context]);
  const picked = value == null ? null : danScaleLabel(value, context);
  return (
    <div className="flex flex-col gap-1.5">
    <div className="flex items-stretch gap-2">
      <div ref={strip} className="scroll-slim flex min-w-0 flex-1 gap-1 overflow-x-auto pb-1">
        {levels.map((level) => {
          const image = danScaleImage(level, context);
          const label = danScaleLabel(level, context);
          const on = value === level;
          const filed = filedLevel === level;
          return (
            <button
              key={level}
              ref={filed ? filedRef : undefined}
              type="button"
              aria-pressed={on}
              aria-label={label}
              onClick={() => onChange(on ? null : level)}
              className={`flex w-12 shrink-0 cursor-pointer flex-col items-center gap-0.5 rounded-lg px-1 pb-1 pt-1.5 transition-colors ${
                on ? "bg-osu-pink/25 ring-1 ring-inset ring-osu-pink" : "hover:bg-white/[0.06]"
              }`}
            >
              {image ? (
                <img src={image} alt="" className={`h-8 w-auto max-w-none object-contain ${filed && !on && value != null ? "opacity-45" : ""}`} />
              ) : (
                <span className="grid h-8 place-items-center text-[13px] font-bold text-osu-l1">{label}</span>
              )}
              <span className={`text-[9px] leading-none ${on ? "text-osu-pink-light" : "text-osu-f1/55"}`}>
                {filed ? t`filed` : image ? label : " "}
              </span>
            </button>
          );
        })}
      </div>
    </div>
    {/* Every dan spans five tiers, low to high; mid until one is picked. */}
    {picked != null && (
      <div className="flex flex-wrap gap-1">
        {TIERS.map((suffix) => {
          const label = `${picked}${suffix}`;
          const image = getDanTierImageSrc(label.toLowerCase(), family === "ln" ? "ln" : undefined, keyCount);
          const on = tier === suffix;
          const filed = value === filedLevel && filedTier === suffix;
          return (
            <button
              key={suffix || "mid"}
              type="button"
              aria-pressed={on}
              aria-label={label}
              onClick={() => onTier(suffix)}
              className={`flex min-w-12 cursor-pointer flex-col items-center gap-0.5 rounded-lg px-1.5 pb-1 pt-1.5 transition-colors ${
                on ? "bg-osu-pink/25 ring-1 ring-inset ring-osu-pink" : "hover:bg-white/[0.06]"
              }`}
            >
              {image ? (
                <img src={image} alt="" className="h-8 w-auto max-w-none object-contain" />
              ) : (
                <span className="grid h-8 place-items-center text-[13px] font-bold text-osu-l1">{label}</span>
              )}
              <span className="text-[9px] font-semibold leading-none" style={{ color: on ? undefined : danTierColor(suffix) ?? undefined }}>
                {filed ? t`filed` : suffix || t`mid`}
              </span>
            </button>
          );
        })}
      </div>
    )}
    </div>
  );
}

export function ChartLabelForm({ context, existing, onSaved, onWithdrawn, onCancel }: {
  context: ChartLabelContext;
  existing: ChartLabelReport | null;
  onSaved: (report: ChartLabelReport) => void;
  onWithdrawn: () => void;
  onCancel: () => void;
}) {
  const { t, i18n } = useLingui();
  const { keyCount, dan, filedTile, unrated, rate } = context;
  const lnChart = dan?.family === "ln";
  const [tile, setTile] = useState<string | null>(existing?.suggestedTile ?? null);
  const [level, setLevel] = useState<number | null>(existing?.suggestedLevel ?? null);
  const [tier, setTier] = useState<string>(existing?.suggestedTier ?? "");
  const [rateable, setRateable] = useState<ChartLabelRateable | null>(existing?.rateable ?? null);
  const [reasons, setReasons] = useState<string[]>(existing?.rateableReasons ?? []);
  const [note, setNote] = useState(existing?.note ?? "");
  const [state, setState] = useState<"idle" | "sending" | "error" | "capped">("idle");

  // The ladder follows the side the player says the chart is on.
  const family: "dan" | "ln" = tile == null ? (lnChart ? "ln" : "dan") : tile === "ln" || isLnTile(tile) ? "ln" : "dan";
  const filedLevel = dan && (dan.family === "ln") === (family === "ln") ? Math.round(dan.rawDan) : null;
  const filedTier = dan ? danTierSuffix(dan.label) : "";
  // A newly picked level starts at mid, or at the filed tier on the filed level.
  const pickLevel = (next: number | null) => {
    setLevel(next);
    setTier(next != null && next === filedLevel ? filedTier : "");
  };
  // A ladder exists for every keymode with dan courses; the others only get one when the chart has a verdict.
  const ladder = keyCount === 4 || keyCount === 6 || keyCount === 7 || dan != null;
  const groups = tileGroups(keyCount, lnChart);
  // Rice and LN both have a Tech (and 4K a Speed), so the groups are labelled
  // wherever LN has subtypes; a lone LN chip names itself.
  const labelled = groups.some((group) => group.side === "ln" && group.tiles[0] !== "ln");
  const tileLabel = (id: string) => {
    const meta = DAN_SKILLSET_META[id];
    return meta ? i18n._(meta.labelMsg) : id;
  };
  const tileChip = (id: string) => (
    <Chip
      key={id}
      on={tile === id}
      dashed={id === filedTile}
      struck={id === filedTile && tile != null && tile !== id}
      onClick={() => setTile(tile === id ? null : id)}
    >
      {tileLabel(id)}
    </Chip>
  );
  // The family change resets a level picked on the other ladder.
  useEffect(() => {
    if (level == null) return;
    const { min, max } = danLadderBounds(danScaleContextFor(keyCount, family));
    if (level < min || level > max) {
      setLevel(null);
      setTier("");
    }
  }, [family, keyCount, level]);

  const answered = tile != null || level != null || rateable != null || note.trim() !== "";
  const send = async () => {
    if (!answered || state === "sending") return;
    setState("sending");
    try {
      const result = await submitChartLabelReport({
        data: {
          beatmapId: context.beatmapId,
          rate,
          seenLabel: dan?.label ?? null,
          seenFamily: dan?.family ?? null,
          seenTile: filedTile,
          seenUnrated: unrated,
          suggestedTile: tile,
          suggestedLevel: level,
          suggestedTier: level == null ? null : tier,
          suggestedFamily: level == null ? null : family,
          rateable,
          rateableReasons: rateable == null ? [] : reasons,
          note: note.trim() || null,
        },
      });
      if (result.ok) onSaved(result.report);
      else setState(result.reason === "too_many_reports" || result.reason === "rate_limited" ? "capped" : "error");
    } catch {
      setState("error");
    }
  };
  const withdraw = async () => {
    setState("sending");
    const result = await withdrawChartLabelReport({ data: { beatmapId: context.beatmapId, rate } }).catch(() => ({ ok: false }));
    if (result.ok) onWithdrawn();
    else setState("error");
  };
  const toggleReason = (id: string) => setReasons((list) => list.includes(id) ? list.filter((reason) => reason !== id) : [...list, id]);

  return (
    <div className="flex w-full flex-col gap-3 border-t border-white/10 pt-3">
      <Question title={t`Plays like`}>
        {labelled ? (
          <div className="grid grid-cols-[auto_1fr] items-center gap-x-2.5 gap-y-1.5">
            {groups.map((group) => (
              <Fragment key={group.side}>
                <span className="text-[10px] font-bold uppercase tracking-wide text-osu-f1/55">
                  {group.side === "ln" ? i18n._(DAN_SKILLSET_META.ln.labelMsg) : i18n._(RICE)}
                </span>
                <div className="flex flex-wrap gap-1.5">{group.tiles.map(tileChip)}</div>
              </Fragment>
            ))}
          </div>
        ) : (
          <div className="flex flex-wrap gap-1.5">{groups.flatMap((group) => group.tiles).map(tileChip)}</div>
        )}
      </Question>

      {ladder && (
        <Question title={t`Level`}>
          <DanLadder
            keyCount={keyCount}
            family={family}
            filedLevel={filedLevel}
            filedTier={filedTier}
            value={level}
            tier={tier}
            onChange={pickLevel}
            onTier={setTier}
          />
        </Question>
      )}

      <Question title={unrated ? t`Should it be rated?` : t`Should plays on it count for ratings?`}>
        <div className="grid grid-cols-2 gap-1 rounded-lg bg-black/25 p-1">
          {(["yes", "no"] as const).map((answer) => (
            <button
              key={answer}
              type="button"
              aria-pressed={rateable === answer}
              onClick={() => setRateable(rateable === answer ? null : answer)}
              className={`cursor-pointer rounded-md py-1.5 text-[11.5px] font-semibold transition-colors ${
                rateable === answer ? "bg-white/[0.12] text-osu-l1" : "text-osu-f1/75 hover:text-osu-l1"
              }`}
            >
              {answer === "yes" ? t`Yes` : t`No`}
            </button>
          ))}
        </div>
        {rateable === "no" && !unrated && (
          <div className="flex flex-wrap gap-1.5">
            {REASONS.filter((reason) => reason.id !== "rate_only" || rate !== 1).map((reason) => (
              <Chip key={reason.id} on={reasons.includes(reason.id)} onClick={() => toggleReason(reason.id)}>
                {i18n._(reason.label)}
              </Chip>
            ))}
          </div>
        )}
      </Question>

      <input
        type="text"
        value={note}
        maxLength={300}
        onChange={(event) => setNote(event.target.value)}
        placeholder={t`Note (optional)`}
        className="w-full rounded-lg bg-black/25 px-3 py-2 text-[12px] text-osu-l1 placeholder:text-osu-f1/50 focus:outline-none focus:ring-1 focus:ring-osu-pink/60"
      />

      <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
        <span className="mr-auto text-[10.5px] text-osu-f1/60">
          {state === "error" ? t`Could not send it. Try again in a bit.`
            : state === "capped" ? t`That's a lot of reports for today. Try again tomorrow.`
            : null}
        </span>
        {existing && (
          <button type="button" onClick={withdraw} disabled={state === "sending"} className="cursor-pointer text-[11.5px] text-osu-f1/70 hover:text-osu-l1">
            {t`Withdraw`}
          </button>
        )}
        <button type="button" onClick={onCancel} className="cursor-pointer text-[11.5px] text-osu-f1/80 hover:text-osu-l1">
          {t`Cancel`}
        </button>
        <button
          type="button"
          onClick={send}
          disabled={!answered || state === "sending"}
          className="cursor-pointer rounded-lg bg-osu-pink px-4 py-1.5 text-[12px] font-bold text-white transition-opacity disabled:cursor-default disabled:opacity-40"
        >
          {existing ? t`Update` : t`Send`}
        </button>
      </div>
    </div>
  );
}

/** The flag and, while open, the form, laid inside the verdict box (which must be `relative` and wrap). */
export function ChartLabelSection({ context }: { context: ChartLabelContext }) {
  const { t } = useLingui();
  const { signedIn, report, setReport } = useOwnChartLabelReport(context.beatmapId, context.rate);
  const [open, setOpen] = useState(false);
  const [thanks, setThanks] = useState(false);
  useEffect(() => {
    setOpen(false);
    setThanks(false);
  }, [context.beatmapId, context.rate]);
  useEffect(() => {
    if (!thanks) return;
    const timer = window.setTimeout(() => setThanks(false), 2200);
    return () => window.clearTimeout(timer);
  }, [thanks]);
  // Signed in only: a report is one player's, edited in place.
  if (!signedIn || !(context.beatmapId > 0)) return null;
  return (
    <>
      <ChartLabelFlag open={open} reported={report != null} onToggle={() => { setThanks(false); setOpen((value) => !value); }} />
      {open ? (
        <ChartLabelForm
          key={`${context.beatmapId}:${context.rate}:${report?.updatedAt ?? 0}`}
          context={context}
          existing={report}
          onSaved={(saved) => { setReport(saved); setOpen(false); setThanks(true); }}
          onWithdrawn={() => { setReport(null); setOpen(false); }}
          onCancel={() => setOpen(false)}
        />
      ) : thanks ? (
        <p className="w-full border-t border-white/10 pt-2 text-[11px] text-osu-f1/75">{t`Thanks, noted. Tap the flag to change your answer.`}</p>
      ) : null}
    </>
  );
}
