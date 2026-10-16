import type { ReactNode } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { useLingui } from "@lingui/react/macro";

import { ManiaCard3DPanel as ManiaCardPanel } from "../player/maniacard3d/LazyManiaCard3DPanel";
import type { ManiaCardPanelProps } from "../player/maniacard3d/types";
import { SupporterAvatarFrame } from "../player/SupporterAvatarFrame";
import { framedAvatarStyle, SUPPORTER_AVATAR_FRAMES, supporterFrameGeometry } from "../../lib/supporter-avatar-frames";
import type { SupporterLook } from "../../lib/supporter-card-looks";
import { SupporterStyledName } from "./SupporterNameStyle";
import { ProfileThemeBackdrop } from "./ProfileThemeBackdrop";
import type { HighwayChart, HighwayNotes } from "../../lib/supporter-profile-themes";
import type { Loadout } from "./loadout";
import { useIsSettled } from "./use-settled";

/* The stage of the /supporter loadout: the viewer's avatar with their name
   under it, and their card, wearing whatever is on show (the
   equipped loadout, a pending roll, or the item under the pointer). `pop`
   moves on every equip and roll landing, and replays the landing bounce.
   Below lg only the part the open slot changes is shown.

   The avatar sits in room reserved for the largest overhang of any frame, so
   neither it nor the name moves when the frame changes. */

/* [top, sides, bottom] in avatar widths: the most any frame reaches past the
   avatar, with the sides evened so the avatar stays centred. */
const ROOM = SUPPORTER_AVATAR_FRAMES.reduce(
  ([top, sides, bottom], id) => {
    const [left, up, right, down] = supporterFrameGeometry(id).overhang;
    return [Math.max(top, up), Math.max(sides, left, right), Math.max(bottom, down)];
  },
  [0, 0, 0],
);
const ROOM_PADDING = `calc(var(--stage-avatar) * ${ROOM[0]}) calc(var(--stage-avatar) * ${ROOM[1]}) calc(var(--stage-avatar) * ${ROOM[2]})`;

const NAME_CLASS = "min-w-0 max-w-full truncate px-2 -mx-2 py-[0.3em] -my-[0.3em] text-[26px] font-black leading-none text-white sm:text-[40px]";

export function LoadoutStage({ shown, notes, chart, cardLook, username, avatar, card, focus, pop, spinning, footer }: {
  shown: Loadout;
  /** The viewer's replay skin notes, for the Note highway. */
  notes: HighwayNotes | null;
  chart: HighwayChart | null;
  /** Held still while the reels spin, since every card look rebuilds the card's textures. */
  cardLook: SupporterLook;
  username: string;
  avatar: string | undefined;
  /** Null when the viewer has no card yet. */
  card: Pick<ManiaCardPanelProps, "user" | "scores" | "loading"> | null;
  focus: "hero" | "card";
  pop: number;
  spinning: boolean;
  footer: ReactNode;
}) {
  const { t } = useLingui();
  const reduced = useReducedMotion();
  const { theme, frame, nameStyle, nameFont } = shown;
  // While the pointer sweeps a drawer the frame shows its still and the name its CSS look.
  const frameSettled = useIsSettled(frame ?? "", 350);
  const nameSettled = useIsSettled(`${nameStyle}|${nameFont}`, 300);
  const landing = reduced ? undefined : { initial: { scale: 0.9, y: 6 }, animate: { scale: 1, y: 0 }, transition: { type: "spring" as const, stiffness: 520, damping: 17 } };

  return (
    <div className="relative isolate overflow-hidden rounded-2xl bg-osu-b6">
      {/* The profile theme plays behind the whole stage, as it will behind the profile. */}
      {theme && <ProfileThemeBackdrop theme={theme} notes={notes} chart={chart} maxPixels={500_000} className="absolute inset-0 -z-10" />}
      <div className="flex flex-col lg:flex-row lg:items-stretch">
        <div className={`${focus === "card" ? "max-lg:hidden" : ""} flex min-w-0 flex-1 flex-col items-center justify-center px-5 py-4 [--stage-avatar:84px] sm:px-8 sm:[--stage-avatar:124px]`}>
          {/* Never shrinks: in a narrow column the side room overflows both ways evenly, and only wide wings get clipped. */}
          <div className="shrink-0" style={{ padding: ROOM_PADDING }}>
            <motion.div key={`avatar-${pop}`} {...landing} className="relative">
              <img src={avatar} alt="" className="h-[84px] w-[84px] max-w-none rounded-2xl object-cover sm:h-[124px] sm:w-[124px]" style={framedAvatarStyle(frame)} />
              {frame && <SupporterAvatarFrame frame={frame} still={!frameSettled} />}
            </motion.div>
          </div>
          {/* Shrinks to its text as in the hero's h1, so a style's gradient
              and plate size to the name. */}
          <motion.div key={`name-${pop}`} {...landing} className="mt-2 flex w-full min-w-0 justify-center">
              {nameStyle || nameFont ? (
                <SupporterStyledName nameStyle={nameStyle} nameFont={nameFont} name={username} className={NAME_CLASS} live={!spinning && nameSettled} />
              ) : (
                <span className={NAME_CLASS}>{username}</span>
              )}
          </motion.div>
        </div>
        <div className={`${focus === "hero" ? "max-lg:hidden" : ""} border-white/[0.07] px-4 max-lg:border-t lg:w-[300px] lg:shrink-0 lg:border-l lg:px-3 ${theme ? "bg-black/25" : ""}`}>
          <div className="mx-auto w-full max-w-[270px]">
            {card ? (
              <ManiaCardPanel user={card.user} scores={card.scores} loading={card.loading} isOwnProfile supporterLookOverride={cardLook} showTierProgress={false} />
            ) : (
              <p className="py-16 text-center text-[13px] text-osu-f1">{t`Your card is not ready yet.`}</p>
            )}
          </div>
        </div>
      </div>
      <div className={`flex flex-wrap items-center gap-2 border-t border-white/[0.07] px-4 py-3 ${theme ? "bg-osu-b6/70" : ""}`}>{footer}</div>
    </div>
  );
}
