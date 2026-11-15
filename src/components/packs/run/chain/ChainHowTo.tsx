import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Trans, useLingui } from "@lingui/react/macro";
import { CHAIN_CHART, CHAIN_LINK_RULES, CHAIN_ROUND_CHART, CHAIN_RULES, makeChainCard, makeChainChartCard, type ChainCard } from "#/lib/chain-run";
import { runSound } from "../runSound";
import { ChainCardFace } from "./ChainCardFace";
import { RoundChartTag } from "./ChainRoundChart";
import { ChainButtons, KIT, MARKER } from "./chainKit";

/* How to play: four short pages, each with real card faces doing what the
   page says. Opens by itself the first time someone reaches the start
   screen, and from the start screen and the table's ? button after. */

const SEEN_KEY = "overjoy-howto-seen-v1";

export function chainHowToSeen(): boolean {
  try {
    return window.localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return true;
  }
}

function markSeen(): void {
  try {
    window.localStorage.setItem(SEEN_KEY, "1");
  } catch {
    // Private mode: it opens again next time, which is fine.
  }
}

/* Demo cards: real avatars and a real chart cover, made-up numbers. */
const demo = (id: number, avatar: number, spec: { cc: string; tier: string; key: 4 | 7; skill: string; power: number; name: string }): ChainCard =>
  makeChainCard({ id, name: spec.name, avatarUrl: `https://a.ppy.sh/${avatar}`, cc: spec.cc, tier: spec.tier, power: spec.power, key: spec.key, skill: spec.skill, pp: 9000, rank: 900 })!;
const CARD_A = demo(1, 7296977, { name: "Rorari", cc: "US", tier: "rare", key: 4, skill: "Stream", power: 150 });
const CARD_B = { ...demo(2, 37538073, { name: "Lumi", cc: "US", tier: "rare", key: 4, skill: "Jack", power: 260 }), dan: "10" };
const CARD_C = { ...demo(3, 16438713, { name: "Yoko", cc: "KR", tier: "elite", key: 4, skill: "Jack", power: 380 }), dan: "10" };
const CARD_D = demo(4, 38355633, { name: "Moka", cc: "JP", tier: "mythic", key: 7, skill: "Tech", power: 700 });
const MAP = makeChainChartCard({ beatmapId: 767046, setId: 347650, title: "Triumph & Regret", version: "[4K] Regret", stars: 5.48, key: 4, skill: "Stamina", coverUrl: "https://assets.ppy.sh/beatmaps/347650/covers/list@2x.jpg" })!;
const FAN = { ...demo(5, 5580057, { name: "Kaneka", cc: "CR", tier: "elite", key: 4, skill: "Jack", power: 400 }), played: [767046] };
const ETERNAL = { ...demo(6, 32047306, { name: "Veyo", cc: "US", tier: "worldClass", key: 4, skill: "Stamina", power: 900 }), eternal: true as const, doubled: 3 };

/* A link between two cards: the traits they share, as chips. */
function LinkChips({ traits, broken = false }: { traits: ReactNode[]; broken?: boolean }) {
  return (
    <div className="flex shrink-0 flex-col items-center gap-1 self-center px-1">
      {broken ? (
        <span className="rounded-full px-2 py-0.5 text-[11px] font-black uppercase" style={{ background: KIT.red, color: KIT.dark }}>
          <Trans>Break</Trans>
        </span>
      ) : (
        traits.map((trait, index) => (
          <span key={index} className="whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-black" style={{ background: KIT.gold, color: KIT.dark }}>
            {trait}
          </span>
        ))
      )}
    </div>
  );
}

/* A row of cards and link chips, shrunk as a whole when the window is
   narrower than the row (three cards and two chip columns pass 380px). */
