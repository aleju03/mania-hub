import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import { Recycle } from "lucide-react";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  BLIND_CLEARED_COPY,
  BLIND_COPY,
  CHARM_BY_ID,
  CHARM_COPY,
  formatScore,
  RARITY_TINT,
  songMod,
  songTarget,
  type BlindId,
  type BossId,
  type OpenOutcome,
  type OpenPayLine,
  type PackRunOpenPayload,
  type RunCharm,
} from "#/lib/pack-run";
import { CharmKey } from "./CharmCard";
import { ModBadge } from "./ModBadge";
import { RUN_END_FEEL } from "./runEndFeel";
import { RUN_FEEL } from "./runFeel";
import { runSound } from "./runSound";
import { Shards } from "./Shards";

type TallyLine =
  | { kind: "song"; blind: BlindId; mod: BossId | null; target: number; shards: number }
  | { kind: "packs"; count: number; each: number | null; shards: number }
  | { kind: "charm"; uid: number | null; id: string; shards: number }
  | { kind: "win"; shards: number }
  | { kind: "xp"; xp: number }
  | { kind: "level"; level: number; shards: number | null };

/* The engine's line-by-line pay, checked at runtime since a backend that
   predates it sends none. */
function reportedPay(outcome: OpenOutcome): OpenPayLine[] | null {
  const pay: unknown = (outcome as Partial<OpenOutcome>).pay;
  if (!Array.isArray(pay) || pay.length === 0) return null;
  return pay.filter(
    (line): line is OpenPayLine =>
      Boolean(line) && typeof line === "object" && typeof (line as { kind?: unknown }).kind === "string" && typeof (line as { shards?: unknown }).shards === "number",
  );
}

/* Only what the outcome reports: the per-line pay when the server sends it,
   otherwise each cleared song's whole pay, the XP and the levels gained. */
function tallyLines(outcome: OpenOutcome): TallyLine[] {
  const before = outcome.blindBefore;
  const mod = songMod(before);
  const pay = reportedPay(outcome);
  const lines: TallyLine[] = [];
  if (pay) {
    for (const line of pay) {
      if (line.kind === "song") lines.push({ kind: "song", blind: line.blind, mod, target: before.target, shards: line.shards });
      else if (line.kind === "packs" && line.count > 0) lines.push({ kind: "packs", count: line.count, each: line.each, shards: line.shards });
      else if (line.kind === "charm") lines.push({ kind: "charm", uid: line.uid ?? null, id: line.id, shards: line.shards });
      else if (line.kind === "win") lines.push({ kind: "win", shards: line.shards });
    }
    if (outcome.xp > 0) lines.push({ kind: "xp", xp: outcome.xp });
    for (const line of pay) if (line.kind === "level") lines.push({ kind: "level", level: line.level, shards: line.shards });
    return lines;
  }
  for (const entry of outcome.cleared) {
    lines.push({ kind: "song", blind: entry.blind, mod, target: before.target, shards: entry.shards });
  }
  if (outcome.xp > 0) lines.push({ kind: "xp", xp: outcome.xp });
  for (const level of outcome.levelsGained) lines.push({ kind: "level", level, shards: null });
  return lines;
}

const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

/* A value that counts up from zero once it is on screen, then stamps. */
function CountUp({ value, instant, format }: { value: number; instant: boolean; format: (value: number) => React.ReactNode }) {
  const [shown, setShown] = useState(instant ? value : 0);
  const [stamp, setStamp] = useState(0);
  useEffect(() => {
    if (instant) {
      setShown(value);
      return;
    }
    const feel = RUN_END_FEEL.tally;
    const duration = Math.max(feel.countMinMs, Math.min(feel.countMaxMs, value * feel.countPerShardMs));
    const start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / duration);
      setShown(Math.floor(value * progress));
      if (progress < 1) frame = window.requestAnimationFrame(tick);
      else setStamp((key) => key + 1);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [instant, value]);
  return (
    <motion.span
      key={stamp}
      className="inline-block"
      initial={stamp > 0 ? { scale: 1.3 } : false}
      animate={{ scale: 1 }}
      transition={{ type: "spring", stiffness: 700, damping: 18 }}
    >
      {format(shown)}
    </motion.span>
  );
}

