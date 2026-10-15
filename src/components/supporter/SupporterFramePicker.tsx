import { useState } from "react";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { MessageDescriptor } from "@lingui/core";

import {
  FRAMED_AVATAR_RADIUS,
  framedAvatarStyle,
  supporterFrameGeometry,
  supporterFrameSrc,
  type SupporterAvatarFrameId,
} from "../../lib/supporter-avatar-frames";
import { SegmentedControl } from "../ui/SegmentedControl";

/* The avatar frame picker on /supporter: every frame as a still around the
   viewer's own avatar, in themed groups shown one at a time behind tabs, so
   the picker stays short and the preview above it stays in view. A set (wing layers, dan skips, the
   7K orbit and 4K LN tiers) is one tile, with its variants as chips under the
   group once it is picked. Only reports picks; the page previews and saves
   them. */

type Entry =
  | { id: SupporterAvatarFrameId; label: MessageDescriptor }
  | { set: string; label: MessageDescriptor; chips: MessageDescriptor; variants: { id: SupporterAvatarFrameId; label: string }[]; shown: number };

const wings = (set: string, label: MessageDescriptor): Entry => ({
  set,
  label,
  chips: msg`Layers`,
  variants: [1, 2, 3].map((tier) => ({ id: `${set}-${tier}` as SupporterAvatarFrameId, label: String(tier) })),
  shown: 1,
});

const GROUPS: { key: string; title: MessageDescriptor; entries: Entry[] }[] = [
  {
    key: "dans",
    title: msg`Dans`,
    entries: [
      { id: "kappa-signal", label: msg`Kappa signal` },
      { id: "delta-crest", label: msg`Delta crest` },
      {
        set: "dan-skip",
        label: msg`Dan skip`,
        chips: msg`Skip`,
        variants: [
          { id: "dan-skip-1-eta", label: "1st to Eta" },
          { id: "dan-skip-5-gamma", label: "5th to Gamma" },
          { id: "dan-skip-10-alpha", label: "10th to Alpha" },
          { id: "dan-skip-alpha-kappa", label: "Alpha to Kappa" },
        ],
        shown: 2,
      },
      {
        set: "7k-orbit",
        label: msg`7K orbit`,
        chips: msg`Tier`,
        variants: [
          { id: "gamma-orbit", label: "Gamma" },
          { id: "azimuth-orbit", label: "Azimuth" },
          { id: "zenith-orbit", label: "Zenith" },
          { id: "stellium-orbit", label: "Stellium" },
        ],
        shown: 2,
      },
      {
        set: "ln-hold",
        label: msg`LN hold`,
        chips: msg`Tier`,
        variants: [1, 5, 9, 13, 17].map((n) => ({ id: `ln-hold-${n}` as SupporterAvatarFrameId, label: `LN ${n}` })),
        shown: 4,
      },
      { id: "hanging-stellium", label: msg`Stellium charm` },
    ],
  },
  {
    key: "mania",
    title: msg`osu!mania`,
    entries: [
      { id: "judgement-pop", label: msg`Judgements` },
      { id: "dfjk-keys", label: msg`DFJK` },
    ],
  },
  {
    key: "retro",
    title: msg`Retro`,
    entries: [
      { id: "classic-window", label: msg`Classic window` },
      { id: "xp-window", label: msg`XP window` },
      { id: "aero-window", label: msg`Aero window` },
      { id: "error-cascade", label: msg`Error cascade` },
      { id: "loading-bar", label: msg`Loading bar` },
      { id: "crt-monitor", label: msg`CRT monitor` },
      { id: "disc-bounce", label: msg`Screensaver` },
      { id: "pixel-hearts", label: msg`Pixel hearts` },
      { id: "old-photo", label: msg`Old photo` },
    ],
  },
  {
    key: "terminal",
    title: msg`Terminal`,
    entries: [
      { id: "term-window", label: msg`Terminal window` },
      { id: "term-rain", label: msg`Matrix rain` },
      { id: "term-boot", label: msg`Boot box` },
      { id: "term-hud", label: msg`Hex HUD` },
    ],
  },
  {
    key: "nature",
    title: msg`Seasons and nature`,
    entries: [
      { id: "sakura", label: msg`Sakura` },
      { id: "wisteria", label: msg`Wisteria` },
      { id: "autumn-maple", label: msg`Autumn maple` },
      { id: "winter-pine", label: msg`Winter pine` },
      { id: "ink-plum", label: msg`Ink plum` },
      { id: "bronze-laurel", label: msg`Bronze laurel` },
      { id: "rain-cloud", label: msg`Rain cloud` },
      { id: "halloween", label: msg`Halloween` },
      { id: "fairy-lights", label: msg`Fairy lights` },
    ],
  },
  {
    key: "cats",
    title: msg`Cats`,
    entries: [
      { id: "cat-parade", label: msg`Cat parade` },
      { id: "makiba-peek", label: msg`Makiba` },
      { id: "neon-ears", label: msg`Neon ears` },
    ],
  },
  {
    key: "effects",
    title: msg`Effects`,
    entries: [{ id: "storm", label: msg`Storm` }],
  },
  {
    key: "wings",
    title: msg`Wings`,
    entries: [
      wings("light-wings", msg`Light wings`),
      wings("ai-wings", msg`Angel wings`),
      wings("wings-feather", msg`Feather wings`),
      wings("wings-swept", msg`Swept wings`),
      wings("wings-soft", msg`Soft wings`),
      wings("wings-pink", msg`Pink wings`),
      wings("wings-gold", msg`Gold wings`),
    ],
  },
];

