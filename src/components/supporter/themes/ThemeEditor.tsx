import { Trans, useLingui } from "@lingui/react/macro";
import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronLeft, ChevronUp, Monitor, MoreHorizontal, PanelsTopLeft, Pause, Play, Plus, Redo2, Smartphone, Undo2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import type { CustomThemeSourceError } from "#custom-themes/source";
import { CUSTOM_THEME_TEXTURES } from "#custom-themes/inputs";
import { checkCustomThemeSource } from "../../../lib/custom-theme-check";
import {
  bakeRow,
  canvasBlob,
  frameBrightness,
  suggestLook,
  ThemeEditorGl,
  type DriverError,
  type FrameInputs,
  type RowFraming,
} from "../../../lib/custom-theme-editor-gl";
import { customThemeSpec, CUSTOM_THEME_STARTER } from "../../../lib/custom-theme-spec";
import { layerAssets, LAYER_GENERATOR_VERSION, LAYERS_MAX, layersToGlsl, newLayer, parseLayerDoc, starterLayerDoc, type Layer, type LayerDoc } from "../../../lib/custom-theme-layers";
import { PROFILE_THEME_MAIN, PROFILE_THEME_PRELUDE, PROFILE_THEME_SHADERS } from "../../../lib/profile-theme-shaders";
import {
  fetchGalleryCustomTheme,
  fetchOwnCustomTheme,
  fetchOwnCustomThemes,
  saveOwnCustomTheme,
  type CustomThemeLook,
  type CustomThemeVisibility,
} from "../../../lib/supporter-custom-themes";
import { fetchSupporterLookState } from "../../../lib/supporter-look-settings";
import { SUPPORTER_PROFILE_THEMES, type SupporterProfileThemeId } from "../../../lib/supporter-profile-themes";
import { supporterRowBackground } from "../SupporterRowBanner";
import { ConfirmModal } from "../../ui/ConfirmModal";
import { Switch } from "../../ui/Switch";
import { InspectorRow, InspectorSection, Meter, StatusDot, ToolButton, ToolDivider } from "./EditorChrome";
import { BasePad, Choice, HUE_STRIP, Popover, Slider, strengthStrip } from "./EditorControls";
import { RowFramer } from "./RowFramer";
import { LayerHandles } from "./LayerHandles";
import { duplicateLayer, LayerInspector, LayersList, moveLayer, patchLayer, useLayerNames } from "./LayerPanel";
import { StartPicker } from "./StartPicker";
import { ThemeCodeEditor, type ThemeCodeEditorHandle } from "./ThemeCodeEditor";

/* The code theme editor (/supporter/themes/$themeId): the author's GLSL on
   the left, checked as they type by the same checker the backend runs on
   save; a live preview on the right, timed against the heaviest built-in;
   then the details a save needs (name, tint, images, the still's moment and
   the banner row) and Save, which renders the still and the row, uploads
   them and puts the revision live. */

const CHECK_DELAY_MS = 450;
const COST_DELAY_MS = 900;
const PREVIEW_MAX_PIXELS = 640_000;
const STILL = { width: 1200, height: 630 } as const;
const MOMENT_MAX = 30;
const FILMSTRIP_FRAMES = 10;
const ROW = { width: 320, height: 200 } as const;
const ROW_SOURCE = { width: 1280, height: 800 } as const;
const BRIGHT_WARN = 0.3;
const DEFAULT_LOOK: CustomThemeLook = { hue: 330, sat: 0.7, base: "#0b0710" };
const CENTRE: [number, number] = [0.5, 0.5];

/* A built-in theme's own code, without the prelude and main its shader() wraps it in. */
function builtinBody(id: SupporterProfileThemeId): string {
  const full = PROFILE_THEME_SHADERS[id];
  return full.slice(PROFILE_THEME_PRELUDE.length + 1, full.length - PROFILE_THEME_MAIN.length - 1).replace(/^\n+/, "").trimEnd() + "\n";
}

/* Built-ins a theme can start from: the ones with no inputs of their own (the Note highway's notes, sprites). */
const STARTABLE_BUILTINS = SUPPORTER_PROFILE_THEMES.filter((id) => !/\buniform\b/.test(builtinBody(id)));

export interface ThemeEditorStart {
  themeId: number | null;
  /** A new theme made of layers (no code) or written as code. */
  mode?: "code" | "layers";
  from?: string;
  remix?: number;
}

type Problem = { line: number | null; snippet: string | null; message: string };