function ShardValue({ value, instant }: { value: number; instant: boolean }) {
  return (
    <CountUp
      value={value}
      instant={instant}
      format={(shown) => (
        <Shards
          value={shown}
          sign
          className="text-[22px] font-black leading-none text-[#ffd36b] md:text-[26px]"
        />
      )}
    />
  );
}

function juice(element: Element | null | undefined, amount = 0.28, rotateDeg = 9) {
  if (!element || typeof (element as HTMLElement).animate !== "function") return;
  const squash = 1 - RUN_FEEL.juice.squash * amount;
  (element as HTMLElement).animate(
    [
      { transform: `scale(${squash}) rotate(0deg)` },
      { transform: `scale(${1 + amount * 0.8}) rotate(${rotateDeg}deg)`, offset: 0.12 },
      { transform: `scale(${1 - amount * 0.3}) rotate(${-rotateDeg * 0.6}deg)`, offset: 0.3 },
      { transform: `scale(${1 + amount * 0.12}) rotate(${rotateDeg * 0.25}deg)`, offset: 0.55 },
      { transform: "scale(1) rotate(0deg)" },
    ],
    { duration: RUN_FEEL.juice.durationMs, easing: "linear" },
  );
}

/* The wallet count in the HUD (the visible one: the phone band and the
   desktop column both carry one). */
function walletElement(): HTMLElement | null {
  const marks = Array.from(document.querySelectorAll<SVGElement>("aside .lucide-recycle"));
  for (const mark of marks) {
    const rect = mark.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return (mark.parentElement as HTMLElement | null) ?? null;
  }
  return null;
}

interface Token {
  id: number;
  from: { x: number; y: number };
  to: { x: number; y: number };
  delay: number;
}

export interface RunTallyProps {
  payload: PackRunOpenPayload;
  /* The charms on the rail, to find the one a charm line paid for. */
  charms: RunCharm[];
  charmElements: () => Map<number, HTMLElement>;
  /* The HUD's wallet before and after this open, both as the server reported them. */
  walletFrom: number;
  walletTo: number;
  reducedMotion: boolean;
  onWallet: (value: number) => void;
  onShake: (amount: number) => void;
  onContinue: () => void;
}

/* A cleared song settles here: the panel comes up, each line of pay counts
   in on a beat with a rising note, the total lands, and the shards fly into
   the wallet before the shop. */