const TILE_PX = 72;

/* A frame's still around the viewer's avatar, fitted into a tile. */
function FrameThumb({ frame, avatar }: { frame: SupporterAvatarFrameId | null; avatar: string | undefined }) {
  const [left, top, width, height] = frame ? supporterFrameGeometry(frame).box : [0, 0, 1, 1];
  const size = TILE_PX / Math.max(width, height, 1.6);
  const avatarLeft = (TILE_PX - width * size) / 2 - left * size;
  const avatarTop = (TILE_PX - height * size) / 2 - top * size;
  return (
    <span className="relative block" style={{ width: TILE_PX, height: TILE_PX }}>
      <span className="absolute" style={{ left: avatarLeft, top: avatarTop, width: size, height: size }}>
        <img src={avatar} alt="" className="h-full w-full bg-osu-b3 object-cover" style={framedAvatarStyle(frame) ?? { borderRadius: FRAMED_AVATAR_RADIUS }} />
        {frame && (
          <img
            src={supporterFrameSrc(frame, "still")}
            alt=""
            loading="lazy"
            className="pointer-events-none absolute max-w-none"
            style={{ left: `${left * 100}%`, top: `${top * 100}%`, width: `${width * 100}%`, height: `${height * 100}%` }}
          />
        )}
      </span>
    </span>
  );
}

const holds = (entry: Entry, frame: SupporterAvatarFrameId | null) =>
  "id" in entry ? entry.id === frame : entry.variants.some((variant) => variant.id === frame);

const tile = (active: boolean) =>
  `flex cursor-pointer flex-col items-center gap-1 rounded-lg px-1 pt-1 pb-1.5 text-[11px] font-semibold transition-colors disabled:cursor-default ${active ? "bg-osu-b3 text-white ring-1 ring-osu-pink" : "bg-osu-b4 text-osu-l2 hover:bg-osu-b3"}`;

const chip = (active: boolean) =>
  `flex h-7 min-w-7 cursor-pointer items-center justify-center rounded-lg px-2 text-[12px] font-semibold transition-colors disabled:cursor-default ${active ? "bg-osu-b3 text-white ring-1 ring-osu-pink" : "bg-osu-b4 text-osu-l2 hover:bg-osu-b3"}`;

export function SupporterFramePicker({ frame, avatar, disabled, onPick }: {
  frame: SupporterAvatarFrameId | null;
  avatar: string | undefined;
  disabled?: boolean;
  onPick: (frame: SupporterAvatarFrameId | null) => void;
}) {
  const { t, i18n } = useLingui();
  // open on the group holding the current frame
  const [tab, setTab] = useState(() => GROUPS.find((g) => g.entries.some((entry) => holds(entry, frame)))?.key ?? GROUPS[0].key);
  const group = GROUPS.find((g) => g.key === tab) ?? GROUPS[0];
  const activeSet = group.entries.find((entry) => "set" in entry && holds(entry, frame));
  const pick = (next: SupporterAvatarFrameId | null) => {
    if (next !== frame) onPick(next);
  };

  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <div className="min-w-0 flex-1 overflow-x-auto">
          <SegmentedControl
            id="supporter-frame-groups"
            value={tab}
            options={GROUPS.map((g) => ({ value: g.key, label: i18n._(g.title) }))}
            onChange={setTab}
          />
        </div>
        <button type="button" disabled={disabled} onClick={() => pick(null)} aria-pressed={frame === null} className={chip(frame === null)}>
          {t`No frame`}
        </button>
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(84px,1fr))] gap-2">
        {group.entries.map((entry) => {
          if ("id" in entry) {
            return (
              <button key={entry.id} type="button" disabled={disabled} onClick={() => pick(entry.id)} aria-pressed={frame === entry.id} className={tile(frame === entry.id)}>
                <FrameThumb frame={entry.id} avatar={avatar} />
                {i18n._(entry.label)}
              </button>
            );
          }
          const active = entry === activeSet;
          const shown = active ? frame! : entry.variants[entry.shown].id;
          return (
            <button key={entry.set} type="button" disabled={disabled} onClick={() => !active && pick(shown)} aria-pressed={active} className={tile(active)}>
              <FrameThumb frame={shown} avatar={avatar} />
              {i18n._(entry.label)}
            </button>
          );
        })}
      </div>
      {activeSet && "set" in activeSet && (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-osu-f1">
          <span>{i18n._(activeSet.chips)}</span>
          {activeSet.variants.map((variant) => (
            <button
              key={variant.id}
              type="button"
              disabled={disabled}
              onClick={() => pick(variant.id)}
              aria-pressed={frame === variant.id}
              className={chip(frame === variant.id)}
            >
              {variant.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
