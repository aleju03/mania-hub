import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Trans, useLingui } from "@lingui/react/macro";
import { msg } from "@lingui/core/macro";
import { getI18n } from "../lib/i18n";
import { PageHeader } from "../components/layout/PageHeader";
import { overjoyRunOgImagePath, pageSeo } from "../lib/seo";
import {
  CHAIN_SCENE_NAMES,
  chainIsEndless,
  fetchChainRunShare,
  formatChainScore,
  type ChainRunShare,
} from "../lib/chain-run";
import { ChainCardFace } from "../components/packs/run/chain/ChainCardFace";
import { ChainButtons, KIT, MARKER, SceneMedallion } from "../components/packs/run/chain/chainKit";
import { SCENE_ART_ID, SceneArt } from "../components/packs/run/sceneArt";
import { PaintBackdrop } from "../components/packs/run/chain/PaintBackdrop";
import { useReducedMotion } from "framer-motion";

/* An Overjoy run as its share link opens it: how far it got, its best row's
   cards and the scene cards it ended with, and a way into the game. Loaded on
   the server so a link pasted into a chat unfurls into the run's card. */

export const Route = createFileRoute("/packs_/overjoy/$id")({
  loader: async ({ params }) => {
    try {
      return await fetchChainRunShare({ data: params.id });
    } catch {
      return null;
    }
  },
  head: ({ match }) => {
    const share = match.loaderData as ChainRunShare | null | undefined;
    const i18n = getI18n(match.context.locale);
    const path = `/packs/overjoy/${match.params.id}`;
    if (!share) {
      return pageSeo({ title: "Overjoy", description: i18n._(msg`A card game on maniacards.`), path, origin: match.context.origin, noindex: true });
    }
    const best = formatChainScore(share.bestRow);
    const round = share.round;
    const who = share.username || "A player";
    return pageSeo({
      // The card and its title stay English, like every other link card.
      title: share.won ? `${who} won an Overjoy run` : `${who} reached round ${round} in Overjoy`,
      description: `Round ${round}, best row ${best}, ${share.rows} rows played.`,
      path,
      origin: match.context.origin,
      image: overjoyRunOgImagePath(share.id),
      imageWidth: 1200,
      imageHeight: 630,
      noindex: true,
    });
  },
  component: OverjoyRunPage,
});

function OverjoyRunPage() {
  const share = Route.useLoaderData() as ChainRunShare | null;
  const navigate = useNavigate();
  const { t } = useLingui();
  const reducedMotion = useReducedMotion();

  if (!share) {
    return (
      <div className="min-h-[60vh] bg-osu-b5">
        <PageHeader iconSrc="/images/icons/packs.svg" title="Overjoy" />
        <div className="mx-auto max-w-[1200px] px-4 py-16 text-center sm:px-5">
          <p className="text-[13px] text-osu-f1"><Trans>This run is gone, or the link is wrong.</Trans></p>
          <Link
            to="/packs"
            search={{ view: "run" }}
            className="mt-3 inline-flex rounded-lg bg-osu-b4 px-3 py-1.5 text-[12px] font-semibold text-osu-l2 transition-colors hover:bg-osu-b3 hover:text-white"
          >
            <Trans>Play Overjoy</Trans>
          </Link>
        </div>
      </div>
    );
  }

  const round = share.round;
  const endless = chainIsEndless(round);
  const day = new Date(share.createdAt).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
  const stat = (label: React.ReactNode, value: string, ink: string) => (
    <div className="flex flex-col items-center">
      <span className="text-[10px] font-black uppercase tracking-[0.22em] text-[#f3e9d8]/50">{label}</span>
      <span className="leading-none tabular-nums" style={{ fontFamily: MARKER, color: ink, fontSize: 40 }}>
        {value}
      </span>
    </div>
  );

  return (
    <div className="min-h-[60vh] bg-osu-b5 pb-16">
      <PageHeader iconSrc="/images/icons/packs.svg" title="Overjoy" />
      <div className="mx-auto max-w-[900px] px-4 pt-6 sm:px-5">
        <div className="relative isolate overflow-hidden rounded-2xl">
          {/* The game's own table behind the run: the end screen's red for a
              run over, the round's pink for a run won. */}
          <PaintBackdrop stage={share.won ? "round" : "over"} heat={0} reducedMotion={Boolean(reducedMotion)} />
          <div className="relative flex flex-col items-center px-5 py-8 text-[#f3e9d8] sm:px-8">
            <Link to="/player/$username" params={{ username: share.username }} className="flex items-center gap-2.5 text-[15px] font-black hover:underline">
              <img src={`https://a.ppy.sh/${share.userId}`} alt="" className="h-8 w-8 rounded-lg object-cover" />
              {share.username}
            </Link>
            <div className="mt-1 flex items-center gap-2 text-[12px] font-bold text-[#f3e9d8]/55">
              {share.daily && (
                <span className="rounded-full border px-2 py-px text-[11px] font-black" style={{ borderColor: KIT.gold, color: KIT.gold }}>
                  <Trans>Daily</Trans>
                </span>
              )}
              {day}
            </div>
            <div className="mt-4 leading-none" style={{ fontFamily: MARKER, fontSize: 52, transform: "rotate(-2deg)" }}>
              {share.won ? <Trans>Run won</Trans> : <Trans>Run over</Trans>}
            </div>
            <div className="mt-3 leading-none" style={{ fontFamily: MARKER, fontSize: 30, color: share.won || endless ? KIT.gold : KIT.pink }}>
              {endless ? <Trans>Endless round {round}</Trans> : <Trans>Round {round}</Trans>}
            </div>
            <div className="mt-5 flex items-end justify-center gap-12">
              {stat(<Trans>Best row</Trans>, formatChainScore(share.bestRow), KIT.gold)}
              {stat(<Trans>Rows</Trans>, String(share.rows), KIT.cream)}
            </div>

            {share.scenes.length > 0 && (
              <div className="mt-6 flex flex-wrap justify-center gap-5">
                {share.scenes.map((scene) => (
                  <div key={scene} className="flex w-[96px] flex-col items-center gap-1">
                    <SceneMedallion size={84}>
                      <SceneArt id={SCENE_ART_ID[scene]} size={44} />
                    </SceneMedallion>
                    <span className="text-center text-[12px] font-bold leading-tight text-[#f3e9d8]/75">{CHAIN_SCENE_NAMES[scene]}</span>
                  </div>
                ))}
              </div>
            )}

            {share.bestRowCards.length > 0 && (
              <>
                <div className="mt-7 text-[10px] font-black uppercase tracking-[0.22em] text-[#f3e9d8]/50">
                  <Trans>Best row</Trans>
                </div>
                <div className="mt-2 flex flex-wrap justify-center gap-2">
                  {share.bestRowCards.map((card, index) => (
                    <div key={`${card.id}-${index}`} style={{ width: 104, height: 104 * 1.4 }}>
                      <ChainCardFace card={card} width={104} />
                    </div>
                  ))}
                </div>
              </>
            )}

            <div className="mt-8">
              <ChainButtons
                items={[
                  {
                    key: "play",
                    primary: true,
                    title: t`Play Overjoy`,
                    label: <Trans>Play Overjoy</Trans>,
                    onClick: () => void navigate({ to: "/packs", search: { view: "run" } }),
                  },
                ]}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
