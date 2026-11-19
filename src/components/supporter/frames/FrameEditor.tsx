import { useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { ChevronLeft, Eye, MoreHorizontal, Pause, Play, Redo2, Undo2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { useAuth } from "../../../lib/auth-context";
import {
  AVATAR_INSET,
  AVATAR_RADIUS,
  AVATAR_SIZE,
  blankCanvas,
  cloneCanvas,
  DOC_CENTRE,
  DOC_SIZE,
  emptyDoc,
  findLayer,
  LOOP_SECONDS,
  mapTree,
  maskKey,
  newId,
  newPaintLayer,
  newPathLayer,
  newShapeLayer,
  newTextLayer,
  patchLayer,
  setBoard,
  walk,
  WORKSHOP_SIZE,
  type BoardId,
  type EditorState,
  type Layer,
  type MotionKey,
  type PathLayer,
  type PathPoint,
  type ShapeLayer,
  type Transform,
} from "../../../lib/frame-editor/doc";
import { useHistory } from "../../../lib/frame-editor/history";
import { canRecordLoop, recordLoop } from "../../../lib/frame-editor/loop";
import {
  centreOnAvatar,
  copySelection,
  docBox,
  duplicateLayer,
  editSelection,
  groupLayer,
  insertLayer,
  mergeDown,
  moveToGroup,
  transformDeep,
  ungroup,
  cloneLayerDeep,
  normaliseAngle,
  paintLayerFrom,
  placePicture,
  rasterize,
  readPicture,
  removeLayer,
  reorder,
  rotateAbout,
  scaleAbout,
  shiftLayer,
} from "../../../lib/frame-editor/ops";
import {
  applyStroke,
  combineSelection,
  keepInSelection,
  Retouch,
  docToLayerMatrix,
  drawInLayerSpace,
  floodRegion,
  invertSelection,
  maskInLayerSpace,
  regionToMask,
  selectAll,
  selectionFromMask,
  Stroke,
  tint,
  type SelectMode,
  type Selection,
} from "../../../lib/frame-editor/paint";
import { alphaBounds, avatarClearance, canvasToBlob, composite, hitTest, isAnimated, localBox, motionPose, renderBoard, renderLayer, toDoc, toLocal } from "../../../lib/frame-editor/render";
import { makeStarter, type StarterId } from "../../../lib/frame-editor/starters";
import {
  cornersBounds,
  gradientCanvas,
  layerDelta,
  liftSelection,
  moveAnchor,
  moveHandle,
  pathOverlay,
  penHit,
  pullHandles,
  shiftedMask,
  snap,
  snapTargets,
  type PenPart,
  type SnapTargets,
} from "../../../lib/frame-editor/tools";
import { canvasToDataUrl, draftFromJson, draftToJson, draftUpdatedAt, listDrafts, loadDraft, saveDraft } from "../../../lib/frame-editor/storage";
import { useMediaQuery } from "../../../lib/use-media-query";
import { forgetLiveSupporterLook, setSupporterFrameLocally } from "../../../lib/live-backend";
import { fetchOwnWorkshopFrames, fetchSupporterLookState, saveSupporterFrameSetting, submitWorkshopFrame, updateWorkshopFrame } from "../../../lib/supporter-look-settings";
import { fetchAccountDraft, fetchAccountDrafts, fetchOwnFramePicture, storeAccountDraft } from "../../../lib/frame-drafts";
import { registerSubmittedFrames, uploadFramePart } from "../../../lib/workshop-frames";
import type { SupporterAvatarFrameId } from "../../../lib/supporter-avatar-frames";
import { avatarImageSrc } from "../../ui/Avatar";
import { ToolButton, ToolDivider } from "../themes/EditorChrome";
import { Popover } from "../themes/EditorControls";
import { ShortcutsDialog, StartDialog, SubmitDialog, useStarterNames, type SubmitState } from "./FrameDialogs";
import { HistoryPanel } from "./FrameHistory";
import { LayerInspector } from "./FrameInspector";
import { LayersPanel, MenuItem, type LayerAction } from "./FrameLayersPanel";
import { FramePreview, measureOverhang, type Overhang } from "./FramePreview";
import { DEFAULT_TOOL_SETTINGS, TOOL_KEYS, ToolOptions, ToolRail, type ToolId, type ToolSettings } from "./FrameTools";

/* The avatar frame editor (/workshop/frames/editor): a layered drawing
   program built round the frame template. Paint, shape, text and picture
   layers with blend modes, clipping, effects, repeats round the avatar and
   motion; brushes with symmetry; selections; the frame previewed on the
   viewer's avatar as they work; drafts kept in the browser; and Submit,
   which exports the 384px still (and round still, and the loop) and sends
   them through the same upload the workshop's file form uses. */

type Action =
  | { kind: "pan"; x: number; y: number; vx: number; vy: number }
  | { kind: "paint"; stroke: Stroke; id: string; layer: Layer; erase: boolean; opacity: number; base: HTMLCanvasElement | undefined; working: HTMLCanvasElement; smooth: [number, number]; smoothing: number }
  | { kind: "retouch"; retouch: Retouch; id: string; layer: Layer; base: HTMLCanvasElement | undefined }
  | { kind: "distort"; id: string; index: number; layer0: Layer; merge: string }
  | { kind: "move"; id: string; start: [number, number]; t0: Transform; merge: string; layer0: Layer; targets: SnapTargets; key: MotionKey | null }
  | { kind: "gradient"; id: string; start: [number, number]; base: HTMLCanvasElement | undefined; layer: Layer; mask: boolean }
  | { kind: "pen-new"; id: string; index: number; merge: string }
  | { kind: "pen-edit"; id: string; index: number; part: PenPart; start: [number, number]; point0: PathPoint; merge: string }
  | { kind: "lift"; id: string; lifted: HTMLCanvasElement; rest: HTMLCanvasElement; start: [number, number]; layer: Layer; mask: HTMLCanvasElement; offset: [number, number] }
  | { kind: "scale"; id: string; handle: Handle; t0: Transform; layer0: Layer; merge: string; key: MotionKey | null }
  | { kind: "rotate"; id: string; centre: [number, number]; a0: number; t0: Transform; merge: string; layer0: Layer; key: MotionKey | null }
  | { kind: "shape"; start: [number, number] }
  | { kind: "marquee"; start: [number, number]; current: [number, number]; mode: SelectMode }
  | { kind: "lasso"; points: [number, number][]; mode: SelectMode };

type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

const SETTINGS_KEY = "mania-hub-frame-editor-tools";
/* Side panels narrow on smaller windows so the canvas keeps its room. */
const LEFT_WIDTH = "clamp(232px, 19vw, 288px)";
const RIGHT_WIDTH = "clamp(248px, 20vw, 300px)";

function hexOf(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}

function selectMode(event: { shiftKey: boolean; altKey: boolean }): SelectMode {
  return event.shiftKey && event.altKey ? "intersect" : event.shiftKey ? "add" : event.altKey ? "subtract" : "replace";
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function fileName(name: string): string {
  return (name.trim() || "frame").replace(/[^a-z0-9-_ ]/gi, "").replace(/\s+/g, "-").toLowerCase() || "frame";
}

export function FrameEditor({ draftId, frameId = null, onDraftId }: { draftId: string | null; frameId?: string | null; onDraftId: (id: string) => void }) {
  const { t } = useLingui();
  const auth = useAuth();
  const viewer = auth.viewer;
  const avatar = viewer ? avatarImageSrc(viewer.avatarUrl, viewer.id) : undefined;
  const narrow = useMediaQuery("(max-width: 1023px)") === true;
  const short = useMediaQuery("(max-height: 900px)") === true;
  const { names: starterNames, labels: starterLabels } = useStarterNames();

  const history = useHistory<EditorState | null>(null);
  const state = history.present;
  const [board, setBoardId] = useState<BoardId>("square");
  const [selected, setSelected] = useState<string | null>(null);
  const [tool, setTool] = useState<ToolId>("brush");
  const [settings, setSettings] = useState<ToolSettings>(DEFAULT_TOOL_SETTINGS);
  const [primary, setPrimary] = useState("#ff66ab");
  const [secondary, setSecondary] = useState("#ffffff");
  const [selection, setSelection] = useState<Selection | null>(null);
  const [view, setView] = useState({ zoom: 1, x: 0, y: 0 });
  const [playing, setPlaying] = useState(false);
  const [showAvatar, setShowAvatar] = useState(true);
  const [backdrop, setBackdrop] = useState<"dark" | "light" | "checker">("dark");
  const [guides, setGuides] = useState(true);
  const [snapOn, setSnapOn] = useState(true);
  const [snapLines, setSnapLines] = useState<{ x: number | null; y: number | null } | null>(null);
  const [penDrawing, setPenDrawing] = useState<string | null>(null);
  const [penAnchor, setPenAnchor] = useState<number | null>(null);
  const [penHover, setPenHover] = useState<[number, number] | null>(null);
  const [gradientLine, setGradientLine] = useState<[[number, number], [number, number]] | null>(null);
  const [liftOffset, setLiftOffset] = useState<[number, number] | null>(null);
  /* the selected layer's mask, not its pixels, is what the paint tools change */
  const [maskTarget, setMaskTarget] = useState(false);
  /* the moment of the loop the stage shows while it isn't playing, and the keyframe being edited */
  const [scrub, setScrub] = useState(0);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [starting, setStarting] = useState(draftId === null && !frameId);
  const [loading, setLoading] = useState(draftId !== null);
  const [submitOpen, setSubmitOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [focusText, setFocusText] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [saved, setSaved] = useState<"saved" | "saving" | "unsaved">("saved");
  /* the copy kept on the player's account, a little behind this browser's */
  const [account, setAccount] = useState<{ state: "idle" | "saving" | "saved" | "error"; message: string | null }>({ state: "idle", message: null });
  const [updating, setUpdating] = useState(true);
  const [moreOpen, setMoreOpen] = useState(false);
  const [viewOpen, setViewOpen] = useState(false);
  const [phonePanel, setPhonePanel] = useState<"layers" | "layer" | "preview" | "history">("layers");
  const [rightTab, setRightTab] = useState<"layers" | "history">("layers");
  const [draftShape, setDraftShape] = useState<ShapeLayer | null>(null);
  const [marquee, setMarquee] = useState<{ kind: "rect" | "ellipse" | "lasso"; d: string } | null>(null);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [dropping, setDropping] = useState(false);
  const [supporter, setSupporter] = useState<boolean | null>(null);
  const [submit, setSubmit] = useState<SubmitState>({ phase: "idle", progress: 0, error: null });
  const [includeLoop, setIncludeLoop] = useState(true);
  const [submitted, setSubmitted] = useState<{ id: SupporterAvatarFrameId; worn: boolean } | null>(null);
  const [exports, setExports] = useState<{ still: string | null; round: string | null; overhang: Overhang; clear: { square: number | null; round: number | null } }>({ still: null, round: null, overhang: [0, 0, 0, 0], clear: { square: null, round: null } });

  const currentDraft = useRef<string | null>(null);
  const stageRef = useRef<HTMLElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cursorRef = useRef<HTMLDivElement>(null);
  const action = useRef<Action | null>(null);
  const live = useRef<{ id: string; canvas: HTMLCanvasElement } | null>(null);
  const time = useRef(0);
  const clipboard = useRef<HTMLCanvasElement | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ distance: number; mid: [number, number]; view: { zoom: number; x: number; y: number } } | null>(null);
  const lastPaint = useRef<[number, number] | null>(null);

  // the latest of everything, for pointer and key handlers
  const latest = useRef({ state, board, selected, tool, settings, primary, secondary, selection, view, spaceHeld, snapOn, penDrawing, penAnchor, maskTarget, scrub, activeKey });
  latest.current = { state, board, selected, tool, settings, primary, secondary, selection, view, spaceHeld, snapOn, penDrawing, penAnchor, maskTarget, scrub, activeKey };

  // picking another layer, or losing the mask, goes back to painting pixels
  const selectedMask = state ? !!findLayer(state.doc, board, selected)?.mask : false;
  useEffect(() => {
    if (!selectedMask) setMaskTarget(false);
  }, [selected, selectedMask]);

  // a path being drawn ends when the pen is put down or another layer is picked
  useEffect(() => {
    if (penDrawing && (tool !== "pen" || selected !== penDrawing)) setPenDrawing(null);
    if (tool !== "pen") setPenAnchor(null);
  }, [tool, selected]); // eslint-disable-line react-hooks/exhaustive-deps

  const layers = state?.doc.boards[board] ?? [];
  const current = state ? findLayer(state.doc, board, selected) : null;
  const flash = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast((value) => (value === message ? null : value)), 2600);
  }, []);

  /* The editor fills the window: the page under it never scrolls, so the top
     bar can't slide under the site's nav. */
  useEffect(() => {
    const root = document.documentElement;
    const before = root.style.overflow;
    root.style.overflow = "hidden";
    window.scrollTo(0, 0);
    return () => {
      root.style.overflow = before;
    };
  }, []);

  /* --- Settings that last between visits ---------------------------------------- */
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(SETTINGS_KEY);
      if (raw) {
        const saved = JSON.parse(raw) as Partial<ToolSettings> & { primary?: string; secondary?: string };
        setSettings((value) => ({
          ...value,
          ...Object.fromEntries(Object.entries(saved).filter(([key]) => key in value).map(([key, entry]) => {
            const fallback = value[key as keyof ToolSettings];
            return [key, entry && typeof entry === "object" && fallback && typeof fallback === "object" ? { ...fallback, ...entry } : entry];
          })),
        }));
        if (saved.primary) setPrimary(saved.primary);
        if (saved.secondary) setSecondary(saved.secondary);
      }
    } catch {
      // nothing saved, or storage off
    }
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        window.localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...settings, primary, secondary }));
      } catch {
        // storage off
      }
    }, 400);
    return () => window.clearTimeout(timer);
  }, [settings, primary, secondary]);

  useEffect(() => {
    if (!viewer) return;
    void fetchSupporterLookState().then((look) => setSupporter(look?.supporter ?? false)).catch(() => setSupporter(false));
  }, [viewer?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  /* --- Opening a draft ------------------------------------------------------------ */
  useEffect(() => {
    if (!draftId || draftId === currentDraft.current) return;
    currentDraft.current = draftId;
    setLoading(true);
    // this browser's copy, or the account's when it's newer or the only one
    void (async () => {
      const [local, localAt, list] = await Promise.all([
        loadDraft(draftId).catch(() => null),
        draftUpdatedAt(draftId).catch(() => null),
        viewer ? fetchAccountDrafts().catch(() => []) : Promise.resolve([]),
      ]);
      const remote = list.find((entry) => entry.id === draftId);
      if (remote && (!local || remote.updatedAt > (localAt ?? 0) + 1000)) {
        const body = (await fetchAccountDraft({ data: { id: draftId } }).catch(() => null))?.body;
        const fromAccount = body ? await draftFromJson(body) : null;
        if (fromAccount) {
          await saveDraft(draftId, fromAccount, renderBoard(fromAccount.doc.boards.square, { pixels: fromAccount.pixels, assets: fromAccount.assets, size: 192 }), remote.updatedAt).catch(() => undefined);
          return fromAccount;
        }
      }
      return local;
    })().then((loaded) => {
      setLoading(false);
      if (!loaded) {
        setStarting(true);
        return;
      }
      history.reset(loaded);
      setSelected(loaded.doc.boards.square.at(-1)?.id ?? null);
      setBoardId("square");
      setSelection(null);
      setStarting(false);
      setSaved("saved");
    }).catch(() => {
      setLoading(false);
      setStarting(true);
    });
  }, [draftId]); // eslint-disable-line react-hooks/exhaustive-deps

  const begin = (next: EditorState, select: string | null) => {
    const id = newId("d");
    currentDraft.current = id;
    history.reset(next);
    setSelected(select);
    setBoardId("square");
    setSelection(null);
    setStarting(false);
    setSaved("unsaved");
    onDraftId(id);
  };

  const startFrom = (starter: StarterId) => {
    const doc = makeStarter(starter, { ...starterNames, name: viewer?.username ?? starterNames.name }, starter === "blank" ? "" : starterLabels[starter]);
    let next: EditorState = { doc, pixels: {}, assets: {} };
    if (starter === "blank") {
      // a blank frame opens with a layer to paint on
      const paint = newPaintLayer(t`Layer 1`);
      next = insertLayer(next, "square", paint, null);
      begin(next, paint.id);
      setTool("brush");
      return;
    }
    begin(next, doc.boards.square.at(-1)?.id ?? null);
    setTool("move");
  };

  const startFromPicture = async (file: File) => {
    try {
      const picture = await readPicture(file);
      const placed = placePicture({ doc: { version: 1, name: "", boards: { square: [], round: [] } }, pixels: {}, assets: {} }, "square", picture, t`Picture`, null);
      begin(placed.state, placed.id);
      setTool("move");
    } catch {
      flash(t`Could not read that picture.`);
    }
  };

  /* --- Opening a submitted frame ("Edit in the editor") -------------------------------- */
  const openedFrame = useRef<string | null>(null);
  useEffect(() => {
    if (!frameId || draftId || !viewer || openedFrame.current === frameId) return;
    openedFrame.current = frameId;
    setStarting(false);
    setLoading(true);
    void (async () => {
      // the draft it was made from, here or on the account, keeps every layer
      const [local, list] = await Promise.all([listDrafts().catch(() => []), fetchAccountDrafts().catch(() => [])]);
      const match = [...local, ...list].sort((a, b) => b.updatedAt - a.updatedAt).find((entry) => entry.submitted === frameId);
      if (match) {
        onDraftId(match.id);
        return;
      }
      // made elsewhere: its pictures become layers
      const frame = (await fetchOwnWorkshopFrames()).find((entry) => entry.id === frameId);
      if (!frame) throw new Error(t`That frame isn't one of yours.`);
      const picture = async (url: string) => readPicture(await (await fetch((await fetchOwnFramePicture({ data: { url } })).dataUrl)).blob());
      let next: EditorState = { doc: { ...emptyDoc(frame.name), submitted: frame.id }, pixels: {}, assets: {} };
      const fullSize = (placed: { state: EditorState; id: string }, board: BoardId) => ({ ...placed.state, doc: patchLayer(placed.state.doc, board, placed.id, { width: DOC_SIZE, height: DOC_SIZE } as Partial<Layer>) });
      next = fullSize(placePicture(next, "square", await picture(frame.still), frame.name, null), "square");
      if (frame.round) next = fullSize(placePicture(next, "round", await picture(frame.round), frame.name, null), "round");
      begin(next, next.doc.boards.square.at(-1)?.id ?? null);
      setTool("move");
    })().catch((cause) => {
      flash(cause instanceof Error ? cause.message : String(cause));
      setStarting(true);
    }).finally(() => setLoading(false));
  }, [frameId, draftId, viewer?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  /* --- Saving the draft as they work ------------------------------------------------ */
  useEffect(() => {
    if (!state || !currentDraft.current) return;
    setSaved("unsaved");
    const id = currentDraft.current;
    const timer = window.setTimeout(() => {
      setSaved("saving");
      const thumb = renderBoard(state.doc.boards.square, { pixels: state.pixels, assets: state.assets, size: 192 });
      // nothing drawn yet: nothing to keep
      if (!hasArt(state, thumb)) {
        setSaved("saved");
        return;
      }
      void saveDraft(id, state, thumb).then(() => setSaved("saved")).catch(() => setSaved("unsaved"));
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [state]);

  // the account copy waits for a pause in the work, so a long session sends a handful of saves, not hundreds
  useEffect(() => {
    if (!state || !currentDraft.current || !viewer) return;
    const id = currentDraft.current;
    const timer = window.setTimeout(() => {
      const small = renderBoard(state.doc.boards.square, { pixels: state.pixels, assets: state.assets, size: 96 });
      if (!hasArt(state, small)) return;
      setAccount({ state: "saving", message: null });
      void (async () => {
        const thumb = await canvasToDataUrl(small);
        const result = await storeAccountDraft({ data: { id, name: state.doc.name, updatedAt: Date.now(), thumb, submitted: state.doc.submitted ?? null, body: await draftToJson(state) } });
        setAccount(result.ok ? { state: "saved", message: null } : { state: "error", message: result.error });
      })().catch(() => setAccount({ state: "error", message: t`Couldn't reach your account; this browser still has it.` }));
    }, 15_000);
    return () => window.clearTimeout(timer);
  }, [state, viewer?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  /* --- Drawing the stage ------------------------------------------------------------- */
  const drawPending = useRef(false);
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const { state: s, board: b } = latest.current;
    if (!canvas || !s) return;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, DOC_SIZE, DOC_SIZE);
    const list = s.doc.boards[b];
    const pixels = live.current ? { ...s.pixels, [live.current.id]: live.current.canvas } : s.pixels;
    composite(ctx, list, { pixels, assets: s.assets, time: time.current, size: DOC_SIZE, live: live.current ? new Set([live.current.id]) : undefined });
  }, []);
  const requestDraw = useCallback(() => {
    if (drawPending.current) return;
    drawPending.current = true;
    requestAnimationFrame(() => {
      drawPending.current = false;
      draw();
    });
  }, [draw]);
  useEffect(() => requestDraw(), [state, board, requestDraw, loading, starting]);

  useEffect(() => {
    if (!playing) {
      time.current = scrub;
      requestDraw();
      return;
    }
    let frame = 0;
    const started = performance.now();
    const tick = () => {
      time.current = (((performance.now() - started) / 1000) / LOOP_SECONDS) % 1;
      draw();
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, draw, requestDraw, scrub]);

  /* --- The exports behind the preview ------------------------------------------------ */
  useEffect(() => {
    if (!state) return;
    const timer = window.setTimeout(() => {
      const input = { pixels: state.pixels, assets: state.assets, size: WORKSHOP_SIZE, time: 0 };
      const square = renderBoard(state.doc.boards.square, input);
      const squareClear = avatarClearance(square, false);
      const hasRound = state.doc.boards.round.some((layer) => layer.visible);
      const round = hasRound ? renderBoard(state.doc.boards.round, input) : null;
      const roundClear = round ? avatarClearance(round, true) : null;
      void Promise.all([squareClear.empty ? null : canvasToBlob(square), round && roundClear && !roundClear.empty ? canvasToBlob(round) : null]).then(([stillBlob, roundBlob]) => {
        setExports((previous) => {
          if (previous.still) URL.revokeObjectURL(previous.still);
          if (previous.round) URL.revokeObjectURL(previous.round);
          return {
            still: stillBlob ? URL.createObjectURL(stillBlob) : null,
            round: roundBlob ? URL.createObjectURL(roundBlob) : null,
            overhang: measureOverhang(square),
            clear: { square: squareClear.empty ? null : squareClear.clear, round: roundClear && !roundClear.empty ? roundClear.clear : null },
          };
        });
      });
    }, 350);
    return () => window.clearTimeout(timer);
  }, [state]);

  /* --- The view ------------------------------------------------------------------------ */
  const fitView = useCallback(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const pad = narrow ? 16 : 56;
    const zoom = Math.max(0.1, Math.min((stage.clientWidth - pad * 2) / DOC_SIZE, (stage.clientHeight - pad * 2) / DOC_SIZE));
    setView({ zoom, x: (stage.clientWidth - DOC_SIZE * zoom) / 2, y: (stage.clientHeight - DOC_SIZE * zoom) / 2 });
  }, [narrow]);
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    fitView();
    let first = true;
    const observer = new ResizeObserver(() => {
      if (first) {
        first = false;
        return;
      }
      fitView();
    });
    observer.observe(stage);
    return () => observer.disconnect();
  }, [fitView, starting, loading]);

  const zoomAt = (factor: number, sx: number, sy: number) => {
    setView((v) => {
      const zoom = Math.max(0.1, Math.min(16, v.zoom * factor));
      const k = zoom / v.zoom;
      return { zoom, x: sx - (sx - v.x) * k, y: sy - (sy - v.y) * k };
    });
  };

  const stagePoint = (clientX: number, clientY: number): [number, number] => {
    const rect = stageRef.current!.getBoundingClientRect();
    return [clientX - rect.left, clientY - rect.top];
  };
  const docPoint = (clientX: number, clientY: number): [number, number] => {
    const [sx, sy] = stagePoint(clientX, clientY);
    const v = latest.current.view;
    return [(sx - v.x) / v.zoom, (sy - v.y) / v.zoom];
  };

  /* --- Committing ------------------------------------------------------------------------ */
  const commit = history.commit;
  const patch = useCallback((id: string, changes: Partial<Layer>, merge?: string) => {
    commit((s) => (s ? { ...s, doc: patchLayer(s.doc, latest.current.board, id, changes) } : s), merge);
  }, [commit]);

  /* The layer as the stage shows it at the paused moment, for layers moved by keyframes. */
  const posed = useCallback((layer: Layer): Layer => {
    if (layer.motion.kind !== "keys") return layer;
    const pose = motionPose(layer.motion, latest.current.scrub);
    const tf = layer.transform;
    return { ...layer, transform: { ...tf, x: tf.x + pose.dx, y: tf.y + pose.dy, rotation: tf.rotation + pose.rotation, scaleX: tf.scaleX * pose.scale, scaleY: tf.scaleY * pose.scale } };
  }, []);
  const editingKey = (layer: Layer): MotionKey | null => (layer.motion.kind === "keys" ? layer.motion.keys?.find((key) => key.id === latest.current.activeKey) ?? null : null);
  const patchKey = useCallback((layer: Layer, key: MotionKey, changes: Partial<MotionKey>, merge?: string) => {
    patch(layer.id, { motion: { ...layer.motion, keys: (layer.motion.keys ?? []).map((entry) => (entry.id === key.id ? { ...entry, ...changes } : entry)) } }, merge);
  }, [patch]);

  /* A keyframe at the paused moment, holding the pose the layer has there now. */
  const addKey = useCallback((layer: Layer) => {
    const at = Math.round(latest.current.scrub * 100) / 100;
    const keys = layer.motion.kind === "keys" ? layer.motion.keys ?? [] : [];
    const same = keys.find((key) => Math.abs(key.t - at) < 0.005);
    if (same) {
      setActiveKey(same.id);
      return;
    }
    const pose = layer.motion.kind === "keys" ? motionPose(layer.motion, at) : { dx: 0, dy: 0, rotation: 0, scale: 1, alpha: 1 };
    const key: MotionKey = { id: newId("k"), t: at, dx: Math.round(pose.dx), dy: Math.round(pose.dy), rotation: Math.round(pose.rotation * 10) / 10, scale: Math.round(pose.scale * 1000) / 1000, opacity: Math.round(pose.alpha * 100) / 100, ease: "smooth" };
    patch(layer.id, { motion: { ...layer.motion, kind: "keys", keys: [...keys, key] } });
    setActiveKey(key.id);
  }, [patch]);

  /* Changes a layer's transform, or, for a group (which keeps none of its own), that of every layer inside it. */
  const setTransform = useCallback((layer0: Layer, fn: (t: Transform, child: Layer) => Transform, merge?: string) => {
    if (layer0.kind === "group") patch(layer0.id, { children: (transformDeep(layer0, fn) as typeof layer0).children } as Partial<Layer>, merge);
    else patch(layer0.id, { transform: fn(layer0.transform, layer0) }, merge);
  }, [patch]);

  /* The paint layer a brush or bucket works on: the selected one, or a new one above it. */
  /* The pixels a paint tool changes: the selected layer's mask while it's being
     edited, else the selected paint layer, else a new paint layer above it. */
  const paintTarget = ({ allowMask = true }: { allowMask?: boolean } = {}): { state: EditorState; layer: Layer; key: string; mask: boolean } | null => {
    const { state: s, board: b, selected: sel, maskTarget: onMask } = latest.current;
    if (!s) return null;
    const layer = findLayer(s.doc, b, sel);
    if (layer?.locked) {
      flash(t`That layer is locked.`);
      return null;
    }
    if (layer?.mask && onMask) {
      if (!allowMask) {
        flash(t`Paint the mask with the brush, eraser or gradient.`);
        return null;
      }
      return { state: s, layer, key: maskKey(layer.id), mask: true };
    }
    if (layer?.kind === "paint" && layer.distort) {
      flash(t`Turn this layer into paint again (layer menu) to paint on it in perspective.`);
      return null;
    }
    if (layer?.kind === "paint") return { state: s, layer, key: layer.id, mask: false };
    const paint = newPaintLayer(t`Layer ${walk(s.doc.boards[b]).length + 1}`);
    // picked a group: the new layer goes on top inside it
    const next = layer?.kind === "group"
      ? (layer.children.length ? insertLayer(s, b, paint, layer.children[layer.children.length - 1].id) : { ...moveToGroup(insertLayer(s, b, paint, layer.id), b, paint.id, layer.id) })
      : insertLayer(s, b, paint, sel);
    if (next === s) {
      flash(t`That's the most layers a frame can have.`);
      return null;
    }
    commit(next);
    setSelected(paint.id);
    return { state: next, layer: paint, key: paint.id, mask: false };
  };

  const sampleComposite = (): ImageData | null => {
    const { state: s, board: b } = latest.current;
    if (!s) return null;
    return renderBoard(s.doc.boards[b], { pixels: s.pixels, assets: s.assets, size: DOC_SIZE, time: 0 }).getContext("2d")!.getImageData(0, 0, DOC_SIZE, DOC_SIZE);
  };

  const pickColour = (x: number, y: number) => {
    const data = sampleComposite();
    if (!data) return;
    const i = (Math.floor(y) * DOC_SIZE + Math.floor(x)) * 4;
    if (x < 0 || y < 0 || x >= DOC_SIZE || y >= DOC_SIZE || data.data[i + 3] < 10) return;
    setPrimary(hexOf(data.data[i], data.data[i + 1], data.data[i + 2]));
  };

  const bucket = (x: number, y: number) => {
    const target = paintTarget({ allowMask: false });
    if (!target) return;
    const { state: s, layer } = target;
    const { fill } = latest.current.settings;
    const pixels = cloneCanvas(s.pixels[layer.id] ?? blankCanvas());
    let mask: HTMLCanvasElement;
    if (fill.sampleAll) {
      const data = sampleComposite();
      if (!data) return;
      const docMask = regionToMask(floodRegion(data.data, DOC_SIZE, x, y, fill.tolerance, fill.contiguous), DOC_SIZE, 1);
      if (latest.current.selection) {
        const ctx = docMask.getContext("2d")!;
        ctx.globalCompositeOperation = "destination-in";
        ctx.drawImage(latest.current.selection.mask, 0, 0);
      }
      drawInLayerSpace(pixels, tint(docMask, latest.current.primary), layer);
    } else {
      const point = docToLayerMatrix(layer).transformPoint(new DOMPoint(x, y));
      const data = pixels.getContext("2d")!.getImageData(0, 0, DOC_SIZE, DOC_SIZE).data;
      mask = regionToMask(floodRegion(data, DOC_SIZE, point.x, point.y, fill.tolerance, fill.contiguous), DOC_SIZE, 1);
      if (latest.current.selection) maskInLayerSpace(mask, latest.current.selection.mask, layer);
      pixels.getContext("2d")!.drawImage(tint(mask, latest.current.primary), 0, 0);
    }
    commit({ ...s, pixels: { ...s.pixels, [layer.id]: pixels } });
  };

  const wand = (x: number, y: number, mode: SelectMode) => {
    const { state: s, board: b, selected: sel, settings: st } = latest.current;
    if (!s) return;
    let data: Uint8ClampedArray | null = null;
    const layer = findLayer(s.doc, b, sel);
    if (st.wand.sampleAll || !layer) data = sampleComposite()?.data ?? null;
    else data = renderLayer(layer, { pixels: s.pixels, assets: s.assets, size: DOC_SIZE }).getContext("2d")!.getImageData(0, 0, DOC_SIZE, DOC_SIZE).data;
    if (!data) return;
    const mask = regionToMask(floodRegion(data, DOC_SIZE, x, y, st.wand.tolerance, st.wand.contiguous), DOC_SIZE);
    setSelection(combineSelection(latest.current.selection, mode, (ctx) => ctx.drawImage(mask, 0, 0)));
  };

  const addText = (x: number, y: number) => {
    const { state: s, board: b, selected: sel, settings: st } = latest.current;
    if (!s) return;
    const layer = newTextLayer(t`Text`, t`Text`, latest.current.primary, { font: st.text.font, size: st.text.size, weight: st.text.weight });
    layer.transform = { ...layer.transform, x, y };
    const next = insertLayer(s, b, layer, sel);
    if (next === s) return;
    commit(next);
    setSelected(layer.id);
    setFocusText(true);
    if (narrow) setPhonePanel("layer");
  };

  const addShapeAround = () => {
    const { state: s, board: b, selected: sel } = latest.current;
    if (!s) return;
    const gap = 6;
    const width = 12;
    const size = AVATAR_SIZE + gap * 2 + width;
    const layer = newShapeLayer(t`Outline`, b === "round" ? "ellipse" : "rect", latest.current.primary, { width: size, height: size, radius: b === "round" ? 0 : AVATAR_RADIUS + gap + width / 2, style: "outline", lineWidth: width });
    const next = insertLayer(s, b, layer, sel);
    if (next === s) return;
    commit(next);
    setSelected(layer.id);
  };

  const addPaintLayer = () => {
    const { state: s, board: b, selected: sel } = latest.current;
    if (!s) return;
    const layer = newPaintLayer(t`Layer ${s.doc.boards[b].length + 1}`);
    const next = insertLayer(s, b, layer, sel);
    if (next === s) return;
    commit(next);
    setSelected(layer.id);
  };

  const addPicture = async (file: Blob) => {
    try {
      const picture = await readPicture(file);
      const { state: s, board: b, selected: sel } = latest.current;
      if (!s) return;
      const placed = placePicture(s, b, picture, t`Picture`, sel);
      commit(placed.state);
      setSelected(placed.id);
      setTool("move");
    } catch {
      flash(t`Could not read that picture.`);
    }
  };

  /* --- Layer actions ---------------------------------------------------------------------- */
  const layerAction = useCallback((id: string, kind: LayerAction | "clearPaint" | "resetDistort") => {
    const { state: s, board: b, selection: sel } = latest.current;
    if (!s) return;
    const layer = findLayer(s.doc, b, id);
    if (!layer) return;
    switch (kind) {
      case "duplicate": {
        const result = duplicateLayer(s, b, id, (entry) => t`${entry.name} copy`);
        if (result) {
          commit(result.state);
          setSelected(result.id);
        }
        return;
      }
      case "delete": {
        const list = s.doc.boards[b];
        const index = list.findIndex((entry) => entry.id === id);
        commit(removeLayer(s, b, id));
        setSelected(list[index - 1]?.id ?? list[index + 1]?.id ?? null);
        return;
      }
      case "merge": {
        const list = s.doc.boards[b];
        const below = list[list.findIndex((entry) => entry.id === id) - 1];
        if (!below) return;
        commit(mergeDown(s, b, id));
        setSelected(below.id);
        return;
      }
      case "rasterize":
        commit(rasterize(s, b, id));
        return;
      case "clip":
        patch(id, { clip: !layer.clip });
        return;
      case "lock":
        patch(id, { locked: !layer.locked });
        return;
      case "hide":
        patch(id, { visible: !layer.visible });
        return;
      case "flipX":
      case "flipY": {
        const box = docBox(layer, s.pixels);
        const pivot = box?.centre ?? [layer.transform.x, layer.transform.y];
        setTransform(layer, (tf, child) => {
          const [qx, qy] = toLocal(child, pivot[0], pivot[1]);
          return scaleAbout(tf, qx, qy, kind === "flipX" ? -1 : 1, kind === "flipY" ? -1 : 1);
        });
        return;
      }
      case "centre": {
        const target = centreOnAvatar(layer, s.pixels);
        const dx = target.x - layer.transform.x;
        const dy = target.y - layer.transform.y;
        setTransform(layer, (tf) => ({ ...tf, x: tf.x + dx, y: tf.y + dy }));
        return;
      }
      case "group": {
        const result = groupLayer(s, b, id, t`Group`);
        if (result) {
          commit(result.state);
          setSelected(result.id);
        }
        return;
      }
      case "ungroup":
        commit(ungroup(s, b, id));
        setSelected(layer.kind === "group" ? layer.children.at(-1)?.id ?? null : id);
        return;
      case "moveOut":
        commit(moveToGroup(s, b, id, null));
        return;
      case "up":
      case "down":
        commit(shiftLayer(s, b, id, kind === "up" ? 1 : -1));
        return;
      case "rename":
        setRenaming(id);
        return;
      case "clearPaint":
        commit(editSelection(s, b, id, sel, null));
        return;
      case "addMask": {
        // a new mask shows everything, or only the selection when there is one
        const mask = blankCanvas();
        const ctx = mask.getContext("2d")!;
        ctx.fillStyle = "#ffffff";
        if (sel) drawInLayerSpace(mask, sel.mask, layer);
        else ctx.fillRect(0, 0, DOC_SIZE, DOC_SIZE);
        commit({ ...s, doc: patchLayer(s.doc, b, id, { mask: { enabled: true } }), pixels: { ...s.pixels, [maskKey(id)]: mask } });
        setMaskTarget(true);
        if (sel) setSelection(null);
        return;
      }
      case "deleteMask":
        commit({ ...s, doc: patchLayer(s.doc, b, id, { mask: null }) });
        setMaskTarget(false);
        return;
      case "toggleMask":
        if (layer.mask) patch(id, { mask: { enabled: !layer.mask.enabled } });
        return;
      case "applyMask": {
        const mask = s.pixels[maskKey(id)];
        if (layer.kind !== "paint" || !mask) return;
        const pixels = cloneCanvas(s.pixels[id] ?? blankCanvas());
        const ctx = pixels.getContext("2d")!;
        ctx.globalCompositeOperation = "destination-in";
        ctx.drawImage(mask, 0, 0);
        commit({ ...s, doc: patchLayer(s.doc, b, id, { mask: null }), pixels: { ...s.pixels, [id]: pixels } });
        setMaskTarget(false);
        return;
      }
      case "resetDistort":
        patch(id, { distort: null });
        return;
      default:
        if (kind.startsWith("into:")) commit(moveToGroup(s, b, id, kind.slice(5)));
        return;
    }
  }, [commit, patch, setTransform, t]);

  const copyBoard = () => {
    const { state: s } = latest.current;
    if (!s) return;
    const pixels = { ...s.pixels };
    // an outline that hugs the square avatar becomes a ring round the round one
    const layers = mapTree(s.doc.boards.square.map((layer) => cloneLayerDeep(layer, s, pixels)), (copy) => (copy.kind === "shape" && copy.shape === "rect" && Math.abs(copy.width - copy.height) < 1 && copy.width >= AVATAR_SIZE ? { ...copy, shape: "ellipse" } : copy));
    commit({ ...s, doc: setBoard(s.doc, "round", layers), pixels });
    setSelected(layers.at(-1)?.id ?? null);
  };

  /* --- Pointer input ------------------------------------------------------------------------ */
  const handleCursor = (clientX: number, clientY: number, visible: boolean) => {
    const cursor = cursorRef.current;
    if (!cursor) return;
    const { tool: tl, settings: st, view: v, spaceHeld: space } = latest.current;
    const brushy = (tl === "brush" || tl === "eraser") && !space;
    if (!visible || !brushy) {
      cursor.style.display = "none";
      return;
    }
    const [sx, sy] = stagePoint(clientX, clientY);
    const size = Math.max(4, st[tl === "eraser" ? "eraser" : "brush"].size * v.zoom);
    cursor.style.display = "block";
    cursor.style.width = cursor.style.height = `${size}px`;
    cursor.style.transform = `translate(${sx - size / 2}px, ${sy - size / 2}px)`;
  };

  const onPointerDown = (event: React.PointerEvent<HTMLElement>) => {
    const s = latest.current.state;
    if (!s) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // synthetic events can't be captured
    }
    if (pointers.current.size === 2) {
      // a second finger: drop whatever the first started and pinch instead
      if (action.current?.kind === "paint") live.current = null;
      action.current = null;
      setDraftShape(null);
      setMarquee(null);
      const [a, b] = [...pointers.current.values()];
      pinch.current = { distance: Math.hypot(a.x - b.x, a.y - b.y), mid: stagePoint((a.x + b.x) / 2, (a.y + b.y) / 2), view: latest.current.view };
      requestDraw();
      return;
    }
    if (pointers.current.size > 2) return;
    // a press on the canvas takes the keyboard back from any field, so tool keys work;
    // the press itself must not, or a text layer's new field would lose it at once
    event.preventDefault();
    if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) document.activeElement.blur();
    const [x, y] = docPoint(event.clientX, event.clientY);
    const { tool: tl, board: b, selected: sel, settings: st, spaceHeld: space } = latest.current;
    if (event.button === 1 || space || tl === "hand") {
      action.current = { kind: "pan", x: event.clientX, y: event.clientY, vx: latest.current.view.x, vy: latest.current.view.y };
      return;
    }
    if (event.button !== 0) return;
    switch (tl) {
      case "zoom": {
        const [sx, sy] = stagePoint(event.clientX, event.clientY);
        zoomAt(event.altKey ? 1 / 1.6 : 1.6, sx, sy);
        return;
      }
      case "eyedropper":
        pickColour(x, y);
        return;
      case "brush":
      case "eraser": {
        if (event.altKey && tl === "brush") {
          pickColour(x, y);
          return;
        }
        const target = paintTarget();
        if (!target) return;
        const brush = st[tl];
        // on a mask the brush hides and the eraser brings back
        const erase = target.mask ? tl === "brush" : tl === "eraser";
        const stroke = new Stroke(brush, target.mask || tl === "eraser" ? "#ffffff" : latest.current.primary, target.layer, st.symmetry);
        const base = target.state.pixels[target.key];
        const working = blankCanvas();
        action.current = { kind: "paint", stroke, id: target.key, layer: target.layer, erase, opacity: brush.opacity, base, working, smooth: [x, y], smoothing: brush.smoothing };
        if (event.shiftKey && lastPaint.current) stroke.add(lastPaint.current[0], lastPaint.current[1], event.pressure);
        stroke.add(x, y, event.pressure);
        live.current = { id: target.key, canvas: applyStroke(base, stroke.buffer, brush.opacity, erase, latest.current.selection?.mask ?? null, target.layer, working) };
        requestDraw();
        return;
      }
      case "fill":
        bucket(x, y);
        return;
      case "retouch": {
        const { state: cur, board: bd, selected: sl, maskTarget: onMask } = latest.current;
        const layer = cur ? findLayer(cur.doc, bd, sl) : null;
        if (!layer || layer.kind !== "paint" || onMask) {
          flash(t`Smudge and blur work on paint layers. Pick one, or turn this layer into paint from the layer menu.`);
          return;
        }
        if (layer.locked) {
          flash(t`That layer is locked.`);
          return;
        }
        const { retouch } = st;
        const tool = new Retouch(s.pixels[layer.id], layer, retouch.mode, retouch.size, retouch.strength, st.symmetry);
        tool.add(x, y);
        action.current = { kind: "retouch", retouch: tool, id: layer.id, layer, base: s.pixels[layer.id] };
        live.current = { id: layer.id, canvas: keepInSelection(s.pixels[layer.id], tool.working, latest.current.selection?.mask ?? null, layer) };
        requestDraw();
        return;
      }
      case "gradient": {
        const target = paintTarget();
        if (!target) return;
        action.current = { kind: "gradient", id: target.key, start: [x, y], base: target.state.pixels[target.key], layer: target.layer, mask: target.mask };
        setGradientLine([[x, y], [x, y]]);
        return;
      }
      case "pen": {
        const layer = findLayer(s.doc, b, sel);
        if (layer?.kind === "path" && !layer.locked) {
          const hit = penHit(layer, x, y, 9 / latest.current.view.zoom, latest.current.penAnchor);
          if (hit) {
            if (latest.current.penDrawing === layer.id && hit.part === "anchor" && hit.index === 0 && layer.points.length > 2 && !layer.closed) {
              patch(layer.id, { closed: true } as Partial<Layer>);
              setPenDrawing(null);
              return;
            }
            setPenAnchor(hit.index);
            action.current = { kind: "pen-edit", id: layer.id, index: hit.index, part: hit.part, start: [x, y], point0: layer.points[hit.index], merge: `pen-edit:${layer.id}:${Date.now()}` };
            return;
          }
          if (latest.current.penDrawing === layer.id) {
            const [lx, ly] = toLocal(layer, x, y);
            const merge = `pen:${layer.id}:${Date.now()}`;
            patch(layer.id, { points: [...layer.points, { x: lx, y: ly, ix: lx, iy: ly, ox: lx, oy: ly }] } as Partial<Layer>, merge);
            setPenAnchor(layer.points.length);
            action.current = { kind: "pen-new", id: layer.id, index: layer.points.length, merge };
            return;
          }
        }
        const { pen } = st;
        const path = newPathLayer(t`Path`, latest.current.primary, { style: pen.style, lineWidth: pen.lineWidth });
        path.points = [{ x: x - DOC_CENTRE, y: y - DOC_CENTRE, ix: x - DOC_CENTRE, iy: y - DOC_CENTRE, ox: x - DOC_CENTRE, oy: y - DOC_CENTRE }];
        const next = insertLayer(s, b, path, sel);
        if (next === s) return;
        const merge = `pen:${path.id}:${Date.now()}`;
        commit(next, merge);
        setSelected(path.id);
        setPenDrawing(path.id);
        setPenAnchor(0);
        action.current = { kind: "pen-new", id: path.id, index: 0, merge };
        return;
      }
      case "wand":
        wand(x, y, selectMode(event));
        return;
      case "text": {
        const hit = hitTest(s.doc.boards[b], { pixels: s.pixels, assets: s.assets }, x, y);
        if (hit?.kind === "text") {
          setSelected(hit.id);
          setFocusText(true);
          if (narrow) setPhonePanel("layer");
          return;
        }
        addText(x, y);
        return;
      }
      case "shape":
        action.current = { kind: "shape", start: [x, y] };
        return;
      case "marquee":
        action.current = { kind: "marquee", start: [x, y], current: [x, y], mode: selectMode(event) };
        return;
      case "lasso":
        action.current = { kind: "lasso", points: [[x, y]], mode: selectMode(event) };
        return;
      case "move": {
        const layer = findLayer(s.doc, b, sel);
        const selMask = latest.current.selection;
        if (selMask && layer?.kind === "paint" && !layer.locked && x >= 0 && y >= 0 && x < DOC_SIZE && y < DOC_SIZE && selMask.mask.getContext("2d", { willReadFrequently: true })!.getImageData(Math.floor(x), Math.floor(y), 1, 1).data[3] > 127) {
          // dragging inside a selection on a paint layer moves the selected pixels
          const { lifted, rest } = liftSelection(layer, s.pixels[layer.id], selMask.mask);
          action.current = { kind: "lift", id: layer.id, lifted, rest, start: [x, y], layer, mask: selMask.mask, offset: [0, 0] };
          return;
        }
        const box = layer ? docBox(posed(layer), s.pixels) : null;
        let target: Layer | null = null;
        if (layer && box && insidePolygon(x, y, box.corners)) target = layer;
        else if (st.move.autoSelect) target = hitTest(s.doc.boards[b], { pixels: s.pixels, assets: s.assets }, x, y, event.ctrlKey || event.metaKey);
        else target = layer;
        if (!target) {
          setSelected(null);
          return;
        }
        setSelected(target.id);
        if (target.locked) {
          flash(t`That layer is locked.`);
          return;
        }
        action.current = { kind: "move", id: target.id, start: [x, y], t0: target.transform, merge: `move:${target.id}:${Date.now()}`, layer0: target, targets: snapTargets(s.doc.boards[b], target.id, s.pixels), key: editingKey(target) };
        return;
      }
    }
  };

  const onPointerMove = (event: React.PointerEvent<HTMLElement>) => {
    handleCursor(event.clientX, event.clientY, true);
    if (pointers.current.has(event.pointerId)) pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pinch.current && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = stagePoint((a.x + b.x) / 2, (a.y + b.y) / 2);
      const start = pinch.current;
      const zoom = Math.max(0.1, Math.min(16, start.view.zoom * (distance / start.distance)));
      const k = zoom / start.view.zoom;
      setView({ zoom, x: mid[0] - (start.mid[0] - start.view.x) * k, y: mid[1] - (start.mid[1] - start.view.y) * k });
      return;
    }
    const act = action.current;
    if (!act) {
      if (latest.current.tool === "pen" && latest.current.penDrawing) setPenHover(docPoint(event.clientX, event.clientY));
      return;
    }
    const [x, y] = docPoint(event.clientX, event.clientY);
    const s = latest.current.state;
    if (!s) return;
    switch (act.kind) {
      case "gradient": {
        const { gradient } = latest.current.settings;
        const selectionMask = latest.current.selection?.mask ?? null;
        const working = act.base ? cloneCanvas(act.base) : blankCanvas();
        if (act.mask) {
          // on a mask: hidden where the drag starts, shown where it ends
          const picture = gradientCanvas(gradient.kind, [x, y], act.start, "#ffffff", null, 1, selectionMask);
          if (selectionMask) drawInLayerSpace(working, selectionMask, act.layer, "destination-out");
          else working.getContext("2d")!.clearRect(0, 0, DOC_SIZE, DOC_SIZE);
          drawInLayerSpace(working, picture, act.layer);
        } else {
          const picture = gradientCanvas(gradient.kind, act.start, [x, y], latest.current.primary, gradient.fade ? null : latest.current.secondary, gradient.opacity, selectionMask);
          drawInLayerSpace(working, picture, act.layer);
        }
        live.current = { id: act.id, canvas: working };
        setGradientLine([act.start, [x, y]]);
        requestDraw();
        return;
      }
      case "pen-new":
      case "pen-edit": {
        const layer = findLayer(s.doc, latest.current.board, act.id);
        if (layer?.kind !== "path") return;
        const [lx, ly] = toLocal(layer, x, y);
        const points = [...layer.points];
        if (act.kind === "pen-new") {
          const point = points[act.index];
          if (!point || Math.hypot(lx - point.x, ly - point.y) < 2) return;
          points[act.index] = pullHandles(point, lx, ly);
        } else if (act.part === "anchor") {
          const [sx, sy] = toLocal(layer, act.start[0], act.start[1]);
          points[act.index] = moveAnchor(act.point0, lx - sx, ly - sy);
        } else {
          points[act.index] = moveHandle(points[act.index], act.part, lx, ly, event.altKey);
        }
        patch(act.id, { points } as Partial<Layer>, act.merge);
        return;
      }
      case "lift": {
        const dx = Math.round(x - act.start[0]);
        const dy = Math.round(y - act.start[1]);
        const [lx, ly] = layerDelta(act.layer, dx, dy);
        const working = cloneCanvas(act.rest);
        working.getContext("2d")!.drawImage(act.lifted, lx, ly);
        live.current = { id: act.id, canvas: working };
        act.offset = [dx, dy];
        setLiftOffset([dx, dy]);
        requestDraw();
        return;
      }
      case "pan":
        setView((v) => ({ ...v, x: act.vx + event.clientX - act.x, y: act.vy + event.clientY - act.y }));
        return;
      case "retouch": {
        const events = typeof event.nativeEvent.getCoalescedEvents === "function" ? event.nativeEvent.getCoalescedEvents() : [];
        for (const sample of events.length ? events : [event.nativeEvent]) {
          const [px, py] = docPoint(sample.clientX, sample.clientY);
          act.retouch.add(px, py);
        }
        live.current = { id: act.id, canvas: keepInSelection(act.base, act.retouch.working, latest.current.selection?.mask ?? null, act.layer) };
        requestDraw();
        return;
      }
      case "distort": {
        const layer0 = act.layer0;
        const from = layer0.distort?.from ?? localBox({ ...layer0, distort: null }, s.pixels);
        if (!from) return;
        const to: [number, number][] = layer0.distort ? layer0.distort.to.map((point) => [...point] as [number, number]) : [[from.x0, from.y0], [from.x1, from.y0], [from.x1, from.y1], [from.x0, from.y1]];
        to[act.index] = toLocal(layer0, x, y);
        patch(act.id, { distort: { from, to } } as Partial<Layer>, act.merge);
        return;
      }
      case "paint": {
        const layer = act.layer;
        const events = typeof event.nativeEvent.getCoalescedEvents === "function" ? event.nativeEvent.getCoalescedEvents() : [];
        const samples = events.length ? events : [event.nativeEvent];
        for (const sample of samples) {
          const [px, py] = docPoint(sample.clientX, sample.clientY);
          const k = 1 - act.smoothing * 0.9;
          act.smooth = [act.smooth[0] + (px - act.smooth[0]) * k, act.smooth[1] + (py - act.smooth[1]) * k];
          act.stroke.add(act.smooth[0], act.smooth[1], sample.pressure);
        }
        live.current = { id: act.id, canvas: applyStroke(act.base, act.stroke.buffer, act.opacity, act.erase, latest.current.selection?.mask ?? null, layer, act.working) };
        requestDraw();
        return;
      }
      case "move": {
        let dx = x - act.start[0];
        let dy = y - act.start[1];
        if (event.shiftKey) {
          if (Math.abs(dx) > Math.abs(dy)) dy = 0;
          else dx = 0;
        }
        if (act.key) {
          // with a keyframe picked, moving changes where the layer is at that moment
          patchKey(act.layer0, act.key, { dx: Math.round(act.key.dx + dx), dy: Math.round(act.key.dy + dy) }, act.merge);
          return;
        }
        let next = { ...act.t0, x: act.t0.x + dx, y: act.t0.y + dy };
        if (latest.current.snapOn && !(event.ctrlKey || event.metaKey)) {
          const box = docBox({ ...act.layer0, transform: next }, s.pixels);
          if (box) {
            const hit = snap(cornersBounds(box.corners), act.targets, 7 / latest.current.view.zoom);
            next = { ...next, x: next.x + (event.shiftKey && dx === 0 ? 0 : hit.dx), y: next.y + (event.shiftKey && dy === 0 ? 0 : hit.dy) };
            setSnapLines(hit.x !== null || hit.y !== null ? { x: hit.x, y: hit.y } : null);
          }
        }
        const ddx = Math.round(next.x * 100) / 100 - act.t0.x;
        const ddy = Math.round(next.y * 100) / 100 - act.t0.y;
        setTransform(act.layer0, (tf) => ({ ...tf, x: tf.x + ddx, y: tf.y + ddy }), act.merge);
        return;
      }
      case "rotate": {
        const angle = (Math.atan2(y - act.centre[1], x - act.centre[0]) * 180) / Math.PI;
        let delta = angle - act.a0;
        if (event.shiftKey) {
          const target = Math.round((act.t0.rotation + delta) / 15) * 15;
          delta = target - act.t0.rotation;
        }
        if (act.key) patchKey(act.layer0, act.key, { rotation: Math.round((act.key.rotation + delta) * 10) / 10 }, act.merge);
        else setTransform(act.layer0, (tf) => rotateAbout(tf, act.centre[0], act.centre[1], delta), act.merge);
        return;
      }
      case "scale": {
        const box = docBox(act.key ? posed(act.layer0) : act.layer0, s.pixels);
        if (!box) return;
        const { x0, y0, x1, y1 } = box.local;
        const anchorOf: Record<Handle, [number, number]> = { nw: [x1, y1], n: [(x0 + x1) / 2, y1], ne: [x0, y1], e: [x0, (y0 + y1) / 2], se: [x0, y0], s: [(x0 + x1) / 2, y0], sw: [x1, y0], w: [x1, (y0 + y1) / 2] };
        const handleOf: Record<Handle, [number, number]> = { nw: [x0, y0], n: [(x0 + x1) / 2, y0], ne: [x1, y0], e: [x1, (y0 + y1) / 2], se: [x1, y1], s: [(x0 + x1) / 2, y1], sw: [x0, y1], w: [x0, (y0 + y1) / 2] };
        const anchor = event.altKey ? [(x0 + x1) / 2, (y0 + y1) / 2] : anchorOf[act.handle];
        const handle = handleOf[act.handle];
        const [lx, ly] = toLocal(act.key ? posed(act.layer0) : act.layer0, x, y);
        const spanX = handle[0] - anchor[0];
        const spanY = handle[1] - anchor[1];
        let fx = spanX ? (lx - anchor[0]) / spanX : 1;
        let fy = spanY ? (ly - anchor[1]) / spanY : 1;
        const corner = act.handle.length === 2;
        if (corner && !event.shiftKey) {
          // corners keep the proportions unless Shift is held
          const along = (spanX * (lx - anchor[0]) + spanY * (ly - anchor[1])) / (spanX * spanX + spanY * spanY || 1);
          fx = fy = along;
        }
        if (!spanX) fx = 1;
        if (!spanY) fy = 1;
        const clampScale = (f: number, s0: number) => (Math.abs(s0 * f) < 0.02 ? (0.02 / Math.abs(s0)) * Math.sign(f || 1) : f);
        fx = clampScale(fx, act.t0.scaleX);
        fy = clampScale(fy, act.t0.scaleY);
        if (act.key) {
          const f = corner ? fx : spanX ? fx : fy;
          patchKey(act.layer0, act.key, { scale: Math.max(0.02, Math.round(act.key.scale * f * 1000) / 1000) }, act.merge);
        } else if (act.layer0.kind === "group") {
          // a group scales evenly, every layer inside about the same point
          const f = corner ? fx : spanX ? fx : fy;
          const pivot = toDoc(act.layer0, anchor[0], anchor[1]);
          setTransform(act.layer0, (tf, child) => {
            const [qx, qy] = toLocal(child, pivot[0], pivot[1]);
            return scaleAbout(tf, qx, qy, f, f);
          }, act.merge);
        } else patch(act.id, { transform: scaleAbout(act.t0, anchor[0], anchor[1], fx, fy) }, act.merge);
        return;
      }
      case "shape": {
        setDraftShape(shapeFromDrag(act.start, [x, y], event.shiftKey, event.altKey));
        return;
      }
      case "marquee": {
        act.current = [x, y];
        const box = dragBox(act.start, act.current, event.shiftKey && act.mode === "replace", event.altKey && act.mode === "replace");
        const kind = latest.current.settings.marquee;
        setMarquee({ kind, d: kind === "rect" ? `M${box.x} ${box.y}h${box.w}v${box.h}h${-box.w}Z` : ellipsePath(box) });
        return;
      }
      case "lasso": {
        const last = act.points[act.points.length - 1];
        if (Math.hypot(x - last[0], y - last[1]) < 1.5) return;
        act.points.push([x, y]);
        setMarquee({ kind: "lasso", d: `M${act.points.map((point) => point.join(" ")).join("L")}` });
        return;
      }
    }
  };

  const shapeFromDrag = (start: [number, number], end: [number, number], even: boolean, centred: boolean): ShapeLayer => {
    const { settings: st, primary: colour } = latest.current;
    const kind = st.shape.kind;
    const layer = newShapeLayer(t`Shape`, kind, colour, { style: kind === "line" || kind === "arc" ? "outline" : st.shape.style, lineWidth: st.shape.lineWidth, sides: kind === "star" ? 5 : 6 });
    if (kind === "line") {
      let [ex, ey] = end;
      if (even) {
        // Shift snaps the line to 45° steps
        const angle = Math.round(Math.atan2(ey - start[1], ex - start[0]) / (Math.PI / 4)) * (Math.PI / 4);
        const length = Math.hypot(ex - start[0], ey - start[1]);
        ex = start[0] + Math.cos(angle) * length;
        ey = start[1] + Math.sin(angle) * length;
      }
      layer.width = Math.max(1, Math.hypot(ex - start[0], ey - start[1]));
      layer.height = 0;
      layer.transform = { x: (start[0] + ex) / 2, y: (start[1] + ey) / 2, rotation: normaliseAngle((Math.atan2(ey - start[1], ex - start[0]) * 180) / Math.PI), scaleX: 1, scaleY: 1 };
      return layer;
    }
    const box = dragBox(start, end, even, centred);
    layer.width = Math.max(1, box.w);
    layer.height = Math.max(1, box.h);
    layer.transform = { x: box.x + box.w / 2, y: box.y + box.h / 2, rotation: 0, scaleX: 1, scaleY: 1 };
    if (kind === "rect") layer.radius = 0;
    return layer;
  };

  const onPointerUp = (event: React.PointerEvent<HTMLElement>) => {
    pointers.current.delete(event.pointerId);
    if (pinch.current) {
      if (pointers.current.size < 2) pinch.current = null;
      return;
    }
    const act = action.current;
    action.current = null;
    if (!act) return;
    const s = latest.current.state;
    if (!s) return;
    const [x, y] = docPoint(event.clientX, event.clientY);
    setSnapLines(null);
    switch (act.kind) {
      case "gradient": {
        const canvas = live.current?.canvas;
        live.current = null;
        setGradientLine(null);
        if (canvas) commit({ ...s, pixels: { ...s.pixels, [act.id]: canvas } });
        requestDraw();
        return;
      }
      case "retouch": {
        const canvas = live.current?.canvas;
        live.current = null;
        if (canvas) commit({ ...s, pixels: { ...s.pixels, [act.id]: canvas } });
        requestDraw();
        return;
      }
      case "lift": {
        const canvas = live.current?.canvas;
        live.current = null;
        const offset = act.offset;
        setLiftOffset(null);
        if (canvas && (offset[0] || offset[1])) {
          commit({ ...s, pixels: { ...s.pixels, [act.id]: canvas } });
          setSelection(selectionFromMask(shiftedMask(act.mask, offset[0], offset[1])));
        }
        requestDraw();
        return;
      }
      case "paint": {
        const canvas = live.current?.canvas;
        live.current = null;
        lastPaint.current = act.smooth;
        if (canvas) commit({ ...s, pixels: { ...s.pixels, [act.id]: canvas } });
        requestDraw();
        return;
      }
      case "shape": {
        const moved = Math.hypot(x - act.start[0], y - act.start[1]) > 4;
        const layer = moved ? shapeFromDrag(act.start, [x, y], event.shiftKey, event.altKey) : shapeFromDrag([x - 60, y - 60], [x + 60, y + 60], true, false);
        setDraftShape(null);
        const next = insertLayer(s, latest.current.board, layer, latest.current.selected);
        if (next !== s) {
          commit(next);
          setSelected(layer.id);
        }
        return;
      }
      case "marquee": {
        setMarquee(null);
        const moved = Math.hypot(x - act.start[0], y - act.start[1]) > 2;
        if (!moved) {
          if (act.mode === "replace") setSelection(null);
          return;
        }
        const box = dragBox(act.start, [x, y], event.shiftKey && act.mode === "replace", event.altKey && act.mode === "replace");
        const kind = latest.current.settings.marquee;
        setSelection(combineSelection(latest.current.selection, act.mode, (ctx) => {
          ctx.beginPath();
          if (kind === "rect") ctx.rect(box.x, box.y, box.w, box.h);
          else ctx.ellipse(box.x + box.w / 2, box.y + box.h / 2, box.w / 2, box.h / 2, 0, 0, Math.PI * 2);
          ctx.fill();
        }));
        return;
      }
      case "lasso": {
        setMarquee(null);
        if (act.points.length < 3) {
          if (act.mode === "replace") setSelection(null);
          return;
        }
        setSelection(combineSelection(latest.current.selection, act.mode, (ctx) => {
          ctx.beginPath();
          act.points.forEach(([px, py], index) => (index ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
          ctx.closePath();
          ctx.fill();
        }));
        return;
      }
      default:
        return;
    }
  };

  const startHandle = (event: React.PointerEvent, handle: Handle | "rotate") => {
    event.stopPropagation();
    const { state: s, board: b, selected: sel } = latest.current;
    const layer = s ? findLayer(s.doc, b, sel) : null;
    if (!s || !layer || layer.locked) return;
    try {
      (stageRef.current as HTMLElement).setPointerCapture(event.pointerId);
    } catch {
      // nothing to capture
    }
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const merge = `${handle}:${layer.id}:${Date.now()}`;
    if (latest.current.settings.move.mode === "distort" && handle !== "rotate" && handle.length === 2) {
      action.current = { kind: "distort", id: layer.id, index: ["nw", "ne", "se", "sw"].indexOf(handle), layer0: layer, merge };
      return;
    }
    const key = editingKey(layer);
    if (handle === "rotate") {
      const box = docBox(posed(layer), s.pixels);
      const centre = box?.centre ?? [layer.transform.x, layer.transform.y] as [number, number];
      const [x, y] = docPoint(event.clientX, event.clientY);
      action.current = { kind: "rotate", id: layer.id, centre, a0: (Math.atan2(y - centre[1], x - centre[0]) * 180) / Math.PI, t0: layer.transform, merge, layer0: layer, key };
    } else {
      action.current = { kind: "scale", id: layer.id, handle, t0: layer.transform, layer0: layer, merge, key };
    }
  };

  /* --- Keys, paste and drop ------------------------------------------------------------------ */
  useEffect(() => {
    const typing = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
    const onKeyDown = (event: KeyboardEvent) => {
      if (typing(event.target) || submitOpen || starting || shortcutsOpen) return;
      if (event.key === "?") {
        setShortcutsOpen(true);
        event.preventDefault();
        return;
      }
      const { state: s, board: b, selected: sel, selection: selMask, settings: st, tool: tl } = latest.current;
      const mod = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      const layer = s ? findLayer(s.doc, b, sel) : null;
      const handled = () => event.preventDefault();
      if (event.key === " " && !event.repeat) {
        setSpaceHeld(true);
        handled();
        return;
      }
      if (mod && key === "z") {
        if (event.shiftKey) history.redo();
        else history.undo();
        return handled();
      }
      if (mod && key === "y") {
        history.redo();
        return handled();
      }
      if (mod && key === "s") {
        handled();
        if (s && currentDraft.current) {
          setSaved("saving");
          void saveDraft(currentDraft.current, s, renderBoard(s.doc.boards.square, { pixels: s.pixels, assets: s.assets, size: 192 })).then(() => setSaved("saved"));
        }
        return;
      }
      if (mod && key === "a") {
        setSelection(selectAll());
        return handled();
      }
      if (mod && key === "d") {
        setSelection(null);
        return handled();
      }
      if (mod && event.shiftKey && key === "i") {
        setSelection(invertSelection(selMask));
        return handled();
      }
      if (mod && event.shiftKey && key === "n") {
        addPaintLayer();
        return handled();
      }
      if (mod && key === "j" && layer && s) {
        if (selMask) {
          const canvas = copySelection(s, b, layer.id, selMask);
          if (canvas) {
            const result = paintLayerFrom(s, b, canvas, t`${layer.name} part`, layer.id);
            commit(result.state);
            setSelected(result.id);
          }
        } else layerAction(layer.id, "duplicate");
        return handled();
      }
      if (mod && key === "e" && layer) {
        layerAction(layer.id, "merge");
        return handled();
      }
      if (mod && event.altKey && key === "g" && layer) {
        layerAction(layer.id, "clip");
        return handled();
      }
      if (mod && key === "g" && layer) {
        layerAction(layer.id, event.shiftKey ? "ungroup" : "group");
        return handled();
      }
      if (mod && (key === "c" || key === "x") && layer && s) {
        clipboard.current = copySelection(s, b, layer.id, selMask);
        if (key === "x" && layer.kind === "paint") commit(editSelection(s, b, layer.id, selMask, null));
        return handled();
      }
      if (mod && (event.key === "]" || event.key === "[") && layer) {
        layerAction(layer.id, event.key === "]" ? "up" : "down");
        return handled();
      }
      if (mod && (key === "0" || key === "1" || key === "=" || key === "+" || key === "-")) {
        const stage = stageRef.current;
        if (key === "0") fitView();
        else if (stage) {
          const sx = stage.clientWidth / 2;
          const sy = stage.clientHeight / 2;
          if (key === "1") zoomAt(1 / latest.current.view.zoom, sx, sy);
          else zoomAt(key === "-" ? 1 / 1.25 : 1.25, sx, sy);
        }
        return handled();
      }
      if ((event.key === "Delete" || event.key === "Backspace") && layer && s && !(tl === "pen" && layer.kind === "path" && latest.current.penAnchor !== null)) {
        if (event.altKey || mod) {
          // Alt fills with the colour, Ctrl with the second colour, as in other editors
          if (layer.kind === "paint") commit(editSelection(s, b, layer.id, selMask, event.altKey ? latest.current.primary : latest.current.secondary));
        } else if (selMask && layer.kind === "paint") commit(editSelection(s, b, layer.id, selMask, null));
        else layerAction(layer.id, "delete");
        return handled();
      }
      if (tl === "pen" && (event.key === "Enter" || event.key === "Escape") && latest.current.penDrawing) {
        setPenDrawing(null);
        return handled();
      }
      if (tl === "pen" && (event.key === "Delete" || event.key === "Backspace") && layer?.kind === "path" && latest.current.penAnchor !== null && s) {
        const points = layer.points.filter((_, index) => index !== latest.current.penAnchor);
        if (points.length) patch(layer.id, { points, closed: layer.closed && points.length > 2 } as Partial<Layer>);
        else layerAction(layer.id, "delete");
        setPenAnchor(null);
        return handled();
      }
      if (event.key === "Escape") {
        if (selMask) setSelection(null);
        else setSelected(null);
        return;
      }
      if (event.key.startsWith("Arrow") && layer && !layer.locked && (tl === "move" || !mod)) {
        const step = event.shiftKey ? 10 : 1;
        const dx = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
        const dy = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
        patch(layer.id, { transform: { ...layer.transform, x: layer.transform.x + dx, y: layer.transform.y + dy } }, `nudge:${layer.id}`);
        return handled();
      }
      if (mod || event.altKey) return;
      if (event.key === "[" || event.key === "]") {
        const brushKey = tl === "eraser" ? "eraser" : "brush";
        const brush = st[brushKey];
        if (event.shiftKey) setSettings({ ...st, [brushKey]: { ...brush, hardness: Math.max(0, Math.min(1, brush.hardness + (event.key === "]" ? 0.1 : -0.1))) } });
        else setSettings({ ...st, [brushKey]: { ...brush, size: Math.max(1, Math.min(300, Math.round(brush.size * (event.key === "]" ? 1.15 : 1 / 1.15)))) } });
        return handled();
      }
      if (key === "x") {
        setPrimary(latest.current.secondary);
        setSecondary(latest.current.primary);
        return handled();
      }
      if (key === "d") {
        setPrimary("#ffffff");
        setSecondary("#000000");
        return handled();
      }
      if (key === "m" && tl === "marquee") {
        setSettings({ ...st, marquee: st.marquee === "rect" ? "ellipse" : "rect" });
        return handled();
      }
      if (key === "g" && (tl === "fill" || tl === "gradient")) {
        setTool(tl === "fill" ? "gradient" : "fill");
        return handled();
      }
      const next = TOOL_KEYS[key];
      if (next) {
        setTool(next);
        handled();
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === " ") setSpaceHeld(false);
    };
    const onPaste = (event: ClipboardEvent) => {
      if (typing(event.target) || starting) return;
      const file = [...(event.clipboardData?.files ?? [])].find((entry) => entry.type.startsWith("image/"));
      if (file) {
        event.preventDefault();
        void addPicture(file);
        return;
      }
      const { state: s, board: b, selected: sel } = latest.current;
      if (clipboard.current && s) {
        event.preventDefault();
        const result = paintLayerFrom(s, b, cloneCanvas(clipboard.current), t`Pasted`, sel);
        commit(result.state);
        setSelected(result.id);
        setTool("move");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("paste", onPaste);
    };
  }); // re-bound each render so it sees the newest handlers

  // a wheel zooms with Ctrl (and trackpad pinches), and scrolls the view otherwise
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = stage.getBoundingClientRect();
      if (event.ctrlKey || event.metaKey) zoomAt(Math.exp(-event.deltaY * 0.01), event.clientX - rect.left, event.clientY - rect.top);
      else setView((v) => ({ ...v, x: v.x - event.deltaX, y: v.y - event.deltaY }));
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [starting, loading]);

  /* --- Exports and submitting ---------------------------------------------------------------- */
  const exportPng = async () => {
    if (!state) return;
    const input = { pixels: state.pixels, assets: state.assets, size: WORKSHOP_SIZE, time: 0 };
    download(await canvasToBlob(renderBoard(state.doc.boards.square, input)), `${fileName(state.doc.name)}.png`);
    if (state.doc.boards.round.some((layer) => layer.visible)) download(await canvasToBlob(renderBoard(state.doc.boards.round, input)), `${fileName(state.doc.name)}-round.png`);
  };
  const exportLoop = async () => {
    if (!state) return;
    flash(t`Recording the loop...`);
    const blob = await recordLoop(state.doc.boards.square, { pixels: state.pixels, assets: state.assets });
    download(blob, `${fileName(state.doc.name)}.webm`);
  };

  const animated = state ? isAnimated(state.doc.boards.square) : false;
  const loopable = useMemo(() => canRecordLoop(), []);
  const issues: string[] = [];
  if (exports.clear.square === null) issues.push(t`The square frame is empty.`);
  else if (exports.clear.square < 0.6) issues.push(t`The square frame covers too much of the avatar; keep the middle see-through.`);
  if (exports.clear.round !== null && exports.clear.round < 0.6) issues.push(t`The round frame covers too much of the avatar; keep the middle see-through.`);

  const doSubmit = async () => {
    if (!state) return;
    setSubmit({ phase: "uploading", progress: 0, error: null });
    try {
      const input = { pixels: state.pixels, assets: state.assets, size: WORKSHOP_SIZE, time: 0 };
      let video: Blob | null = null;
      if (animated && includeLoop && loopable) {
        setSubmit({ phase: "recording", progress: 0, error: null });
        video = await recordLoop(state.doc.boards.square, { pixels: state.pixels, assets: state.assets }, (progress) => setSubmit((value) => ({ ...value, progress })));
        if (video.size > 2 * 1024 * 1024) throw new Error(t`The loop came out over 2 MB. Make it simpler and try again, or turn the loop off.`);
        setSubmit({ phase: "uploading", progress: 0, error: null });
      }
      const stillBlob = await canvasToBlob(renderBoard(state.doc.boards.square, input));
      const hasRound = exports.clear.round !== null;
      const steps = 1 + (video ? 1 : 0) + (hasRound ? 1 : 0) + 1;
      let done = 0;
      const step = () => setSubmit((value) => ({ ...value, progress: ++done / steps }));
      const still = await uploadFramePart("still", stillBlob);
      step();
      const videoUrl = video ? (await uploadFramePart("video", video)).url : null;
      if (video) step();
      const roundUrl = hasRound ? (await uploadFramePart("round", await canvasToBlob(renderBoard(state.doc.boards.round, input)))).url : null;
      if (hasRound) step();
      const parts = { name: state.doc.name, still: still.url, video: videoUrl, round: roundUrl, overhang: still.overhang ?? exports.overhang };
      const { frame } = state.doc.submitted && updating
        ? await updateWorkshopFrame({ data: { id: state.doc.submitted, ...parts } })
        : await submitWorkshopFrame({ data: parts });
      registerSubmittedFrames([frame]);
      // the draft remembers the frame, so the next Submit can update it
      if (state.doc.submitted !== frame.id) commit((s) => (s ? { ...s, doc: { ...s.doc, submitted: frame.id } } : s));
      step();
      setSubmitted({ id: frame.id, worn: false });
      setSubmit({ phase: "done", progress: 1, error: null });
    } catch (cause) {
      setSubmit({ phase: "idle", progress: 0, error: cause instanceof Error ? cause.message : String(cause) });
    }
  };

  const wear = async () => {
    if (!submitted) return;
    try {
      await saveSupporterFrameSetting({ data: { frame: submitted.id } });
      if (viewer) {
        forgetLiveSupporterLook(viewer.id);
        setSupporterFrameLocally(viewer.id, submitted.id);
      }
      setSubmitted({ ...submitted, worn: true });
    } catch (cause) {
      setSubmit((value) => ({ ...value, error: cause instanceof Error ? cause.message : String(cause) }));
    }
  };

  /* --- Layout ---------------------------------------------------------------------------------- */
  if (!viewer) {
    return (
      <div className="grid min-h-[70vh] place-items-center bg-osu-b5 px-4 text-center text-[13px] text-osu-l2">
        <p>
          <a href={`/api/auth/osu?next=${encodeURIComponent("/workshop/frames/editor")}`} className="font-semibold text-osu-pink-light hover:underline">{t`Sign in`}</a>{" "}
          {t`to make your own avatar frames.`}
        </p>
      </div>
    );
  }

  const box = current && current.visible ? docBox(playing ? current : posed(current), live.current && live.current.id === current.id ? { ...state!.pixels, [current.id]: live.current.canvas } : state!.pixels) : null;
  const handleSize = 9 / view.zoom;
  const stageCursor = spaceHeld || tool === "hand" ? (action.current?.kind === "pan" ? "grabbing" : "grab") : tool === "brush" || tool === "eraser" ? "none" : tool === "zoom" ? "zoom-in" : tool === "text" ? "text" : tool === "move" ? "default" : "crosshair";
  const avatarRadius = board === "round" ? "50%" : `${(AVATAR_RADIUS / AVATAR_SIZE) * 100}%`;
  const backdropStyle = backdrop === "checker"
    ? { backgroundColor: "#2a2530", backgroundImage: "conic-gradient(#ffffff12 25%, transparent 0 50%, #ffffff12 0 75%, transparent 0)", backgroundSize: "32px 32px" }
    : { backgroundColor: backdrop === "dark" ? "var(--color-osu-b5)" : "#d9dce6" };

  const inspector = (
    <LayerInspector
      layer={current}
      board={board}
      onPatch={(changes, merge) => current && patch(current.id, changes, merge)}
      onAction={(kind) => current && layerAction(current.id, kind)}
      maskTarget={maskTarget}
      onMaskTarget={setMaskTarget}
      keyframes={{
        scrub,
        activeKey,
        onPick: (key) => {
          setPlaying(false);
          setActiveKey(key?.id ?? null);
          if (key) setScrub(key.t);
        },
        onAdd: () => current && addKey(current),
      }}
      focusText={focusText}
      onFocusedText={() => setFocusText(false)}
    />
  );
  const layersPanel = state ? (
    <LayersPanel
      state={state}
      layers={layers}
      selected={selected}
      onSelect={setSelected}
      onPatch={patch}
      onReorder={(parent, ids) => commit(reorder(state, board, parent, ids), "reorder")}
      onAction={layerAction}
      onAddPaint={addPaintLayer}
      onAddShape={addShapeAround}
      onAddText={() => addText(DOC_CENTRE, AVATAR_INSET / 2)}
      onAddPicture={(file) => void addPicture(file)}
      renaming={renaming}
      onRenaming={setRenaming}
      maskTarget={maskTarget}
      onMaskTarget={(id, value) => {
        setSelected(id);
        setMaskTarget(value);
      }}
    />
  ) : null;
  const historyPanel = <HistoryPanel steps={history.steps} position={history.position} onJump={history.jump} />;
  const preview = <FramePreview still={exports.still} round={exports.round} video={null} overhang={exports.overhang} avatar={avatar} clear={exports.clear} motion={state && animated ? { layers: state.doc.boards.square, pixels: state.pixels, assets: state.assets } : null} />;

  return (
    // fixed under the site nav, so nothing can scroll the page out from under it
    <div className="fixed inset-x-0 bottom-0 top-[60px] z-10 flex flex-col bg-[color-mix(in_srgb,var(--color-osu-b6)_70%,black)] text-osu-l2">
      {/* Top bar */}
      <header className="flex h-[52px] shrink-0 items-center gap-1 border-b border-white/[0.07] bg-osu-b6 px-2 md:gap-1.5 md:px-3">
        <Link to="/workshop/frames" aria-label={t`Avatar frames`} className="flex h-8 shrink-0 items-center gap-1 rounded-md px-1 text-[12px] font-semibold text-osu-f1 transition-colors hover:bg-white/[0.06] hover:text-white md:px-2">
          <ChevronLeft size={16} />
          <span className="hidden md:inline">{t`Frames`}</span>
        </Link>
        {narrow ? null : <ToolDivider />}
        <input
          value={state?.doc.name ?? ""}
          onChange={(event) => commit((s) => (s ? { ...s, doc: { ...s.doc, name: event.target.value.slice(0, 32) } } : s), "name")}
          placeholder={t`Untitled frame`}
          aria-label={t`Name`}
          className="h-9 min-w-0 flex-1 rounded-lg bg-transparent px-2 text-[14px] font-semibold text-white placeholder:text-osu-f1 hover:bg-white/[0.04] focus:bg-black/30 focus:outline-none md:w-52 md:flex-none md:px-2.5"
        />
        <span className="ml-1 hidden text-[11.5px] text-osu-f1 lg:inline" title={account.message ?? undefined}>
          {saved === "saving" ? t`Saving...` : saved === "unsaved" ? t`Unsaved changes` : account.state === "saved" ? t`Saved to your account` : account.state === "error" ? t`Saved in this browser only` : t`Saved in this browser`}
        </span>

        <div className="flex shrink-0 items-center gap-0.5 md:mx-auto">
          <div className="mr-1 flex gap-0.5 rounded-lg bg-black/30 p-[3px] ring-1 ring-white/[0.07]">
            {(["square", "round"] as const).map((id) => (
              <button
                key={id}
                type="button"
                aria-pressed={board === id}
                onClick={() => {
                  setBoardId(id);
                  setSelected(state?.doc.boards[id].at(-1)?.id ?? null);
                  setSelection(null);
                }}
                aria-label={id === "square" ? t`Square` : t`Round`}
                title={id === "square" ? t`Square` : t`Round`}
                className={`grid h-7 cursor-pointer place-items-center rounded-md px-2.5 text-[12px] font-semibold transition-colors ${board === id ? "bg-white/[0.12] text-white" : "text-osu-f1 hover:text-white"}`}
              >
                {narrow ? <span className={`block h-3.5 w-3.5 border-[1.5px] border-current ${id === "square" ? "rounded-[3px]" : "rounded-full"}`} /> : id === "square" ? t`Square` : t`Round`}
              </button>
            ))}
          </div>
          <ToolButton label={t`Undo`} shortcut="Ctrl Z" onClick={history.undo} disabled={!history.canUndo}><Undo2 size={16} /></ToolButton>
          {narrow ? null : <ToolButton label={t`Redo`} shortcut="Ctrl Shift Z" onClick={history.redo} disabled={!history.canRedo}><Redo2 size={16} /></ToolButton>}
          {narrow && !animated && !playing ? null : <ToolButton label={playing ? t`Stop the loop` : t`Play the loop`} onClick={() => setPlaying((value) => !value)} active={playing} disabled={!animated && !playing}>{playing ? <Pause size={16} /> : <Play size={16} />}</ToolButton>}
          {narrow ? null : <Popover
            open={viewOpen}
            onOpenChange={setViewOpen}
            className="w-56"
            align="right"
            trigger={<ToolButton label={t`View`} onClick={() => setViewOpen((value) => !value)} active={viewOpen}><Eye size={16} /></ToolButton>}
          >
            <div className="grid gap-1 p-1 text-[12px]">
              <ViewToggle label={t`Your avatar under it`} checked={showAvatar} onChange={setShowAvatar} />
              <ViewToggle label={t`Template guides`} checked={guides} onChange={setGuides} />
              <ViewToggle label={t`Snap while moving`} checked={snapOn} onChange={setSnapOn} />
              <span className="mt-1 text-[11px] font-bold uppercase tracking-[0.08em] text-osu-f1">{t`Backdrop`}</span>
              <div className="grid grid-cols-3 gap-1">
                {(["dark", "light", "checker"] as const).map((id) => (
                  <button key={id} type="button" onClick={() => setBackdrop(id)} className={`h-7 cursor-pointer rounded-md text-[11.5px] font-semibold ${backdrop === id ? "bg-white/[0.12] text-white" : "bg-black/30 text-osu-f1 hover:text-white"}`}>
                    {id === "dark" ? t`Dark` : id === "light" ? t`Light` : t`Clear`}
                  </button>
                ))}
              </div>
              <button type="button" onClick={() => { fitView(); setViewOpen(false); }} className="mt-1 h-7 cursor-pointer rounded-md bg-white/[0.06] text-[11.5px] font-semibold text-osu-l2 hover:text-white">{t`Fit to screen`} <span className="font-mono text-[10px] text-osu-f1">Ctrl 0</span></button>
            </div>
          </Popover>}
        </div>

        <Popover
          open={moreOpen}
          onOpenChange={setMoreOpen}
          className="w-56"
          align="right"
          trigger={<ToolButton label={t`More`} onClick={() => setMoreOpen((value) => !value)}><MoreHorizontal size={16} /></ToolButton>}
        >
          {narrow ? (
            <>
              <MenuItem icon={null} label={t`Redo`} disabled={!history.canRedo} onClick={() => { setMoreOpen(false); history.redo(); }} />
              <MenuItem icon={null} label={showAvatar ? t`Hide your avatar` : t`Show your avatar`} onClick={() => { setMoreOpen(false); setShowAvatar((value) => !value); }} />
              <MenuItem icon={null} label={guides ? t`Hide the guides` : t`Show the guides`} onClick={() => { setMoreOpen(false); setGuides((value) => !value); }} />
              <MenuItem icon={null} label={t`Fit to screen`} onClick={() => { setMoreOpen(false); fitView(); }} />
              <div className="my-1 h-px bg-white/[0.06]" />
            </>
          ) : null}
          <MenuItem icon={null} label={t`New frame...`} onClick={() => { setMoreOpen(false); setStarting(true); }} />
          <MenuItem icon={null} label={t`Keyboard shortcuts`} shortcut="?" onClick={() => { setMoreOpen(false); setShortcutsOpen(true); }} />
          <MenuItem icon={null} label={t`Download PNG`} onClick={() => { setMoreOpen(false); void exportPng(); }} />
          {animated && loopable ? <MenuItem icon={null} label={t`Download the loop (WebM)`} onClick={() => { setMoreOpen(false); void exportLoop(); }} /> : null}
          <MenuItem icon={null} label={t`Open a picture as a layer...`} onClick={() => {
            setMoreOpen(false);
            const input = document.createElement("input");
            input.type = "file";
            input.accept = "image/*";
            input.onchange = () => input.files?.[0] && void addPicture(input.files[0]);
            input.click();
          }} />
          {board === "round" ? <MenuItem icon={null} label={t`Copy the square frame here`} onClick={() => { setMoreOpen(false); copyBoard(); }} /> : null}
          <div className="my-1 h-px bg-white/[0.06]" />
          <MenuItem icon={null} label={t`Select all`} shortcut="Ctrl A" onClick={() => { setMoreOpen(false); setSelection(selectAll()); }} />
          <MenuItem icon={null} label={t`Drop the selection`} shortcut="Ctrl D" disabled={!selection} onClick={() => { setMoreOpen(false); setSelection(null); }} />
          <MenuItem icon={null} label={t`Invert the selection`} shortcut="Ctrl Shift I" onClick={() => { setMoreOpen(false); setSelection(invertSelection(selection)); }} />
        </Popover>
        <button
          type="button"
          onClick={() => {
            setSubmit({ phase: "idle", progress: 0, error: null });
            setSubmitOpen(true);
          }}
          disabled={!state}
          className="ml-0.5 inline-flex h-9 shrink-0 cursor-pointer items-center rounded-lg bg-osu-pink px-3 text-[13px] font-semibold text-white transition hover:brightness-110 disabled:cursor-default disabled:opacity-60 md:ml-1.5 md:px-5"
        >
          {t`Submit`}
        </button>
      </header>

      <ToolOptions tool={tool} settings={settings} onChange={setSettings} onFitView={fitView} />

      <div className={`flex min-h-0 flex-1 ${narrow ? "flex-col" : ""}`}>
        {narrow ? null : (
          <>
            <nav className={`flex shrink-0 flex-col items-center overflow-y-auto border-r border-white/[0.07] bg-osu-b6 ${short ? "w-[84px]" : "w-[52px]"}`}>
              <ToolRail columns={short ? 2 : 1} tool={tool} onTool={setTool} settings={settings} primary={primary} secondary={secondary} onPrimary={setPrimary} onSecondary={setSecondary} onSwap={() => { setPrimary(secondary); setSecondary(primary); }} />
            </nav>
            <aside className="flex shrink-0 flex-col overflow-y-auto overscroll-contain border-r border-white/[0.07] bg-[color-mix(in_srgb,var(--color-osu-b6)_88%,black)]" style={{ width: LEFT_WIDTH }}>
              {inspector}
            </aside>
          </>
        )}

        {/* The canvas */}
        <main
          ref={stageRef}
          className={`relative min-w-0 touch-none select-none overflow-hidden ${narrow ? "h-[46dvh] shrink-0" : "flex-1"}`}
          style={{ cursor: stageCursor, backgroundColor: "color-mix(in srgb, var(--color-osu-b6) 55%, black)", backgroundImage: "radial-gradient(rgba(255,255,255,0.05) 1px, transparent 1px)", backgroundSize: "18px 18px" }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onPointerLeave={(event) => handleCursor(event.clientX, event.clientY, false)}
          onContextMenu={(event) => event.preventDefault()}
          onDragOver={(event) => {
            if (!event.dataTransfer.types.includes("Files")) return;
            event.preventDefault();
            setDropping(true);
          }}
          onDragLeave={(event) => event.target === event.currentTarget && setDropping(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDropping(false);
            const file = [...event.dataTransfer.files].find((entry) => entry.type.startsWith("image/"));
            if (file) void addPicture(file);
          }}
        >
          <div className="pointer-events-none absolute left-0 top-0 origin-top-left" style={{ width: DOC_SIZE, height: DOC_SIZE, transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}>
            <div className="absolute inset-0 shadow-[0_0_0_1px_rgba(255,255,255,0.1),0_24px_80px_rgba(0,0,0,0.6)]" style={backdropStyle} />
            {showAvatar ? (
              <div className="absolute overflow-hidden bg-osu-b3" style={{ left: AVATAR_INSET, top: AVATAR_INSET, width: AVATAR_SIZE, height: AVATAR_SIZE, borderRadius: avatarRadius }}>
                {avatar ? <img src={avatar} alt="" className="h-full w-full object-cover" draggable={false} /> : null}
              </div>
            ) : null}
            <canvas ref={canvasRef} width={DOC_SIZE} height={DOC_SIZE} className="absolute inset-0 h-full w-full" style={{ imageRendering: view.zoom > 2 ? "pixelated" : "auto" }} />
            <svg className="absolute inset-0 h-full w-full overflow-visible" viewBox={`0 0 ${DOC_SIZE} ${DOC_SIZE}`}>
              {guides ? (
                <g fill="none" vectorEffect="non-scaling-stroke" opacity={0.55}>
                  {board === "round"
                    ? <circle cx={DOC_CENTRE} cy={DOC_CENTRE} r={AVATAR_SIZE / 2} stroke="#7fd4ff" strokeWidth={1.2 / view.zoom} strokeDasharray={`${4 / view.zoom} ${4 / view.zoom}`} />
                    : <rect x={AVATAR_INSET} y={AVATAR_INSET} width={AVATAR_SIZE} height={AVATAR_SIZE} rx={AVATAR_RADIUS} stroke="#ffffff" strokeWidth={1.2 / view.zoom} strokeDasharray={`${4 / view.zoom} ${4 / view.zoom}`} />}
                  <line x1={DOC_CENTRE} y1={0} x2={DOC_CENTRE} y2={DOC_SIZE} stroke="#ffffff" strokeOpacity={0.25} strokeWidth={1 / view.zoom} />
                  <line x1={0} y1={DOC_CENTRE} x2={DOC_SIZE} y2={DOC_CENTRE} stroke="#ffffff" strokeOpacity={0.25} strokeWidth={1 / view.zoom} />
                </g>
              ) : null}
              {(tool === "brush" || tool === "eraser") && settings.symmetry.mode !== "none" ? (
                <SymmetryGuides mode={settings.symmetry.mode} count={settings.symmetry.count} mirror={settings.symmetry.mirror} zoom={view.zoom} />
              ) : null}
              {selection ? (
                <g fill="none">
                  <path d={selection.d} stroke="#000" strokeWidth={1.2 / view.zoom} transform={liftOffset ? `translate(${liftOffset[0]} ${liftOffset[1]})` : undefined} />
                  <path d={selection.d} transform={liftOffset ? `translate(${liftOffset[0]} ${liftOffset[1]})` : undefined} stroke="#fff" strokeWidth={1.2 / view.zoom} strokeDasharray={`${4 / view.zoom} ${4 / view.zoom}`} className="frame-editor-ants" style={{ ["--ants" as string]: `${8 / view.zoom}px` }} />
                </g>
              ) : null}
              {marquee ? (
                <g fill={marquee.kind === "lasso" ? "rgba(255,102,171,0.08)" : "rgba(255,255,255,0.06)"}>
                  <path d={marquee.d} stroke="#000" strokeWidth={1.2 / view.zoom} />
                  <path d={marquee.d} stroke="#fff" strokeWidth={1.2 / view.zoom} strokeDasharray={`${4 / view.zoom} ${4 / view.zoom}`} fill="none" />
                </g>
              ) : null}
              {draftShape ? <DraftShape layer={draftShape} zoom={view.zoom} /> : null}
              {snapLines ? (
                <g stroke="#ff66ab" strokeWidth={1 / view.zoom}>
                  {snapLines.x !== null ? <line x1={snapLines.x} y1={-DOC_SIZE} x2={snapLines.x} y2={DOC_SIZE * 2} /> : null}
                  {snapLines.y !== null ? <line x1={-DOC_SIZE} y1={snapLines.y} x2={DOC_SIZE * 2} y2={snapLines.y} /> : null}
                </g>
              ) : null}
              {gradientLine ? (
                <g>
                  <line x1={gradientLine[0][0]} y1={gradientLine[0][1]} x2={gradientLine[1][0]} y2={gradientLine[1][1]} stroke="#000" strokeWidth={3 / view.zoom} />
                  <line x1={gradientLine[0][0]} y1={gradientLine[0][1]} x2={gradientLine[1][0]} y2={gradientLine[1][1]} stroke="#fff" strokeWidth={1.5 / view.zoom} />
                  <circle cx={gradientLine[0][0]} cy={gradientLine[0][1]} r={4 / view.zoom} fill={primary} stroke="#fff" strokeWidth={1.5 / view.zoom} />
                  <circle cx={gradientLine[1][0]} cy={gradientLine[1][1]} r={4 / view.zoom} fill={settings.gradient.fade ? "none" : secondary} stroke="#fff" strokeWidth={1.5 / view.zoom} />
                </g>
              ) : null}
              {tool === "pen" && current?.kind === "path" ? <PenOverlay layer={current} zoom={view.zoom} active={penAnchor} hover={penDrawing === current.id ? penHover : null} /> : null}
              {box && tool === "move" && !current?.locked ? (
                <g>
                  {(() => {
                    const corners = settings.move.mode === "distort" && current?.distort ? current.distort.to.map(([px, py]) => toDoc(current, px, py)) : box.corners;
                    return <polygon points={corners.map((point) => point.join(",")).join(" ")} fill="none" stroke="#ff66ab" strokeWidth={1.5 / view.zoom} />;
                  })()}
                  {(() => {
                    const [a, b, c, d] = settings.move.mode === "distort" && current?.distort ? current.distort.to.map(([px, py]) => toDoc(current, px, py)) : box.corners;
                    const mid = (p: [number, number], q: [number, number]): [number, number] => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
                    const points: [Handle, [number, number]][] = [["nw", a], ["n", mid(a, b)], ["ne", b], ["e", mid(b, c)], ["se", c], ["s", mid(c, d)], ["sw", d], ["w", mid(d, a)]];
                    const top = mid(a, b);
                    const centre = box.centre;
                    const away = Math.hypot(top[0] - centre[0], top[1] - centre[1]) || 1;
                    const reach = 26 / view.zoom;
                    const knob: [number, number] = [top[0] + ((top[0] - centre[0]) / away) * reach, top[1] + ((top[1] - centre[1]) / away) * reach];
                    return (
                      <>
                        {settings.move.mode === "distort" ? null : <line x1={top[0]} y1={top[1]} x2={knob[0]} y2={knob[1]} stroke="#ff66ab" strokeWidth={1.5 / view.zoom} />}
                        {settings.move.mode === "distort" ? null : <circle cx={knob[0]} cy={knob[1]} r={handleSize * 0.7} fill="#fff" stroke="#ff66ab" strokeWidth={1.5 / view.zoom} className="pointer-events-auto" style={{ cursor: "grab" }} onPointerDown={(event) => startHandle(event, "rotate")} />}
                        {points.filter(([name]) => settings.move.mode !== "distort" || name.length === 2).map(([name, [px, py]]) => (
                          <rect
                            key={name}
                            x={px - handleSize / 2}
                            y={py - handleSize / 2}
                            width={handleSize}
                            height={handleSize}
                            fill="#fff"
                            stroke="#ff66ab"
                            strokeWidth={1.5 / view.zoom}
                            className="pointer-events-auto"
                            style={{ cursor: name === "n" || name === "s" ? "ns-resize" : name === "e" || name === "w" ? "ew-resize" : name === "nw" || name === "se" ? "nwse-resize" : "nesw-resize" }}
                            onPointerDown={(event) => startHandle(event, name)}
                          />
                        ))}
                      </>
                    );
                  })()}
                </g>
              ) : null}
            </svg>
          </div>
          <div ref={cursorRef} className="pointer-events-none absolute left-0 top-0 hidden rounded-full border border-white mix-blend-difference" />
          {board === "round" && state && state.doc.boards.round.length === 0 && state.doc.boards.square.length > 0 ? (
            <div className="absolute inset-x-0 top-4 flex justify-center">
              <div className="pointer-events-auto flex items-center gap-3 rounded-lg bg-black/75 px-3.5 py-2 text-[12px] text-osu-l2 backdrop-blur" onPointerDown={(event) => event.stopPropagation()}>
                {t`Lists show avatars round. Draw the frame again round the circle, or`}
                <button type="button" onClick={copyBoard} className="cursor-pointer font-semibold text-osu-pink-light hover:underline">{t`copy the square one`}</button>
              </div>
            </div>
          ) : null}
          {current && current.motion.kind === "keys" ? (
            <Timeline
              scrub={scrub}
              keys={current.motion.keys ?? []}
              activeKey={activeKey}
              onScrub={(value) => {
                setPlaying(false);
                setScrub(value);
              }}
              onPickKey={(key) => {
                setPlaying(false);
                setActiveKey(key.id);
                setScrub(key.t);
              }}
              onMoveKey={(key, at, merge) => {
                patchKey(current, key, { t: at }, merge);
                setScrub(at);
              }}
              onAddKey={() => addKey(current)}
            />
          ) : null}
          {dropping ? (
            <div className="pointer-events-none absolute inset-3 grid place-items-center rounded-xl border-2 border-dashed border-osu-pink/70 bg-osu-pink/[0.06]">
              <span className="rounded-lg bg-black/70 px-3 py-2 text-[13px] font-semibold text-white">{t`Drop to add it as a layer`}</span>
            </div>
          ) : null}
          {toast ? (
            <div className="pointer-events-none absolute bottom-12 left-1/2 -translate-x-1/2 rounded-lg bg-black/80 px-3 py-1.5 text-[12px] text-white">{toast}</div>
          ) : null}
          <div className="absolute bottom-3 left-3 hidden items-center gap-2 rounded-md bg-black/50 px-2 py-1 text-[10.5px] text-osu-f1 backdrop-blur md:flex">
            <span className="font-mono">{Math.round(view.zoom * 100)}%</span>
            <span aria-hidden className="h-3 w-px bg-white/15" />
            {board === "square" ? t`Square frame` : t`Round frame, for lists`}
            <span aria-hidden className="h-3 w-px bg-white/15" />
            {t`Drop or paste pictures here`}
          </div>
          {loading ? <div className="absolute inset-0 grid place-items-center text-[12px] text-osu-f1">{t`Loading...`}</div> : null}
        </main>

        {narrow ? (
          <>
            <div className="shrink-0 border-y border-white/[0.07] bg-osu-b6">
              <ToolRail horizontal tool={tool} onTool={setTool} settings={settings} primary={primary} secondary={secondary} onPrimary={setPrimary} onSecondary={setSecondary} onSwap={() => { setPrimary(secondary); setSecondary(primary); }} />
            </div>
            <div className="flex h-10 shrink-0 items-end gap-1 border-b border-white/[0.07] bg-osu-b6 px-2">
              {([["layers", t`Layers`], ["layer", t`Layer`], ["preview", t`Preview`], ["history", t`History`]] as const).map(([id, label]) => (
                <button key={id} type="button" onClick={() => setPhonePanel(id)} className={`-mb-px h-9 flex-1 cursor-pointer border-b-2 px-2 text-[13px] font-semibold transition-colors ${phonePanel === id ? "border-osu-pink text-white" : "border-transparent text-osu-f1"}`}>
                  {label}
                </button>
              ))}
            </div>
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-[color-mix(in_srgb,var(--color-osu-b6)_88%,black)]">
              {phonePanel === "layers" ? layersPanel : phonePanel === "layer" ? inspector : phonePanel === "history" ? historyPanel : preview}
            </div>
          </>
        ) : (
          <aside className="flex shrink-0 flex-col border-l border-white/[0.07] bg-[color-mix(in_srgb,var(--color-osu-b6)_88%,black)]" style={{ width: RIGHT_WIDTH }}>
            {preview}
            <div className="flex h-9 shrink-0 items-end gap-1 border-b border-white/[0.06] px-2">
              {([["layers", t`Layers`], ["history", t`History`]] as const).map(([id, label]) => (
                <button key={id} type="button" onClick={() => setRightTab(id)} className={`-mb-px h-8 cursor-pointer border-b-2 px-2.5 text-[11px] font-bold uppercase tracking-[0.08em] transition-colors ${rightTab === id ? "border-osu-pink text-white" : "border-transparent text-osu-f1 hover:text-white"}`}>
                  {label}
                </button>
              ))}
            </div>
            {rightTab === "layers" ? layersPanel : historyPanel}
          </aside>
        )}
      </div>

      {starting && !loading ? (
        <StartDialog
          username={viewer.username ?? null}
          avatar={avatar}
          onStarter={startFrom}
          onDraft={(id) => {
            currentDraft.current = null;
            setStarting(false);
            onDraftId(id);
            if (id === draftId) {
              // the address already names it: load it directly
              currentDraft.current = id;
              void loadDraft(id).then((loaded) => loaded && history.reset(loaded));
            }
          }}
          onPicture={(file) => void startFromPicture(file)}
          onClose={state ? () => setStarting(false) : undefined}
        />
      ) : null}
      {shortcutsOpen ? <ShortcutsDialog onClose={() => setShortcutsOpen(false)} /> : null}
      {submitOpen && state ? (
        <SubmitDialog
          name={state.doc.name}
          onName={(name) => commit((s) => (s ? { ...s, doc: { ...s.doc, name } } : s), "name")}
          still={exports.still}
          round={exports.round}
          issues={issues}
          supporter={supporter}
          animated={animated}
          canLoop={loopable}
          includeLoop={includeLoop}
          onIncludeLoop={setIncludeLoop}
          status={submit}
          worn={submitted?.worn ?? false}
          onWear={() => void wear()}
          onSubmit={() => void doSubmit()}
          canUpdate={!!state.doc.submitted}
          updating={updating}
          onUpdating={setUpdating}
          onClose={() => {
            setSubmitOpen(false);
            setSubmit({ phase: "idle", progress: 0, error: null });
          }}
        />
      ) : null}
    </div>
  );
}

function ViewToggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <button type="button" onClick={() => onChange(!checked)} className="flex h-8 cursor-pointer items-center justify-between rounded-md px-2 text-left text-osu-l2 hover:bg-white/[0.06] hover:text-white">
      {label}
      <span className={`h-2 w-2 rounded-full ${checked ? "bg-osu-pink" : "bg-white/15"}`} />
    </button>
  );
}

/* Whether either board has anything drawn: the square's thumbnail, or the round board when the square is empty. */
function hasArt(state: EditorState, squareThumb: HTMLCanvasElement): boolean {
  if (alphaBounds(squareThumb, true)) return true;
  return !!alphaBounds(renderBoard(state.doc.boards.round, { pixels: state.pixels, assets: state.assets, size: 96 }), true);
}

function insidePolygon(x: number, y: number, corners: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = corners.length - 1; i < corners.length; j = i++) {
    const [xi, yi] = corners[i];
    const [xj, yj] = corners[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-9) + xi) inside = !inside;
  }
  return inside;
}

