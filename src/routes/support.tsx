import { useEffect, useRef, useState, type ReactNode } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { AnimatePresence, motion, useInView, useReducedMotion, type Variants } from "framer-motion";
import type { MessageDescriptor } from "@lingui/core";

import { PageHeader } from "../components/layout/PageHeader";
import { SupportCheckout } from "../components/supporter/SupportCheckout";
import {
  CardShowcase,
  ClipShowcase,
  FramesShowcase,
  GiftShowcase,
  HeroStage,
  NamesShowcase,
  PacksShowcase,
  StatsShowcase,
  ThemesShowcase,
} from "../components/supporter/SupportShowcase";
import { CountUp, Reveal } from "../components/supporter/SupportMotion";
import { getI18n } from "../lib/i18n";
import { track } from "../lib/analytics";
import { SUPPORTER_PROFILE_THEMES } from "../lib/supporter-profile-themes";
import { SUPPORTER_AVATAR_FRAMES } from "../lib/supporter-avatar-frames";
import { SUPPORTER_NAME_STYLES } from "../lib/supporter-name-styles";
import { SUPPORTER_NAME_FONTS } from "../lib/supporter-name-fonts";
import { SUPPORTER_FOILS } from "../lib/supporter-foils";

/* What supporting is and what it brings, for anyone: every perk with the
   real thing it draws beside it, how paying turns into supporter time, and
   the Ko-fi panel to pay with. /supporter is where a supporter sets it up. */

export const Route = createFileRoute("/support")({
  head: ({ match }) => {
    const i18n = getI18n(match.context.locale);
    return {
      meta: [
        { title: i18n._(msg`Support`) },
        { name: "description", content: i18n._(msg`Supporting pays for the servers. Supporters get profile themes, avatar frames, name styles, card foils, packs cosmetics, extra profile stats and video share links.`) },
      ],
    };
  },
  component: SupportPage,
});

const SECTIONS: { id: string; label: MessageDescriptor }[] = [
  { id: "introduction", label: msg`Introduction` },
  { id: "themes", label: msg`Profile themes` },
  { id: "frames", label: msg`Avatar frames` },
  { id: "names", label: msg`Name styles` },
  { id: "card", label: msg`Your card` },
  { id: "packs", label: msg`Packs` },
  { id: "stats", label: msg`Profile stats` },
  { id: "sharing", label: msg`Video share links` },
  { id: "gift", label: msg`A week for a friend` },
  { id: "how", label: msg`How it works` },
  { id: "checkout", label: msg`Support` },
];

