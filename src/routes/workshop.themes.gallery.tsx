import { createFileRoute, Link } from "@tanstack/react-router";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { PageHeader } from "../components/layout/PageHeader";
import { WorkshopTitle } from "../components/supporter/WorkshopTitle";
import { ReportModal } from "../components/supporter/CustomThemeCredit";
import { ProfileThemeBackdrop } from "../components/supporter/ProfileThemeBackdrop";
import { ConfirmModal } from "../components/ui/ConfirmModal";
import { useAuth } from "../lib/auth-context";
import { reportCustomTheme } from "../lib/custom-theme-reports";
import { hideBrokenImage, parseCustomTheme, type CustomTheme } from "../lib/custom-themes";
import { getI18n } from "../lib/i18n";
import {
  deleteOwnCustomTheme,
  fetchCustomThemeGallery,
  fetchGalleryCustomTheme,
  markCustomThemeGalleryChanged,
  wearCustomTheme,
  type CustomThemeSummary,
  type GalleryCustomTheme,
} from "../lib/supporter-custom-themes";
import { fetchSupporterLookState } from "../lib/supporter-look-settings";
import { useBodyScrollLock } from "../lib/use-body-scroll-lock";

/* Themes supporters chose to share: stills in a grid, one playing live at a
   time when opened, to wear, remix or report. Its maker can edit or delete it
   from there too. */
export const Route = createFileRoute("/workshop/themes/gallery")({
  head: ({ match }) => {
    const i18n = getI18n(match.context.locale);
    return { meta: [{ title: i18n._(msg`Theme gallery`) }, { name: "description", content: i18n._(msg`Profile themes made by supporters.`) }] };
  },
  component: ThemeGalleryPage,
});

