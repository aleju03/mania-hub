import { createFileRoute, Link } from "@tanstack/react-router";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useEffect, useState } from "react";

import { PageHeader } from "../components/layout/PageHeader";
import { WorkshopTitle } from "../components/supporter/WorkshopTitle";
import { NewThemeChooser } from "../components/supporter/themes/NewThemeChooser";
import { ConfirmModal } from "../components/ui/ConfirmModal";
import { useAuth } from "../lib/auth-context";
import { hideBrokenImage } from "../lib/custom-themes";
import { getI18n } from "../lib/i18n";
import {
  deleteOwnCustomTheme,
  fetchOwnCustomThemes,
  setOwnCustomThemeVisibility,
  wearCustomTheme,
  type CustomThemeSummary,
  type OwnCustomThemes,
} from "../lib/supporter-custom-themes";

/* A supporter's own profile themes: make one, edit, wear, share in the
   gallery or take out of it, and delete. */
export const Route = createFileRoute("/workshop/themes/")({
  head: ({ match }) => {
    const i18n = getI18n(match.context.locale);
    return { meta: [{ title: i18n._(msg`Your themes`) }, { name: "robots", content: "noindex, nofollow" }] };
  },
  component: OwnThemesPage,
});

function OwnThemesPage() {
  const { t } = useLingui();
  const auth = useAuth();
  const [own, setOwn] = useState<OwnCustomThemes | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [deleting, setDeleting] = useState<CustomThemeSummary | null>(null);

  const load = () => fetchOwnCustomThemes().then(setOwn).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  useEffect(() => {
    if (auth.viewer) void load();
  }, [auth.viewer?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (themeId: number, action: () => Promise<unknown>) => {
    setBusy(themeId);
    setError(null);
    try {
      await action();
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const header = (
    <PageHeader
      iconSrc="/images/icons/workshop.svg"
      title={<WorkshopTitle>{t`your themes`}</WorkshopTitle>}
      right={
        <span className="flex items-center gap-3">
          <Link to="/workshop/themes/gallery" className="text-[12px] font-semibold text-osu-f1 hover:text-white">{t`Gallery`}</Link>
          <Link to="/workshop/themes/spec" className="text-[12px] font-semibold text-osu-f1 hover:text-white">{t`Spec`}</Link>
          <NewThemeButton />
        </span>
      }
    />
  );

  if (!auth.viewer) {
    return (
      <div className="min-h-[80vh] bg-osu-b5">
        {header}
        <p className="py-16 text-center text-[13px] text-osu-l2">
          <a href={`/api/auth/osu?next=${encodeURIComponent("/workshop/themes")}`} className="font-semibold text-osu-pink-light hover:underline">{t`Sign in`}</a>{" "}
          {t`to make your own profile themes.`}
        </p>
      </div>
    );
  }

  const worn = own?.worn ?? null;
  return (
    <div className="min-h-[80vh] bg-osu-b5">
      {header}
      <div className="mx-auto max-w-[1200px] px-4 py-6 sm:px-5">
        <p className="mb-5 max-w-[720px] text-[12.5px] text-osu-l2">
          {t`Build a theme from layers with no code, or write its shader yourself. Save drafts as you go, and publish it when it's ready.`}
        </p>
        {own?.disabled ? (
          <p className="mb-4 rounded-lg bg-amber-500/10 px-3 py-2 text-[12.5px] text-amber-200">{t`Custom themes are switched off for now: profiles show their stills, and saving waits.`}</p>
        ) : null}
        {error ? <p className="mb-4 text-[12.5px] text-osu-red-light">{error}</p> : null}
        {own === undefined ? (
          <p className="py-10 text-center text-[12.5px] text-osu-f1">{t`Loading...`}</p>
        ) : !own || own.themes.length === 0 ? (
          <div className="py-12 text-center">
            <p className="text-[13px] text-osu-l2">{t`No themes yet.`}</p>
            <p className="mt-1 text-[12px] text-osu-f1">
              <Link to="/workshop/themes/$themeId" params={{ themeId: "new" }} search={{ mode: "layers" }} className="font-semibold text-osu-pink-light hover:underline">{t`Start one`}</Link>
              {" "}{t`or`}{" "}
              <Link to="/workshop/themes/gallery" className="font-semibold text-osu-pink-light hover:underline">{t`remix one from the gallery`}</Link>
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4">
            {own.themes.map((theme) => {
              const wearing = worn?.themeId === theme.id;
              const taken = theme.state === "taken_down";
              // only ever a draft: nothing to wear or share until it's published
              const unpublished = theme.liveRevision === null;
              return (
                <article key={theme.id} className="overflow-hidden rounded-xl bg-osu-b4">
                  <div className="relative aspect-[1200/630] bg-osu-b6" style={theme.look ? { backgroundColor: theme.look.base } : undefined}>
                    {theme.stillUrl ? <img src={theme.stillUrl} alt="" className="h-full w-full object-cover" loading="lazy" onError={hideBrokenImage} /> : unpublished ? (
                      <span className="absolute inset-0 grid place-items-center text-[12px] text-osu-f1">{t`Not published yet`}</span>
                    ) : null}
                    {wearing ? <span className="absolute left-2 top-2 rounded-md bg-osu-pink px-1.5 py-0.5 text-[11px] font-semibold text-white">{t`Wearing`}</span> : null}
                  </div>
                  <div className="p-3">
                    <div className="flex items-center gap-2">
                      <h3 className="min-w-0 flex-1 truncate text-[14px] font-semibold text-white">{theme.name || t`Untitled theme`}</h3>
                      <StatePill theme={theme} />
                    </div>
                    {theme.visibility === "gallery" && !taken && !unpublished ? (
                      <p className="mt-0.5 text-[11.5px] text-osu-f1">{theme.wearers === 1 ? t`1 wearing it` : t`${theme.wearers} wearing it`}</p>
                    ) : null}
                    {theme.draftAt !== null && !unpublished && !taken ? (
                      <p className="mt-0.5 text-[11.5px] text-amber-200/80">{t`Has a draft you haven't published`}</p>
                    ) : null}
                    <div className="mt-3 flex flex-wrap items-center gap-1.5">
                      {!taken ? (
                        <Link to="/workshop/themes/$themeId" params={{ themeId: String(theme.id) }} className={BUTTON}>{t`Edit`}</Link>
                      ) : null}
                      {!taken && !unpublished && theme.state === "live" ? (
                        wearing ? (
                          <button type="button" disabled={busy !== null} onClick={() => void act(theme.id, () => wearCustomTheme({ data: { themeId: null } }))} className={BUTTON}>{t`Take off`}</button>
                        ) : (
                          <button type="button" disabled={busy !== null} onClick={() => void act(theme.id, () => wearCustomTheme({ data: { themeId: theme.id, rows: worn?.rows ?? false } }))} className={BUTTON}>{t`Wear`}</button>
                        )
                      ) : null}
                      {!taken && !unpublished ? (
                        <button
                          type="button"
                          disabled={busy !== null}
                          onClick={() => void act(theme.id, () => setOwnCustomThemeVisibility({ data: { themeId: theme.id, visibility: theme.visibility === "gallery" ? "private" : "gallery" } }))}
                          className={BUTTON}
                        >
                          {theme.visibility === "gallery" ? t`Take out of the gallery` : t`Share in the gallery`}
                        </button>
                      ) : null}
                      <button type="button" disabled={busy !== null} onClick={() => setDeleting(theme)} className={`${BUTTON} ml-auto text-rose-300 hover:text-rose-200`}>{t`Delete`}</button>
                    </div>
                    {wearing ? (
                      <label className="mt-2.5 flex cursor-pointer items-center gap-2 text-[12px] text-osu-l2">
                        <input
                          type="checkbox"
                          checked={worn?.rows ?? false}
                          disabled={busy !== null}
                          onChange={(event) => void act(theme.id, () => wearCustomTheme({ data: { themeId: theme.id, rows: event.target.checked } }))}
                          className="accent-osu-pink"
                        />
                        {t`Show its banner behind my rows in lists`}
                      </label>
                    ) : null}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>
      {deleting ? (
        <ConfirmModal
          title={deleting.name ? t`Delete ${deleting.name}?` : t`Delete this theme?`}
          body={deleting.visibility === "gallery" ? t`It leaves your list, your profile and the gallery. Anyone already wearing it keeps it.` : t`It leaves your list and your profile.`}
          confirmLabel={t`Delete`}
          cancelLabel={t`Cancel`}
          danger
          onConfirm={() => void act(deleting.id, () => deleteOwnCustomTheme({ data: { themeId: deleting.id } }))}
          onClose={() => setDeleting(null)}
        />
      ) : null}
    </div>
  );
}

/* New theme: built from layers (no code) or written as code. */
function NewThemeButton() {
  const { t } = useLingui();
  return (
    <NewThemeChooser
      align="right"
      trigger={(toggle) => (
        <button
          type="button"
          onClick={toggle}
          className="inline-flex h-8 cursor-pointer items-center rounded-full bg-osu-pink px-4 text-[12px] font-semibold text-white transition hover:brightness-110"
        >
          {t`New theme`}
        </button>
      )}
    />
  );
}

const BUTTON = "inline-flex h-7 cursor-pointer items-center rounded-lg bg-osu-b3/60 px-2.5 text-[11.5px] font-semibold text-osu-l2 transition-colors hover:bg-osu-b3 hover:text-white disabled:cursor-default disabled:opacity-50";

function StatePill({ theme }: { theme: CustomThemeSummary }) {
  const { t } = useLingui();
  if (theme.state === "taken_down") return <span className="rounded-md bg-rose-500/15 px-1.5 py-0.5 text-[11px] font-semibold text-rose-300">{t`Taken down`}</span>;
  if (theme.liveRevision === null) return <span className="rounded-md bg-osu-b3/60 px-1.5 py-0.5 text-[11px] font-semibold text-osu-f1">{t`Draft`}</span>;
  if (theme.state === "auto_hidden") return <span className="rounded-md bg-amber-500/15 px-1.5 py-0.5 text-[11px] font-semibold text-amber-300" title={t`It crashed on several visitors' devices, so it shows its still until it's looked at.`}>{t`Still only`}</span>;
  return (
    <span className="rounded-md bg-osu-b3/60 px-1.5 py-0.5 text-[11px] font-semibold text-osu-f1">
      {theme.visibility === "gallery" ? t`In the gallery` : t`Just me`}
    </span>
  );
}
