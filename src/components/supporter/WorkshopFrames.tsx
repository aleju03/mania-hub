import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useLingui } from "@lingui/react/macro";

import { avatarImageSrc } from "../ui/Avatar";
import { frameOverhangMargins, SupporterAvatarFrame } from "../player/SupporterAvatarFrame";
import { useAuth } from "../../lib/auth-context";
import { deleteDraft, listDraftsWithArt, type DraftSummary } from "../../lib/frame-editor/storage";
import { removeAccountDraft } from "../../lib/frame-drafts";
import { ConfirmModal } from "../ui/ConfirmModal";
import { deleteAdminFrame, loadAdminFrames, setAdminFrameListed, setAdminFrameReviewed } from "../../lib/admin-supporters";
import { fetchLiveWorkshopFrames, forgetLiveSupporterLook, setSupporterFrameLocally } from "../../lib/live-backend";
import {
  framedAvatarStyle,
  registerWorkshopFrames,
  WORKSHOP_FRAME_TEMPLATE,
  type SupporterAvatarFrameId,
  type WorkshopFrameArt,
} from "../../lib/supporter-avatar-frames";
import {
  deleteOwnWorkshopFrame,
  fetchOwnWorkshopFrames,
  fetchSupporterLookState,
  saveSupporterFrameSetting,
  submitWorkshopFrame,
} from "../../lib/supporter-look-settings";
import { FRAME_NAME_MAX, registerSubmittedFrames, uploadFramePart as upload, type SubmittedFrame } from "../../lib/workshop-frames";

/* The workshop's frame maker (/workshop/frames). A supporter draws on the
   template, picks the still (and, if they like, a looping WebM and a round
   version), sees it on their own avatar at the sizes the site draws it, names
   it and submits it. Anyone can make and preview one (the files stay in the
   browser); submitting uploads them and is for supporters.
   It goes into everyone's picker at once; an admin reviews it afterwards from
   the same page, newest unreviewed first, and can take it off the list. */

/* The draft's art is shown under an id no saved frame can have. */
const DRAFT_ID = "u0" as const;
const { size: T, avatar: A, inset: I } = WORKSHOP_FRAME_TEMPLATE;
const AVATAR_RADIUS = Math.round((16 / 124) * A);

/* The template to draw on: the canvas, the avatar's place, and the line art should keep clear of. */
function templateSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${T}" height="${T}" viewBox="0 0 ${T} ${T}">
  <rect x="0.5" y="0.5" width="${T - 1}" height="${T - 1}" fill="none" stroke="#ff66ab" stroke-opacity="0.5" stroke-dasharray="6 6"/>
  <rect x="${I}" y="${I}" width="${A}" height="${A}" rx="${AVATAR_RADIUS}" fill="#ffffff" fill-opacity="0.12" stroke="#ffffff" stroke-opacity="0.7" stroke-width="2" stroke-dasharray="8 6"/>
  <circle cx="${T / 2}" cy="${T / 2}" r="${A / 2}" fill="none" stroke="#7fd4ff" stroke-opacity="0.7" stroke-width="2" stroke-dasharray="3 5"/>
  <text x="${T / 2}" y="${T - I / 2}" fill="#7fd4ff" fill-opacity="0.8" font-family="sans-serif" font-size="13" text-anchor="middle" dominant-baseline="middle">round version: draw it around the circle</text>
  <text x="${T / 2}" y="${T / 2}" fill="#ffffff" fill-opacity="0.6" font-family="sans-serif" font-size="16" text-anchor="middle" dominant-baseline="middle">avatar (keep this mostly clear)</text>
  <text x="${T / 2}" y="${I / 2}" fill="#ff66ab" fill-opacity="0.8" font-family="sans-serif" font-size="13" text-anchor="middle" dominant-baseline="middle">art may reach out to the dashed edge</text>
