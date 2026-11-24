import { Suspense, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { AnimatePresence, motion, useInView, useReducedMotion, type Variants } from "framer-motion";
import type { MessageDescriptor } from "@lingui/core";

import { PageHeader } from "../components/layout/PageHeader";
import { methodSellsPlan, SupportCheckout, SupportMethodSteps, useSupportMethods, type SupportMethod, type SupportPlan } from "../components/supporter/SupportCheckout";
import { KofiNameSteps } from "../components/supporter/KofiNameSteps";
import { SupportPlanInfo } from "../components/supporter/SupportPlans";
import {
  CardShowcase,
  ClipShowcase,
  FramesShowcase,
  GiftShowcase,
  HeroStage,
  NamesShowcase,
  CompanionsShowcase,
  SHOWCASE_COMPANIONS,
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
import { SUPPORTER_RANKS } from "../lib/supporter-ranks";
import { SupporterRankShowcase } from "../components/supporter/SupporterRankBadge";
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
        { name: "description", content: i18n._(msg`Supporting pays for the servers. Supporters get profile themes, avatar frames, name styles, stands, card foils, packs cosmetics, extra profile stats, video share links and DMs from the Discord bot.`) },
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
  { id: "companions", label: msg`Stands` },
  { id: "card", label: msg`Your card` },
  { id: "packs", label: msg`Packs` },
  { id: "stats", label: msg`Profile stats` },
  { id: "sharing", label: msg`Video share links` },
  { id: "gift", label: msg`A week for a friend` },
  { id: "ranks", label: msg`Supporter ranks` },
  { id: "extras", label: msg`Also included` },
  { id: "checkout", label: msg`Support` },
];

/* The section nearest the top of the screen, for the side nav. Read once a
   frame at most while scrolling, and only the nav and the floating button use
   it: when it lived in the page, every section change re-rendered the whole
   page, every showcase included, mid-scroll. */
function useCurrentSection(): string {
  const [current, setCurrent] = useState(SECTIONS[0].id);
  useEffect(() => {
    const nodes = SECTIONS.map((section) => document.getElementById(section.id)).filter((node): node is HTMLElement => !!node);
    let frame = 0;
    const update = () => {
      frame = 0;
      let next = nodes[0]?.id ?? SECTIONS[0].id;
      for (const node of nodes) if (node.getBoundingClientRect().top < 160) next = node.id;
      setCurrent(next);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
    };
  }, []);
  return current;
}

function SectionNav() {
  const { t, i18n } = useLingui();
  const current = useCurrentSection();
  return (
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
  );
}

/* Each section hydrates in its own Suspense boundary (nothing in them
   suspends), so React hydrates the page a section at a time and lets a
   scroll through in between, rather than in one long task. */
function Perk({ id, title, count, body, more, children }: { id: string; title: string; count: ReactNode; body: ReactNode; /** A second line under the body, for a way to make your own. */ more?: ReactNode; children: ReactNode }) {
  return (
    <Suspense fallback={null}>
    <section id={id} className="scroll-mt-[76px] border-t border-white/[0.07] pt-8">
      <Reveal>
      <div className="mb-5 max-w-[620px]">
        <div className="flex flex-wrap items-baseline gap-x-3">
          <h2 className="text-[22px] font-bold text-white">{title}</h2>
          <span className="text-[13px] font-semibold text-osu-pink-light">{count}</span>
        </div>
        <p className="mt-1.5 text-[14px] leading-relaxed text-osu-l2 [&_a]:font-semibold [&_a]:text-osu-pink-light hover:[&_a]:underline">{body}</p>
        {more ? <p className="mt-1 text-[14px] leading-relaxed text-osu-l2 [&_a]:font-semibold [&_a]:text-osu-pink-light hover:[&_a]:underline">{more}</p> : null}
      </div>
      <Reveal delay={0.08}>{children}</Reveal>
      </Reveal>
    </section>
    </Suspense>
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
      {t`Become a supporter`}
    </motion.a>
  );
}

/* The same button, floating at the bottom once the hero has scrolled away and
   until the Ko-fi panel is reached. */
function FloatingSupportButton({ heroRef }: { heroRef: RefObject<HTMLDivElement | null> }) {
  const current = useCurrentSection();
  const heroInView = useInView(heroRef);
  const show = !heroInView && current !== "checkout";
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
  const { t } = useLingui();
  // how to pay: the visitor's pick, else the one their country fits
  const { methods: payMethods, initial: initialPayMethod } = useSupportMethods();
  const [pickedMethod, setPickedMethod] = useState<SupportMethod | null>(null);
  // The one-time amount: the calculator's, and what the crypto panel pays.
  const [onceAmount, setOnceAmount] = useState("4");
  const [plan, setPlan] = useState<SupportPlan>("monthly");
  // back from a crypto invoice: that is a one-time payment
  useEffect(() => {
    if (initialPayMethod === "crypto") setPlan("once");
  }, [initialPayMethod]);
  // only the methods that sell the picked plan; the visitor's pick, then their country's, then the first
  const planMethods = payMethods.filter((method) => methodSellsPlan(method, plan));
  const payMethod = pickedMethod && planMethods.includes(pickedMethod)
    ? pickedMethod
    : initialPayMethod == null ? null
    : planMethods.includes(initialPayMethod) ? initialPayMethod : (planMethods[0] ?? null);
  const reduced = useReducedMotion();
  const heroRef = useRef<HTMLDivElement>(null);

  return (
    <div className="flex-1">
      <PageHeader iconSrc="/images/icons/supporter-gem.svg" title={t`support`} />
      {/* clip, not hidden: the gift ticket's canvas reaches past its box
          and must not widen the page on phones, yet still overlap rows above
          and below it; the section nav stays sticky */}
      <div className="overflow-x-clip bg-osu-b5">
        <div className="mx-auto grid max-w-[1200px] gap-8 px-3 py-6 sm:px-5 sm:py-8 lg:grid-cols-[180px_minmax(0,1fr)]">
          <SectionNav />

          <div className="min-w-0 space-y-12">
            <section id="introduction" className="scroll-mt-[76px] grid items-center gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
              <motion.div variants={HERO_TEXT} initial={reduced ? false : "hidden"} animate="shown">
                <motion.h1 variants={HERO_LINE} className="text-[30px] font-black leading-tight text-white sm:text-[36px]">{t`Become a supporter`}</motion.h1>
                <motion.p variants={HERO_LINE} className="mt-3 text-[15px] leading-relaxed text-osu-l2">
                  {t`Supporting keeps the servers running and new features coming. As thanks, supporters get everything on this page.`}
                </motion.p>
                <motion.p variants={HERO_LINE} className="mt-3 text-[15px] leading-relaxed text-osu-l2">{t`$4 buys a month of supporter, and every payment adds more time. Once you've paid for a month, your customizations keep showing even after your time runs out.`}</motion.p>
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
                <Suspense fallback={null}>
                  <HeroStage />
                </Suspense>
              </motion.div>
            </section>

            <Perk
              id="themes"
              title={t`Profile themes`}
              count={<Trans><CountUp value={SUPPORTER_PROFILE_THEMES.length} /> themes, or your own</Trans>}
              body={t`Your whole profile takes on a theme, with a living backdrop behind it and the site's colours shifted to match.`}
              more={<Trans>Or <Link to="/workshop/themes">create a theme of your own</Link>, or wear one another player shared.</Trans>}
            >
              <ThemesShowcase />
            </Perk>

            <Perk
              id="frames"
              title={t`Avatar frames`}
              count={<Trans><CountUp value={SUPPORTER_AVATAR_FRAMES.length} /> frames, or your own</Trans>}
              body={t`A frame around your avatar on your profile and in maniabot's image replies.`}
              more={<Trans>Or <Link to="/workshop/frames">draw a frame of your own</Link> and submit it for everyone to wear.</Trans>}
            >
              <FramesShowcase />
            </Perk>

            <Perk
              id="names"
              title={t`Name styles and fonts`}
              count={<Trans><CountUp value={SUPPORTER_NAME_STYLES.length} /> styles, <CountUp value={SUPPORTER_NAME_FONTS.length} /> fonts</Trans>}
              body={t`Your name in its own style and font, on your profile, in every list it shows up in and in maniabot's image replies.`}
            >
              <NamesShowcase />
            </Perk>

            <Perk
              id="companions"
              title={t`Stands`}
              count={<Trans><CountUp value={SHOWCASE_COMPANIONS.length} /> to pick, or your own</Trans>}
              body={t`A small figure that stands in the corner of your profile header. Drag a 3D one to turn it around.`}
            >
              <CompanionsShowcase />
            </Perk>

            <Perk
              id="card"
              title={t`Your card`}
              count={<Trans><CountUp value={SUPPORTER_FOILS.length} /> foils</Trans>}
              body={t`The foil on every copy of your card, including the ones other players pull from packs, and an image of your own on it if you like.`}
            >
              <CardShowcase />
            </Perk>

            <Perk
              id="packs"
              title={t`Packs`}
              count={t`Cases, binders and wrappers`}
              body={<Trans>Keep the cards you own in a 3D case, show your collection as binder pages, and open packs printed on your own wrapper, with your own blade, sparks and sound. And fill <Link to="/packs/collections" search={{ tab: "board" }}>the board</Link> with 3x the cards.</Trans>}
            >
              <PacksShowcase />
            </Perk>

            <Perk
              id="stats"
              title={t`Profile stats`}
              count={t`More stats`}
              body={t`Swap any of the four cards under your profile for your ratio, rice / LN split, longest streak, percentile among tracked players, notes hit, strongest skill or the hour you play most.`}
            >
              <StatsShowcase />
            </Perk>

            <Perk
              id="sharing"
              title={t`Video share links`}
              count={t`Up to 200 MB`}
              body={t`Press Share video on a replay to get a link that plays it right in Discord chat.`}
            >
              <ClipShowcase />
            </Perk>

            <Perk
              id="gift"
              title={t`A week for a friend`}
              count={t`One code per $4`}
              body={t`Every $4 you give, in one payment or several, earns a one-time code that gives someone else a week of supporter. You hold one code at a time, and the next shows up once it is used. A monthly subscription earns an extra code every third month, and the same friend can be gifted again after three months.`}
            >
              <GiftShowcase />
            </Perk>

            <Perk
              id="ranks"
              title={t`Supporter ranks`}
              count={<Trans><CountUp value={SUPPORTER_RANKS.length} /> ranks</Trans>}
              body={t`A badge beside your name that moves up a rank for every month in a row you're a supporter, from Amber all the way to Holo. Monthly subscribers get their rank on fire.`}
            >
              <SupporterRankShowcase />
            </Perk>

            <section id="extras" className="scroll-mt-[76px] border-t border-white/[0.07] pt-8">
              <Reveal>
                <h2 className="text-[22px] font-bold text-white">{t`Also included`}</h2>
                <div id="bot-dms" className="mt-4 flex max-w-[620px] scroll-mt-[96px] gap-3">
                  <img src="/images/discord/bot-avatar.png" alt="" className="mt-0.5 h-8 w-8 shrink-0 rounded-full" />
                  <div>
                    <div className="flex flex-wrap items-baseline gap-x-3">
                      <h3 className="text-[15px] font-bold text-white">{t`DMs from the bot`}</h3>
                      <span className="text-[13px] font-semibold text-osu-pink-light">{t`Optional`}</span>
                    </div>
                    <p className="mt-1 text-[14px] leading-relaxed text-osu-l2">
                      {t`Link Discord and pick which ones maniabot sends you: when someone pulls your card, a player you follow sets a top play, a new farm map at your level gets ranked or you get sniped, and a recap of your week.`}{" "}
                      <span className="[&_a]:font-semibold [&_a]:text-osu-pink-light hover:[&_a]:underline"><Trans>Turn them on from the <Link to="/discord">Discord bot page</Link>.</Trans></span>
                    </p>
                  </div>
                </div>
              </Reveal>
            </section>

            <section id="checkout" className="scroll-mt-[76px] border-t border-white/[0.07] pt-8">
              <Reveal>
                <h2 className="text-[22px] font-bold text-white">{t`Support`}</h2>
                {/* the panel comes first on phones, so paying is not below the perks */}
                <div className="mt-4 grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)]">
                  <div className="order-2 lg:order-1">
                    <SupportPlanInfo plan={plan} method={payMethod} amount={onceAmount} onAmount={setOnceAmount} />
                    <p className="mt-4 text-[13px] leading-relaxed text-osu-l2">
                      {t`Pick your look on the supporter page. It saves as you go.`}{" "}
                      <Link to="/supporter" className="font-semibold text-osu-pink-light hover:underline">{t`Open the supporter page`}</Link>
                    </p>
                  </div>
                  <div className="order-1 lg:order-2">
                    <SupportCheckout
                      plan={plan}
                      onPlan={setPlan}
                      methods={planMethods}
                      method={payMethod}
                      onMethod={setPickedMethod}
                      amount={onceAmount}
                      onAmount={setOnceAmount}
                      steps={payMethod ? <SupportMethodSteps method={payMethod} plan={plan} /> : <KofiNameSteps plan={plan} />}
                    />
                  </div>
                </div>
              </Reveal>
            </section>
          </div>
        </div>
      </div>
      <FloatingSupportButton heroRef={heroRef} />
    </div>
  );
}
