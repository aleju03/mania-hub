import type { ReactNode } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { useLingui } from "@lingui/react/macro";

import { ManiaCard3DPanel as ManiaCardPanel } from "../player/maniacard3d/LazyManiaCard3DPanel";
import type { ManiaCardPanelProps } from "../player/maniacard3d/types";
import { SupporterAvatarFrame } from "../player/SupporterAvatarFrame";
import { avatarUrlUserId } from "../ui/Avatar";
import { framedAvatarStyle, SUPPORTER_AVATAR_FRAMES, supporterFrameGeometry } from "../../lib/supporter-avatar-frames";
import type { SupporterLook } from "../../lib/supporter-card-looks";
import { SupporterStyledName } from "./SupporterNameStyle";
import { useFittedName } from "./useFittedName";
import { ProfileThemeBackdrop } from "./ProfileThemeBackdrop";
import { themeBlurStyle, themeDimColor, type HighwayChart, type HighwayNotes } from "../../lib/supporter-profile-themes";
import type { Loadout } from "./loadout";
import { useIsSettled } from "./use-settled";
import { TestPack } from "./TestPack";
import { TestBinder } from "./TestBinder";

/* The stage of the /supporter loadout: the viewer's avatar with their name
   under it, and their card, wearing whatever is on show (the
   equipped loadout, a pending roll, or the item under the pointer). `pop`
   moves on every equip and roll landing, and replays the landing bounce.
   Below lg only the part the open slot changes is shown. With the wrapper or
   the opening slot open, a test pack takes the avatar's place, to be cut open
   with the blade on show; with the binder slot open, the binder on show
   holding the viewer's own cards takes the whole stage.

   The avatar sits in room reserved for the largest overhang of any frame, so
   neither it nor the name moves when the frame changes. On a phone the stage
   stays in view while the drawers scroll under it, so it is kept short there:
   a smaller avatar with the name beside it, as in the profile hero, and that
   room capped (`--stage-room-cap`, in avatar widths), so the widest wings are
   cut at the stage's edge. */

/* [top, sides, bottom] in avatar widths: the most any frame reaches past the
   avatar, with the sides evened so the avatar stays centred. */
const ROOM = SUPPORTER_AVATAR_FRAMES.reduce(
  ([top, sides, bottom], id) => {
    const [left, up, right, down] = supporterFrameGeometry(id).overhang;
    return [Math.max(top, up), Math.max(sides, left, right), Math.max(bottom, down)];
  },
  [0, 0, 0],
);
const room = (share: number) => `calc(var(--stage-avatar) * min(${share}, var(--stage-room-cap)))`;
const ROOM_PADDING = `${room(ROOM[0])} ${room(ROOM[1])} ${room(ROOM[2])}`;

// --name-scale (useFittedName) shrinks a name too wide for its column before it would truncate
const NAME_CLASS = "min-w-0 max-w-full truncate px-2 -mx-2 py-[0.3em] -my-[0.3em] text-[length:calc(22px*var(--name-scale,1))] font-black leading-none text-white sm:text-[length:calc(40px*var(--name-scale,1))]";

