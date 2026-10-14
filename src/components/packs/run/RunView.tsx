import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { fetchLivePackRunBoard, type LivePackRunBoardEntry } from "#/lib/live-backend";
import {
  BLIND_COPY,
  BLINDS,
  blindPacks,
  blindTarget,
  BOSS_COPY,
  EDITION_COPY,
  EDITION_TINT,
  formatScore,
  HAND_BASE,
  HAND_TYPE_COPY,
  HAND_TYPES,
  rerollCost,
  rerollsLeft,
  RUN_EDITIONS,
  RUNG_COPY,
  sellValue,
  WINNING_ANTE,
  WRAPPER_COPY,
  xpForNextLevel,
} from "#/lib/pack-run";
import { CharmKey, CharmRow, EmptyKey } from "./CharmCard";
import { NudgeGlyph, RerollGlyph } from "./charmGlyphs";
import { Shards } from "./Shards";
import { ModBadge } from "./ModBadge";
import type { PackRunApi } from "./usePackRun";

const REFUSALS: Record<string, MessageDescriptor> = {
  no_shards: msg`Not enough shards.`,
  no_rerolls: msg`No rerolls left in this shop.`,
  no_slot: msg`Every charm slot is full. Sell one first.`,
  sold: msg`Already bought.`,
};

function Hairline() {
  return <span className="mx-2.5 inline-block h-3.5 w-px translate-y-[2px] bg-white/15" />;
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <div className="text-[11px] font-bold uppercase tracking-[0.16em] text-osu-f1">{children}</div>;
}

/* The run on its own page inside /packs: the stage's three songs, the charms
   held and the shop, the collector level and the collection ladder, and how a
   pack scores. Everything here is the server's; buttons send one action and
   draw the run it answers with. */
