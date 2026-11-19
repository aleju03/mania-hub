import { Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { ImagePlus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { WORKSHOP_SIZE } from "../../../lib/frame-editor/doc";
import { renderBoard } from "../../../lib/frame-editor/render";
import { makeStarter, STARTERS, type StarterId, type StarterNames } from "../../../lib/frame-editor/starters";
import { deleteDraft, listDraftsWithArt, type DraftSummary } from "../../../lib/frame-editor/storage";
import { fetchAccountDrafts, removeAccountDraft } from "../../../lib/frame-drafts";
import { FRAME_NAME_MAX } from "../../../lib/workshop-frames";
import { ConfirmModal } from "../../ui/ConfirmModal";
import { Switch } from "../../ui/Switch";
import { EditorModal } from "./FrameTools";

/* The frame editor's two dialogs: where to start (a starter, a saved draft
   or a picture), and submitting the finished frame. */

export function useStarterNames(): { names: StarterNames; labels: Record<StarterId, string> } {
  const { t } = useLingui();
  return {
    names: { outline: t`Outline`, inner: t`Inner line`, outer: t`Outer line`, corner: t`Corner`, name: t`Your name`, dots: t`Dots` },
    labels: { blank: t`Blank`, ring: t`Glow ring`, double: t`Double line`, corners: t`Corners`, name: t`Name arc`, orbit: t`Orbit` },
  };
}

function StarterThumb({ id, names, label }: { id: StarterId; names: StarterNames; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const doc = useMemo(() => makeStarter(id, names, label), [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    // the fonts may still be loading; draw again once they are in
    const draw = () => {
      const ctx = canvas.getContext("2d")!;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(renderBoard(doc.boards.square, { pixels: {}, assets: {}, size: WORKSHOP_SIZE }), 0, 0, canvas.width, canvas.height);
    };
    draw();
    void document.fonts?.ready.then(draw);
  }, [doc]);
  return <canvas ref={ref} width={192} height={192} className="h-full w-full" />;
}

export function StartDialog({ username, avatar, onStarter, onDraft, onPicture, onClose }: {
  username: string | null;
  avatar: string | undefined;
  onStarter: (id: StarterId) => void;
  onDraft: (id: string) => void;
  onPicture: (file: File) => void;
  onClose?: () => void;
}) {
  const { t } = useLingui();
  const { names, labels } = useStarterNames();
  const named = { ...names, name: username ?? names.name };
  const [drafts, setDrafts] = useState<{ id: string; name: string; updatedAt: number; url: string | null; account: boolean }[] | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const [deleting, setDeleting] = useState<{ id: string; name: string } | null>(null);
  useEffect(() => {
    let urls: string[] = [];
    // this browser's drafts and the account's, the newest copy of each
    void Promise.all([listDraftsWithArt().catch(() => [] as DraftSummary[]), username ? fetchAccountDrafts().catch(() => []) : Promise.resolve([])]).then(([local, account]) => {
      const merged = new Map<string, { id: string; name: string; updatedAt: number; url: string | null; account: boolean }>();
      for (const draft of local) {
        const url = draft.thumb ? URL.createObjectURL(draft.thumb) : null;
        if (url) urls.push(url);
        merged.set(draft.id, { id: draft.id, name: draft.name, updatedAt: draft.updatedAt, url, account: false });
      }
      for (const draft of account) {
        const known = merged.get(draft.id);
        if (!known || draft.updatedAt > known.updatedAt) merged.set(draft.id, { id: draft.id, name: draft.name, updatedAt: draft.updatedAt, url: draft.thumb ?? known?.url ?? null, account: !known });
      }
      setDrafts([...merged.values()].sort((a, b) => b.updatedAt - a.updatedAt));
    });
    return () => urls.forEach((url) => URL.revokeObjectURL(url));
  }, [username]);

  return (
    <EditorModal label={t`New frame`} onClose={onClose} wide>
      <div className="border-b border-white/[0.07] px-5 py-4">
        <h2 className="text-[15px] font-bold text-white">{t`Make an avatar frame`}</h2>
      </div>
      <div className="max-h-[70dvh] overflow-y-auto px-5 py-4">
        <div className="grid grid-cols-3 gap-2.5 sm:grid-cols-6">
          {STARTERS.map((id) => (
            <button key={id} type="button" onClick={() => onStarter(id)} className="group flex cursor-pointer flex-col items-center gap-1.5 rounded-lg p-1.5 text-center transition-colors hover:bg-white/[0.05]">
              <span className="relative aspect-square w-full overflow-hidden rounded-md bg-osu-b6 ring-1 ring-white/[0.08] transition group-hover:ring-osu-pink/60">
                {avatar ? <img src={avatar} alt="" className="absolute left-[17.7%] top-[17.7%] h-[64.6%] w-[64.6%] rounded-[8%] object-cover opacity-80" /> : <span className="absolute left-[17.7%] top-[17.7%] h-[64.6%] w-[64.6%] rounded-[8%] bg-osu-b3" />}
                <span className="absolute inset-0"><StarterThumb id={id} names={named} label={labels[id]} /></span>
              </span>
              <span className="text-[12px] font-semibold text-osu-l2 group-hover:text-white">{labels[id]}</span>
            </button>
          ))}
        </div>
        <button type="button" onClick={() => input.current?.click()} className="mt-3 flex h-9 cursor-pointer items-center gap-2 rounded-lg px-2 text-[12.5px] font-semibold text-osu-l2 hover:bg-white/[0.05] hover:text-white">
          <ImagePlus size={15} />
          {t`Start from a picture`}
        </button>
        <input
          ref={input}
          type="file"
          accept="image/*"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) onPicture(file);
          }}
        />
        {drafts && drafts.length ? (
          <div className="mt-4 border-t border-white/[0.07] pt-4">
            <h3 className="mb-2 text-[11px] font-bold uppercase tracking-[0.08em] text-osu-f1">{t`Your drafts`}</h3>
            <div className="grid grid-cols-3 gap-2.5 sm:grid-cols-6">
              {drafts.map((draft) => (
                <div key={draft.id} className="group relative flex flex-col items-center gap-1.5 rounded-lg p-1.5 text-center hover:bg-white/[0.05]">
                  <button type="button" onClick={() => onDraft(draft.id)} className="aspect-square w-full cursor-pointer overflow-hidden rounded-md bg-[conic-gradient(#ffffff0d_25%,transparent_0_50%,#ffffff0d_0_75%,transparent_0)] bg-[length:12px_12px] ring-1 ring-white/[0.08] transition hover:ring-osu-pink/60">
                    {draft.url ? <img src={draft.url} alt="" className="h-full w-full object-contain" /> : null}
                  </button>
                  <span className="w-full truncate text-[12px] font-semibold text-osu-l2">{draft.name || t`Untitled frame`}</span>
                  <span className="text-[11px] text-osu-f1">{new Date(draft.updatedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
                  <button
                    type="button"
                    aria-label={t`Delete draft`}
                    title={t`Delete draft`}
                    onClick={() => setDeleting(draft)}
                    className="absolute right-2.5 top-2.5 grid h-7 w-7 cursor-pointer place-items-center rounded-md bg-black/70 text-osu-l2 hover:text-rose-300 [@media(hover:hover)]:hidden [@media(hover:hover)]:group-hover:grid"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
            <p className="mt-2 text-[11px] text-osu-f1">{username ? t`Drafts are saved as you work, in this browser and on your account.` : t`Drafts are saved in this browser as you work.`}</p>
          </div>
        ) : null}
      </div>
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
            void Promise.all([deleteDraft(id).catch(() => undefined), username ? removeAccountDraft({ data: { id } }).catch(() => undefined) : undefined]).then(() => setDrafts((list) => list?.filter((entry) => entry.id !== id) ?? null));
          }}
        />
      ) : null}
      {onClose ? (
        <div className="flex justify-end border-t border-white/[0.07] px-5 py-3">
          <button type="button" onClick={onClose} className="h-9 cursor-pointer rounded-lg px-3.5 text-[12.5px] font-semibold text-osu-l2 hover:bg-white/[0.06] hover:text-white">{t`Cancel`}</button>
        </div>
      ) : null}
    </EditorModal>
  );
}

export interface SubmitState {
  phase: "idle" | "recording" | "uploading" | "done";
  progress: number;
  error: string | null;
}

export function SubmitDialog({ name, onName, still, round, issues, supporter, animated, canLoop, includeLoop, onIncludeLoop, status, worn, onWear, onSubmit, onClose, updating, onUpdating, canUpdate }: {
  /* the draft was submitted before: replace that frame, or add a new one */
  canUpdate: boolean;
  updating: boolean;
  onUpdating: (value: boolean) => void;
  name: string;
  onName: (name: string) => void;
  still: string | null;
  round: string | null;
  issues: string[];
  supporter: boolean | null;
  animated: boolean;
  canLoop: boolean;
  includeLoop: boolean;
  onIncludeLoop: (value: boolean) => void;
  status: SubmitState;
  worn: boolean;
  onWear: () => void;
  onSubmit: () => void;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const [rights, setRights] = useState(false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && status.phase !== "recording" && status.phase !== "uploading" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, status.phase]);
  const busy = status.phase === "recording" || status.phase === "uploading";
  const ready = name.trim() && rights && issues.length === 0 && supporter === true && !busy;

  if (status.phase === "done") {
    return (
      <EditorModal label={t`Submitted`} onClose={onClose}>
        <div className="flex flex-col items-center gap-3 px-6 py-6 text-center">
          {still ? <img src={still} alt="" className="h-28 w-28" /> : null}
          <h2 className="text-[15px] font-bold text-white">{t`It's up: in your picker and everyone else's.`}</h2>
          <div className="flex flex-wrap justify-center gap-2">
            <button type="button" disabled={worn || busy} onClick={onWear} className="h-9 cursor-pointer rounded-lg bg-osu-pink px-4 text-[12.5px] font-semibold text-white transition hover:brightness-110 disabled:cursor-default disabled:opacity-60">
              {worn ? t`Wearing it` : t`Wear it`}
            </button>
            <Link to="/workshop/frames" hash="yours" className="inline-flex h-9 items-center rounded-lg px-3.5 text-[12.5px] font-semibold text-osu-l2 ring-1 ring-inset ring-white/[0.12] hover:bg-white/[0.06] hover:text-white">{t`Your frames`}</Link>
            <button type="button" onClick={onClose} className="h-9 cursor-pointer rounded-lg px-3.5 text-[12.5px] font-semibold text-osu-l2 hover:bg-white/[0.06] hover:text-white">{t`Keep editing`}</button>
          </div>
        </div>
      </EditorModal>
    );
  }

  return (
    <EditorModal label={t`Submit frame`} onClose={busy ? undefined : onClose}>
      <div className="border-b border-white/[0.07] px-5 py-4">
        <h2 className="text-[15px] font-bold text-white">{t`Submit frame`}</h2>
        <p className="mt-0.5 text-[12px] text-osu-f1">{t`It goes into everyone's picker right away, with your name on it.`}</p>
      </div>
      <div className="grid gap-4 px-5 py-4">
        <div className="flex justify-center gap-4">
          {still ? <img src={still} alt="" className="h-24 w-24 rounded-md bg-[conic-gradient(#ffffff0d_25%,transparent_0_50%,#ffffff0d_0_75%,transparent_0)] bg-[length:12px_12px]" /> : null}
          {round ? <img src={round} alt="" className="h-24 w-24 rounded-md bg-[conic-gradient(#ffffff0d_25%,transparent_0_50%,#ffffff0d_0_75%,transparent_0)] bg-[length:12px_12px]" /> : null}
        </div>
        {canUpdate ? (
          <div className="grid grid-cols-2 gap-2">
            {([[true, t`Update your frame`, t`Same frame, new art. Whoever wears it gets this.`], [false, t`Submit a new one`, t`Keeps the old frame as it is.`]] as const).map(([value, title, blurb]) => (
              <button key={String(value)} type="button" onClick={() => onUpdating(value)} className={`cursor-pointer rounded-lg p-2.5 text-left ring-1 transition-colors ${updating === value ? "bg-osu-pink/[0.12] ring-osu-pink/70" : "bg-black/20 ring-white/[0.08] hover:ring-white/20"}`}>
                <span className="block text-[12.5px] font-semibold text-white">{title}</span>
                <span className="block text-[11px] text-osu-f1">{blurb}</span>
              </button>
            ))}
          </div>
        ) : null}
        <label className="grid gap-1.5">
          <span className="text-[11.5px] font-semibold text-osu-l2">{t`Name`}</span>
          <input autoFocus value={name} maxLength={FRAME_NAME_MAX} onChange={(event) => onName(event.target.value.slice(0, FRAME_NAME_MAX))} placeholder={t`Frame name`} className="h-9 rounded-lg bg-black/30 px-3 text-[13px] text-white ring-1 ring-white/10 placeholder:text-osu-f1 focus:outline-none focus:ring-osu-pink/60" />
        </label>
        {animated ? (
          <div className="flex items-start gap-2.5 text-[12px] leading-relaxed text-osu-l2">
            <span className="mt-0.5"><Switch checked={includeLoop && canLoop} onChange={onIncludeLoop} label={t`Include the loop`} /></span>
            <span>{canLoop ? t`Include the loop. It records for 3 seconds before uploading.` : t`This browser can't record the loop with a see-through background. Open the editor in Chrome or Edge to include it; the still goes up either way.`}</span>
          </div>
        ) : null}
        <div className="flex items-start gap-2.5 text-[12px] leading-relaxed text-osu-l2">
          <span className="mt-0.5"><Switch checked={rights} onChange={setRights} label={t`I understand`} /></span>
          <span>
            <Trans>
              I understand I'm responsible for what I put in my frames, and that one breaking the{" "}
              <Link to="/terms" hash="supporter-uploads" target="_blank" rel="noopener" className="text-osu-f1 underline underline-offset-2 hover:text-white">Terms</Link> can be taken down.
            </Trans>
          </span>
        </div>
        {supporter === false ? (
          <p className="rounded-lg bg-white/[0.04] px-3 py-2 text-[12px] text-osu-l2">
            {t`Supporters submit frames to everyone's picker and wear them on their profile. You can still download it as a PNG from the menu.`}{" "}
            <Link to="/support" hash="checkout" className="font-semibold text-osu-pink-light hover:underline">{t`Support`}</Link>
          </p>
        ) : null}
        {issues.length ? (
          <ul className="grid gap-1 rounded-lg bg-rose-500/[0.08] px-3 py-2 text-[11.5px] text-rose-200">
            {issues.map((issue) => <li key={issue}>{issue}</li>)}
          </ul>
        ) : null}
        {status.error ? <p className="text-[12px] text-rose-300">{status.error}</p> : null}
        {busy ? (
          <div className="grid gap-1.5">
            <span className="text-[12px] text-osu-l2">{status.phase === "recording" ? t`Recording the loop...` : t`Uploading...`}</span>
            <span className="h-1.5 overflow-hidden rounded-full bg-white/10"><span className="block h-full rounded-full bg-osu-pink transition-[width]" style={{ width: `${Math.round(status.progress * 100)}%` }} /></span>
          </div>
        ) : null}
      </div>
      <div className="flex justify-end gap-2 border-t border-white/[0.07] px-5 py-3">
        <button type="button" disabled={busy} onClick={onClose} className="h-9 cursor-pointer rounded-lg px-3.5 text-[12.5px] font-semibold text-osu-l2 hover:bg-white/[0.06] hover:text-white disabled:opacity-40">{t`Cancel`}</button>
        <button type="button" disabled={!ready} onClick={onSubmit} className="h-9 cursor-pointer rounded-lg bg-osu-pink px-4 text-[12.5px] font-semibold text-white transition hover:brightness-110 disabled:cursor-default disabled:opacity-45">
          {busy ? t`Submitting...` : canUpdate && updating ? t`Update` : t`Submit`}
        </button>
      </div>
    </EditorModal>
  );
}

/* Every key the editor answers to, grouped as the editor is. Opened with ? or from the More menu. */
export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const { t } = useLingui();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" || event.key === "?") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const groups: { title: string; rows: [string[], string][] }[] = [
    {
      title: t`Tools`,
      rows: [
        [["V"], t`Move`], [["M"], t`Select (again to swap rectangle and ellipse)`], [["L"], t`Lasso`], [["W"], t`Magic wand`],
        [["B"], t`Brush`], [["E"], t`Eraser`], [["G"], t`Paint bucket (again for the gradient)`], [["I"], t`Eyedropper`], [["R"], t`Smudge and blur`],
        [["U"], t`Shape`], [["P"], t`Pen`], [["T"], t`Text`], [["H"], t`Hand tool`], [["Z"], t`Zoom`], [["Space"], t`Hold to move the view from any tool`],
      ],
    },
    {
      title: t`Brush and colours`,
      rows: [
        [["[", "]"], t`Smaller or bigger brush`], [["Shift", "[", "]"], t`Softer or harder brush`],
        [["Alt", t`click`], t`Take a colour while painting`], [["Shift", t`click`], t`Straight line from the last stroke`],
        [["X"], t`Swap colours`], [["D"], t`White and black`],
      ],
    },
    {
      title: t`Edit`,
      rows: [
        [["Ctrl", "Z"], t`Undo`], [["Ctrl", "Shift", "Z"], t`Redo`], [["Ctrl", "C"], t`Copy`], [["Ctrl", "X"], t`Cut`],
        [["Ctrl", "V"], t`Paste, as a new layer`], [["Delete"], t`Clear the selection, or delete the layer`],
        [["Alt", "Backspace"], t`Fill with the colour`], [["Ctrl", "Backspace"], t`Fill with the second colour`], [["Ctrl", "S"], t`Save the draft now`],
      ],
    },
    {
      title: t`Selection`,
      rows: [
        [["Ctrl", "A"], t`Select all`], [["Ctrl", "D"], t`Drop the selection`], [["Ctrl", "Shift", "I"], t`Invert the selection`],
        [["Shift"], t`Add to it`], [["Alt"], t`Take away from it`], [["Shift", "Alt"], t`Keep only the overlap`], [["Esc"], t`Drop the selection, then the layer`],
      ],
    },
    {
      title: t`Layers`,
      rows: [
        [["Ctrl", "Shift", "N"], t`New paint layer`], [["Ctrl", "J"], t`Duplicate, or the selection to a new layer`], [["Ctrl", "E"], t`Merge down`],
        [["Ctrl", "Alt", "G"], t`Clip to the layer below`], [["Ctrl", "G"], t`Put in a new group`], [["Ctrl", "Shift", "G"], t`Ungroup`],
        [["Ctrl", t`click`], t`Pick a layer inside a group on the canvas`], [["Ctrl", "[", "]"], t`Send backward or bring forward`],
      ],
    },
    {
      title: t`Moving and drawing`,
      rows: [
        [["←", "↑", "→", "↓"], t`Nudge 1px`], [["Shift", "←"], t`Nudge 10px`], [["Shift"], t`Move on one axis, turn in 15° steps, keep shapes even`],
        [["Alt"], t`Resize or draw from the middle`], [["Ctrl"], t`Hold while moving to stop snapping`],
        [["Enter"], t`Finish the path`], [["Delete"], t`Remove the picked path point`],
      ],
    },
    {
      title: t`View`,
      rows: [[["Ctrl", "0"], t`Fit to screen`], [["Ctrl", "1"], t`Actual size`], [["Ctrl", "+", "-"], t`Zoom in or out`], [["Ctrl", t`scroll`], t`Zoom at the pointer`], [["?"], t`This list`]],
    },
  ];
  return (
    <EditorModal label={t`Keyboard shortcuts`} onClose={onClose} wide>
      <div className="flex items-center border-b border-white/[0.07] px-5 py-4">
        <h2 className="flex-1 text-[15px] font-bold text-white">{t`Keyboard shortcuts`}</h2>
        <button type="button" onClick={onClose} className="h-8 cursor-pointer rounded-lg px-3 text-[12.5px] font-semibold text-osu-l2 hover:bg-white/[0.06] hover:text-white">{t`Close`}</button>
      </div>
      <div className="grid max-h-[72dvh] gap-x-8 gap-y-5 overflow-y-auto px-5 py-4 sm:grid-cols-2">
        {groups.map((group) => (
          <section key={group.title}>
            <h3 className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.08em] text-osu-f1">{group.title}</h3>
            <dl className="grid gap-1">
              {group.rows.map(([keys, label]) => (
                <div key={label} className="flex min-h-7 items-center gap-3 text-[12.5px]">
                  <dt className="flex shrink-0 gap-1">
                    {keys.map((key) => <kbd key={key} className="min-w-6 rounded-md bg-white/[0.08] px-1.5 py-0.5 text-center font-mono text-[11.5px] text-white shadow-[inset_0_-1px_0_rgba(0,0,0,0.4)]">{key}</kbd>)}
                  </dt>
                  <dd className="min-w-0 text-osu-l2">{label}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </EditorModal>
  );
}