/* A drag from `start` to `end` as a box; `even` makes it square, `centred` grows it from the start. */
function dragBox(start: [number, number], end: [number, number], even: boolean, centred: boolean): { x: number; y: number; w: number; h: number } {
  let dx = end[0] - start[0];
  let dy = end[1] - start[1];
  if (even) {
    const side = Math.max(Math.abs(dx), Math.abs(dy));
    dx = side * Math.sign(dx || 1);
    dy = side * Math.sign(dy || 1);
  }
  if (centred) return { x: start[0] - Math.abs(dx), y: start[1] - Math.abs(dy), w: Math.abs(dx) * 2, h: Math.abs(dy) * 2 };
  return { x: Math.min(start[0], start[0] + dx), y: Math.min(start[1], start[1] + dy), w: Math.abs(dx), h: Math.abs(dy) };
}

function ellipsePath(box: { x: number; y: number; w: number; h: number }): string {
  const rx = box.w / 2;
  const ry = box.h / 2;
  const cx = box.x + rx;
  const cy = box.y + ry;
  return `M${cx - rx} ${cy}a${rx} ${ry} 0 1 0 ${rx * 2} 0a${rx} ${ry} 0 1 0 ${-rx * 2} 0Z`;
}

/* The shape being dragged out, as an outline. */
function DraftShape({ layer, zoom }: { layer: ShapeLayer; zoom: number }) {
  const t = layer.transform;
  const w = layer.width / 2;
  const h = layer.height / 2;
  const stroke = { fill: "none", stroke: "#ff66ab", strokeWidth: 1.5 / zoom };
  return (
    <g transform={`translate(${t.x} ${t.y}) rotate(${t.rotation})`}>
      {layer.shape === "line" ? <line x1={-w} y1={0} x2={w} y2={0} {...stroke} /> : layer.shape === "rect" ? <rect x={-w} y={-h} width={w * 2} height={h * 2} {...stroke} /> : <ellipse rx={w} ry={h} {...stroke} />}
    </g>
  );
}

