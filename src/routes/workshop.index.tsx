import { useEffect, useState, type ReactNode } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";

import { PageHeader } from "../components/layout/PageHeader";
import { ProfileThemeBackdrop, profileThemeThumb } from "../components/supporter/ProfileThemeBackdrop";
import { NewThemeChooser } from "../components/supporter/themes/NewThemeChooser";
import { frameOverhangMargins, SupporterAvatarFrame } from "../components/player/SupporterAvatarFrame";
import { avatarImageSrc } from "../components/ui/Avatar";
import { useAuth } from "../lib/auth-context";
import { hideBrokenImage } from "../lib/custom-themes";
import { getI18n } from "../lib/i18n";
import { fetchLiveWorkshopFrames } from "../lib/live-backend";
import { framedAvatarStyle, type SupporterAvatarFrameId } from "../lib/supporter-avatar-frames";
import { fetchCustomThemeGallery, type CustomThemeSummary } from "../lib/supporter-custom-themes";
import type { SupporterProfileThemeId } from "../lib/supporter-profile-themes";
import type { SubmittedFrame } from "../lib/workshop-frames";

/* The workshop as a storefront: a rail of where to go, a featured slide
   rotating through what players made, shelves of new frames and popular
   themes worn on the viewer's own avatar, and the two makers at the end. */
export const Route = createFileRoute("/workshop/")({
  head: ({ match }) => {
    const i18n = getI18n(match.context.locale);
    return { meta: [{ title: i18n._(msg`Workshop`) }, { name: "robots", content: "noindex, nofollow" }] };
  },
  component: WorkshopPage,
});

const SLIDE_MS = 6500;
/* Built-in theme pictures the frame tiles stand on, so a shelf isn't one flat colour. */
const BACKDROPS: SupporterProfileThemeId[] = ["synthwave", "inferno", "sakura", "cosmos", "koi", "noir", "aurora", "blackhole", "vaporwave", "frost"];
// versioned like every theme thumb: the service worker keeps an unversioned one forever
const backdrop = (index: number) => profileThemeThumb(BACKDROPS[index % BACKDROPS.length]);

/* What a slide stands on: a gallery theme's still, or one of the site's themes
   played live (their thumbnails are too small to stretch across the slide). */
type Backdrop = { image: string } | { live: SupporterProfileThemeId };
type Slide =
  | { kind: "frame"; frame: SubmittedFrame; backdrop: Backdrop }
  | { kind: "theme"; theme: CustomThemeSummary; backdrop: Backdrop };
const LIVE_BACKDROPS: SupporterProfileThemeId[] = ["vaporwave", "synthwave", "sakura", "aurora"];