</svg>`;
}

/* A file picked for the draft, shown from the browser: nothing is uploaded
   until the frame is submitted, so anyone can try the maker. */
type Local = { file: File; url: string };
type Draft = { still: Local | null; overhang: WorkshopFrameArt["overhang"] | null; video: Local | null; round: Local | null; name: string };
const EMPTY_DRAFT: Draft = { still: null, overhang: null, video: null, round: null, name: "" };
const MIN_CLEAR_AVATAR = 0.6;

/* The picture's reach past the avatar and whether it leaves the avatar
   showing, measured in the browser as the upload will measure it again. */
async function measurePicture(file: File, round: boolean): Promise<{ overhang: [number, number, number, number] } | { error: "size" | "square" | "empty" | "covers" | "read" }> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return { error: "read" };
  }
  if (bitmap.width < T / 2 || bitmap.height < T / 2) return { error: "size" };
  if (Math.abs(bitmap.width - bitmap.height) > Math.max(bitmap.width, bitmap.height) * 0.01) return { error: "square" };
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = T;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return { error: "read" };
  context.drawImage(bitmap, 0, 0, T, T);
  bitmap.close();
  const data = context.getImageData(0, 0, T, T).data;
  const centre = I + A / 2, radius2 = (A / 2) ** 2;
  let x0: number = T, y0: number = T, x1 = -1, y1 = -1, covered = 0;
  for (let y = 0; y < T; y++) {
    for (let x = 0; x < T; x++) {
      const alpha = data[(y * T + x) * 4 + 3];
      if (alpha < 16) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      const inside = round ? (x + 0.5 - centre) ** 2 + (y + 0.5 - centre) ** 2 <= radius2 : x >= I && x < I + A && y >= I && y < I + A;
      if (alpha > 200 && inside) covered++;
    }
  }
  if (x1 < 0) return { error: "empty" };
  if (1 - covered / (round ? Math.PI * radius2 : A * A) < MIN_CLEAR_AVATAR) return { error: "covers" };
  const reach = (n: number) => Math.max(0, n) / A;
  return { overhang: [reach(I - x0), reach(I - y0), reach(x1 + 1 - (I + A)), reach(y1 + 1 - (I + A))] };
}

export function WorkshopFrames() {
  const { t } = useLingui();
  const auth = useAuth();
  const viewer = auth.viewer;
  const avatar = viewer ? avatarImageSrc(viewer.avatarUrl, viewer.id) : undefined;
  const [supporter, setSupporter] = useState<boolean | null>(null);
  const [worn, setWorn] = useState<SupporterAvatarFrameId | null>(null);
  const [own, setOwn] = useState<SubmittedFrame[]>([]);
  const [shared, setShared] = useState<SubmittedFrame[]>([]);
  const [review, setReview] = useState<SubmittedFrame[] | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = async () => {
    const [list, mine, state] = await Promise.all([
      fetchLiveWorkshopFrames().catch(() => []),
      viewer ? fetchOwnWorkshopFrames().catch(() => []) : Promise.resolve([]),
      viewer ? fetchSupporterLookState().catch(() => null) : Promise.resolve(null),
    ]);
    setShared(list);
    setOwn([...registerSubmittedFrames(mine)]);
    if (state) {
      registerWorkshopFrames(state.frameArt ?? {});
      setSupporter(state.supporter);
      setWorn(state.frame);
    } else setSupporter(false);
    if (auth.isAdmin) {
      const all = await loadAdminFrames().catch(() => null);
      setReview(all ? [...registerSubmittedFrames(all)] : null);
    }
  };
  useEffect(() => {
    void load();
  }, [viewer?.id, auth.isAdmin]); // eslint-disable-line react-hooks/exhaustive-deps

  // the draft draws through the same frame code as a saved one, from the picked files
  useEffect(() => {
    if (draft.still && draft.overhang) registerWorkshopFrames({ [DRAFT_ID]: { name: draft.name, still: draft.still.url, video: draft.video?.url ?? null, round: draft.round?.url ?? null, overhang: draft.overhang } });
  }, [draft]);
  // a replaced or dropped file lets go of its preview URL
  const urls = useRef(new Set<string>());
  useEffect(() => {
    const live = new Set([draft.still?.url, draft.video?.url, draft.round?.url].filter((url): url is string => !!url));
    for (const url of urls.current) if (!live.has(url)) URL.revokeObjectURL(url);
    urls.current = live;
  }, [draft.still, draft.video, draft.round]);
  useEffect(() => () => {
    for (const url of urls.current) URL.revokeObjectURL(url);
  }, []);

  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const pictureError = (error: "size" | "square" | "empty" | "covers" | "read") => ({
    size: t`Draw it at least ${T / 2}px square (the template is ${T}px).`,
    square: t`The frame has to be square, like the template.`,
    empty: t`That picture is empty.`,
    covers: t`The frame covers too much of the avatar; keep the middle see-through.`,
    read: t`Could not read that picture.`,
  })[error];
  const onPicture = (key: "still" | "round", file: File) => run(key, async () => {
    const measured = await measurePicture(file, key === "round");
    if ("error" in measured) throw new Error(pictureError(measured.error));
    const local = { file, url: URL.createObjectURL(file) };
    setDraft((prev) => key === "still" ? { ...prev, still: local, overhang: measured.overhang } : { ...prev, round: local });
  });
  const onVideo = (file: File) => run("video", async () => {
    if (file.size > 2 * 1024 * 1024) throw new Error(t`That video is over 2 MB.`);
    setDraft((prev) => ({ ...prev, video: { file, url: URL.createObjectURL(file) } }));
  });
  const submit = () => run("submit", async () => {
    if (!draft.still) throw new Error(t`Add its picture first.`);
    const still = await upload("still", draft.still.file);
    const video = draft.video ? (await upload("video", draft.video.file)).url : null;
    const round = draft.round ? (await upload("round", draft.round.file)).url : null;
    const { frame } = await submitWorkshopFrame({ data: { name: draft.name, still: still.url, video, round, overhang: still.overhang ?? [...(draft.overhang ?? [0, 0, 0, 0])] } });
    registerSubmittedFrames([frame]);
    setOwn((prev) => [frame, ...prev]);
    setDraft(EMPTY_DRAFT);
    setNotice(t`It's up: in your picker and everyone else's.`);
  });
  const wear = (frame: SupporterAvatarFrameId | null) => run(`wear:${frame}`, async () => {
    await saveSupporterFrameSetting({ data: { frame } });
    if (viewer) {
      forgetLiveSupporterLook(viewer.id);
      setSupporterFrameLocally(viewer.id, frame);
    }
    setWorn(frame);
  });
  const remove = (frame: SubmittedFrame) => run(`delete:${frame.id}`, async () => {
    await deleteOwnWorkshopFrame({ data: { id: frame.id } });
    if (worn === frame.id) setWorn(null);
    await load();
  });
  const moderate = (frame: SubmittedFrame, action: "fine" | "list" | "unlist" | "delete") => run(`admin:${frame.id}`, async () => {
    if (action === "fine") await setAdminFrameReviewed({ data: { id: frame.id } });
    else if (action === "delete") await deleteAdminFrame({ data: { id: frame.id } });
    else await setAdminFrameListed({ data: { id: frame.id, listed: action === "list" } });
    await load();
  });

  // the template as a PNG, which every drawing app opens (an SVG doesn't open in most)
  const templateSvgUrl = useMemo(() => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(templateSvg())}`, []);
  const [templateUrl, setTemplateUrl] = useState<string | null>(null);
  useEffect(() => {
    let url: string | null = null;
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = T;
      canvas.getContext("2d")?.drawImage(image, 0, 0, T, T);
      canvas.toBlob((blob) => {
        if (!blob) return;
        url = URL.createObjectURL(blob);
        setTemplateUrl(url);
      }, "image/png");
    };
    image.src = templateSvgUrl;
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [templateSvgUrl]);

  if (!viewer) {
    return (
      <p className="py-16 text-center text-[13px] text-osu-l2">
        <a href={`/api/auth/osu?next=${encodeURIComponent("/workshop/frames")}`} className="font-semibold text-osu-pink-light hover:underline">{t`Sign in`}</a>{" "}
        {t`to make your own avatar frames.`}
      </p>
    );
  }

  const card = (frame: SubmittedFrame, actions: ReactNode, note?: ReactNode) => (
    <article key={frame.id} className="flex flex-col items-center gap-2 rounded-xl bg-osu-b4 p-3">
      <FramedAvatar frame={frame.id} avatar={avatar} size={84} />
      <div className="w-full min-w-0 text-center">
        <p className="truncate text-[13px] font-semibold text-white">{frame.name}</p>
        <p className="truncate text-[11px] text-osu-f1">{note ?? t`by ${frame.submittedBy.username}`}</p>
      </div>
      <div className="flex flex-wrap justify-center gap-1.5">{actions}</div>
    </article>
  );
  const wearButton = (frame: SubmittedFrame) => supporter ? (
    worn === frame.id
      ? <button type="button" disabled={busy !== null} onClick={() => void wear(null)} className={BUTTON}>{t`Take off`}</button>
      : <button type="button" disabled={busy !== null} onClick={() => void wear(frame.id)} className={BUTTON}>{t`Wear`}</button>
  ) : null;

  return (
    <div className="space-y-10">
      <EditorEntry />
      <section className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <h2 className="text-[15px] font-semibold text-white lg:col-span-2">{t`Or upload one you drew elsewhere`}</h2>
        <div className="space-y-5">
          <Step n={1} title={t`Draw it on the template`}>
            <p>{t`A ${T}px square with the avatar in the middle. Draw on a transparent background; the art can reach out to the canvas edge, and the avatar has to stay mostly clear.`}</p>
            <div className="mt-3 flex items-center gap-4">
              {/* what the download is: the canvas edge, the avatar's square and the round version's circle */}
              <img src={templateSvgUrl} alt="" className="h-[84px] w-[84px] rounded-md bg-[conic-gradient(#ffffff0d_25%,transparent_0_50%,#ffffff0d_0_75%,transparent_0)] bg-[length:12px_12px]" />
              <div className="space-y-1.5">
                {templateUrl ? <a href={templateUrl} download="mania-tracker-frame-template.png" className={BUTTON}>{t`Download the template`}</a> : null}
                <p className="text-[11.5px] text-osu-f1">{t`Put it on a layer under your drawing and hide it before you export.`}</p>
              </div>
            </div>
          </Step>
          <Step n={2} title={t`Add the picture`}>
            <p>{t`A PNG or WebP with transparency. It's also what lists, Safari and reduced motion show.`}</p>
            <FileButton accept="image/png,image/webp" disabled={busy !== null} label={draft.still ? t`Replace the picture` : t`Choose a picture`} onFile={(file) => void onPicture("still", file)} />
          </Step>
          <Step n={3} title={t`Add a loop (optional)`}>
            <p>{t`A WebM with alpha (VP9), the same square, under 2 MB. Make the first frame match the picture so it doesn't jump when it starts.`}</p>
            <div className="mt-2 flex items-center gap-2">
              <FileButton accept="video/webm" disabled={!draft.still || busy !== null} label={draft.video ? t`Replace the loop` : t`Choose a loop`} onFile={(file) => void onVideo(file)} />
              {draft.video ? <button type="button" onClick={() => setDraft((prev) => ({ ...prev, video: null }))} className="text-[12px] text-osu-f1 hover:text-white">{t`Remove`}</button> : null}
            </div>
          </Step>
          <Step n={4} title={t`Add a round version (optional)`}>
            <p>{t`Lists show avatars as circles. Draw the frame again around the template's circle and lists use it; without one, your avatar stays square there.`}</p>
            <div className="mt-2 flex items-center gap-2">
              <FileButton accept="image/png,image/webp" disabled={!draft.still || busy !== null} label={draft.round ? t`Replace the round version` : t`Choose a round version`} onFile={(file) => void onPicture("round", file)} />
              {draft.round ? <button type="button" onClick={() => setDraft((prev) => ({ ...prev, round: null }))} className="text-[12px] text-osu-f1 hover:text-white">{t`Remove`}</button> : null}
            </div>
          </Step>
          <Step n={5} title={t`Name it and submit`}>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <input
                value={draft.name}
                maxLength={FRAME_NAME_MAX}
                onChange={(event) => setDraft((prev) => ({ ...prev, name: event.target.value }))}
                placeholder={t`Frame name`}
                className="h-9 min-w-0 flex-1 rounded-lg bg-osu-b6 px-3 text-[13px] text-white outline-none ring-1 ring-white/10 focus:ring-osu-pink/60"
              />
              {supporter === false ? (
                <Link to="/support" hash="checkout" className="inline-flex h-9 items-center rounded-full bg-osu-pink px-5 text-[13px] font-semibold text-white transition hover:brightness-110">{t`Support to submit`}</Link>
              ) : (
                <button
                  type="button"
                  disabled={!supporter || !draft.still || !draft.name.trim() || busy !== null}
                  onClick={() => void submit()}
                  className="h-9 cursor-pointer rounded-full bg-osu-pink px-5 text-[13px] font-semibold text-white transition hover:brightness-110 disabled:cursor-default disabled:opacity-50"
                >
                  {busy === "submit" ? t`Submitting...` : t`Submit`}
                </button>
              )}
            </div>
            <p className="mt-2 text-[11.5px] text-osu-f1">
              {supporter === false
                ? t`Supporters submit frames to everyone's picker, with their name on them, and wear them on their profile.`
                : t`It goes into everyone's picker right away, with your name on it.`}
            </p>
          </Step>
          {error ? <p className="text-[12.5px] text-osu-red-light">{error}</p> : null}
          {notice ? <p className="text-[12.5px] text-emerald-300">{notice}</p> : null}
        </div>

        <div className="rounded-2xl bg-osu-b6 p-5 lg:sticky lg:top-[76px] lg:self-start">
          <p className="mb-4 text-[12px] font-semibold uppercase tracking-wide text-osu-f1">{t`Preview`}</p>
          {draft.still ? (
            <div className="grid grid-cols-2 gap-3">
              {(["dark", "light"] as const).map((tone) => (
                <div key={tone} className={`flex flex-col items-center justify-center gap-6 rounded-xl py-8 ${tone === "dark" ? "bg-osu-b5" : "bg-[#d9dce6]"}`}>
                  <FramedAvatar frame={DRAFT_ID} avatar={avatar} size={124} live />
                  <div className="flex items-end gap-6">
                    <FramedAvatar frame={DRAFT_ID} avatar={avatar} size={84} live />
                    <FramedAvatar frame={DRAFT_ID} avatar={avatar} size={36} round />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="py-16 text-center text-[12.5px] text-osu-f1">{t`Upload a picture to see it on your avatar at profile, card and list sizes.`}</p>
          )}
        </div>
      </section>

      {own.length > 0 ? (
        <section id="yours">
          <h2 className="mb-3 text-[15px] font-semibold text-white">{t`Your frames`}</h2>
          <div className={GRID}>
            {own.map((frame) => card(
              frame,
              <>
                {wearButton(frame)}
                <Link to="/workshop/frames/editor" search={{ frame: frame.id }} className={BUTTON}>{t`Edit`}</Link>
                <button type="button" disabled={busy !== null} onClick={() => void remove(frame)} className={BUTTON}>{t`Delete`}</button>
              </>,
              frame.listed ? t`In everyone's picker` : t`Taken off the list`,
            ))}
          </div>
        </section>
      ) : null}

      <section id="shared">
        <h2 className="mb-3 text-[15px] font-semibold text-white">{t`Made by players`}</h2>
        {shared.length === 0 ? (
          <p className="text-[12.5px] text-osu-f1">{t`None yet. Yours could be the first.`}</p>
        ) : (
          <div className={GRID}>{shared.map((frame) => card(frame, wearButton(frame)))}</div>
        )}
      </section>

      {review ? (
        <section>
          <h2 className="mb-3 text-[15px] font-semibold text-white">{t`Review`} <span className="text-[12px] font-normal text-osu-f1">{t`only admins see this`}</span></h2>
          {review.length === 0 ? <p className="text-[12.5px] text-osu-f1">{t`Nothing submitted.`}</p> : (
            <div className={GRID}>
              {review.map((frame) => card(
                frame,
                <>
                  {!frame.reviewed ? <button type="button" disabled={busy !== null} onClick={() => void moderate(frame, "fine")} className={BUTTON}>{t`Looks fine`}</button> : null}
                  <button type="button" disabled={busy !== null} onClick={() => void moderate(frame, frame.listed ? "unlist" : "list")} className={BUTTON}>{frame.listed ? t`Unlist` : t`List`}</button>
                  <button type="button" disabled={busy !== null} onClick={() => void moderate(frame, "delete")} className={BUTTON}>{t`Delete`}</button>
                </>,
                !frame.reviewed ? t`New, by ${frame.submittedBy.username}` : frame.listed ? t`Reviewed, by ${frame.submittedBy.username}` : t`Unlisted, by ${frame.submittedBy.username}`,
              ))}
            </div>
          )}
        </section>
      ) : null}
    </div>
  );
}

/* The way in to the frame editor, with the drafts this browser keeps. */
function EditorEntry() {
  const { t } = useLingui();
  const [drafts, setDrafts] = useState<(DraftSummary & { url: string | null })[]>([]);
  const [deleting, setDeleting] = useState<DraftSummary | null>(null);
  useEffect(() => {
    let urls: string[] = [];
    void listDraftsWithArt().then((list) => {
      const withUrls = list.slice(0, 8).map((draft) => ({ ...draft, url: draft.thumb ? URL.createObjectURL(draft.thumb) : null }));
      urls = withUrls.map((draft) => draft.url).filter((url): url is string => !!url);
      setDrafts(withUrls);
    }).catch(() => undefined);
    return () => urls.forEach((url) => URL.revokeObjectURL(url));
  }, []);
  return (
    <section className="flex flex-wrap items-center gap-x-6 gap-y-4 rounded-2xl bg-osu-b6 p-5">
      <h2 className="min-w-0 flex-1 text-[17px] font-semibold text-white">{t`Make one in the frame editor`}</h2>
      {drafts.length ? (
        <div className="flex items-center gap-3">
          <span className="text-[11px] font-bold uppercase tracking-[0.08em] text-osu-f1">{t`Your drafts`}</span>
          <div className="flex items-center gap-2">
            {drafts.map((draft) => (
              <div key={draft.id} className="group relative">
                <Link
                  to="/workshop/frames/editor"
                  search={{ draft: draft.id }}
                  title={draft.name || t`Untitled frame`}
                  className="block h-14 w-14 overflow-hidden rounded-lg bg-[conic-gradient(#ffffff0d_25%,transparent_0_50%,#ffffff0d_0_75%,transparent_0)] bg-[length:10px_10px] ring-1 ring-white/[0.08] transition hover:ring-osu-pink/60"
                >
                  {draft.url ? <img src={draft.url} alt="" className="h-full w-full object-contain" /> : null}
                </Link>
                <button
                  type="button"
                  aria-label={t`Delete draft`}
                  title={t`Delete draft`}
                  onClick={() => setDeleting(draft)}
                  className="absolute -right-1.5 -top-1.5 grid h-5 w-5 cursor-pointer place-items-center rounded-full bg-osu-b3 text-[12px] leading-none text-osu-l2 shadow ring-1 ring-black/40 transition hover:bg-rose-500 hover:text-white [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      <Link to="/workshop/frames/editor" className="inline-flex h-10 items-center rounded-full bg-osu-pink px-6 text-[13px] font-semibold text-white transition hover:brightness-110">{t`Open the editor`}</Link>
      {deleting ? (
        <ConfirmModal
          title={t`Delete this draft?`}
          body={deleting.name ? t`${deleting.name} is deleted from this browser and your account.` : t`It's deleted from this browser and your account.`}
          confirmLabel={t`Delete`}
          cancelLabel={t`Cancel`}
          danger
          onClose={() => setDeleting(null)}
          onConfirm={() => {
            const id = deleting.id;
            setDeleting(null);
            void Promise.all([deleteDraft(id).catch(() => undefined), removeAccountDraft({ data: { id } }).catch(() => undefined)]).then(() => setDrafts((list) => list.filter((entry) => entry.id !== id)));
          }}
        />
      ) : null}
    </section>
  );
}

const BUTTON = "inline-flex h-7 cursor-pointer items-center rounded-lg bg-osu-b3/60 px-2.5 text-[11.5px] font-semibold text-osu-l2 transition-colors hover:bg-osu-b3 hover:text-white disabled:cursor-default disabled:opacity-50";
const GRID = "grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3";

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-osu-b4 text-[12px] font-bold text-osu-pink-light">{n}</span>
      <div className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-osu-l2">
        <h3 className="mb-0.5 text-[14px] font-semibold text-white">{title}</h3>
        {children}
      </div>
    </div>
  );
}

function FileButton({ accept, disabled, label, onFile }: { accept: string; disabled: boolean; label: string; onFile: (file: File) => void }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" disabled={disabled} onClick={() => input.current?.click()} className={`${BUTTON} mt-2`}>{label}</button>
      <input
        ref={input}
        type="file"
        accept={accept}
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) onFile(file);
        }}
      />
    </>
  );
}

/* The viewer's avatar `size` px wide wearing the frame, with room left for its art. */
/* `round`: as a list draws it, a circle with the frame's round version (or square without one). */
function FramedAvatar({ frame, avatar, size, live = false, round = false }: { frame: SupporterAvatarFrameId; avatar: string | undefined; size: number; live?: boolean; round?: boolean }) {
  return (
    <div className="relative shrink-0" style={frameOverhangMargins(frame, `${size}px`)}>
      <div className="overflow-hidden bg-osu-b3" style={{ width: size, height: size, ...framedAvatarStyle(frame, { round }) }}>
        {avatar ? <img src={avatar} alt="" className="h-full w-full object-cover" /> : null}
      </div>
      <SupporterAvatarFrame frame={frame} still={!live || round} round={round} />
    </div>
  );
}