export function RunView({ api, shards }: { api: PackRunApi; shards: number }) {
  const { t, i18n } = useLingui();
  const [error, setError] = useState<string | null>(null);
  const [board, setBoard] = useState<LivePackRunBoardEntry[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    void fetchLivePackRunBoard()
      .then((entries) => {
        if (!cancelled) setBoard(entries);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const view = api.view;
  if (!view) {
    return (
      <div className="py-16 text-center text-[12px] text-osu-f1">
        <Trans>Loading your run...</Trans>
      </div>
    );
  }
  const { state, unlocks } = view;
  const { blind, progress } = state;
  const act = async (action: Parameters<PackRunApi["act"]>[0]) => {
    setError(null);
    const refusal = await api.act(action);
    if (refusal) setError(REFUSALS[refusal] ? i18n._(REFUSALS[refusal]) : t`That did not go through. Please try again.`);
  };
  const cost = rerollCost(state);
  const rerolls = rerollsLeft(state);
  const nextRung = view.rungs.find((rung) => !rung.reached) ?? null;
  const previousRungAt = [...view.rungs].reverse().find((rung) => rung.reached)?.at ?? 0;
  const xpNeeded = xpForNextLevel(progress.level);

  const stageCount = Math.max(WINNING_ANTE, blind.ante);

  return (
    <div className="mx-auto w-full max-w-[720px]" translate="no">
      <div className="text-[12px] text-osu-f1 tabular-nums">
        <Trans>Run {state.runId}</Trans>
        <Hairline />
        <Trans>Best stage {progress.bestAnte}</Trans>
        <Hairline />
        <Plural value={progress.runsWon} one="# run cleared" other="# runs cleared" />
      </div>

      {/* The stage, and the eight it takes to clear a run. */}
      <div className="mt-5 flex items-end gap-3">
        <span className="text-[44px] font-black italic uppercase leading-none text-white tabular-nums">
          <Trans>Stage {blind.ante}</Trans>
        </span>
        <span className="pb-1 text-[13px] text-osu-f1 tabular-nums">/ {WINNING_ANTE}</span>
        <Shards value={shards} className="ml-auto pb-0.5 text-[22px] font-black leading-none text-white" />
      </div>
      <div className="mt-3 flex gap-1">
        {Array.from({ length: stageCount }, (_, index) => {
          const stage = index + 1;
          const fill = stage < blind.ante ? "#ff66aa" : stage === blind.ante ? "#ffffff" : "rgba(255,255,255,0.08)";
          return <span key={stage} className="h-1.5 flex-1 rounded-full" style={{ background: fill }} />;
        })}
      </div>

      {/* The stage's three songs, as a song select. */}
      <div className="mt-6 flex flex-col">
        {BLINDS.map((id) => {
          const index = BLINDS.indexOf(id);
          const current = BLINDS.indexOf(blind.blind);
          const isCurrent = index === current && !state.over;
          const isDone = index < current;
          const boss = id === "boss" ? blind.boss : null;
          const target = isCurrent ? blind.target : blindTarget(blind.ante, id, boss);
          return (
            <div
              key={id}
              className={`relative border-t border-white/[0.07] py-3.5 pl-4 pr-1 ${isCurrent ? "bg-white/[0.04]" : ""} ${isDone ? "opacity-40" : ""}`}
            >
              {isCurrent && <span className="absolute inset-y-0 left-0 w-[3px] bg-osu-pink" />}
              <div className="flex items-center gap-2.5">
                <span className={`text-[16px] font-bold ${isCurrent ? "text-white" : "text-osu-f1"}`}>{i18n._(BLIND_COPY[id])}</span>
                {boss && <ModBadge boss={boss} />}
                {isDone && (
                  <span className="text-[11px] font-bold uppercase tracking-wider text-[#6be0a0]">
                    <Trans context="a dan course pass">Clear</Trans>
                  </span>
                )}
                <span className="ml-auto text-[22px] font-black leading-none text-white tabular-nums">{formatScore(target)}</span>
              </div>
              {boss && (
                <div className="mt-1 text-[12px] text-osu-f1">
                  <span className="font-bold text-white">{i18n._(BOSS_COPY[boss].name)}</span> {i18n._(BOSS_COPY[boss].text)}
                </div>
              )}
              {isCurrent ? (
                <div className="mt-2.5 flex items-center gap-3">
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-osu-b5/70">
                    <div
                      className="h-full rounded-full bg-[#8fc1ff]"
                      style={{ width: `${Math.max(2, Math.min(100, (blind.score / Math.max(1, blind.target)) * 100))}%` }}
                    />
                  </div>
                  <span className="text-[12px] font-bold text-white tabular-nums">{formatScore(blind.score)}</span>
                  <span className="text-[11px] text-osu-f1 tabular-nums">
                    <Plural value={blind.packsLeft} one="# pack left" other="# packs left" />
                  </span>
                </div>
              ) : (
                !isDone && (
                  <div className="mt-1 text-[11px] text-osu-f1">
                    <Plural value={blindPacks(id, boss)} one="# pack" other="# packs" />
                  </div>
                )
              )}
            </div>
          );
        })}
      </div>

      {state.over && (
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.07] pt-4">
          <div className="text-[18px] font-black text-white">
            {state.over.won ? <Trans>Run cleared</Trans> : <Trans>Failed at stage {state.over.ante}</Trans>}
            <span className="ml-3 text-[13px] font-normal text-osu-f1">
              <Trans>Best pack {formatScore(state.over.bestHand)}</Trans>
            </span>
          </div>
          <button
            type="button"
            disabled={api.busy}
            onClick={() => void act({ kind: "newRun" })}
            className="rounded-full bg-osu-pink px-5 py-2 text-sm font-bold text-white transition hover:brightness-110 disabled:opacity-50"
          >
            <Trans>New run</Trans>
          </button>
        </div>
      )}

      {error && <div className="mt-4 text-center text-[12px] text-osu-pink-light">{error}</div>}

      {/* Charms held, as a key row: one key per slot, in the order they fire. */}
      <div className="mt-10 flex items-baseline justify-between">
        <SectionTitle>
          <Trans>Charms</Trans>
        </SectionTitle>
        <span className="text-[13px] font-black italic text-white tabular-nums">{unlocks.slots}K</span>
      </div>
      <div className="mt-3 flex gap-2">
        {Array.from({ length: unlocks.slots }, (_, index) => {
          const charm = state.charms[index];
          return (
            <span key={charm ? charm.uid : `empty-${index}`} className="flex flex-1 justify-center">
              {charm ? <CharmKey id={charm.id} charm={charm} size={52} /> : <EmptyKey size={52} />}
            </span>
          );
        })}
      </div>
      {state.charms.length > 0 && (
        <div className="mt-4 flex flex-col divide-y divide-white/[0.06]">
          {state.charms.map((charm, index) => (
            <CharmRow
              key={charm.uid}
              id={charm.id}
              charm={charm}
              trailing={
                <>
                  <button
                    type="button"
                    aria-label={t`Move left`}
                    disabled={api.busy || index === 0}
                    onClick={() => void act({ kind: "move", uid: charm.uid, to: index - 1 })}
                    className="grid h-8 w-7 place-items-center rounded-md text-osu-f1 hover:bg-white/5 hover:text-white disabled:opacity-30"
                  >
                    <NudgeGlyph direction="left" />
                  </button>
                  <button
                    type="button"
                    aria-label={t`Move right`}
                    disabled={api.busy || index === state.charms.length - 1}
                    onClick={() => void act({ kind: "move", uid: charm.uid, to: index + 1 })}
                    className="grid h-8 w-7 place-items-center rounded-md text-osu-f1 hover:bg-white/5 hover:text-white disabled:opacity-30"
                  >
                    <NudgeGlyph direction="right" />
                  </button>
                  <button
                    type="button"
                    disabled={api.busy || Boolean(state.over)}
                    onClick={() => void act({ kind: "sell", uid: charm.uid })}
                    className="ml-1 inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[12px] font-bold text-white hover:bg-white/5 disabled:opacity-40"
                  >
                    <Trans>Sell</Trans>
                    <Shards value={sellValue(charm, state.charms)} className="text-osu-pink-light" />
                  </button>
                </>
              }
            />
          ))}
        </div>
      )}

      {/* The shop: restocked every time a song is cleared. */}
      <div className="mt-10 flex items-baseline justify-between">
        <SectionTitle>
          <Trans>Shop</Trans>
        </SectionTitle>
        <button
          type="button"
          disabled={api.busy || Boolean(state.over) || shards < cost || rerolls <= 0}
          onClick={() => void act({ kind: "reroll" })}
          className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[12px] font-bold text-white transition hover:bg-white/5 disabled:opacity-40"
        >
          <RerollGlyph size={15} />
          <Trans>Reroll</Trans>
          {cost === 0 ? <Trans>free</Trans> : <Shards value={cost} className="text-osu-pink-light" />}
          <span className="font-normal text-osu-f1">
            <Plural value={rerolls} one="# left" other="# left" />
          </span>
        </button>
      </div>
      <div className="mt-1 flex flex-col divide-y divide-white/[0.06]">
        {state.shop.offers.map((offer, index) => (
          <div key={`${offer.id}-${index}`} className={offer.sold ? "opacity-35" : ""}>
            <CharmRow
              id={offer.id}
              trailing={
                <button
                  type="button"
                  disabled={api.busy || Boolean(offer.sold) || Boolean(state.over) || shards < offer.cost || state.charms.length >= unlocks.slots}
                  onClick={() => void act({ kind: "buy", index })}
                  className="inline-flex min-w-[84px] items-center justify-center gap-1.5 rounded-lg bg-osu-pink px-3 py-2 text-[13px] font-black text-white transition hover:brightness-110 disabled:opacity-40"
                >
                  {offer.sold ? (
                    <Trans>Bought</Trans>
                  ) : (
                    <>
                      <Trans>Buy</Trans>
                      <Shards value={offer.cost} />
                    </>
                  )}
                </button>
              }
            />
          </div>
        ))}
        {state.shop.offers.length === 0 && (
          <div className="py-6 text-center text-[12px] text-osu-f1">
            <Trans>The shop restocks when a song is cleared.</Trans>
          </div>
        )}
      </div>

      {/* Collector level and the next pack's wrapper. */}
      <div className="mt-10 grid gap-8 border-t border-white/[0.07] pt-7 sm:grid-cols-2">
        <div>
          <SectionTitle>
            <Trans>Collector level</Trans>
          </SectionTitle>
          <div className="mt-2 flex items-baseline gap-3">
            <span className="text-[40px] font-black leading-none text-white tabular-nums">{progress.level}</span>
            <span className="text-[12px] text-osu-f1 tabular-nums">
              {formatScore(progress.xp)} / {formatScore(xpNeeded)} XP
            </span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-osu-b4">
            <div className="h-full rounded-full bg-osu-pink" style={{ width: `${Math.min(100, (progress.xp / xpNeeded) * 100)}%` }} />
          </div>
          <div className="mt-3 text-[13px]">
            {progress.wrapper !== "plain" ? (
              <span className="font-bold text-[#ffd36b]">
                {i18n._(WRAPPER_COPY[progress.wrapper].name)}
                <span className="ml-2 font-normal text-osu-f1">{i18n._(WRAPPER_COPY[progress.wrapper].text)}</span>
              </span>
            ) : (
              <span className="text-osu-f1">
                <Trans>Your next pack is plain.</Trans>
              </span>
            )}
          </div>
          {(progress.goldTokens > 0 || progress.prismaticTokens > 0) && (
            <div className="mt-1 text-[12px] text-osu-f1">
              <Trans>
                Queued: {progress.goldTokens} gold, {progress.prismaticTokens} rainbow
              </Trans>
            </div>
          )}
        </div>

        {/* The collection ladder: every distinct card ever held, editions
            included, unlocks something at each rung. */}
        <div>
          <SectionTitle>
            <Trans>Collection ladder</Trans>
          </SectionTitle>
          <div className="mt-2 flex items-baseline gap-3">
            <span className="text-[40px] font-black leading-none text-white tabular-nums">{formatScore(view.distinct)}</span>
            <span className="text-[12px] text-osu-f1">
              <Trans>cards held</Trans>
            </span>
          </div>
          {nextRung && (
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-osu-b4">
              <div
                className="h-full rounded-full bg-[#6be0a0]"
                style={{
                  width: `${Math.max(2, Math.min(100, ((view.distinct - previousRungAt) / Math.max(1, nextRung.at - previousRungAt)) * 100))}%`,
                }}
              />
            </div>
          )}
          <div className="mt-3 flex flex-col">
            {view.rungs.map((rung) => (
              <div
                key={rung.at}
                className={`flex items-baseline justify-between border-t border-white/[0.05] py-1.5 text-[12px] ${
                  rung.reached ? "text-white" : "text-osu-f1"
                }`}
              >
                <span className={rung === nextRung ? "font-bold text-white" : ""}>{RUNG_COPY[rung.unlock] ? i18n._(RUNG_COPY[rung.unlock]) : rung.unlock}</span>
                <span className={`tabular-nums ${rung.reached ? "text-[#6be0a0]" : ""}`}>{rung.at.toLocaleString("en-US")}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Master sets: every player in one edition. */}
      {view.masterSets && (
        <div className="mt-10 border-t border-white/[0.07] pt-7">
          <SectionTitle>
            <Trans>Master sets</Trans>
          </SectionTitle>
          <div className="mt-3 grid grid-cols-3 gap-6">
            {RUN_EDITIONS.map((edition) => {
              const owned = view.masterSets?.[edition] ?? 0;
              const total = view.poolTotal ?? 0;
              return (
                <div key={edition}>
                  <div className="text-[13px] font-bold" style={{ color: EDITION_TINT[edition] }}>
                    {i18n._(EDITION_COPY[edition].name)}
                  </div>
                  <div className="text-[11px] text-osu-f1">{i18n._(EDITION_COPY[edition].text)}</div>
                  <div className="mt-1 text-[22px] font-black leading-none text-white tabular-nums">
                    {formatScore(owned)}
                    {total > 0 && <span className="text-[13px] font-normal text-osu-f1"> / {formatScore(total)}</span>}
                  </div>
                  {edition === "polychrome" && !unlocks.polychrome && (
                    <div className="mt-1 text-[11px] text-osu-f1">
                      <Trans>Unlocks at 1,000 cards</Trans>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* How a pack scores, and the board. */}
      <div className="mt-10 grid gap-8 border-t border-white/[0.07] pt-7 sm:grid-cols-2">
        <div>
          <SectionTitle>
            <Trans>Patterns</Trans>
          </SectionTitle>
          <div className="mt-3 flex flex-col">
            {[...HAND_TYPES].reverse().map((id) => (
              <div key={id} className="flex items-baseline gap-3 border-t border-white/[0.05] py-1.5 text-[12px]">
                <span className="w-[120px] shrink-0 font-bold text-white">{i18n._(HAND_TYPE_COPY[id].name)}</span>
                <span className="min-w-0 flex-1 text-osu-f1">{i18n._(HAND_TYPE_COPY[id].text)}</span>
                <span className="shrink-0 font-bold tabular-nums">
                  <span className="text-[#8fc1ff]">{HAND_BASE[id].chips}</span>
                  <span className="text-osu-f1"> x </span>
                  <span className="text-[#ff66aa]">{HAND_BASE[id].mult}</span>
                </span>
              </div>
            ))}
          </div>
        </div>
        <div>
          <SectionTitle>
            <Trans>Furthest stages</Trans>
          </SectionTitle>
          <div className="mt-3 flex flex-col">
            {(board ?? []).map((entry, index) => (
              <div key={entry.userId} className="flex items-baseline gap-3 border-t border-white/[0.05] py-1.5 text-[13px]">
                <span className="w-5 text-right text-[11px] text-osu-f1 tabular-nums">{index + 1}</span>
                <Link
                  to="/packs/collections"
                  search={{ collector: entry.username }}
                  className="min-w-0 flex-1 truncate font-bold text-white hover:underline"
                >
                  {entry.username}
                </Link>
                <span className="font-black text-white tabular-nums">{entry.bestAnte}</span>
                <span className="w-[86px] text-right text-[11px] text-osu-f1 tabular-nums">{formatScore(entry.bestHand)}</span>
              </div>
            ))}
            {board && board.length === 0 && (
              <div className="py-4 text-[12px] text-osu-f1">
                <Trans>Nobody has cleared a stage yet.</Trans>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* CC BY 3.0 attribution for the charm silhouettes (gameIconBodies.ts). */}
      <div className="mt-10 border-t border-white/[0.07] pt-4 text-[11px] text-osu-f1">
        <Trans>
          Charm icons by Lorc, Delapouite and contributors at{" "}
          <a href="https://game-icons.net" target="_blank" rel="noreferrer" className="underline hover:text-white">
            game-icons.net
          </a>
          , CC BY 3.0
        </Trans>
      </div>
    </div>
  );
}