export function LoadoutStage({ shown, ownThemeStill = null, notes, chart, cardLook, username, avatar, card, focus, pop, spinning, footer, tall = false }: {
  shown: Loadout;
  /** The still of the viewer's own worn theme, shown when no built-in one is. */
  ownThemeStill?: string | null;
  /** The viewer's replay skin notes, for the Note highway. */
  notes: HighwayNotes | null;
  chart: HighwayChart | null;
  /** Held still while the reels spin, since every card look rebuilds the card's textures. */
  cardLook: SupporterLook;
  username: string;
  avatar: string | undefined;
  /** Null when the viewer has no card yet. */
  card: Pick<ManiaCardPanelProps, "user" | "scores" | "loading"> | null;
  focus: "hero" | "card" | "pack" | "binder";
  pop: number;
  spinning: boolean;
  footer: ReactNode;
  /** Fill the height it is given from lg up (the scene grows, the footer stays at the bottom),
      so a sticky stage beside a long drawer is a big preview rather than a gap under a small one. */
  tall?: boolean;
}) {
  const { t } = useLingui();
  const reduced = useReducedMotion();
  const { theme, frame, nameStyle, nameFont, nameOutline } = shown;
  // While the pointer sweeps a drawer the frame shows its still and the name its CSS look.
  const frameSettled = useIsSettled(frame ?? "", 350);
  const nameSettled = useIsSettled(`${nameStyle}|${nameFont}`, 300);
  const nameBoxRef = useFittedName([username, nameStyle, nameFont, pop, focus]);
  const landing = reduced ? undefined : { initial: { scale: 0.9, y: 6 }, animate: { scale: 1, y: 0 }, transition: { type: "spring" as const, stiffness: 520, damping: 17 } };

  return (
    <div className={`relative isolate overflow-hidden rounded-2xl bg-osu-b6 ${tall ? "lg:flex lg:h-full lg:flex-col" : ""}`}>
      {/* The profile theme plays behind the whole stage, as it will behind the profile. */}
      {(theme || ownThemeStill) && (
        <div className="absolute inset-0 -z-10 overflow-hidden">
          <div className="absolute inset-0" style={themeBlurStyle(shown.themeOptions.blur)}>
            {theme
              ? <ProfileThemeBackdrop theme={theme} notes={notes} chart={chart} maxPixels={500_000} className="absolute inset-0" />
              : <img src={ownThemeStill!} alt="" className="absolute inset-0 h-full w-full object-cover" />}
          </div>
          {themeDimColor(shown.themeOptions.dim) ? <div className="absolute inset-0" style={{ background: themeDimColor(shown.themeOptions.dim)! }} /> : null}
        </div>
      )}
      <div className={`flex flex-col lg:flex-row lg:items-stretch ${tall ? "lg:min-h-0 lg:flex-1" : ""}`}>
        {focus === "binder" ? (
          <div className="min-w-0 flex-1 px-3">
            <TestBinder binder={shown.pack.binder} />
          </div>
        ) : focus === "pack" ? (
          <div className="flex min-w-0 flex-1 items-center justify-center px-4 pt-10 pb-3">
            <TestPack wrapper={shown.pack.wrapper} blade={shown.pack.blade} />
          </div>
        ) : (
        <div className={`${focus === "card" ? "max-lg:hidden" : ""} flex min-w-0 flex-1 flex-row items-center justify-center px-3 py-1 [--stage-avatar:64px] [--stage-room-cap:0.42] sm:flex-col sm:px-8 sm:py-4 sm:[--stage-avatar:124px] sm:[--stage-room-cap:9]`}>
          {/* Never shrinks: in a narrow column the side room overflows both ways evenly, and only wide wings get clipped. */}
          <div className="shrink-0" style={{ padding: ROOM_PADDING }}>
            <motion.div key={`avatar-${pop}`} {...landing} className="relative">
              <img src={avatar} alt="" className="h-[64px] w-[64px] max-w-none rounded-2xl object-cover sm:h-[124px] sm:w-[124px]" style={framedAvatarStyle(frame)} />
              {frame && <SupporterAvatarFrame frame={frame} still={!frameSettled} userId={avatarUrlUserId(avatar)} />}
            </motion.div>
          </div>
          {/* Shrinks to its text as in the hero's h1, so a style's gradient
              and plate size to the name. */}
          <motion.div key={`name-${pop}`} {...landing} className="flex min-w-0 flex-1 sm:mt-2 sm:w-full sm:flex-none">
            <div ref={nameBoxRef} className="flex w-full min-w-0 justify-start sm:justify-center">
              {nameStyle || nameFont || nameOutline ? (
                <SupporterStyledName nameStyle={nameStyle} nameFont={nameFont} outline={nameOutline} name={username} className={NAME_CLASS} live={!spinning && nameSettled} />
              ) : (
                <span className={NAME_CLASS}>{username}</span>
              )}
            </div>
          </motion.div>
        </div>
        )}
        <div className={`${focus !== "card" ? "max-lg:hidden" : ""} ${focus === "binder" ? "lg:hidden" : ""} border-white/[0.07] px-4 max-lg:border-t lg:w-[300px] lg:shrink-0 lg:border-l lg:px-3 ${tall ? "lg:flex lg:flex-col lg:justify-center" : ""} ${theme ? "bg-black/25" : ""}`}>
          <div className="mx-auto w-full max-w-[270px]">
            {card ? (
              <ManiaCardPanel user={card.user} scores={card.scores} loading={card.loading} isOwnProfile supporterLookOverride={cardLook} showTierProgress={false} sleeve={shown.pack.sleeve} />
            ) : (
              <p className="py-16 text-center text-[13px] text-osu-f1">{t`Your card is not ready yet.`}</p>
            )}
          </div>
        </div>
      </div>
      <div className={`flex flex-wrap items-center gap-2 border-t border-white/[0.07] px-4 py-2 sm:py-3 ${theme ? "bg-osu-b6/70" : ""}`}>{footer}</div>
    </div>
  );
}