/* 4.25 as 0:04.2 */
function clock(seconds: number): string {
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}.${Math.floor((seconds - whole) * 10)}`;
}

function errorText(errors: Problem[]): string {
  return errors.map((error) => `${error.line ? `Line ${error.line}: ` : ""}${error.snippet ? `\`${error.snippet}\`: ` : ""}${error.message}`).join("\n");
}

export function ThemeEditor({ start, onCreated }: { start: ThemeEditorStart; onCreated?: (themeId: number) => void }) {
  const { t } = useLingui();
  const navigate = useNavigate();
  const [themeId, setThemeId] = useState<number | null>(start.themeId);
  const [loading, setLoading] = useState(start.themeId !== null || start.remix !== undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [supporter, setSupporter] = useState<boolean | null>(null);
  const [disabled, setDisabled] = useState(false);

  const { names: layerNames } = useLayerNames();
  const [mode, setMode] = useState<"code" | "layers">(start.themeId === null && start.remix === undefined && !start.from && start.mode !== "code" ? "layers" : "code");
  const [doc, setDoc] = useState<LayerDoc | null>(() => (mode === "layers" ? starterLayerDoc(layerNames) : null));
  const [selectedLayer, setSelectedLayer] = useState<string | null>(null);
  const [toCode, setToCode] = useState(false);
  const liveGlsl = useRef<string | null>(null);
  const [code, setCode] = useState(() => (start.from && STARTABLE_BUILTINS.includes(start.from as SupporterProfileThemeId) ? builtinBody(start.from as SupporterProfileThemeId) : CUSTOM_THEME_STARTER));
  const [edited, setEdited] = useState(false);
  const [name, setName] = useState("");
  const [visibility, setVisibility] = useState<CustomThemeVisibility>("private");
  const [credits, setCredits] = useState("");
  const [remixedFrom, setRemixedFrom] = useState<number | null>(start.remix ?? null);
  const [assets, setAssets] = useState<string[]>([]);
  const [look, setLook] = useState<CustomThemeLook>(DEFAULT_LOOK);
  const lookTouched = useRef(false);
  const [rights, setRights] = useState(false);

  const [problems, setProblems] = useState<Problem[]>([]);
  const [checking, setChecking] = useState(false);
  const [compiledOk, setCompiledOk] = useState(false);
  const [format, setFormat] = useState<"theme" | "shadertoy" | null>(null);
  const [tooHeavyLive, setTooHeavyLive] = useState(false);
  const [cost, setCost] = useState<number | null>(null);
  const [brightness, setBrightness] = useState<number | null>(null);
  const [fps, setFps] = useState<number | null>(null);

  const [phone, setPhone] = useState(false);
  const [overlay, setOverlay] = useState(false);
  const [playing, setPlaying] = useState(true);
  const playStart = useRef(0);
  const playheadRef = useRef<HTMLDivElement>(null);
  const clockRef = useRef<HTMLSpanElement>(null);
  const [inspectorTab, setInspectorTab] = useState<"layer" | "theme">("layer");
  const [saveOpen, setSaveOpen] = useState(false);
  const [problemsOpen, setProblemsOpen] = useState(true);
  const savedSnapshot = useRef<string | null>(null);
  const pendingSnapshot = useRef(start.themeId !== null);
  const [scroll, setScroll] = useState(0);
  const [moment, setMoment] = useState(4);
  const [framing, setFraming] = useState<RowFraming>({ zoom: 1.4, x: 0.6, y: 0.45 });
  const [rowSource, setRowSource] = useState<{ url: string; width: number; height: number } | null>(null);
  const [filmstrip, setFilmstrip] = useState<string[]>([]);
  const [replacing, setReplacing] = useState<"starter" | SupporterProfileThemeId | null>(null);
  const [rowPreview, setRowPreview] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ tone: "good" | "bad"; text: string } | null>(null);
  const [uploading, setUploading] = useState<number | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const glRef = useRef<ThemeEditorGl | null>(null);
  const editorRef = useRef<ThemeCodeEditorHandle>(null);
  const pointer = useRef<[number, number]>([0.5, 0.5]);
  const pointerTarget = useRef<[number, number]>([0.5, 0.5]);
  const live = useRef({ playing, moment, scroll, tooHeavyLive });
  live.current = { playing, moment, scroll, tooHeavyLive };

  /* --- Loading --------------------------------------------------------- */

  useEffect(() => {
    let alive = true;
    fetchSupporterLookState().then((state) => alive && setSupporter(state.supporter)).catch(() => alive && setSupporter(false));
    fetchOwnCustomThemes().then((own) => alive && setDisabled(own?.disabled === true)).catch(() => {});
    if (start.themeId !== null) {
      fetchOwnCustomTheme({ data: { themeId: start.themeId } })
        .then((draft) => {
          if (!alive) return;
          if (!draft) {
            setLoadError(t`This theme isn't yours, or it was deleted.`);
            return;
          }
          setCode(draft.source);
          const layers = draft.kind === "layers" ? parseLayerDoc(draft.layers) : null;
          setMode(layers ? "layers" : "code");
          setDoc(layers);
          setName(draft.name);
          setVisibility(draft.visibility);
          setCredits(draft.credits ?? "");
          setRemixedFrom(draft.remixedFrom);
          setAssets(draft.assets);
          if (draft.look) {
            setLook(draft.look);
            lookTouched.current = true;
          }
          setRights(true);
        })
        .catch((cause: unknown) => alive && setLoadError(cause instanceof Error ? cause.message : String(cause)))
        .finally(() => alive && setLoading(false));
    } else if (start.remix !== undefined) {
      fetchGalleryCustomTheme(start.remix)
        .then((original) => {
          if (!alive) return;
          if (!original) {
            setLoadError(t`That theme isn't in the gallery anymore.`);
            return;
          }
          setCode(original.source);
          const layers = original.kind === "layers" ? parseLayerDoc(original.layers) : null;
          setMode(layers ? "layers" : "code");
          setDoc(layers);
          setName(t`${original.name} remix`.slice(0, 40));
          setCredits(t`Remix of ${original.name} by ${original.author.username}`.slice(0, 300));
          setAssets(original.assets);
          setLook(original.look);
          lookTouched.current = true;
        })
        .catch((cause: unknown) => alive && setLoadError(cause instanceof Error ? cause.message : String(cause)))
        .finally(() => alive && setLoading(false));
    }
    return () => {
      alive = false;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /* --- The preview's GL ------------------------------------------------ */

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = ThemeEditorGl.create(canvas);
    glRef.current = gl;
    if (!gl) {
      setProblems([{ line: null, snippet: null, message: t`This browser has no WebGL2, so the preview can't run here.` }]);
      return;
    }
    let frame = 0;
    let frames = 0;
    let since = performance.now();
    playStart.current = performance.now();
    const tick = () => {
      frame = requestAnimationFrame(tick);
      const now = performance.now();
      const { playing: running, moment: at, scroll: scrolled, tooHeavyLive: heavy } = live.current;
      const time = running ? (at + (now - playStart.current) / 1000) % MOMENT_MAX : at;
      if (playheadRef.current) playheadRef.current.style.left = `${(time / MOMENT_MAX) * 100}%`;
      if (clockRef.current) clockRef.current.textContent = clock(time);
      if (heavy || !gl.ready) return;
      const box = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const scale = Math.min(1, Math.sqrt(PREVIEW_MAX_PIXELS / Math.max(1, box.width * dpr * box.height * dpr)));
      const width = Math.max(1, Math.round(box.width * dpr * scale));
      const height = Math.max(1, Math.round(box.height * dpr * scale));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      pointer.current = [pointer.current[0] + (pointerTarget.current[0] - pointer.current[0]) * 0.08, pointer.current[1] + (pointerTarget.current[1] - pointer.current[1]) * 0.08];
      gl.draw({ time, pointer: pointer.current, scroll: scrolled });
      frames += 1;
      if (now - since >= 1000) {
        setFps(Math.round((frames * 1000) / (now - since)));
        frames = 0;
        since = now;
      }
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      gl.dispose();
      glRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    glRef.current?.setAssets(assets);
  }, [assets]);

  /* A layer theme: its saved code follows every change, and the preview runs
     the live variant, recompiled only when the structure changes (a slider
     only moves numbers). */
  useEffect(() => {
    if (mode !== "layers" || !doc) return;
    const gl = glRef.current;
    const live = layersToGlsl(doc, { live: true });
    if (gl && live.glsl !== liveGlsl.current) {
      const failed = gl.useLive(live.glsl);
      if (failed.length) {
        setProblems(failed.map((error) => ({ line: null, snippet: null, message: error.message })));
        liveGlsl.current = null;
      } else {
        liveGlsl.current = live.glsl;
        gl.setParams(live.params);
        setTooHeavyLive(!gl.probe());
      }
    }
    gl?.setParams(live.params);
    const urls = layerAssets(doc);
    setAssets((current) => (current.join("|") === urls.join("|") ? current : urls));
    setCode(layersToGlsl(doc).glsl);
  }, [doc, mode]);

  /* --- Checking as the author types ------------------------------------ */

  const checkRun = useRef(0);
  useEffect(() => {
    if (loading) return;
    const run = ++checkRun.current;
    setChecking(true);
    const timer = setTimeout(() => {
      void checkCustomThemeSource(code).then(({ result, lineProgram }) => {
        if (run !== checkRun.current) return;
        setChecking(false);
        const gl = glRef.current;
        setCost(null);
        if (!result.ok) {
          setProblems(result.errors.map((error: CustomThemeSourceError) => ({ line: error.line, snippet: error.snippet, message: error.message })));
          setCompiledOk(false);
          return;
        }
        setFormat(result.format);
        if (!gl) return;
        if (mode === "layers") {
          // the preview already runs this theme's live variant; the check is what a save will pass
          setProblems([]);
          setCompiledOk(true);
          return;
        }
        const driver: DriverError[] = lineProgram ? gl.driverErrors(lineProgram) : [];
        const lines = code.split("\n");
        const failed = driver.length ? driver : gl.use(result.compiled);
        if (failed.length) {
          setProblems(failed.map((error) => ({ line: error.line, snippet: error.line ? lines[error.line - 1]?.trim() || null : null, message: error.message })));
          setCompiledOk(false);
          return;
        }
        setProblems([]);
        setCompiledOk(true);
        setTooHeavyLive(!gl.probe());
      });
    }, CHECK_DELAY_MS);
    return () => clearTimeout(timer);
  }, [code, loading, mode]);

  /* The cost, the brightness and a suggested tint, once the code has settled. */
  useEffect(() => {
    if (!compiledOk) return;
    const timer = setTimeout(() => {
      const gl = glRef.current;
      if (!gl?.ready) return;
      setCost(gl.measureCost());
      const sample = gl.capture(64, 36, { time: moment, pointer: CENTRE, scroll: 0 });
      if (sample) {
        setBrightness(frameBrightness(sample));
        if (!lookTouched.current) setLook(suggestLook(sample));
      }
    }, COST_DELAY_MS);
    return () => clearTimeout(timer);
  }, [compiledOk, code, moment]);

  /* The banner row as it will be saved, redrawn when its moment or framing
     moves. Always a frame of the theme itself, never an upload: rows show in
     public lists, so what's there has to be what the code draws. */
  useEffect(() => {
    const timer = setTimeout(() => {
      const gl = glRef.current;
      const source = compiledOk && gl?.ready ? gl.capture(ROW_SOURCE.width / 2, ROW_SOURCE.height / 2, { time: moment, pointer: CENTRE, scroll: 0 }) : null;
      if (!source) return;
      setRowPreview(bakeRow(source, framing, ROW.width, ROW.height).toDataURL("image/webp"));
      setRowSource((current) => {
        const url = source.toDataURL("image/webp", 0.8);
        return current?.url === url ? current : { url, width: source.width, height: source.height };
      });
    }, 250);
    return () => clearTimeout(timer);
  }, [compiledOk, code, moment, framing]);

  /* Small frames along the moment's track, so picking one is picking a picture. */
  useEffect(() => {
    if (!compiledOk) return;
    const timer = setTimeout(() => {
      const gl = glRef.current;
      if (!gl?.ready || tooHeavyLive) return;
      const frames: string[] = [];
      for (let index = 0; index < FILMSTRIP_FRAMES; index++) {
        const frame = gl.capture(96, 60, { time: ((index + 0.5) / FILMSTRIP_FRAMES) * MOMENT_MAX, pointer: CENTRE, scroll: 0 });
        if (frame) frames.push(frame.toDataURL("image/webp", 0.7));
      }
      setFilmstrip(frames);
    }, COST_DELAY_MS + 300);
    return () => clearTimeout(timer);
  }, [compiledOk, code, tooHeavyLive]);

  /* --- Actions ---------------------------------------------------------- */

  const startFrom = (start: "starter" | SupporterProfileThemeId) => {
    setCode(start === "starter" ? CUSTOM_THEME_STARTER : builtinBody(start));
    setEdited(false);
    lookTouched.current = false;
  };
  const pickStart = (start: "starter" | SupporterProfileThemeId) => {
    if (edited) setReplacing(start);
    else startFrom(start);
  };

  const copy = (text: string, what: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(what);
      setTimeout(() => setCopied((current) => (current === what ? null : current)), 1600);
    });
  };

  const upload = async (blob: Blob, kind: "texture" | "still" | "row"): Promise<string> => {
    const response = await fetch(`/api/supporter-theme-asset?kind=${kind}`, { method: "POST", headers: { "content-type": blob.type || "application/octet-stream" }, body: blob });
    const body = await response.json().catch(() => null) as { url?: unknown; error?: unknown } | null;
    if (!response.ok || typeof body?.url !== "string") throw new Error(typeof body?.error === "string" ? body.error : t`Could not upload that image.`);
    return body.url;
  };

  const addTexture = async (index: number, file: File) => {
    setUploading(index);
    setStatus(null);
    try {
      const url = await upload(file, "texture");
      setAssets((current) => {
        const next = [...current];
        next[index] = url;
        return next.filter(Boolean).slice(0, CUSTOM_THEME_TEXTURES);
      });
    } catch (cause) {
      setStatus({ tone: "bad", text: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setUploading(null);
    }
  };

  /* A picture for a layer: uploaded for a supporter (a save needs its URL),
     only shown here for anyone else, who can try the editor but not save. */
  const uploadLayerImage = async (file: File): Promise<string | null> => {
    if (!file.type.startsWith("image/")) return null;
    if (supporter !== true) return URL.createObjectURL(file);
    setUploading(-1);
    setStatus(null);
    try {
      return await upload(file, "texture");
    } catch (cause) {
      setStatus({ tone: "bad", text: cause instanceof Error ? cause.message : String(cause) });
      return null;
    } finally {
      setUploading(null);
    }
  };

  /* A picture dropped on the preview becomes a new image layer on top, picked. */
  const addImageLayer = async (file: File) => {
    if (!doc) return;
    if (doc.layers.length >= LAYERS_MAX) {
      setStatus({ tone: "bad", text: t`A theme holds up to ${LAYERS_MAX} layers.` });
      return;
    }
    if (layerAssets(doc).length >= CUSTOM_THEME_TEXTURES) {
      setStatus({ tone: "bad", text: t`A theme holds up to four pictures.` });
      return;
    }
    const url = await uploadLayerImage(file);
    if (!url) return;
    const layer = newLayer("image", file.name.replace(/\.[a-z0-9]+$/i, "").slice(0, 40) || layerNames.image);
    if (layer.kind === "image") layer.image = url;
    setDoc((current) => current && { ...current, layers: [...current.layers, layer] });
    setSelectedLayer(layer.id);
  };

  const blockers: string[] = [];
  if (supporter === false) blockers.push(t`Only supporters can save themes. Everything here works as a preview.`);
  if (disabled) blockers.push(t`Custom themes are switched off for now, so saving is too.`);
  const nameBlocker = t`Give it a name.`;
  const rightsBlocker = t`Tick "I understand" before saving.`;
  if (!name.trim()) blockers.push(nameBlocker);
  if (!compiledOk) blockers.push(t`Fix the code's errors first.`);
  if (cost !== null && cost > 1) blockers.push(t`It's heavier than the limit.`);
  if (!rights) blockers.push(rightsBlocker);

  const save = async (): Promise<boolean> => {
    const gl = glRef.current;
    if (!gl?.ready || blockers.length || saving) return false;
    setSaving(true);
    setStatus(null);
    try {
      const measured = cost ?? gl.measureCost();
      if (measured === null || measured > 1) {
        setCost(measured);
        throw new Error(t`It's heavier than the limit.`);
      }
      const inputs: FrameInputs = { time: moment, pointer: CENTRE, scroll: 0 };
      const still = gl.capture(STILL.width, STILL.height, inputs);
      const rowSource = gl.capture(ROW_SOURCE.width, ROW_SOURCE.height, inputs);
      if (!still || !rowSource) throw new Error(t`Could not render the theme.`);
      const [stillUrl, rowUrl] = await Promise.all([
        canvasBlob(still).then((blob) => upload(blob, "still")),
        canvasBlob(bakeRow(rowSource, framing, ROW.width, ROW.height)).then((blob) => upload(blob, "row")),
      ]);
      const result = await saveOwnCustomTheme({
        data: {
          themeId, name: name.trim(), visibility, credits, remixedFrom, source: code, assets, look, stillUrl, rowUrl, costRatio: measured, rightsConfirmed: rights,
          ...(mode === "layers" && doc ? { kind: "layers" as const, layers: doc, generatorVersion: LAYER_GENERATOR_VERSION } : { kind: "code" as const }),
        },
      });
      if (!result.ok) {
        if (result.errors.length) setProblems(result.errors.map((error) => ({ line: error.line, snippet: error.snippet, message: error.message })));
        throw new Error(saveErrorText(result.error));
      }
      setStatus({ tone: "good", text: visibility === "gallery" ? t`Saved. It's live, and in the gallery.` : t`Saved. It's live on your list.` });
      if (themeId === null) {
        setThemeId(result.theme.id);
        onCreated?.(result.theme.id);
        void navigate({ to: "/supporter/themes/$themeId", params: { themeId: String(result.theme.id) }, replace: true });
      }
      return true;
    } catch (cause) {
      setStatus({ tone: "bad", text: cause instanceof Error ? cause.message : String(cause) });
      return false;
    } finally {
      setSaving(false);
    }
  };

  const saveErrorText = (error: string): string => {
    switch (error) {
      case "not_supporter": return t`Your supporter time has run out.`;
      case "blocked": return t`You can't make themes anymore.`;
      case "taken_down": return t`This theme, or code or an image in it, was taken down.`;
      case "too_many_saves": return t`That's a lot of saves in a minute. Wait a moment and save again.`;
      case "disabled": return t`Custom themes are switched off for now.`;
      case "source_rejected": return t`The code didn't pass the check. The errors are listed under it.`;
      case "rights_not_confirmed": return rightsBlocker;
      case "signed_out": return t`Sign in to save.`;
      default: return t`Could not save the theme.`;
    }
  };

  const marks = useMemo(() => problems.filter((problem) => problem.line !== null).map((problem) => ({ line: problem.line!, message: problem.message })), [problems]);
  const onCode = useCallback((value: string) => {
    setCode(value);
    setEdited(true);
  }, []);

  /* --- Undo and redo (layers; the code editor keeps its own) ------------- */

  const history = useHistory(doc, setDoc);
  const leftPanel = usePanelWidth("layers", 300, 240, 440, 1);
  const codePanel = usePanelWidth("code", 600, 380, 980, 1);
  const rightPanel = usePanelWidth("inspector", 360, 300, 520, -1);

  /* --- Play, pause, the clock -------------------------------------------- */

  const currentTime = () => (playing ? (moment + (performance.now() - playStart.current) / 1000) % MOMENT_MAX : moment);
  const togglePlay = () => {
    if (playing) {
      setMoment(Math.round(currentTime() * 10) / 10);
      setPlaying(false);
    } else {
      playStart.current = performance.now();
      setPlaying(true);
    }
  };
  const seek = (time: number) => {
    setPlaying(false);
    setMoment(time);
  };

  /* --- Saved or not ------------------------------------------------------ */

  const snapshot = `${code}|${name}|${visibility}|${credits}|${look.hue}|${look.sat}|${look.base}`;
  useEffect(() => {
    if (pendingSnapshot.current && !loading && !checking && compiledOk) {
      savedSnapshot.current = snapshot;
      pendingSnapshot.current = false;
    }
  }, [snapshot, loading, checking, compiledOk]);
  const dirty = savedSnapshot.current !== snapshot;

  const requestSave = () => {
    if (themeId === null || !name.trim() || !rights || blockers.length) setSaveOpen(true);
    else void save().then((ok) => {
      if (ok) savedSnapshot.current = snapshot;
    });
  };

  /* --- Shortcuts ---------------------------------------------------------- */

  const keys = useRef({ requestSave, togglePlay, history, doc, selectedLayer, mode });
  keys.current = { requestSave, togglePlay, history, doc, selectedLayer, mode };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const { requestSave: saveNow, togglePlay: toggle, history: undoable, doc: current, selectedLayer: picked, mode: editing } = keys.current;
      const command = event.ctrlKey || event.metaKey;
      if (command && event.key.toLowerCase() === "s") {
        event.preventDefault();
        saveNow();
        return;
      }
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable=true], .cm-editor")) return;
      if (command && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) undoable.redo();
        else undoable.undo();
        return;
      }
      if (command && event.key.toLowerCase() === "y") {
        event.preventDefault();
        undoable.redo();
        return;
      }
      if (event.key === " ") {
        event.preventDefault();
        toggle();
        return;
      }
      if (editing !== "layers" || !current) return;
      if (event.key === "Escape") setSelectedLayer(null);
      const layer = current.layers.find((entry) => entry.id === picked);
      if (!layer) return;
      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        setDoc({ ...current, layers: current.layers.filter((entry) => entry.id !== layer.id) });
        setSelectedLayer(null);
      } else if (command && event.key.toLowerCase() === "d") {
        event.preventDefault();
        const copy = duplicateLayer(current, layer.id);
        if (copy) {
          setDoc(copy.doc);
          setSelectedLayer(copy.id);
        }
      } else if (event.key.toLowerCase() === "h" && !command) {
        setDoc(patchLayer(current, layer.id, { hidden: !layer.hidden }));
      } else if (event.key === "]" || event.key === "[") {
        setDoc(moveLayer(current, layer.id, event.key === "]" ? 1 : -1));
      } else if (event.key.startsWith("Arrow") && "x" in layer && "y" in layer) {
        event.preventDefault();
        const step = event.shiftKey ? 0.05 : 0.005;
        const dx = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
        const dy = event.key === "ArrowUp" ? step : event.key === "ArrowDown" ? -step : 0;
        setDoc(patchLayer(current, layer.id, { x: layer.x + dx, y: layer.y + dy } as Partial<Layer>));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // an editor fills the window: the page under it doesn't scroll
  useEffect(() => {
    const root = document.documentElement;
    const before = root.style.overflow;
    root.style.overflow = "hidden";
    return () => {
      root.style.overflow = before;
    };
  }, []);

  // picking a layer brings its settings forward
  useEffect(() => {
    if (selectedLayer) setInspectorTab("layer");
  }, [selectedLayer]);

  if (loadError) {
    return (
      <div className="grid h-[calc(100dvh-60px)] place-items-center bg-[#100d13] px-4 text-center text-[13px] text-osu-l2">
        <p>
          {loadError}{" "}
          <Link to="/supporter/themes" className="font-semibold text-osu-pink-light hover:underline">{t`Back to your themes`}</Link>
        </p>
      </div>
    );
  }

  const costLabel = cost === null ? "-" : cost === Number.POSITIVE_INFINITY ? t`far over` : `${cost.toFixed(2)}x`;
  const checkTone = checking ? "busy" : problems.length ? "bad" : compiledOk ? "good" : "busy";
  const checkText = checking ? t`Checking the code` : problems.length ? (problems.length === 1 ? t`1 error in the code` : t`${problems.length} errors in the code`) : compiledOk ? t`No errors in the code` : t`Checking the code`;
  const updateLayer = (id: string, patch: Partial<Layer>) => setDoc((current) => current && patchLayer(current, id, patch));

  const themeSettings = (
    <>
      <InspectorSection title={t`Site colours`}>
        <p className="mb-2 text-[11px] leading-relaxed text-osu-f1">{t`The tint the rest of the profile takes while the theme is on.`}</p>
        <InspectorRow label={t`Hue`}>
          <Slider value={look.hue} min={0} max={360} onChange={(hue) => { lookTouched.current = true; setLook({ ...look, hue }); }} label={t`Hue`} gradient={HUE_STRIP} thumbColor={`hsl(${look.hue}, 90%, 55%)`} />
        </InspectorRow>
        <InspectorRow label={t`Strength`}>
          <Slider value={look.sat} min={0} max={1} step={0.01} onChange={(sat) => { lookTouched.current = true; setLook({ ...look, sat }); }} label={t`Strength`} gradient={strengthStrip(look.hue)} thumbColor={`hsl(${look.hue}, ${Math.round(look.sat * 100)}%, 55%)`} />
        </InspectorRow>
        <InspectorRow label={t`Base`}>
          <BasePad value={look.base} onChange={(base) => { lookTouched.current = true; setLook({ ...look, base }); }} label={t`Base colour`} />
        </InspectorRow>
        <div className="mt-2 flex items-center gap-2">
          <div className="flex h-12 flex-1 flex-col justify-center gap-1.5 rounded-lg px-2.5 ring-1 ring-white/[0.07]" style={{ backgroundColor: look.base }}>
            <span className="block h-1.5 w-2/3 rounded" style={{ background: `hsl(${look.hue} ${Math.round(look.sat * 100)}% 62%)` }} />
            <span className="block h-1.5 w-1/2 rounded bg-white/40" />
          </div>
          <SmallButton onClick={() => {
            const sample = glRef.current?.capture(64, 36, { time: moment, pointer: CENTRE, scroll: 0 });
            if (sample) {
              lookTouched.current = false;
              setLook(suggestLook(sample));
            }
          }}>{t`From the theme`}</SmallButton>
        </div>
      </InspectorSection>
      <InspectorSection title={t`Banner row`}>
        <p className="mb-2 text-[11px] leading-relaxed text-osu-f1">{t`Behind your row in rankings and lists, when you turn rows on. A still of the paused frame.`}</p>
        <RowFramer source={rowSource} framing={framing} onChange={setFraming} aspect={ROW.width / ROW.height} />
        <div className="mt-2 flex h-10 items-center gap-2.5 rounded-md bg-osu-b4 px-2.5" style={rowPreview ? supporterRowBackground({ image: rowPreview }) : undefined}>
          <span className="w-5 text-[11px] font-semibold text-osu-f1">#1</span>
          <span className="h-6 w-6 rounded bg-osu-b2" />
          <span className="text-[12px] font-semibold text-white">{name || t`Your name`}</span>
        </div>
      </InspectorSection>
      {mode === "code" ? (
        <InspectorSection title={t`Pictures`}>
          <p className="mb-2 text-[11px] leading-relaxed text-osu-f1">{t`Read in the code as u_tex0 to u_tex3 (iChannel0 to iChannel3 in Shadertoy code).`}</p>
          <div className="grid grid-cols-4 gap-1.5">
            {Array.from({ length: CUSTOM_THEME_TEXTURES }, (_, index) => {
              const url = assets[index];
              return (
                <div key={index} className="relative aspect-square overflow-hidden rounded-md bg-black/30 ring-1 ring-white/[0.06]">
                  {url ? (
                    <>
                      <img src={url} alt="" className="h-full w-full object-cover" />
                      <button type="button" aria-label={t`Remove`} onClick={() => setAssets((current) => current.filter((_, at) => at !== index))} className="absolute right-0.5 top-0.5 grid h-5 w-5 cursor-pointer place-items-center rounded bg-black/70 text-[11px] text-white hover:bg-black">x</button>
                    </>
                  ) : index === assets.length ? (
                    <label className="grid h-full w-full cursor-pointer place-items-center text-osu-f1 hover:text-white" title={t`Add image`}>
                      {uploading === index ? "..." : <Plus size={15} />}
                      <input type="file" accept="image/*" className="hidden" disabled={uploading !== null || supporter !== true} onChange={(event) => {
                        const file = event.target.files?.[0];
                        event.target.value = "";
                        if (file) void addTexture(index, file);
                      }} />
                    </label>
                  ) : null}
                  <span className="pointer-events-none absolute bottom-0.5 left-0.5 font-mono text-[9.5px] text-white/50">{index}</span>
                </div>
              );
            })}
          </div>
        </InspectorSection>
      ) : null}
      <InspectorSection title={t`Sharing`}>
        <InspectorRow label={t`Who`}>
          <Choice value={visibility} onChange={setVisibility} options={[{ id: "private", label: t`Just me` }, { id: "gallery", label: t`Gallery` }]} />
        </InspectorRow>
        <p className="mb-1 text-[11px] text-osu-f1">{visibility === "gallery" ? t`Other supporters can wear it and remix it.` : t`Only you can wear it.`}</p>
        <input
          value={credits}
          onChange={(event) => setCredits(event.target.value.slice(0, 300))}
          placeholder={t`Credits (optional)`}
          className="h-8 w-full rounded-md bg-osu-b6/80 px-2.5 text-[12px] text-white ring-1 ring-white/[0.06] placeholder:text-osu-f1 focus:outline-none focus:ring-osu-pink/50"
        />
      </InspectorSection>
    </>
  );

  return (
    <div className="flex h-[calc(100dvh-60px)] flex-col bg-[#100d13] text-osu-l2">
      {/* Toolbar */}
      <header className="flex h-[52px] shrink-0 items-center gap-1.5 border-b border-white/[0.07] bg-[#17131b] px-3">
        <Link to="/supporter/themes" className="flex h-8 items-center gap-1 rounded-md px-2 text-[12px] font-semibold text-osu-f1 transition-colors hover:bg-white/[0.06] hover:text-white">
          <ChevronLeft size={16} />
          {t`Themes`}
        </Link>
        <ToolDivider />
        <input
          value={name}
          onChange={(event) => setName(event.target.value.slice(0, 40))}
          placeholder={t`Untitled theme`}
          aria-label={t`Name`}
          className="h-9 w-56 min-w-0 rounded-lg bg-transparent px-2.5 text-[14px] font-semibold text-white placeholder:text-osu-f1 hover:bg-white/[0.04] focus:bg-black/30 focus:outline-none"
        />
        <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-osu-f1">{mode === "layers" ? t`Layers` : format === "shadertoy" ? "Shadertoy" : t`Code`}</span>
        <span className="ml-2 hidden text-[11.5px] text-osu-f1 md:inline">{saving ? t`Saving...` : themeId === null ? t`Not saved yet` : dirty ? t`Unsaved changes` : t`Saved`}</span>

        <div className="mx-auto flex items-center gap-0.5">
          {mode === "layers" ? (
            <>
              <ToolButton label={t`Undo`} shortcut="Ctrl Z" onClick={history.undo} disabled={!history.canUndo}><Undo2 size={16} /></ToolButton>
              <ToolButton label={t`Redo`} shortcut="Ctrl Shift Z" onClick={history.redo} disabled={!history.canRedo}><Redo2 size={16} /></ToolButton>
              <ToolDivider />
            </>
          ) : null}
          <ToolButton label={t`Desktop`} onClick={() => setPhone(false)} active={!phone}><Monitor size={16} /></ToolButton>
          <ToolButton label={t`Phone`} onClick={() => setPhone(true)} active={phone}><Smartphone size={16} /></ToolButton>
          <ToolButton label={t`Profile on top`} onClick={() => setOverlay((value) => !value)} active={overlay}><PanelsTopLeft size={16} /></ToolButton>
        </div>

        <MoreMenu
          items={[
            ...(mode === "layers" ? [{ label: t`Open as code`, onClick: () => setToCode(true) }] : [{ label: copied === "spec" ? t`Copied` : t`Copy the theme spec`, onClick: () => copy(customThemeSpec(), "spec") }]),
            { label: t`Theme spec`, href: "/supporter/themes/spec" },
            { label: t`Gallery`, href: "/supporter/themes/gallery" },
          ]}
        />
        <button
          type="button"
          onClick={requestSave}
          disabled={saving}
          className="ml-1.5 inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-lg bg-osu-pink px-5 text-[13px] font-semibold text-white transition hover:brightness-110 disabled:cursor-default disabled:opacity-60"
        >
          {saving ? t`Saving...` : t`Save`}
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Left: layers, or the code */}
        <aside className="relative flex min-h-0 shrink-0 flex-col border-r border-white/[0.07] bg-[#15111a]" style={{ width: mode === "layers" ? leftPanel.width : codePanel.width }}>
          <ResizeHandle side="right" {...(mode === "layers" ? leftPanel.handle : codePanel.handle)} />
          {mode === "layers" && doc ? (
            <LayersList
              doc={doc}
              onChange={setDoc}
              selected={selectedLayer}
              onSelect={setSelectedLayer}
              onUpload={uploadLayerImage}
              uploading={uploading !== null}
              canUpload={supporter !== null}
            />
          ) : (
            <>
              <div className="flex h-10 shrink-0 items-center gap-2 border-b border-white/[0.06] px-2">
                <StartPicker themes={STARTABLE_BUILTINS} onPick={pickStart} />
                <span className="truncate text-[11px] text-osu-f1">{t`or paste a Shadertoy shader as it is`}</span>
              </div>
              <div className="min-h-0 flex-1 bg-[#130f17]">
                {loading ? <div className="p-4 text-[12px] text-osu-f1">{t`Loading...`}</div> : <ThemeCodeEditor ref={editorRef} value={code} onChange={onCode} marks={marks} className="h-full" />}
              </div>
              <div className={`shrink-0 border-t border-white/[0.07] ${problemsOpen && problems.length ? "max-h-48" : ""}`}>
                <div className="flex h-8 items-center gap-2 px-2.5">
                  <button type="button" onClick={() => setProblemsOpen((value) => !value)} className="flex cursor-pointer items-center gap-1.5 text-[10.5px] font-bold uppercase tracking-[0.08em] text-osu-f1 hover:text-white">
                    <ChevronUp size={13} className={`transition-transform ${problemsOpen ? "" : "rotate-180"}`} />
                    {t`Problems`}
                  </button>
                  <span className={`rounded px-1.5 font-mono text-[10.5px] ${problems.length ? "bg-rose-500/20 text-rose-300" : "bg-white/[0.06] text-osu-f1"}`}>{problems.length}</span>
                  {problems.length ? (
                    <button type="button" onClick={() => copy(errorText(problems), "errors")} className="ml-auto cursor-pointer text-[11px] font-semibold text-osu-f1 hover:text-white">
                      {copied === "errors" ? t`Copied` : t`Copy all`}
                    </button>
                  ) : null}
                </div>
                {problemsOpen && problems.length ? (
                  <ul className="max-h-40 overflow-y-auto pb-1.5">
                    {problems.map((problem, index) => (
                      <li key={index}>
                        <button
                          type="button"
                          disabled={problem.line === null}
                          onClick={() => problem.line && editorRef.current?.jumpTo(problem.line)}
                          className="flex w-full cursor-pointer items-baseline gap-2 px-3 py-1 text-left text-[11.5px] text-osu-l2 hover:bg-white/[0.04] disabled:cursor-default"
                        >
                          <span className="w-12 shrink-0 font-mono text-[10.5px] text-rose-300">{problem.line ? `${t`line`} ${problem.line}` : ""}</span>
                          <span className="min-w-0">
                            {problem.snippet ? <code className="mr-2 rounded bg-black/40 px-1 text-[11px] text-white">{problem.snippet}</code> : null}
                            {problem.message}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </>
          )}
        </aside>

        {/* Stage */}
        <main
          className="relative min-w-0 flex-1 overflow-hidden"
          style={{ backgroundColor: "#0c0a0f", backgroundImage: "radial-gradient(rgba(255,255,255,0.055) 1px, transparent 1px)", backgroundSize: "18px 18px" }}
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) setSelectedLayer(null);
          }}
          onDragOver={(event) => {
            if (mode !== "layers" || !event.dataTransfer.types.includes("Files")) return;
            event.preventDefault();
            setDropping(true);
          }}
          onDragLeave={(event) => {
            if (event.target === event.currentTarget) setDropping(false);
          }}
          onDrop={(event) => {
            if (mode !== "layers") return;
            event.preventDefault();
            setDropping(false);
            const file = [...event.dataTransfer.files].find((entry) => entry.type.startsWith("image/"));
            if (file) void addImageLayer(file);
          }}
        >
          <StageFrame phone={phone}>
            <div className="relative h-full w-full overflow-hidden" style={{ backgroundColor: look.base }}>
              <canvas
                ref={canvasRef}
                className="absolute inset-0 h-full w-full"
                onPointerMove={(event) => {
                  const box = event.currentTarget.getBoundingClientRect();
                  pointerTarget.current = [(event.clientX - box.left) / box.width, 1 - (event.clientY - box.top) / box.height];
                }}
                onPointerLeave={() => {
                  pointerTarget.current = [0.5, 0.5];
                }}
                onPointerDown={() => setSelectedLayer(null)}
              />
              {overlay ? <MockProfile phone={phone} /> : null}
              {mode === "layers" && doc && !overlay ? <LayerHandles doc={doc} selected={selectedLayer} onSelect={setSelectedLayer} onPatch={updateLayer} /> : null}
              {tooHeavyLive ? (
                <div className="absolute inset-0 grid place-items-center bg-black/75 p-6 text-center text-[12.5px] text-osu-l2">
                  {t`Too heavy to run live: even a tiny frame takes too long. Lighten the loops or the fbm calls.`}
                </div>
              ) : null}
            </div>
          </StageFrame>
          {dropping ? (
            <div className="pointer-events-none absolute inset-3 grid place-items-center rounded-xl border-2 border-dashed border-osu-pink/70 bg-osu-pink/[0.06]">
              <span className="rounded-lg bg-black/70 px-3 py-2 text-[13px] font-semibold text-white">{t`Drop to add it as a picture layer`}</span>
            </div>
          ) : null}
          <div className="absolute bottom-3 left-3 flex items-center gap-2 rounded-md bg-black/50 px-2 py-1 text-[10.5px] text-osu-f1 backdrop-blur">
            {phone ? t`Phone` : t`Desktop`}
            {mode === "layers" ? <><span aria-hidden className="h-3 w-px bg-white/15" />{t`Drop pictures here`}</> : null}
          </div>
          <div className="absolute bottom-3 right-3 flex w-48 items-center gap-2 rounded-md bg-black/50 px-2.5 py-1 text-[10.5px] text-osu-f1 backdrop-blur">
            {t`Scroll`}
            <Slider value={scroll} min={0} max={3} step={0.05} onChange={setScroll} label={t`Page scroll`} small />
          </div>
        </main>

        {/* Inspector */}
        <aside className="relative flex shrink-0 flex-col border-l border-white/[0.07] bg-[#15111a]" style={{ width: rightPanel.width }}>
          <ResizeHandle side="left" {...rightPanel.handle} />
          <div className="flex h-11 shrink-0 items-end gap-1 border-b border-white/[0.07] px-3">
            {(mode === "layers" ? (["layer", "theme"] as const) : (["theme"] as const)).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setInspectorTab(tab)}
                className={`-mb-px h-10 cursor-pointer border-b-2 px-3 text-[13px] font-semibold transition-colors ${(mode === "code" || inspectorTab === tab) ? "border-osu-pink text-white" : "border-transparent text-osu-f1 hover:text-white"}`}
              >
                {tab === "layer" ? t`Layer` : t`Theme`}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {mode === "layers" && doc && inspectorTab === "layer" ? (
              <LayerInspector doc={doc} selected={selectedLayer} onChange={setDoc} onUpload={uploadLayerImage} uploading={uploading !== null} canUpload={supporter !== null} />
            ) : themeSettings}
          </div>
        </aside>
      </div>

      {/* Timeline */}
      <div className="flex h-[74px] shrink-0 items-center gap-3 border-t border-white/[0.07] bg-[#17131b] px-3">
        <button
          type="button"
          onClick={togglePlay}
          aria-label={playing ? t`Pause` : t`Play`}
          title={`${playing ? t`Pause` : t`Play`} (Space)`}
          className="grid h-9 w-9 shrink-0 cursor-pointer place-items-center rounded-full bg-white/[0.08] text-white transition-colors hover:bg-white/[0.14]"
        >
          {playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" className="translate-x-px" />}
        </button>
        <div className="w-[118px] shrink-0 whitespace-nowrap font-mono text-[12px] leading-tight">
          <span ref={clockRef} className="text-white">{clock(moment)}</span>
          <span className="text-osu-f1"> / {clock(MOMENT_MAX)}</span>
          <div className="mt-0.5 font-sans text-[10px] text-osu-f1">{playing ? t`Playing` : t`Paused: still frame`}</div>
        </div>
        <Timeline frames={filmstrip} moment={moment} playheadRef={playheadRef} onSeek={seek} />
      </div>

      {/* Status */}
      <footer className="flex h-8 shrink-0 items-center gap-4 border-t border-white/[0.07] bg-[#120f15] px-4 text-[11.5px] text-osu-f1">
        {mode === "code" ? (
          <>
            <button
              type="button"
              onClick={() => setProblemsOpen(true)}
              className={`flex items-center gap-1.5 ${problems.length ? "cursor-pointer text-rose-300" : "cursor-default"}`}
            >
              <StatusDot tone={checkTone} />
              {checkText}
            </button>
            <span aria-hidden className="h-3 w-px bg-white/10" />
          </>
        ) : null}
        <span>{fps ?? "-"} {t`fps`}</span>
        <span aria-hidden className="h-3 w-px bg-white/10" />
        <span className="flex items-center gap-1.5" title={t`Against the heaviest built-in theme: saving needs 1.00x or less.`}>
          {t`Cost`} <Meter value={cost} warn={0.75} bad={1} label={t`Cost`} /> <span className={cost !== null && cost > 1 ? "text-rose-300" : "text-osu-l2"}>{compiledOk ? costLabel : "-"}</span>
        </span>
        <span aria-hidden className="h-3 w-px bg-white/10" />
        <span className="flex items-center gap-1.5" title={t`Built-in themes sit around 0.05 to 0.15. Above 0.30, white text gets hard to read.`}>
          {t`Brightness`} <Meter value={brightness} warn={0.22} bad={BRIGHT_WARN} label={t`Brightness`} /> <span className={brightness !== null && brightness > BRIGHT_WARN ? "text-amber-300" : "text-osu-l2"}>{brightness === null ? "-" : brightness.toFixed(2)}</span>
        </span>
        {mode === "layers" && doc ? (
          <>
            <span aria-hidden className="h-3 w-px bg-white/10" />
            <span>{doc.layers.length}/{LAYERS_MAX} {t`layers`}</span>
          </>
        ) : null}
        <span className="ml-auto truncate">
          {status ? <span className={status.tone === "good" ? "text-emerald-300" : "text-rose-300"}>{status.text}</span> : cost !== null && cost > 1 ? (
            <span className="text-rose-300">{cost === Number.POSITIVE_INFINITY ? t`Far over the limit. Cut loop turns and fbm octaves a lot.` : t`About ${cost.toFixed(1)}x the limit: fewer fbm octaves or loop iterations would help.`}</span>
          ) : null}
        </span>
      </footer>

      {saveOpen ? (
        <SaveDialog
          name={name}
          onName={setName}
          visibility={visibility}
          onVisibility={setVisibility}
          credits={credits}
          onCredits={setCredits}
          rights={rights}
          onRights={setRights}
          issues={blockers.filter((blocker) => blocker !== nameBlocker && blocker !== rightsBlocker)}
          saving={saving}
          onClose={() => setSaveOpen(false)}
          onSave={() => {
            void save().then((ok) => {
              if (!ok) return;
              savedSnapshot.current = snapshot;
              setSaveOpen(false);
            });
          }}
        />
      ) : null}
      {toCode ? (
        <ConfirmModal
          title={t`Open this theme as code?`}
          body={t`You'll edit the code its layers make. There's no going back to layers for this theme.`}
          confirmLabel={t`Open as code`}
          cancelLabel={t`Cancel`}
          onConfirm={() => {
            setMode("code");
            setDoc(null);
            setSelectedLayer(null);
            liveGlsl.current = null;
          }}
          onClose={() => setToCode(false)}
        />
      ) : null}
      {replacing ? (
        <ConfirmModal
          title={t`Replace your code?`}
          body={t`What you wrote here goes, unless it's saved.`}
          confirmLabel={t`Replace`}
          cancelLabel={t`Cancel`}
          onConfirm={() => startFrom(replacing)}
          onClose={() => setReplacing(null)}
        />
      ) : null}
    </div>
  );
}

/* --- Pieces ------------------------------------------------------------------- */

/* Undo and redo over a value that changes a lot: a run of changes within a
   moment (a slider being dragged) is one step. */
function useHistory<T>(value: T | null, set: (value: T) => void) {
  const past = useRef<T[]>([]);
  const future = useRef<T[]>([]);
  const committed = useRef<T | null>(value);
  const latest = useRef<T | null>(value);
  const applying = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [, bump] = useState(0);
  latest.current = value;

  const flush = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (committed.current !== null && latest.current !== null && latest.current !== committed.current) {
      past.current.push(committed.current);
      if (past.current.length > 100) past.current.shift();
      committed.current = latest.current;
      future.current = [];
    }
  };

  useEffect(() => {
    if (value === null) return;
    if (applying.current) {
      applying.current = false;
      committed.current = value;
      return;
    }
    if (committed.current === null) {
      committed.current = value;
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      flush();
      bump((n) => n + 1);
    }, 350);
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    canUndo: past.current.length > 0 || (latest.current !== null && latest.current !== committed.current),
    canRedo: future.current.length > 0,
    undo() {
      flush();
      const previous = past.current.pop();
      if (previous === undefined || committed.current === null) return;
      future.current.push(committed.current);
      committed.current = previous;
      applying.current = true;
      set(previous);
      bump((n) => n + 1);
    },
    redo() {
      const next = future.current.pop();
      if (next === undefined || committed.current === null) return;
      past.current.push(committed.current);
      committed.current = next;
      applying.current = true;
      set(next);
      bump((n) => n + 1);
    },
  };
}

/* A side panel's width, dragged at its edge and remembered on this device.
   `grow` is which way dragging right moves it: 1 for a left panel. */
function usePanelWidth(key: string, initial: number, min: number, max: number, grow: 1 | -1) {
  const storageKey = `mania-hub-theme-editor-${key}`;
  const [width, setWidth] = useState(initial);
  useEffect(() => {
    const saved = Number(window.localStorage.getItem(storageKey));
    if (saved >= min && saved <= max) setWidth(saved);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const drag = useRef<{ x: number; width: number } | null>(null);
  const latest = useRef(width);
  latest.current = width;
  return {
    width,
    handle: {
      onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { x: event.clientX, width };
      },
      onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => {
        if (!drag.current) return;
        setWidth(Math.round(Math.min(max, Math.max(min, drag.current.width + (event.clientX - drag.current.x) * grow))));
      },
      onPointerUp: () => {
        drag.current = null;
        try {
          window.localStorage.setItem(storageKey, String(latest.current));
        } catch {
          // storage off: the width lasts this visit
        }
      },
      onDoubleClick: () => {
        setWidth(initial);
        try {
          window.localStorage.removeItem(storageKey);
        } catch {
          // nothing stored
        }
      },
    },
  };
}

function ResizeHandle({ side, ...handlers }: { side: "left" | "right" } & React.HTMLAttributes<HTMLDivElement>) {
  const { t } = useLingui();
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      title={t`Drag to resize, double-click to reset`}
      className={`group absolute inset-y-0 z-20 w-2 cursor-col-resize touch-none ${side === "right" ? "-right-1" : "-left-1"}`}
      {...handlers}
    >
      <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors group-hover:bg-osu-pink/70 group-active:bg-osu-pink" />
    </div>
  );
}

/* The preview at its device's shape, as large as the stage allows. */
function StageFrame({ phone, children }: { phone: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setSize({ width: el.clientWidth, height: el.clientHeight }));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const aspect = phone ? 9 / 19.5 : 16 / 9;
  const pad = 40;
  const width = Math.max(0, Math.min(size.width - pad * 2, (size.height - pad * 2 - 24) * aspect));
  const height = width / aspect;
  return (
    <div ref={ref} className="pointer-events-none absolute inset-0 grid place-items-center">
      <div className="pointer-events-auto relative overflow-hidden rounded-[10px] shadow-[0_0_0_1px_rgba(255,255,255,0.08),0_24px_80px_rgba(0,0,0,0.65)]" style={{ width, height }}>
        {children}
      </div>
    </div>
  );
}

function Timeline({ frames, moment, playheadRef, onSeek }: { frames: string[]; moment: number; playheadRef: React.RefObject<HTMLDivElement | null>; onSeek: (time: number) => void }) {
  const { t } = useLingui();
  const ref = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const seekAt = (clientX: number) => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    onSeek(Math.round(Math.min(1, Math.max(0, (clientX - box.left) / box.width)) * MOMENT_MAX * 10) / 10);
  };
  return (
    <div className="relative min-w-0 flex-1">
      <div className="mb-1 flex justify-between font-mono text-[9.5px] text-osu-f1/70">
        {Array.from({ length: 7 }, (_, index) => <span key={index}>{index * 5}s</span>)}
      </div>
      <div
        ref={ref}
        role="slider"
        tabIndex={0}
        aria-label={t`Time`}
        aria-valuemin={0}
        aria-valuemax={MOMENT_MAX}
        aria-valuenow={moment}
        className="relative h-9 cursor-pointer touch-none select-none overflow-hidden rounded-md bg-black/40 ring-1 ring-white/[0.07]"
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          dragging.current = true;
          seekAt(event.clientX);
        }}
        onPointerMove={(event) => dragging.current && seekAt(event.clientX)}
        onPointerUp={() => {
          dragging.current = false;
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            event.preventDefault();
            onSeek(Math.min(MOMENT_MAX, Math.max(0, moment + (event.key === "ArrowRight" ? 1 : -1) * (event.shiftKey ? 1 : 0.1))));
          }
        }}
      >
        <div className="flex h-full w-full">
          {frames.map((frame, index) => <img key={index} src={frame} alt="" draggable={false} className="h-full min-w-0 flex-1 object-cover opacity-75" />)}
        </div>
        <div ref={playheadRef} className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 bg-osu-pink shadow-[0_0_0_1px_rgba(0,0,0,0.5)]" style={{ left: `${(moment / MOMENT_MAX) * 100}%` }}>
          <span className="absolute -top-px left-1/2 h-2 w-2 -translate-x-1/2 rotate-45 bg-osu-pink" />
        </div>
      </div>
    </div>
  );
}