function Cards({ children }: { children: ReactNode }) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<{ scale: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const box = outer.current;
    const row = inner.current;
    if (!box || !row) return;
    const measure = () => {
      const scale = Math.min(1, box.clientWidth / row.scrollWidth);
      setFit(scale < 1 ? { scale, height: row.offsetHeight * scale } : null);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={outer} className="flex w-full justify-center" style={fit ? { height: fit.height } : undefined}>
      <div
        ref={inner}
        className="flex shrink-0 items-start justify-center gap-1.5"
        style={fit ? { transform: `scale(${fit.scale})`, transformOrigin: "top center" } : undefined}
      >
        {children}
      </div>
    </div>
  );
}

function Face({ card, lit, width, playedCover }: { card: ChainCard; lit?: string[]; width: number; playedCover?: string }) {
  return (
    <div className="shrink-0" style={{ width, height: width * 1.4 }}>
      <ChainCardFace card={card} width={width} lit={lit ? new Set(lit) : null} playedCover={playedCover ?? null} />
    </div>
  );
}

export function ChainHowTo({ open, narrow, onClose, onTutorial }: { open: boolean; narrow: boolean; onClose: () => void; onTutorial?: () => void }) {
  const { t } = useLingui();
  const [page, setPage] = useState(0);
  const w = narrow ? 74 : 120;
  useEffect(() => {
    if (!open) return;
    setPage(0);
    markSeen();
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const pages: Array<{ title: ReactNode; body: ReactNode; art: ReactNode }> = [
    {
      title: <Trans>Link a row</Trans>,
      body: (
        <Trans>
          Put up to {CHAIN_RULES.rowMax} cards in a row. Two cards side by side link when they share a country, a dan or a skillset (a second
          skillset only matches another second skillset). Rarity, region and keymode count too, but one of them alone is not a link: the pair has to share something else as well.
        </Trans>
      ),
      art: (
        <Cards>
          <Face card={CARD_A} width={w} lit={["cc", "tier", "key"]} />
          <LinkChips traits={[t`Country`, t`Rarity`, "4K"]} />
          <Face card={CARD_B} width={w} lit={["cc", "tier", "dan", "key", "skill"]} />
          <LinkChips traits={[t`Dan`, "4K", t`Skillset`]} />
          <Face card={CARD_C} width={w} lit={["dan", "key", "skill"]} />
        </Cards>
      ),
    },
    {
      title: <Trans>Build the combo</Trans>,
      body: (
        <Trans>
          Every shared trait raises the combo, more for each extra trait in the same link, up to {CHAIN_LINK_RULES.maxTraits} per link. Each card scores its number times the combo when the chain
          reaches it. A pair that shares nothing breaks the combo back to the start.
        </Trans>
      ),
      art: (
        <Cards>
          <Face card={CARD_B} width={w} lit={["dan", "key", "skill"]} />
          <LinkChips traits={[t`Dan`, "4K", t`Skillset`]} />
          <Face card={CARD_C} width={w} lit={["dan", "key", "skill"]} />
          <LinkChips traits={[]} broken />
          <Face card={CARD_D} width={w} />
        </Cards>
      ),
    },
    {
      title: <Trans>Clear the round</Trans>,
      body: (
        <Trans>
          Reach the round's target within {CHAIN_RULES.rows} rows. A clear pays shards: more for rows left over, a big overshoot, and 1 for every{" "}
          {CHAIN_RULES.interestPer} you already hold. Now and then a round is set on a real map: cards of its keymode and skillset score x
          {CHAIN_ROUND_CHART.skill}, and harder maps pay more. Spend shards in the shop on packs, scene cards, practice and mods.
        </Trans>
      ),
      art: (
        <div className="flex flex-col items-center gap-1 leading-none">
          <div className="mb-3">
            <RoundChartTag chart={MAP} compact={narrow} />
          </div>
          <span style={{ fontFamily: MARKER, fontSize: narrow ? 40 : 56, color: KIT.cream }}>
            6,390{" "}
            <span style={{ color: KIT.gold, fontSize: "0.6em" }}>
              <Trans>of 6,390</Trans>
            </span>
          </span>
          <span className="mt-2 text-[13px] font-black uppercase tracking-[0.2em]" style={{ color: KIT.gold }}>
            <Trans>Round cleared</Trans>
          </span>
        </div>
      ),
    },
    {
      title: <Trans>Cards to look for</Trans>,
      body: (
        <Trans>
          A map card links fully with any player who has it in their top plays, and those players score x{CHAIN_CHART.played} in its row (they wear its
          cover). An Eternal never leaves your hand and doubles every time it plays. GOATs link on every trait. Hover or hold any card to read what it
          does.
        </Trans>
      ),
      art: (
        <Cards>
          <Face card={FAN} width={w} lit={["cc", "tier", "key", "skill"]} playedCover={MAP.avatarUrl} />
          <LinkChips traits={[t`Played it`]} />
          <Face card={MAP} width={w} lit={["tier", "key", "skill"]} />
          <div className="w-3" />
          <Face card={ETERNAL} width={w} />
        </Cards>
      ),
    },
  ];
  const last = page === pages.length - 1;
  const current = pages[page];
  if (typeof document === "undefined") return null;
  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          key="howto"
          className="fixed inset-0 z-[90] flex items-center justify-center overflow-y-auto bg-[#0d0912]/85 px-4 py-8 backdrop-blur-[3px]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
          role="dialog"
          aria-modal="true"
          aria-label={t`How to play`}
        >
          <motion.div
            className="relative flex w-full max-w-[560px] flex-col items-center rounded-[18px] border-[3px] px-5 pb-6 pt-5 text-center text-[#f3e9d8]"
            style={{ background: KIT.dark, borderColor: KIT.cream, boxShadow: "0 8px 0 rgba(0,0,0,0.45)" }}
            initial={{ y: 30, scale: 0.96 }}
            animate={{ y: 0, scale: 1 }}
            exit={{ y: 30, scale: 0.96 }}
            transition={{ type: "spring", stiffness: 380, damping: 28 }}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="text-[12px] font-black uppercase tracking-[0.22em] text-[#f3e9d8]/50">
              <Trans>
                How to play {page + 1} of {pages.length}
              </Trans>
            </div>
            <AnimatePresence mode="wait">
              <motion.div
                key={page}
                className="flex w-full flex-col items-center"
                initial={{ x: 24, opacity: 0 }}
                animate={{ x: 0, opacity: 1 }}
                exit={{ x: -24, opacity: 0 }}
                transition={{ duration: 0.18 }}
              >
                <div className="mt-2 leading-none" style={{ fontFamily: MARKER, fontSize: narrow ? 30 : 38 }}>
                  {current.title}
                </div>
                <div className="mt-5 flex min-h-[150px] w-full items-center justify-center">{current.art}</div>
                <p className="mt-5 max-w-[440px] text-[14px] font-bold leading-snug text-[#f3e9d8]/85">{current.body}</p>
              </motion.div>
            </AnimatePresence>
            <div className="mt-6">
              <ChainButtons
                compact={narrow}
                items={[
                  ...(page > 0
                    ? [{ key: "back", label: <Trans>Back</Trans>, title: t`Back`, onClick: () => { runSound.uiTap(); setPage(page - 1); } }]
                    : onTutorial
                      ? [{ key: "tutorial", label: <Trans>Tutorial</Trans>, title: t`Play the tutorial`, onClick: () => { runSound.uiTap(); onClose(); onTutorial(); } }]
                      : []),
                  {
                    key: "next",
                    primary: true,
                    label: last ? <Trans>Got it</Trans> : <Trans>Next</Trans>,
                    title: last ? t`Got it` : t`Next`,
                    onClick: () => {
                      runSound.uiTap();
                      if (last) onClose();
                      else setPage(page + 1);
                    },
                  },
                ]}
              />
            </div>
            {/* CC BY 4.0 attribution for the table's music (packSfx.ts). 4.0 asks
                for the creator, the licence and a link, not the title. */}
            {last && (
              <div className="mt-4 text-[11px] font-bold text-[#f3e9d8]/45">
                <Trans>
                  Music by Kevin MacLeod (
                  <a href="https://incompetech.com" target="_blank" rel="noreferrer" className="underline hover:text-[#f3e9d8]">
                    incompetech.com
                  </a>
                  ), CC BY 4.0
                </Trans>
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