/* The axes the brush mirrors across. */
function SymmetryGuides({ mode, count, mirror, zoom }: { mode: string; count: number; mirror: boolean; zoom: number }) {
  const lines: ReactNode[] = [];
  const style = { stroke: "#7fd4ff", strokeOpacity: 0.55, strokeWidth: 1 / zoom, strokeDasharray: `${6 / zoom} ${4 / zoom}` };
  if (mode === "x" || mode === "xy") lines.push(<line key="x" x1={DOC_CENTRE} y1={0} x2={DOC_CENTRE} y2={DOC_SIZE} {...style} />);
  if (mode === "y" || mode === "xy") lines.push(<line key="y" x1={0} y1={DOC_CENTRE} x2={DOC_SIZE} y2={DOC_CENTRE} {...style} />);
  if (mode === "radial") {
    const copies = Math.max(2, Math.round(count)) * (mirror ? 2 : 1);
    for (let i = 0; i < copies; i++) {
      const angle = (i / copies) * Math.PI * 2 - Math.PI / 2;
      lines.push(<line key={i} x1={DOC_CENTRE} y1={DOC_CENTRE} x2={DOC_CENTRE + Math.cos(angle) * DOC_SIZE} y2={DOC_CENTRE + Math.sin(angle) * DOC_SIZE} {...style} />);
    }
  }
  return <g>{lines}</g>;
}

