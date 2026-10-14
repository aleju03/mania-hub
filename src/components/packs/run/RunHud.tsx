import { useEffect } from "react";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { prefetchRunSounds } from "../packSfx";
import { BLIND_COPY, formatScore, WRAPPER_COPY } from "#/lib/pack-run";
import { CharmKey, EmptyKey } from "./CharmCard";
import { NudgeGlyph } from "./charmGlyphs";
import { ModBadge } from "./ModBadge";
import type { PackRunApi } from "./usePackRun";

const WRAPPER_TINT = { silver: "#cfd8e6", gold: "#ffd36b", prismatic: "#ff8ad8" } as const;

/* The run in a strip above the pack: the stage and song, how far into its
   target, credits and packs left, and the charm keys. Opens the run page. */
export function RunHud({ api, onOpen }: { api: PackRunApi; onOpen: () => void }) {
  const { i18n } = useLingui();
  // Decoded ahead of the first tally, so its opening notes are not synth.
  useEffect(() => prefetchRunSounds(), []);
  const view = api.view;
  if (!view) return null;
  const { blind, charms, progress, over } = view.state;
  const share = blind.target > 0 ? Math.min(1, blind.score / blind.target) : 0;
  const wrapper = progress.wrapper;
  const slots = view.unlocks.slots;
  return (
    <div className="mx-auto mb-7 w-full max-w-[560px]" translate="no">
      <button type="button" onClick={onOpen} className="group block w-full text-left">
        {over ? (
          <div className="text-[13px] font-bold text-osu-pink-light">
            {over.won ? <Trans>Run cleared</Trans> : <Trans>Failed at stage {over.ante}</Trans>}
            <span className="ml-2 font-normal text-osu-f1">
              <Trans>The next pack starts a new run</Trans>
            </span>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2.5">
              <span className="text-[18px] font-black italic uppercase leading-none text-white">
                <Trans>Stage {blind.ante}</Trans>
              </span>
              <span className="text-[13px] text-osu-f1">{i18n._(BLIND_COPY[blind.blind])}</span>
              {blind.blind === "boss" && <ModBadge boss={blind.boss} size="sm" />}
              <span className="ml-auto text-[12px] text-osu-f1 tabular-nums">
                <span className="text-[16px] font-black text-white">{formatScore(blind.score)}</span> / {formatScore(blind.target)}
              </span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-osu-b3/50">
              <div className="h-full rounded-full bg-[#8fc1ff] transition-[width] duration-500" style={{ width: `${Math.max(2, share * 100)}%` }} />
            </div>
          </>
        )}
        <div className="mt-3 flex items-center gap-3">
          {!over && (
            <span className="text-[11px] text-osu-f1 tabular-nums">
              <Plural value={blind.packsLeft} one="# pack left" other="# packs left" />
            </span>
          )}
          <span className="ml-auto flex gap-1.5">
            {Array.from({ length: slots }, (_, index) => {
              const charm = charms[index];
              return charm ? <CharmKey key={charm.uid} id={charm.id} charm={charm} size={30} /> : <EmptyKey key={`empty-${index}`} size={30} />;
            })}
          </span>
          <NudgeGlyph direction="right" className="text-osu-f1 group-hover:text-white" />
        </div>
      </button>
      {wrapper !== "plain" && (
        <div className="mt-3 text-center text-[13px] font-black uppercase tracking-[0.14em]" style={{ color: WRAPPER_TINT[wrapper] }}>
          {i18n._(WRAPPER_COPY[wrapper].name)}
          <span className="ml-2 text-[11px] font-normal normal-case tracking-normal text-osu-f1">
            {i18n._(WRAPPER_COPY[wrapper].text)}
          </span>
        </div>
      )}
    </div>
  );
}