function MoreMenu({ items }: { items: ({ label: string; onClick: () => void } | { label: string; href: string })[] }) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align="right"
      className="w-52 p-1"
      trigger={<ToolButton label={t`More`} onClick={() => setOpen((value) => !value)}><MoreHorizontal size={16} /></ToolButton>}
    >
      {items.map((item) => ("href" in item ? (
        <a key={item.label} href={item.href} target="_blank" rel="noreferrer" className="flex h-8 items-center rounded-md px-2.5 text-[12px] text-osu-l2 hover:bg-white/[0.06] hover:text-white">{item.label}</a>
      ) : (
        <button key={item.label} type="button" onClick={() => { item.onClick(); setOpen(false); }} className="flex h-8 w-full cursor-pointer items-center rounded-md px-2.5 text-left text-[12px] text-osu-l2 hover:bg-white/[0.06] hover:text-white">{item.label}</button>
      )))}
    </Popover>
  );
}

function SaveDialog({ name, onName, visibility, onVisibility, credits, onCredits, rights, onRights, issues, saving, onClose, onSave }: {
  name: string;
  onName: (name: string) => void;
  visibility: CustomThemeVisibility;
  onVisibility: (visibility: CustomThemeVisibility) => void;
  credits: string;
  onCredits: (credits: string) => void;
  rights: boolean;
  onRights: (rights: boolean) => void;
  issues: string[];
  saving: boolean;
  onClose: () => void;
  onSave: () => void;
}) {
  const { t } = useLingui();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const ready = name.trim() && rights && issues.length === 0;
  return createPortal(
    <div className="fixed inset-0 z-[140] grid place-items-center bg-black/70 p-4" role="dialog" aria-modal="true" aria-label={t`Save theme`} onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="w-full max-w-[420px] overflow-hidden rounded-xl border border-white/[0.08] bg-[#1a151e] shadow-[0_24px_80px_rgba(0,0,0,0.7)]">
        <div className="border-b border-white/[0.07] px-5 py-4">
          <h2 className="text-[15px] font-bold text-white">{t`Save theme`}</h2>
          <p className="mt-0.5 text-[12px] text-osu-f1">{t`It goes live as soon as it's saved.`}</p>
        </div>
        <div className="grid gap-4 px-5 py-4">
          <label className="grid gap-1.5">
            <span className="text-[11.5px] font-semibold text-osu-l2">{t`Name`}</span>
            <input autoFocus value={name} onChange={(event) => onName(event.target.value.slice(0, 40))} placeholder={t`What it's called`} className="h-9 rounded-lg bg-black/30 px-3 text-[13px] text-white ring-1 ring-white/10 placeholder:text-osu-f1 focus:outline-none focus:ring-osu-pink/60" />
          </label>
          <div className="grid gap-1.5">
            <span className="text-[11.5px] font-semibold text-osu-l2">{t`Who can wear it`}</span>
            <div className="grid grid-cols-2 gap-2">
              {([["private", t`Just me`, t`Only on your profile`], ["gallery", t`Gallery`, t`Others can wear and remix it`]] as const).map(([id, title, blurb]) => (
                <button key={id} type="button" onClick={() => onVisibility(id)} className={`cursor-pointer rounded-lg p-2.5 text-left ring-1 transition-colors ${visibility === id ? "bg-osu-pink/[0.12] ring-osu-pink/70" : "bg-black/20 ring-white/[0.08] hover:ring-white/20"}`}>
                  <span className="block text-[12.5px] font-semibold text-white">{title}</span>
                  <span className="block text-[11px] text-osu-f1">{blurb}</span>
                </button>
              ))}
            </div>
          </div>
          <label className="grid gap-1.5">
            <span className="text-[11.5px] font-semibold text-osu-l2">{t`Credits`} <span className="font-normal text-osu-f1">{t`(optional)`}</span></span>
            <input value={credits} onChange={(event) => onCredits(event.target.value.slice(0, 300))} placeholder={t`Artists, shaders it builds on`} className="h-9 rounded-lg bg-black/30 px-3 text-[12.5px] text-white ring-1 ring-white/10 placeholder:text-osu-f1 focus:outline-none focus:ring-osu-pink/60" />
          </label>
          <div className="flex items-start gap-2.5 text-[12px] leading-relaxed text-osu-l2">
            <span className="mt-0.5"><Switch checked={rights} onChange={onRights} label={t`I understand`} /></span>
            <span>
              <Trans>
                I understand I'm responsible for what I put in my themes, and that one breaking the{" "}
                <Link to="/terms" className="text-osu-f1 underline underline-offset-2 hover:text-white">Terms</Link> can be taken down.
              </Trans>
            </span>
          </div>
          {issues.length ? (
            <ul className="grid gap-1 rounded-lg bg-rose-500/[0.08] px-3 py-2 text-[11.5px] text-rose-200">
              {issues.map((issue) => <li key={issue}>{issue}</li>)}
            </ul>
          ) : null}
        </div>
        <div className="flex justify-end gap-2 border-t border-white/[0.07] px-5 py-3">
          <button type="button" onClick={onClose} className="h-9 cursor-pointer rounded-lg px-3.5 text-[12.5px] font-semibold text-osu-l2 hover:bg-white/[0.06] hover:text-white">{t`Cancel`}</button>
          <button type="button" disabled={!ready || saving} onClick={onSave} className="h-9 cursor-pointer rounded-lg bg-osu-pink px-4 text-[12.5px] font-semibold text-white transition hover:brightness-110 disabled:cursor-default disabled:opacity-45">
            {saving ? t`Saving...` : t`Save and put it live`}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function SmallButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="h-8 shrink-0 cursor-pointer rounded-md bg-white/[0.06] px-2.5 text-[11.5px] font-semibold text-osu-l2 transition-colors hover:bg-white/[0.1] hover:text-white">
      {children}
    </button>
  );
}

/* Panels and text where a profile puts them, to check the theme reads under them. */
function MockProfile({ phone }: { phone: boolean }) {
  return (
    <div className="pointer-events-none absolute inset-0 flex flex-col items-center px-[6%] pt-[8%]">
      <span className="aspect-square w-[14%] min-w-8 rounded-xl bg-white/80" />
      <span className="mt-[2%] h-[5%] w-[30%] rounded bg-white" />
      <div className={`mt-auto grid w-full gap-[3%] pb-[5%] ${phone ? "grid-cols-1" : "grid-cols-3"}`}>
        {Array.from({ length: phone ? 2 : 3 }, (_, index) => (
          <div key={index} className="rounded-lg bg-osu-b5/85 p-[6%]">
            <span className="block h-2 w-1/2 rounded bg-white/70" />
            <span className="mt-2 block h-1.5 w-4/5 rounded bg-white/30" />
            <span className="mt-1.5 block h-1.5 w-3/5 rounded bg-white/30" />
          </div>
        ))}
      </div>
    </div>
  );
}