export function RunTally({
  payload,
  charms,
  charmElements,
  walletFrom,
  walletTo,
  reducedMotion,
  onWallet,
  onShake,
  onContinue,
}: RunTallyProps) {
  const { i18n } = useLingui();
  const { outcome } = payload;
  const lines = useMemo(() => tallyLines(outcome), [outcome]);
  const before = outcome.blindBefore;
  const won = Boolean(outcome.over?.won);
  const stageCleared = before.blind === "boss";
  const [shown, setShown] = useState(0);
  const [totalShown, setTotalShown] = useState(false);
  const [instant, setInstant] = useState(reducedMotion);
  const [settled, setSettled] = useState(false);
  /* The button arrives shortly after the total, while the shards still fly. */
  const [actionable, setActionable] = useState(false);
  const [tokens, setTokens] = useState<Token[]>([]);
  const totalRef = useRef<HTMLDivElement>(null);
  const skipRef = useRef<() => void>(() => {});
  const arrivedRef = useRef(0);
  const callbacks = useRef({ onWallet, onShake });
  callbacks.current = { onWallet, onShake };

  const charmUid = (line: Extract<TallyLine, { kind: "charm" }>) =>
    line.uid ?? charms.find((entry) => entry.id === line.id)?.uid ?? null;

  useEffect(() => {
    let cancelled = false;
    let skipped = reducedMotion;
    let release: () => void = () => {};
    const skip = new Promise<void>((resolve) => {
      release = resolve;
    });
    skipRef.current = () => {
      skipped = true;
      release();
    };
    const pause = (ms: number) => (skipped ? Promise.resolve() : Promise.race([wait(ms), skip]));
    const feel = RUN_END_FEEL.tally;

    const run = async () => {
      await pause(feel.enterMs + feel.landMs);
      if (cancelled) return;
      callbacks.current.onShake(feel.landShake);
      runSound.songCleared(stageCleared ? "stage" : "song");
      await pause(feel.firstLineMs);
      for (let index = 0; index < lines.length; index += 1) {
        if (cancelled) return;
        if (skipped) break;
        setShown(index + 1);
        runSound.tallyLine(index);
        const line = lines[index];
        if (line.kind === "charm") {
          const uid = charmUid(line);
          if (uid !== null) juice(charmElements().get(uid));
        }
        await pause(feel.lineMs);
      }
      if (cancelled) return;
      if (skipped) {
        setInstant(true);
        setShown(lines.length);
      } else {
        await pause(feel.totalLeadMs - feel.lineMs);
        if (cancelled) return;
      }
      setTotalShown(true);
      runSound.tallyTotal();
      callbacks.current.onShake(feel.totalShake);
      window.setTimeout(() => {
        if (!cancelled) setActionable(true);
      }, skipped ? 0 : feel.buttonMs);
      if (skipped || outcome.shards <= 0) {
        callbacks.current.onWallet(walletTo);
      } else {
        await pause(feel.flyLeadMs);
        if (cancelled) return;
        const wallet = walletElement();
        const source = totalRef.current?.getBoundingClientRect();
        const target = wallet?.getBoundingClientRect();
        if (skipped || !wallet || !source || !target) {
          callbacks.current.onWallet(walletTo);
        } else {
          const count = Math.max(3, Math.min(feel.flyMaxTokens, Math.ceil(outcome.shards / 4)));
          const from = { x: source.left + source.width / 2, y: source.top + source.height / 2 };
          const to = { x: target.left + target.width / 2, y: target.top + target.height / 2 };
          arrivedRef.current = 0;
          setTokens(
            Array.from({ length: count }, (_, id) => ({
              id,
              from: { x: from.x + (((id * 37) % 41) - 20), y: from.y + (((id * 23) % 17) - 8) },
              to,
              delay: id * feel.flyStaggerMs,
            })),
          );
          await pause((count - 1) * feel.flyStaggerMs + feel.flyMs + 60);
          if (cancelled) return;
          setTokens([]);
          callbacks.current.onWallet(walletTo);
        }
      }
      await pause(feel.settleMs);
      if (cancelled) return;
      setActionable(true);
      setSettled(true);
    };
    void run();
    return () => {
      cancelled = true;
    };
    // One sequence per payload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload]);

  const onTokenArrive = (count: number) => {
    arrivedRef.current += 1;
    const share = Math.min(1, arrivedRef.current / count);
    callbacks.current.onWallet(Math.round(walletFrom + (walletTo - walletFrom) * share));
    const wallet = walletElement();
    if (wallet) juice(wallet, 0.18, 0);
  };

  const nextStage = stageCleared && !won && !outcome.over ? payload.view.state : null;
  const nextSongs = nextStage
    ? (["small", "big", "boss"] as const).map((blind) => ({
        blind,
        target: songTarget(nextStage, blind),
        mod: songMod({ blind, boss: nextStage.blind.boss, stageMods: nextStage.blind.stageMods }),
      }))
    : [];

  const label = (line: TallyLine) => {
    switch (line.kind) {
      case "song":
        return (
          <div className="flex min-w-0 items-center gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-[16px] font-bold md:text-[18px]">
                {i18n._(BLIND_COPY[line.blind])}
                {line.mod && <ModBadge boss={line.mod} size="sm" />}
              </div>
              <div className="text-[12px] text-osu-f1 tabular-nums">
                <Trans>Target {formatScore(line.target)}</Trans>
              </div>
            </div>
          </div>
        );
      case "packs":
        return (
          <div className="flex items-baseline gap-2">
            <span className="text-[26px] font-black leading-none text-[#8fc1ff] tabular-nums md:text-[30px]">{line.count}</span>
            <span className="text-[15px] font-bold md:text-[16px]">
              <Trans>Packs left</Trans>
            </span>
            {line.each !== null && (
              <span className="text-[12px] text-osu-f1 tabular-nums">
                <Trans>{line.each} each</Trans>
              </span>
            )}
          </div>
        );
      case "charm": {
        const copy = CHARM_COPY[line.id];
        const tint = RARITY_TINT[CHARM_BY_ID.get(line.id)?.rarity ?? "common"];
        return (
          <div className="flex items-center gap-2.5">
            <CharmKey id={line.id} size={34} />
            <span className="text-[15px] font-bold md:text-[16px]" style={{ color: tint }}>
              {copy ? i18n._(copy.name) : line.id}
            </span>
          </div>
        );
      }
      case "win":
        return (
          <span className="text-[15px] font-bold text-[#6be0a0] md:text-[16px]">
            <Trans>Run cleared</Trans>
          </span>
        );
      case "xp":
        return (
          <span className="text-[15px] font-bold md:text-[16px]">
            <Trans>Collector XP</Trans>
          </span>
        );
      case "level":
        return (
          <span className="text-[15px] font-bold text-[#c58cff] md:text-[16px]">
            <Trans>Collector level {line.level}</Trans>
          </span>
        );
    }
  };

  const value = (line: TallyLine) => {
    if (line.kind === "xp") {
      return (
        <CountUp
          value={line.xp}
          instant={instant}
          format={(shown) => <span className="text-[20px] font-black leading-none text-[#c58cff] tabular-nums md:text-[22px]">+{shown.toLocaleString("en-US")} XP</span>}
        />
      );
    }
    if (line.kind === "level") return line.shards !== null ? <ShardValue value={line.shards} instant={instant} /> : null;
    return <ShardValue value={line.shards} instant={instant} />;
  };

  return (
    <div
      className="absolute inset-0 z-30 flex justify-center overflow-y-auto p-2 md:p-4"
      data-run-tally={settled ? "settled" : "playing"}
      translate="no"
      onPointerDown={() => {
        if (!settled) skipRef.current();
      }}
    >
      <motion.div
        aria-hidden="true"
        className="absolute inset-0 bg-black/45"
        initial={reducedMotion ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.25 }}
      />
      <motion.section
        aria-label={i18n._(BLIND_CLEARED_COPY[before.blind])}
        className="relative my-auto w-full max-w-[480px] rounded-2xl bg-osu-b6 px-4 pb-4 pt-4 md:px-7 md:pb-6 md:pt-6"
        initial={reducedMotion ? false : { y: RUN_END_FEEL.tally.panelFromPx, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{
          y: { ...RUN_END_FEEL.tally.panelSpring, delay: RUN_END_FEEL.tally.enterMs / 1000 },
          opacity: { duration: 0.12, delay: RUN_END_FEEL.tally.enterMs / 1000 },
        }}
      >
        <h2 className="text-[30px] font-black italic uppercase leading-none text-[#6be0a0] md:text-[42px]">
          {stageCleared ? <Trans>Stage {before.ante} cleared</Trans> : i18n._(BLIND_CLEARED_COPY[before.blind])}
        </h2>

        <div className="mt-3 md:mt-4">
          {/* Every line holds its place from the start, so the panel keeps
              its size while they count in. */}
          {lines.map((line, index) => (
            <motion.div
              key={`${line.kind}-${index}`}
              className={`flex items-center justify-between gap-3 py-2 md:py-2.5 ${index > 0 ? "border-t border-white/[0.07]" : ""}`}
              aria-hidden={index >= shown}
              initial={instant ? false : { opacity: 0, x: -14 }}
              animate={index < shown ? { opacity: 1, x: 0 } : { opacity: 0, x: -14 }}
              transition={{ type: "spring", stiffness: 600, damping: 32 }}
            >
              {label(line)}
              <div className="shrink-0 text-right">{index < shown && value(line)}</div>
            </motion.div>
          ))}
        </div>

        <div ref={totalRef} className="mt-1 flex min-h-[64px] items-center justify-between gap-3 border-t border-white/[0.07] pt-3 md:min-h-[78px]">
          {totalShown && (
            <>
              <span className="text-[13px] font-bold uppercase tracking-[0.14em] text-osu-f1">
                <Trans>Total</Trans>
              </span>
              <motion.div
                initial={instant ? false : { scale: 1.6, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ type: "spring", stiffness: 640, damping: 20 }}
              >
                <Shards value={outcome.shards} sign className="text-[44px] font-black leading-none text-[#ffd36b] md:text-[56px]" />
              </motion.div>
            </>
          )}
        </div>

        {nextStage && (
          <motion.div
            className="mt-3 border-t border-white/[0.07] pt-3"
            aria-hidden={!actionable}
            initial={instant ? false : { opacity: 0, y: 8 }}
            animate={actionable ? { opacity: 1, y: 0 } : { opacity: 0, y: 8 }}
            transition={{ duration: 0.22 }}
          >
            <div className="text-[18px] font-black italic uppercase leading-none md:text-[20px]">
              <Trans>Stage {nextStage.blind.ante}</Trans>
            </div>
            <div className="mt-2 grid grid-cols-3 gap-3">
              {nextSongs.map((song) => (
                <div key={song.blind} className="min-w-0">
                  <div className="flex items-center gap-1.5 text-[12px] font-bold text-osu-f1">
                    <span className="truncate">{i18n._(BLIND_COPY[song.blind])}</span>
                    {song.mod && <ModBadge boss={song.mod} size="sm" />}
                  </div>
                  <div className="mt-0.5 text-[18px] font-black leading-none tabular-nums md:text-[20px]">{formatScore(song.target)}</div>
                </div>
              ))}
            </div>
          </motion.div>
        )}

        <motion.button
            type="button"
            disabled={!actionable}
            tabIndex={actionable ? 0 : -1}
            data-run-tally-continue={actionable ? "" : undefined}
            onClick={() => {
              runSound.uiTap();
              onContinue();
            }}
            className={`mt-4 w-full rounded-xl py-3 text-[16px] font-black text-white transition-[filter] hover:brightness-110 md:mt-5 ${
              won ? "bg-osu-pink" : "bg-[#2f9e63]"
            }`}
            initial={instant ? false : { opacity: 0, y: 10 }}
            animate={actionable ? { opacity: 1, y: 0 } : { opacity: 0, y: 10 }}
            transition={{ type: "spring", stiffness: 520, damping: 28 }}
          >
            {won ? <Trans>Continue</Trans> : <Trans>Shop</Trans>}
          </motion.button>
      </motion.section>

      {tokens.length > 0 &&
        createPortal(
          <div aria-hidden="true" className="pointer-events-none fixed inset-0 z-[80]">
            {tokens.map((token) => (
              <motion.span
                key={token.id}
                className="absolute left-0 top-0 text-[#ffd36b]"
                initial={{ x: token.from.x - 10, y: token.from.y - 10, scale: 0.6, opacity: 0 }}
                animate={{
                  x: [token.from.x - 10, (token.from.x + token.to.x) / 2 - 10, token.to.x - 10],
                  y: [token.from.y - 10, Math.min(token.from.y, token.to.y) - RUN_END_FEEL.tally.flyArcPx - 10, token.to.y - 10],
                  scale: [0.6, 1.15, 0.7],
                  opacity: [0, 1, 1],
                }}
                transition={{ duration: RUN_END_FEEL.tally.flyMs / 1000, delay: token.delay / 1000, ease: "easeIn", times: [0, 0.45, 1] }}
                onAnimationComplete={() => onTokenArrive(tokens.length)}
              >
                <Recycle className="h-5 w-5" />
              </motion.span>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