function WorkshopPage() {
  const { t } = useLingui();
  const viewer = useAuth().viewer;
  const avatar = viewer ? avatarImageSrc(viewer.avatarUrl, viewer.id) : undefined;
  const [frames, setFrames] = useState<SubmittedFrame[] | null>(null);
  const [themes, setThemes] = useState<CustomThemeSummary[] | null>(null);

  useEffect(() => {
    let alive = true;
    fetchLiveWorkshopFrames().then((list) => alive && setFrames(list)).catch(() => alive && setFrames([]));
    fetchCustomThemeGallery("worn").then((list) => alive && setThemes(list)).catch(() => alive && setThemes([]));
    return () => {
      alive = false;
    };
  }, []);

  // the newest frames and the most worn themes take turns on the featured slide
  const slides: Slide[] = [];
  const shownThemes = (themes ?? []).filter((theme) => theme.stillUrl);
  for (let i = 0; i < 4; i++) {
    const frame = frames?.[i];
    const still = shownThemes[i]?.stillUrl;
    if (frame) slides.push({ kind: "frame", frame, backdrop: still ? { image: still } : { live: LIVE_BACKDROPS[i % LIVE_BACKDROPS.length] } });
    const theme = shownThemes[i];
    if (theme?.stillUrl) slides.push({ kind: "theme", theme, backdrop: { image: theme.stillUrl } });
  }

  return (
    <div className="min-h-[80vh] bg-osu-b5">
      <PageHeader
        iconSrc="/images/icons/workshop.svg"
        title={t`workshop`}
        right={<Link to="/supporter" className="text-[12px] font-semibold text-osu-f1 hover:text-white">{t`Your look`}</Link>}
      />
      <div className="mx-auto grid max-w-[1180px] gap-7 px-4 py-6 sm:px-5 md:grid-cols-[190px_minmax(0,1fr)]">
        <Rail />
        <div className="min-w-0 space-y-9">
          {frames === null || themes === null ? (
            <div className="h-[300px] animate-pulse rounded-2xl bg-osu-b6" />
          ) : slides.length > 0 ? (
            <Featured slides={slides} avatar={avatar} />
          ) : (
            <EmptyHero avatar={avatar} />
          )}

          {frames && frames.length > 0 ? (
            <Shelf title={t`New frames`} more={<Link to="/workshop/frames" hash="shared">{frames.length > 5 ? t`See all ${frames.length}` : t`See all`}</Link>}>
              {frames.slice(0, 5).map((frame, index) => (
                <Link key={frame.id} to="/workshop/frames" hash="shared" className="group overflow-hidden rounded-xl bg-osu-b4 transition hover:brightness-110">
                  <div className="grid h-[150px] place-items-center bg-cover bg-center" style={{ backgroundImage: `url(${backdrop(index)})` }}>
                    <FramedAvatar frame={frame.id} avatar={avatar} size={64} />
                  </div>
                  <Caption name={frame.name} by={frame.submittedBy.username} />
                </Link>
              ))}
            </Shelf>
          ) : null}

          {shownThemes.length > 0 ? (
            <Shelf title={t`Popular themes`} more={<Link to="/workshop/themes/gallery">{t`Gallery`}</Link>}>
              {shownThemes.slice(0, 5).map((theme) => (
                <Link key={theme.id} to="/workshop/themes/gallery" className="overflow-hidden rounded-xl bg-osu-b4 transition hover:brightness-110">
                  <img src={theme.stillUrl ?? undefined} alt="" loading="lazy" onError={hideBrokenImage} className="block aspect-video w-full bg-osu-b6 object-cover" />
                  <Caption name={theme.name} by={theme.author.username} extra={theme.wearers > 0 ? (theme.wearers === 1 ? t`1 using it` : t`${theme.wearers} using it`) : null} />
                </Link>
              ))}
            </Shelf>
          ) : null}

          <section>
            <h2 className="mb-3 text-[17px] font-semibold text-white">{t`Make your own`}</h2>
            <div className="grid gap-3 sm:grid-cols-2">
              <MakeTile to="frames" title={t`Make a frame`} body={t`Draw it on the template, add a loop if you like.`} art={<FramedAvatar frame="pencil-boil" avatar={avatar} size={46} />} />
              <MakeTile to="themes" title={t`Make a theme`} body={t`Stack layers, or write the shader.`} art={<img src={backdrop(9)} alt="" className="h-[58px] w-[104px] rounded-lg object-cover" />} />
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function Rail() {
  const { t } = useLingui();
  const item = "flex items-center rounded-lg px-2.5 py-2 text-[13.5px] font-semibold text-osu-l2 transition-colors hover:bg-osu-b4/60 hover:text-white";
  const heading = "px-2.5 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-wide text-osu-f1";
  return (
    // On a phone it is one scrolling row: nothing shrinks or wraps, or one
    // squeezed label goes to three lines and every tab stretches to its height.
    <nav className="scrollbar-hide max-md:-mx-1 max-md:flex max-md:items-center max-md:gap-1 max-md:overflow-x-auto max-md:whitespace-nowrap max-md:[&>*]:shrink-0 md:sticky md:top-[76px] md:self-start">
      <Link to="/workshop" className={`${item} bg-osu-b4 text-white`}>{t`Featured`}</Link>
      <Link to="/workshop/frames" hash="shared" className={item}>{t`Frames`}</Link>
      <Link to="/workshop/themes/gallery" className={item}>{t`Themes`}</Link>
      <div className={`${heading} max-md:hidden`}>{t`Make`}</div>
      <Link to="/workshop/frames" className={`${item} max-md:shrink-0`}>{t`Make a frame`}</Link>
      <NewThemeChooser trigger={(toggle) => <button type="button" onClick={toggle} className={`${item} w-full cursor-pointer text-left max-md:shrink-0`}>{t`Make a theme`}</button>} />
      <div className={`${heading} max-md:hidden`}>{t`Yours`}</div>
      <Link to="/workshop/frames" hash="yours" className={`${item} max-md:shrink-0`}>{t`Your frames`}</Link>
      <Link to="/workshop/themes" className={`${item} max-md:shrink-0`}>{t`Your themes`}</Link>
      <Link to="/workshop/themes/spec" className={`${item} max-md:shrink-0`}>{t`Theme spec`}</Link>
    </nav>
  );
}

/* The featured slide: one player-made frame or theme at a time, the viewer wearing it. */
function Featured({ slides, avatar }: { slides: Slide[]; avatar: string | undefined }) {
  const { t } = useLingui();
  const reduced = useReducedMotion();
  const [at, setAt] = useState(0);
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (reduced || held || slides.length < 2) return;
    const timer = setTimeout(() => setAt((n) => (n + 1) % slides.length), SLIDE_MS);
    return () => clearTimeout(timer);
  }, [at, held, reduced, slides.length]);
  const slide = slides[at % slides.length];
  return (
    <div className="relative h-[clamp(260px,34vw,330px)] overflow-hidden rounded-2xl bg-osu-b6" onPointerEnter={() => setHeld(true)} onPointerLeave={() => setHeld(false)}>
      <AnimatePresence initial={false}>
        <motion.div
          key={at}
          className="absolute inset-0 flex items-center"
          initial={reduced ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={reduced ? undefined : { opacity: 0 }}
          transition={{ duration: 0.5 }}
        >
          <SlideBackdrop backdrop={slide.backdrop} />
          <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(13,10,18,0.92)_0%,rgba(13,10,18,0.55)_45%,transparent_78%)]" />
          <div className="relative max-w-[380px] px-6 sm:px-12">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-osu-pink-light">{slide.kind === "frame" ? t`Featured frame` : t`Featured theme`}</p>
            <h2 className="mt-2 text-[26px] font-bold leading-tight text-white sm:text-[32px]">{slide.kind === "frame" ? slide.frame.name : slide.theme.name}</h2>
            <p className="mt-1 text-[13px] text-white/70">{t`by ${slide.kind === "frame" ? slide.frame.submittedBy.username : slide.theme.author.username}`}</p>
            <div className="mt-5 flex flex-wrap gap-2">
              {slide.kind === "frame" ? (
                <>
                  <Link to="/supporter" search={{ s: "frame" }} className="inline-flex h-10 items-center rounded-full bg-osu-pink px-5 text-[13.5px] font-semibold text-white transition hover:brightness-110">{t`Try it on`}</Link>
                  <Link to="/workshop/frames" hash="shared" className="inline-flex h-10 items-center rounded-full bg-black/40 px-5 text-[13.5px] font-semibold text-white transition-colors hover:bg-black/60">{t`More frames`}</Link>
                </>
              ) : (
                <>
                  <Link to="/workshop/themes/gallery" className="inline-flex h-10 items-center rounded-full bg-osu-pink px-5 text-[13.5px] font-semibold text-white transition hover:brightness-110">{t`Try it on`}</Link>
                  <Link to="/workshop/themes/$themeId" params={{ themeId: "new" }} search={{ remix: slide.theme.id }} className="inline-flex h-10 items-center rounded-full bg-black/40 px-5 text-[13.5px] font-semibold text-white transition-colors hover:bg-black/60">{t`Remix it`}</Link>
                </>
              )}
            </div>
          </div>
          {slide.kind === "frame" ? (
            <div className="relative ml-auto mr-10 hidden sm:block lg:mr-20">
              <FramedAvatar frame={slide.frame.id} avatar={avatar} size={150} live />
            </div>
          ) : null}
        </motion.div>
      </AnimatePresence>
      {slides.length > 1 ? (
        <div className="absolute bottom-4 left-6 flex gap-1.5 sm:left-12">
          {slides.map((_, index) => (
            <button
              key={index}
              type="button"
              aria-label={t`Slide ${index + 1}`}
              onClick={() => setAt(index)}
              className={`h-1 w-6 cursor-pointer rounded-full transition-colors ${index === at % slides.length ? "bg-white" : "bg-white/30 hover:bg-white/60"}`}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* Before anyone has made anything: the frame maker's invitation in the featured spot. */
function EmptyHero({ avatar }: { avatar: string | undefined }) {
  const { t } = useLingui();
  return (
    <div className="relative flex h-[clamp(260px,34vw,330px)] items-center overflow-hidden rounded-2xl bg-osu-b6">
      <SlideBackdrop backdrop={{ live: "vaporwave" }} />
      <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(13,10,18,0.92)_0%,rgba(13,10,18,0.5)_50%,transparent_80%)]" />
      <div className="relative max-w-[400px] px-6 sm:px-12">
        <h2 className="text-[28px] font-bold leading-tight text-white">{t`Nothing here yet`}</h2>
        <p className="mt-2 text-[13px] text-white/70">{t`The first frame players make goes up here.`}</p>
        <Link to="/workshop/frames" className="mt-5 inline-flex h-10 items-center rounded-full bg-osu-pink px-5 text-[13.5px] font-semibold text-white transition hover:brightness-110">{t`Make a frame`}</Link>
      </div>
      <div className="relative ml-auto mr-10 hidden sm:block lg:mr-20">
        <FramedAvatar frame="crown-sketch-gold" avatar={avatar} size={150} live />
      </div>
    </div>
  );
}

function SlideBackdrop({ backdrop }: { backdrop: Backdrop }) {
  return "image" in backdrop
    ? <img src={backdrop.image} alt="" className="absolute inset-0 h-full w-full object-cover" onError={hideBrokenImage} />
    : <ProfileThemeBackdrop theme={backdrop.live} maxPixels={500_000} className="absolute inset-0" />;
}

function Shelf({ title, more, children }: { title: string; more: ReactNode; children: ReactNode }) {
  return (
    <section>
      <div className="mb-3 flex items-baseline gap-3">
        <h2 className="text-[17px] font-semibold text-white">{title}</h2>
        <span className="text-[12.5px] font-semibold text-osu-f1 [&_a:hover]:text-white">{more}</span>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">{children}</div>
    </section>
  );
}

function Caption({ name, by, extra = null }: { name: string; by: string; extra?: string | null }) {
  const { t } = useLingui();
  return (
    <div className="min-w-0 px-3 pb-3 pt-2.5">
      <p className="truncate text-[13px] font-semibold text-white">{name}</p>
      <p className="truncate text-[11.5px] text-osu-f1">{t`by ${by}`}{extra ? <><span className="mx-1.5 inline-block h-2.5 w-px bg-osu-f1/40 align-middle" />{extra}</> : null}</p>
    </div>
  );
}

function MakeTile({ to, title, body, art }: { to: "frames" | "themes"; title: string; body: string; art: ReactNode }) {
  const inner = (
    <>
      <span className="grid shrink-0 place-items-center">{art}</span>
      <span className="min-w-0">
        <span className="block text-[15px] font-semibold text-white">{title}</span>
        <span className="block text-[12.5px] text-osu-f1">{body}</span>
      </span>
    </>
  );
  const className = "flex items-center gap-5 rounded-xl border-[1.5px] border-dashed border-osu-pink/40 bg-osu-b4 px-5 py-4 transition hover:border-osu-pink/70 hover:brightness-110";
  // a theme starts from layers or from code, so its tile asks which
  return to === "frames"
    ? <Link to="/workshop/frames" className={className}>{inner}</Link>
    : <NewThemeChooser trigger={(toggle) => <button type="button" onClick={toggle} className={`${className} h-full w-full cursor-pointer text-left`}>{inner}</button>} />;
}

/* The viewer's avatar `size` px wide wearing a frame, with room for the frame's art. */
function FramedAvatar({ frame, avatar, size, live = false }: { frame: SupporterAvatarFrameId; avatar: string | undefined; size: number; live?: boolean }) {
  return (
    <div className="relative shrink-0" style={frameOverhangMargins(frame, `${size}px`)}>
      <div className="overflow-hidden bg-osu-b3 shadow-[0_10px_30px_rgba(0,0,0,0.45)]" style={{ width: size, height: size, ...framedAvatarStyle(frame) }}>
        {avatar ? <img src={avatar} alt="" className="h-full w-full object-cover" /> : null}
      </div>
      <SupporterAvatarFrame frame={frame} still={!live} />
    </div>
  );
}