/* A path's outline, anchors and handles while the pen is out, and the line to the pointer while drawing. */
function PenOverlay({ layer, zoom, active, hover }: { layer: PathLayer; zoom: number; active: number | null; hover: [number, number] | null }) {
  const { d, anchors, handles } = pathOverlay(layer);
  const size = 8 / zoom;
  const last = anchors[anchors.length - 1];
  return (
    <g>
      <path d={d} fill="none" stroke="#66ccff" strokeWidth={1.2 / zoom} />
      {hover && last && !layer.closed ? <line x1={last[0]} y1={last[1]} x2={hover[0]} y2={hover[1]} stroke="#66ccff" strokeOpacity={0.6} strokeWidth={1 / zoom} strokeDasharray={`${4 / zoom} ${3 / zoom}`} /> : null}
      {handles.filter((handle) => active !== null && Math.abs(handle.index - active) <= 1).map((handle) => (
        <g key={`${handle.index}${handle.part}`}>
          <line x1={handle.from[0]} y1={handle.from[1]} x2={handle.to[0]} y2={handle.to[1]} stroke="#66ccff" strokeWidth={1 / zoom} />
          <circle cx={handle.to[0]} cy={handle.to[1]} r={size / 2} fill="#fff" stroke="#66ccff" strokeWidth={1.2 / zoom} />
        </g>
      ))}
      {anchors.map(([x, y], index) => (
        <rect key={index} x={x - size / 2} y={y - size / 2} width={size} height={size} fill={index === active ? "#66ccff" : "#fff"} stroke="#66ccff" strokeWidth={1.2 / zoom} />
      ))}
    </g>
  );
}

