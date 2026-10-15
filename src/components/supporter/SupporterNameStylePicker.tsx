import { useState } from "react";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { MessageDescriptor } from "@lingui/core";

import { SUPPORTER_NAME_FONT_LABELS, SUPPORTER_NAME_FONTS, type SupporterNameFontId } from "../../lib/supporter-name-fonts";
import { SUPPORTER_NAME_STYLE_LABELS, type SupporterNameStyleId } from "../../lib/supporter-name-styles";
import { SegmentedControl } from "../ui/SegmentedControl";
import { SupporterStyledName } from "./SupporterNameStyle";

/* The name tag picker on /supporter: a row of fonts, then the styles in
   groups behind tabs (so the panel stays short), each tile the viewer's own
   name in that style and the picked font, on a dark strip like the profile
   hero. Only reports picks; the page previews and saves them. */

const GROUPS: { key: string; title: MessageDescriptor; styles: SupporterNameStyleId[] }[] = [
  {
    key: "effects",
    title: msg`Effects`,
    styles: ["chrome", "molten-gold", "ethereal", "pearl", "galaxy", "heatmap", "note-rain", "plasma", "ink", "caustics", "lava", "dither", "mesh", "aurora", "glitch"],
  },
  { key: "gradients", title: msg`Gradients`, styles: ["holo", "gold", "rainbow", "sunset", "ember", "frost"] },
  { key: "glow", title: msg`Glow and retro`, styles: ["neon", "hit-light", "300g", "pixel", "terminal", "sticker", "plate"] },
];

const tile = (active: boolean) =>
  `flex min-w-0 cursor-pointer flex-col gap-1.5 rounded-lg p-1.5 text-[11px] font-semibold transition-colors disabled:cursor-default ${active ? "bg-osu-b3 text-white ring-1 ring-osu-pink" : "bg-osu-b4 text-osu-l2 hover:bg-osu-b3"}`;

const chip = (active: boolean) =>
  `flex h-8 shrink-0 cursor-pointer items-center justify-center rounded-lg px-3 text-[14px] transition-colors disabled:cursor-default ${active ? "bg-osu-b3 text-white ring-1 ring-osu-pink" : "bg-osu-b4 text-osu-l2 hover:bg-osu-b3"}`;

const NAME_CLASS = "min-w-0 truncate p-2 -m-2 text-[18px] font-black leading-none text-white";

export function SupporterNameStylePicker({ nameStyle, nameFont, username, disabled, onPick, onPickFont }: {
  nameStyle: SupporterNameStyleId | null;
  nameFont: SupporterNameFontId | null;
  username: string;
  disabled?: boolean;
  onPick: (nameStyle: SupporterNameStyleId | null) => void;
  onPickFont: (nameFont: SupporterNameFontId | null) => void;
}) {
  const { t, i18n } = useLingui();
  // open on the group holding the current style
  const [tab, setTab] = useState(() => GROUPS.find((g) => nameStyle && g.styles.includes(nameStyle))?.key ?? GROUPS[0].key);
  const group = GROUPS.find((g) => g.key === tab) ?? GROUPS[0];
  const pick = (next: SupporterNameStyleId | null) => {
    if (next !== nameStyle) onPick(next);
  };
  const pickFont = (next: SupporterNameFontId | null) => {
    if (next !== nameFont) onPickFont(next);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2">
        <span className="mt-2 shrink-0 text-[11px] font-semibold uppercase tracking-wide text-osu-f1">{t`Font`}</span>
        <div className="flex min-w-0 flex-wrap gap-1.5">
          <button type="button" disabled={disabled} onClick={() => pickFont(null)} aria-pressed={nameFont === null} className={`${chip(nameFont === null)} font-bold`}>
            {t`Default`}
          </button>
          {SUPPORTER_NAME_FONTS.map((id) => (
            <button key={id} type="button" disabled={disabled} onClick={() => pickFont(id)} aria-pressed={nameFont === id} className={`${chip(nameFont === id)} name-font--${id}`}>
              {i18n._(SUPPORTER_NAME_FONT_LABELS[id])}
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="mb-3 flex items-center gap-2">
          <div className="min-w-0 flex-1 overflow-x-auto">
            <SegmentedControl
              id="supporter-name-style-groups"
              value={tab}
              options={GROUPS.map((g) => ({ value: g.key, label: i18n._(g.title) }))}
              onChange={setTab}
            />
          </div>
          <button type="button" disabled={disabled} onClick={() => pick(null)} aria-pressed={nameStyle === null} className={`${chip(nameStyle === null)} text-[12px] font-semibold`}>
            {t`Plain`}
          </button>
        </div>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2">
          {group.styles.map((id) => (
            <button key={id} type="button" disabled={disabled} onClick={() => pick(id)} aria-pressed={nameStyle === id} className={tile(nameStyle === id)}>
              <span className="flex h-12 items-center justify-center overflow-hidden rounded-md bg-osu-b6 px-3">
                <SupporterStyledName nameStyle={id} nameFont={nameFont} name={username} className={NAME_CLASS} />
              </span>
              {i18n._(SUPPORTER_NAME_STYLE_LABELS[id])}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