/* The section nearest the top of the screen, for the side nav. */
function useCurrentSection(): string {
  const [current, setCurrent] = useState(SECTIONS[0].id);
  useEffect(() => {
    const nodes = SECTIONS.map((section) => document.getElementById(section.id)).filter((node): node is HTMLElement => !!node);
    const update = () => {
      let next = nodes[0]?.id ?? SECTIONS[0].id;
      for (const node of nodes) if (node.getBoundingClientRect().top < 160) next = node.id;
      setCurrent(next);
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    return () => window.removeEventListener("scroll", update);
  }, []);
  return current;
}

function Perk({ id, title, count, body, children }: { id: string; title: string; count: ReactNode; body: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-[76px] border-t border-white/[0.07] pt-8">
      <Reveal>
      <div className="mb-5 max-w-[620px]">
        <div className="flex flex-wrap items-baseline gap-x-3">
          <h2 className="text-[22px] font-bold text-white">{title}</h2>
          <span className="text-[13px] font-semibold text-osu-pink-light">{count}</span>
        </div>
        <p className="mt-1.5 text-[14px] leading-relaxed text-osu-l2">{body}</p>
      </div>
      <Reveal delay={0.08}>{children}</Reveal>
      </Reveal>
    </section>
  );
}

const HERO_TEXT: Variants = { hidden: {}, shown: { transition: { staggerChildren: 0.09 } } };
const HERO_LINE: Variants = {
  hidden: { opacity: 0, y: 22 },
  shown: { opacity: 1, y: 0, transition: { type: "spring", stiffness: 260, damping: 22 } },
};

/* The pink button to the Ko-fi panel, which squashes under a press. */
function SupportButton({ className = "" }: { className?: string }) {
  const { t } = useLingui();
  return (
    <motion.a
      href="#checkout"
      onClick={() => track("support_open")}
      whileHover={{ scale: 1.05 }}
      whileTap={{ scale: 0.94 }}
      transition={{ type: "spring", stiffness: 500, damping: 17 }}
      className={`inline-flex h-10 items-center rounded-full bg-osu-pink px-5 text-[14px] font-semibold text-white hover:brightness-110 ${className}`}
    >
      {t`Support on Ko-fi`}
    </motion.a>
  );
}

/* The same button, floating at the bottom once the hero has scrolled away and
   until the Ko-fi panel is reached. */
function FloatingSupportButton({ show }: { show: boolean }) {
  return (
    <AnimatePresence>
      {show && (
        <motion.div
          className="fixed inset-x-0 bottom-5 z-40 flex justify-center"
          initial={{ opacity: 0, y: 40, scale: 0.9 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 40, scale: 0.9 }}
          transition={{ type: "spring", stiffness: 380, damping: 26 }}
        >
          <SupportButton className="shadow-[0_10px_30px_rgba(0,0,0,0.5)]" />
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function SupportPage() {
  const { t, i18n } = useLingui();
  const current = useCurrentSection();
  const reduced = useReducedMotion();
  const heroRef = useRef<HTMLDivElement>(null);
  const heroInView = useInView(heroRef);
  const floating = !heroInView && current !== "checkout";
  const steps = [
    { title: t`Tip on Ko-fi`, body: t`Use your osu! username as your name there, so the time lands on your account.` },
    { title: t`$3 is a month`, body: t`Any amount works and is counted to the day. Every tip adds to the time you have left.` },
    { title: t`Set it up`, body: t`Pick your look on the supporter page. It saves as you go.` },
  ];

  return (
    <div className="flex-1">
      <PageHeader iconSrc="/images/icons/supporter-heart.svg" title={t`support`} />
      <div className="bg-osu-b5">
        <div className="mx-auto grid max-w-[1200px] gap-8 px-3 py-6 sm:px-5 sm:py-8 lg:grid-cols-[180px_minmax(0,1fr)]">
          <nav className="max-lg:hidden" aria-label={t`On this page`}>
            <ul className="sticky top-[84px] space-y-0.5">
              {SECTIONS.map((section) => (
                <li key={section.id}>
                  <a
                    href={`#${section.id}`}
                    className={`block rounded-md px-3 py-1.5 text-[13px] transition-colors ${current === section.id ? "bg-white/[0.06] font-semibold text-white" : "text-osu-f1 hover:text-white"}`}
                  >
                    {i18n._(section.label)}
                  </a>
                </li>
              ))}
            </ul>
          </nav>

          <div className="min-w-0 space-y-12">
            <section id="introduction" className="scroll-mt-[76px] grid items-center gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
              <motion.div variants={HERO_TEXT} initial={reduced ? false : "hidden"} animate="shown">
                <motion.h1 variants={HERO_LINE} className="text-[30px] font-black leading-tight text-white sm:text-[36px]">{t`Become a supporter`}</motion.h1>
                <motion.p variants={HERO_LINE} className="mt-3 text-[15px] leading-relaxed text-osu-l2">
                  {t`The site is made and paid for by one person. Supporting covers the servers and gives me time to keep building it. As thanks, supporters get everything on this page.`}
                </motion.p>
                <motion.p variants={HERO_LINE} className="mt-3 text-[15px] leading-relaxed text-osu-l2">{t`$3 buys a month of supporter, and every tip adds more time.`}</motion.p>
                <motion.div variants={HERO_LINE} className="mt-5 flex flex-wrap items-center gap-2">
                  <SupportButton />
                  <Link to="/supporter" className="inline-flex h-10 items-center rounded-full bg-osu-b4 px-5 text-[14px] font-semibold text-white transition-colors hover:bg-osu-b3">
                    {t`Try it all on`}
                  </Link>
                </motion.div>
              </motion.div>
              <motion.div
                ref={heroRef}
                initial={reduced ? false : { opacity: 0, scale: 0.9, rotate: -1.5 }}
                animate={{ opacity: 1, scale: 1, rotate: 0 }}
                transition={{ type: "spring", stiffness: 180, damping: 18, delay: 0.15 }}
              >
                <HeroStage />
              </motion.div>
            </section>

            <Perk
              id="themes"
              title={t`Profile themes`}
              count={<Trans><CountUp value={SUPPORTER_PROFILE_THEMES.length} /> themes</Trans>}
              body={t`Your whole profile takes on a theme, with a living backdrop behind it and the site's colours shifted to match.`}
            >
              <ThemesShowcase />
            </Perk>

            <Perk id="frames" title={t`Avatar frames`} count={<Trans><CountUp value={SUPPORTER_AVATAR_FRAMES.length} /> frames</Trans>} body={t`A frame around your avatar on your profile.`}>
              <FramesShowcase />
            </Perk>

            <Perk
              id="names"
              title={t`Name styles and fonts`}
              count={<Trans><CountUp value={SUPPORTER_NAME_STYLES.length} /> styles, <CountUp value={SUPPORTER_NAME_FONTS.length} /> fonts</Trans>}
              body={t`Your name in its own style and font, on your profile and in every list it shows up in.`}
            >
              <NamesShowcase />
            </Perk>

            <Perk
              id="card"
              title={t`Your card`}
              count={<Trans><CountUp value={SUPPORTER_FOILS.length} /> foils</Trans>}
              body={t`The foil and the art on every copy of your card, including the ones other players pull from packs. You can also put your own image on it.`}
            >
              <CardShowcase />
            </Perk>

            <Perk
              id="packs"
              title={t`Packs`}
              count={t`Cases, binders and wrappers`}
              body={t`Keep the cards you own in a 3D case, show your collection as binder pages, and open packs printed on your own wrapper, with your own blade, sparks and sound.`}
            >
              <PacksShowcase />
            </Perk>

            <Perk
              id="stats"
              title={t`Profile stats`}
              count={t`4 more stats`}
              body={t`Swap any of the four cards under your profile for your ratio, rice / LN split, longest streak or percentile among tracked players.`}
            >
              <StatsShowcase />
            </Perk>

            <Perk
              id="sharing"
              title={t`Video share links`}
              count={t`Up to 200 MB`}
              body={t`After exporting a replay video, get a link that plays it right in Discord chat.`}
            >
              <ClipShowcase />
            </Perk>

            <Perk
              id="gift"
              title={t`A week for a friend`}
              count={t`One code per payment`}
              body={t`Each payment gives you a one-time code that gives someone else a week of supporter.`}
            >
              <GiftShowcase />
            </Perk>

            <section id="how" className="scroll-mt-[76px] border-t border-white/[0.07] pt-8">
              <Reveal>
              <h2 className="text-[22px] font-bold text-white">{t`How it works`}</h2>
              <ol className="mt-5 grid gap-6 sm:grid-cols-3">
                {steps.map((step, index) => (
                  <Reveal key={step.title} delay={0.1 + index * 0.12}>
                  <li>
                    <div className="text-[30px] font-black leading-none tabular-nums text-osu-pink-light">{index + 1}</div>
                    <div className="mt-2 text-[15px] font-semibold text-white">{step.title}</div>
                    <p className="mt-1 text-[13px] leading-relaxed text-osu-l2">
                      {step.body}
                      {index === 2 ? (
                        <>
                          {" "}
                          <Link to="/supporter" className="font-semibold text-osu-pink-light hover:underline">{t`Open the supporter page`}</Link>
                        </>
                      ) : null}
                    </p>
                  </li>
                  </Reveal>
                ))}
              </ol>
              </Reveal>
            </section>

            <section id="checkout" className="scroll-mt-[76px] border-t border-white/[0.07] pt-8">
              <Reveal className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)]">
                <div>
                  <h2 className="text-[22px] font-bold text-white">{t`Support`}</h2>
                  <p className="mt-1.5 text-[14px] leading-relaxed text-osu-l2">
                    {t`Pick an amount on Ko-fi. Use your osu! username as your name there, or write osu: and your username as the message, so the time counts for you.`}
                  </p>
                </div>
                <SupportCheckout />
              </Reveal>
            </section>
          </div>
        </div>
      </div>
      <FloatingSupportButton show={floating} />
    </div>
  );
}