/* The loop's timeline for a layer moved by keyframes: drag the playhead to a
   moment, click a diamond to edit that key, drag it to move it in time. */
function Timeline({ scrub, keys, activeKey, onScrub, onPickKey, onMoveKey, onAddKey }: {
  scrub: number;
  keys: MotionKey[];
  activeKey: string | null;
  onScrub: (value: number) => void;
  onPickKey: (key: MotionKey) => void;
  onMoveKey: (key: MotionKey, at: number, merge: string) => void;
  onAddKey: () => void;
}) {
  const { t } = useLingui();
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef<{ key: MotionKey | null; merge: string } | null>(null);
  const at = (clientX: number) => {
    const box = track.current!.getBoundingClientRect();
    return Math.round(Math.max(0, Math.min(0.999, (clientX - box.left) / box.width)) * 100) / 100;
  };
  return (
    <div
      className="absolute bottom-12 left-1/2 flex w-[min(560px,calc(100%-24px))] -translate-x-1/2 items-center gap-2 rounded-lg bg-black/70 px-3 py-2 backdrop-blur"
      onPointerDown={(event) => event.stopPropagation()}
      onPointerMove={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
    >
      <span className="w-10 shrink-0 font-mono text-[11px] text-white">{(scrub * LOOP_SECONDS).toFixed(2)}s</span>
      <div
        ref={track}
        className="relative h-7 flex-1 cursor-pointer touch-none"
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { key: null, merge: "" };
          onScrub(at(event.clientX));
        }}
        onPointerMove={(event) => {
          const current = drag.current;
          if (!current) return;
          if (current.key) onMoveKey(current.key, at(event.clientX), current.merge);
          else onScrub(at(event.clientX));
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
      >
        <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-white/15" />
        {[0, 1, 2, 3].map((second) => (
          <span key={second} className="absolute top-0 h-1.5 w-px bg-white/30" style={{ left: `${(second / LOOP_SECONDS) * 100}%` }} />
        ))}
        {keys.map((key) => (
          <button
            key={key.id}
            type="button"
            aria-label={t`Keyframe at ${(key.t * LOOP_SECONDS).toFixed(2)}s`}
            onPointerDown={(event) => {
              event.stopPropagation();
              track.current!.setPointerCapture(event.pointerId);
              drag.current = { key, merge: `key-time:${key.id}:${Date.now()}` };
              onPickKey(key);
            }}
            className={`absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rotate-45 cursor-grab rounded-[2px] ring-1 ring-black/60 ${key.id === activeKey ? "bg-osu-pink" : "bg-white"}`}
            style={{ left: `${key.t * 100}%` }}
          />
        ))}
        <span className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 bg-sky-300" style={{ left: `${scrub * 100}%` }} />
      </div>
      <button type="button" onClick={onAddKey} className="h-7 shrink-0 cursor-pointer rounded-md bg-white/10 px-2.5 text-[11.5px] font-semibold text-white hover:bg-white/15">{t`Add key`}</button>
    </div>
  );
}