function ThemeGalleryPage() {
  const { t } = useLingui();
  const [sort, setSort] = useState<"new" | "worn">("new");
  const [themes, setThemes] = useState<CustomThemeSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<CustomThemeSummary | null>(null);

  useEffect(() => {
    let alive = true;
    setThemes(null);
    fetchCustomThemeGallery(sort)
      .then((next) => alive && setThemes(next))
      .catch((cause: unknown) => alive && setError(cause instanceof Error ? cause.message : String(cause)));
    return () => {
      alive = false;
    };
  }, [sort]);

  return (
    <div className="min-h-[80vh] bg-osu-b5">
      <PageHeader
        iconSrc="/images/icons/workshop.svg"
        title={<WorkshopTitle>{t`theme gallery`}</WorkshopTitle>}
        right={<Link to="/workshop/themes" className="text-[12px] font-semibold text-osu-f1 hover:text-white">{t`Your themes`}</Link>}
      />
      <div className="mx-auto max-w-[1200px] px-4 py-6 sm:px-5">
        <div className="mb-4 flex items-center gap-1.5">
          {(["new", "worn"] as const).map((id) => (
            <button
              key={id}
              type="button"
              aria-pressed={sort === id}
              onClick={() => setSort(id)}
              className={`h-7 cursor-pointer rounded-full px-3 text-[11.5px] font-semibold transition-colors ${sort === id ? "bg-osu-pink/20 text-osu-pink-light" : "bg-osu-b4 text-osu-f1 hover:text-white"}`}
            >
              {id === "new" ? t`Newest` : t`Most worn`}
            </button>
          ))}
        </div>
        {error ? <p className="text-[12.5px] text-osu-red-light">{error}</p> : null}
        {themes === null ? (
          <p className="py-10 text-center text-[12.5px] text-osu-f1">{t`Loading...`}</p>
        ) : themes.length === 0 ? (
          <p className="py-12 text-center text-[13px] text-osu-l2">{t`Nobody has shared a theme yet.`}</p>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4">
            {themes.map((theme) => (
              <button key={theme.id} type="button" onClick={() => setOpen(theme)} className="group cursor-pointer overflow-hidden rounded-xl bg-osu-b4 text-left">
                <div className="aspect-[1200/630] overflow-hidden" style={theme.look ? { backgroundColor: theme.look.base } : undefined}>
                  {theme.stillUrl ? <img src={theme.stillUrl} alt="" loading="lazy" className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]" onError={hideBrokenImage} /> : null}
                </div>
                <div className="p-3">
                  <h3 className="truncate text-[14px] font-semibold text-white">{theme.name}</h3>
                  <p className="mt-0.5 flex items-center gap-2 text-[11.5px] text-osu-f1">
                    <span className="truncate">{t`by ${theme.author.username}`}</span>
                    <span aria-hidden className="h-3 w-px shrink-0 bg-white/15" />
                    <span className="shrink-0">{theme.wearers === 1 ? t`1 using it` : t`${theme.wearers} using it`}</span>
                  </p>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
      {open ? (
        <GalleryThemeModal
          summary={open}
          onClose={() => setOpen(null)}
          onDeleted={() => {
            setThemes((list) => list?.filter((theme) => theme.id !== open.id) ?? list);
            setOpen(null);
          }}
        />
      ) : null}
    </div>
  );
}

function GalleryThemeModal({ summary, onClose, onDeleted }: { summary: CustomThemeSummary; onClose: () => void; onDeleted: () => void }) {
  const { t } = useLingui();
  const auth = useAuth();
  const [theme, setTheme] = useState<GalleryCustomTheme | null | undefined>(undefined);
  const [supporter, setSupporter] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [reporting, setReporting] = useState(false);
  const [wearing, setWearing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  // Escape answers the confirm first, and only then closes the preview under it
  const confirmingRef = useRef(false);
  confirmingRef.current = confirming;
  useBodyScrollLock(true);

  useEffect(() => {
    let alive = true;
    fetchGalleryCustomTheme(summary.id).then((next) => alive && setTheme(next)).catch(() => alive && setTheme(null));
    if (auth.viewer) fetchSupporterLookState().then((state) => alive && setSupporter(state.supporter)).catch(() => {});
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !confirmingRef.current) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      alive = false;
      window.removeEventListener("keydown", onKey);
    };
  }, [summary.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const backdrop: CustomTheme | null = theme ? parseCustomTheme(theme) : null;
  const own = auth.viewer?.id === summary.author.id;

  const wear = async () => {
    setWearing(true);
    setStatus(null);
    try {
      await wearCustomTheme({ data: { themeId: summary.id } });
      setStatus(t`It's on your profile now.`);
    } catch (cause) {
      setStatus(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWearing(false);
    }
  };

  const remove = async () => {
    setRemoving(true);
    setStatus(null);
    try {
      await deleteOwnCustomTheme({ data: { themeId: summary.id } });
      markCustomThemeGalleryChanged();
      onDeleted();
    } catch (cause) {
      setStatus(cause instanceof Error ? cause.message : String(cause));
      setRemoving(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[130] flex justify-center overflow-y-auto bg-black/75 p-3 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label={summary.name}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="my-auto w-full max-w-[960px] overflow-hidden rounded-xl bg-osu-b5">
        <div className="relative aspect-video" style={{ backgroundColor: summary.look?.base ?? "#000" }}>
          {backdrop ? (
            <ProfileThemeBackdrop theme={backdrop} className="absolute inset-0" />
          ) : summary.stillUrl ? (
            <img src={summary.stillUrl} alt="" className="absolute inset-0 h-full w-full object-cover" onError={hideBrokenImage} />
          ) : null}
        </div>
        <div className="flex flex-wrap items-start gap-4 p-4">
          <div className="min-w-0 flex-1">
            <h2 className="text-[16px] font-bold text-white">{summary.name}</h2>
            <p className="mt-0.5 text-[12px] text-osu-f1">
              {t`by ${summary.author.username}`}
              {summary.remixedFrom ? <> <span aria-hidden className="mx-1.5 inline-block h-3 w-px translate-y-0.5 bg-white/15" /> {t`a remix`}</> : null}
            </p>
            {theme?.credits ? <p className="mt-2 text-[12px] text-osu-l2">{theme.credits}</p> : null}
            {theme === null ? <p className="mt-2 text-[12px] text-osu-red-light">{t`This theme isn't in the gallery anymore.`}</p> : null}
            {status ? <p className="mt-2 text-[12px] text-osu-l2">{status}</p> : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {supporter && theme ? (
              <button type="button" disabled={wearing} onClick={() => void wear()} className="h-9 cursor-pointer rounded-full bg-osu-pink px-4 text-[12.5px] font-semibold text-white transition hover:brightness-110 disabled:opacity-60">
                {t`Use it`}
              </button>
            ) : null}
            {theme ? (
              <Link
                to="/workshop/themes/$themeId"
                params={{ themeId: "new" }}
                search={{ remix: summary.id }}
                className="inline-flex h-9 items-center rounded-full bg-osu-b4 px-4 text-[12.5px] font-semibold text-white transition-colors hover:bg-osu-b3"
              >
                {t`Remix it`}
              </Link>
            ) : null}
            {auth.viewer && !own && theme ? (
              <button type="button" onClick={() => setReporting(true)} className="h-9 cursor-pointer rounded-full px-3 text-[12.5px] font-semibold text-osu-f1 hover:text-white">
                {t`Report`}
              </button>
            ) : null}
            {own ? (
              <>
                <Link
                  to="/workshop/themes/$themeId"
                  params={{ themeId: String(summary.id) }}
                  className="inline-flex h-9 items-center rounded-full bg-osu-b4 px-4 text-[12.5px] font-semibold text-white transition-colors hover:bg-osu-b3"
                >
                  {t`Edit`}
                </Link>
                <button type="button" disabled={removing} onClick={() => setConfirming(true)} className="h-9 cursor-pointer rounded-full px-3 text-[12.5px] font-semibold text-rose-300 hover:text-rose-200 disabled:opacity-60">
                  {t`Delete`}
                </button>
              </>
            ) : null}
            <button type="button" onClick={onClose} className="h-9 cursor-pointer rounded-full px-3 text-[12.5px] font-semibold text-osu-f1 hover:text-white">
              {t`Close`}
            </button>
          </div>
          {!supporter && auth.viewer && theme ? (
            <p className="w-full text-[11.5px] text-osu-f1">{t`Using a theme from the gallery is for supporters. Anyone can remix one to try it in the editor.`}</p>
          ) : null}
        </div>
      </div>
      {confirming ? (
        <ConfirmModal
          title={summary.name ? t`Delete ${summary.name}?` : t`Delete this theme?`}
          body={t`It leaves your list, your profile and the gallery. Anyone already using it keeps it.`}
          confirmLabel={t`Delete`}
          cancelLabel={t`Cancel`}
          danger
          onConfirm={() => void remove()}
          onClose={() => setConfirming(false)}
        />
      ) : null}
      {reporting && theme ? (
        <ReportModal
          onClose={() => setReporting(false)}
          onSend={async (kind, note) => {
            await reportCustomTheme({ data: { themeId: theme.themeId, rev: theme.rev, kind, note } });
            setStatus(t`Thanks, the report was sent.`);
          }}
        />
      ) : null}
    </div>,
    document.body,
  );
}
