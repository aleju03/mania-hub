import { Trans, useLingui } from "@lingui/react/macro";
import { Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

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
import { BasePad, HUE_STRIP, Slider, strengthStrip } from "./EditorControls";
import { RowFramer } from "./RowFramer";
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
  from?: string;
  remix?: number;
}

type Problem = { line: number | null; snippet: string | null; message: string };

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
  const [paused, setPaused] = useState(false);
  const [scroll, setScroll] = useState(0);
  const [moment, setMoment] = useState(4);
  const [framing, setFraming] = useState<RowFraming>({ zoom: 1.4, x: 0.6, y: 0.45 });
  const [rowSource, setRowSource] = useState<{ url: string; width: number; height: number } | null>(null);
  const [filmstrip, setFilmstrip] = useState<string[]>([]);
  const [replacing, setReplacing] = useState<"starter" | SupporterProfileThemeId | null>(null);
  const scrubbedFrom = useRef<boolean | null>(null);
  const [rowPreview, setRowPreview] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ tone: "good" | "bad"; text: string } | null>(null);
  const [uploading, setUploading] = useState<number | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const glRef = useRef<ThemeEditorGl | null>(null);
  const editorRef = useRef<ThemeCodeEditorHandle>(null);
  const pointer = useRef<[number, number]>([0.5, 0.5]);
  const pointerTarget = useRef<[number, number]>([0.5, 0.5]);
  const live = useRef({ paused, moment, scroll, tooHeavyLive });
  live.current = { paused, moment, scroll, tooHeavyLive };

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
    const started = performance.now();
    const tick = () => {
      frame = requestAnimationFrame(tick);
      const now = performance.now();
      const { paused: still, moment: at, scroll: scrolled, tooHeavyLive: heavy } = live.current;
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
      gl.draw({ time: still ? at : (now - started) / 1000, pointer: pointer.current, scroll: scrolled });
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
  }, [code, loading]);

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

  const blockers: string[] = [];
  if (supporter === false) blockers.push(t`Only supporters can save themes. Everything here works as a preview.`);
  if (disabled) blockers.push(t`Custom themes are switched off for now, so saving is too.`);
  if (!name.trim()) blockers.push(t`Give it a name.`);
  if (!compiledOk) blockers.push(t`Fix the code's errors first.`);
  if (cost !== null && cost > 1) blockers.push(t`It's heavier than the limit.`);
  if (!rights) blockers.push(t`Tick "I understand" under Sharing.`);

  const save = async () => {
    const gl = glRef.current;
    if (!gl?.ready || blockers.length || saving) return;
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
        data: { themeId, name: name.trim(), visibility, credits, remixedFrom, source: code, assets, look, stillUrl, rowUrl, costRatio: measured, rightsConfirmed: rights },
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
    } catch (cause) {
      setStatus({ tone: "bad", text: cause instanceof Error ? cause.message : String(cause) });
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
      case "rights_not_confirmed": return t`Tick "I understand" under Sharing.`;
      case "signed_out": return t`Sign in to save.`;
      default: return t`Could not save the theme.`;
    }
  };

  const marks = useMemo(() => problems.filter((problem) => problem.line !== null).map((problem) => ({ line: problem.line!, message: problem.message })), [problems]);
  const onCode = useCallback((value: string) => {
    setCode(value);
    setEdited(true);
  }, []);

  if (loadError) {
    return (
      <div className="mx-auto max-w-[1400px] px-4 py-10 text-center text-[13px] text-osu-l2">
        {loadError}{" "}
        <Link to="/supporter/themes" className="font-semibold text-osu-pink-light hover:underline">{t`Back to your themes`}</Link>
      </div>
    );
  }

  const costText = cost === null
    ? t`measuring`
    : cost === Number.POSITIVE_INFINITY
      ? t`far over the limit`
      : t`${cost.toFixed(2)}x the heaviest built-in`;

  return (
    <div className="mx-auto grid max-w-[1400px] gap-5 px-4 py-5 sm:px-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      {/* Code */}
      <section className="min-w-0">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <StartPicker themes={STARTABLE_BUILTINS} onPick={pickStart} />
          <span className="text-[11.5px] text-osu-f1">{t`or paste a Shadertoy shader as it is`}</span>
          <span className="ml-auto flex items-center gap-1.5">
            <SmallButton onClick={() => copy(customThemeSpec(), "spec")}>{copied === "spec" ? t`Copied` : t`Copy the theme spec`}</SmallButton>
            <Link to="/supporter/themes/spec" className="text-[11.5px] font-semibold text-osu-f1 hover:text-white">{t`Read it`}</Link>
          </span>
        </div>
        <div className="h-[62vh] min-h-[360px] overflow-hidden rounded-xl border border-white/[0.07] bg-[#17121b]">
          {loading ? <div className="p-4 text-[12px] text-osu-f1">{t`Loading...`}</div> : <ThemeCodeEditor ref={editorRef} value={code} onChange={onCode} marks={marks} className="h-full" />}
        </div>
        <div className="mt-2 min-h-[44px]">
          {checking ? (
            <p className="text-[12px] text-osu-f1">{t`Checking...`}</p>
          ) : problems.length ? (
            <div>
              <div className="mb-1.5 flex items-center gap-2">
                <span className="text-[12px] font-semibold text-osu-red-light">{problems.length === 1 ? t`1 error` : t`${problems.length} errors`}</span>
                <SmallButton onClick={() => copy(errorText(problems), "errors")}>{copied === "errors" ? t`Copied` : t`Copy errors`}</SmallButton>
              </div>
              <ul className="max-h-40 space-y-1 overflow-y-auto">
                {problems.map((problem, index) => (
                  <li key={index}>
                    <button
                      type="button"
                      disabled={problem.line === null}
                      onClick={() => problem.line && editorRef.current?.jumpTo(problem.line)}
                      className="w-full cursor-pointer rounded-md px-2 py-1 text-left text-[12px] text-osu-l2 hover:bg-white/[0.04] disabled:cursor-default disabled:hover:bg-transparent"
                    >
                      {problem.line ? <span className="mr-2 font-mono text-osu-red-light">{t`line ${problem.line}`}</span> : null}
                      {problem.snippet ? <code className="mr-2 rounded bg-black/30 px-1 text-[11.5px] text-white">{problem.snippet}</code> : null}
                      {problem.message}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-[12px] text-osu-f1">{format === "shadertoy" ? t`Reads as a Shadertoy shader. No errors.` : t`No errors.`}</p>
          )}
        </div>
      </section>

      {/* Preview */}
      <section className="min-w-0">
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          <Toggle on={!phone} onClick={() => setPhone(false)}>{t`Desktop`}</Toggle>
          <Toggle on={phone} onClick={() => setPhone(true)}>{t`Phone`}</Toggle>
          <span aria-hidden className="mx-1 h-4 w-px bg-white/10" />
          <Toggle on={overlay} onClick={() => setOverlay((value) => !value)}>{t`Profile on top`}</Toggle>
          <Toggle on={paused} onClick={() => setPaused((value) => !value)}>{t`Still`}</Toggle>
          <div className="ml-auto flex w-40 items-center gap-2 text-[11.5px] text-osu-f1">
            {t`Scroll`}
            <Slider value={scroll} min={0} max={3} step={0.05} onChange={setScroll} label={t`Scroll`} />
          </div>
        </div>
        <div className={`relative mx-auto overflow-hidden rounded-xl border border-white/[0.07] ${phone ? "aspect-[9/19.5] w-[min(100%,300px)]" : "aspect-video w-full"}`} style={{ backgroundColor: look.base }}>
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
          />
          {overlay ? <MockProfile phone={phone} /> : null}
          {tooHeavyLive ? (
            <div className="absolute inset-0 grid place-items-center bg-black/70 p-6 text-center text-[12.5px] text-osu-l2">
              {t`Too heavy to run live: even a tiny frame takes too long. Lighten the loops or the fbm calls.`}
            </div>
          ) : null}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-osu-f1">
          <Stat label={t`fps here`}>{fps ?? "-"}</Stat>
          <Hairline />
          <Stat label={t`cost`} tone={cost !== null && cost > 1 ? "bad" : undefined}>{compiledOk ? costText : "-"}</Stat>
          <Hairline />
          <Stat label={t`brightness`} tone={brightness !== null && brightness > BRIGHT_WARN ? "warn" : undefined}>{brightness === null ? "-" : brightness.toFixed(2)}</Stat>
          <Hairline />
          <Stat label={t`images`}>{`${assets.length}/${CUSTOM_THEME_TEXTURES}`}</Stat>
        </div>
        {cost !== null && cost > 1 ? (
          <p className="mt-1 text-[11.5px] text-osu-red-light">
            {cost === Number.POSITIVE_INFINITY
              ? t`Far over the limit. Cut loop turns and fbm octaves a lot.`
              : t`About ${cost.toFixed(1)}x the limit: fewer fbm octaves or loop iterations would help.`}
          </p>
        ) : null}
        {brightness !== null && brightness > BRIGHT_WARN ? (
          <p className="mt-1 text-[11.5px] text-amber-300">{t`Quite bright: white text on top will be hard to read. Built-in themes sit around 0.05 to 0.15.`}</p>
        ) : null}

        {/* Details */}
        <div className="mt-5 space-y-5">
          <Group title={t`Name`}>
            <input
              value={name}
              onChange={(event) => setName(event.target.value.slice(0, 40))}
              placeholder={t`What it's called`}
              className="h-9 w-full rounded-lg border border-white/10 bg-osu-b6 px-3 text-[13px] text-white placeholder:text-osu-f1 focus:border-osu-pink/50 focus:outline-none"
            />
          </Group>

          <Group title={t`Moment`} hint={t`The frame used for the still (thumbnails, the gallery, slow devices) and the banner row.`}>
            <Slider
              value={moment}
              min={0}
              max={MOMENT_MAX}
              step={0.1}
              onChange={setMoment}
              label={t`Moment`}
              format={(value) => `${value.toFixed(1)}s`}
              onDragStart={() => {
                scrubbedFrom.current = paused;
                setPaused(true);
              }}
              onDragEnd={() => {
                if (scrubbedFrom.current === false) setPaused(false);
                scrubbedFrom.current = null;
              }}
              track={
                <div className="flex h-full w-full">
                  {filmstrip.map((frame, index) => <img key={index} src={frame} alt="" draggable={false} className="h-full min-w-0 flex-1 object-cover opacity-80" />)}
                </div>
              }
            />
            <p className="mt-1 text-[11px] text-osu-f1">{t`Drag along it to see each moment in the preview.`}</p>
          </Group>

          <Group title={t`Images`} hint={t`Up to four, read in the code as u_tex0 to u_tex3 (iChannel0 to iChannel3 in Shadertoy code).`}>
            <div className="grid max-w-[440px] grid-cols-4 gap-2">
              {Array.from({ length: CUSTOM_THEME_TEXTURES }, (_, index) => {
                const url = assets[index];
                const slot = index === assets.length;
                return (
                  <div key={index} className="relative aspect-square overflow-hidden rounded-lg bg-osu-b6 ring-1 ring-white/[0.07]">
                    {url ? (
                      <>
                        <img src={url} alt="" className="h-full w-full object-cover" />
                        <button
                          type="button"
                          onClick={() => setAssets((current) => current.filter((_, at) => at !== index))}
                          className="absolute right-1 top-1 cursor-pointer rounded bg-black/70 px-1.5 text-[11px] text-white hover:bg-black"
                        >
                          {t`Remove`}
                        </button>
                        <span className="absolute bottom-1 left-1 rounded bg-black/70 px-1 font-mono text-[10.5px] text-white">u_tex{index}</span>
                      </>
                    ) : slot ? (
                      <label className="grid h-full w-full cursor-pointer place-items-center text-[11.5px] font-semibold text-osu-f1 hover:text-white">
                        {uploading === index ? t`Uploading...` : t`Add image`}
                        <input type="file" accept="image/*" className="hidden" disabled={uploading !== null || supporter !== true} onChange={(event) => {
                          const file = event.target.files?.[0];
                          event.target.value = "";
                          if (file) void addTexture(index, file);
                        }} />
                      </label>
                    ) : (
                      <span className="grid h-full w-full place-items-center font-mono text-[10.5px] text-osu-f1/40">u_tex{index}</span>
                    )}
                  </div>
                );
              })}
            </div>
            {supporter === false ? <p className="mt-1.5 text-[11.5px] text-osu-f1">{t`Uploading images is for supporters.`}</p> : null}
          </Group>

          <Group title={t`Site colours`} hint={t`The tint the rest of the profile takes while the theme is on. Picked from the theme until you change it.`}>
            <div className="grid gap-2.5 sm:grid-cols-[minmax(0,1fr)_180px]">
              <div className="grid gap-2.5">
                <div className="flex items-center gap-3 text-[11.5px] text-osu-f1">
                  <span className="w-16">{t`Hue`}</span>
                  <Slider value={look.hue} min={0} max={360} onChange={(hue) => { lookTouched.current = true; setLook({ ...look, hue }); }} label={t`Hue`} gradient={HUE_STRIP} thumbColor={`hsl(${look.hue}, 90%, 55%)`} />
                </div>
                <div className="flex items-center gap-3 text-[11.5px] text-osu-f1">
                  <span className="w-16">{t`Strength`}</span>
                  <Slider value={look.sat} min={0} max={1} step={0.01} onChange={(sat) => { lookTouched.current = true; setLook({ ...look, sat }); }} label={t`Strength`} gradient={strengthStrip(look.hue)} thumbColor={`hsl(${look.hue}, ${Math.round(look.sat * 100)}%, 55%)`} />
                </div>
                <div className="flex items-start gap-3 text-[11.5px] text-osu-f1">
                  <span className="w-16 pt-1">{t`Base`}</span>
                  <BasePad value={look.base} onChange={(base) => { lookTouched.current = true; setLook({ ...look, base }); }} label={t`Base colour`} />
                </div>
              </div>
              <div className="flex flex-col gap-2">
                <div className="flex-1 rounded-lg p-2.5 ring-1 ring-white/[0.07]" style={{ backgroundColor: look.base }}>
                  <span className="block h-2 w-2/3 rounded" style={{ background: `hsl(${look.hue} ${Math.round(look.sat * 100)}% 62%)` }} />
                  <span className="mt-2 block rounded-md p-1.5" style={{ background: `hsl(${look.hue} ${Math.round(look.sat * 35)}% 14% / 0.9)` }}>
                    <span className="block h-1.5 w-4/5 rounded bg-white/70" />
                    <span className="mt-1 block h-1.5 w-1/2 rounded bg-white/30" />
                  </span>
                </div>
                <SmallButton onClick={() => {
                  const sample = glRef.current?.capture(64, 36, { time: moment, pointer: CENTRE, scroll: 0 });
                  if (sample) setLook(suggestLook(sample));
                }}>{t`Pick from the theme`}</SmallButton>
              </div>
            </div>
          </Group>

          <Group title={t`Banner row`} hint={t`What shows behind your row in rankings and lists when you turn rows on: a still of the theme, at the moment above.`}>
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
              <RowFramer source={rowSource} framing={framing} onChange={setFraming} aspect={ROW.width / ROW.height} />
              <div className="flex flex-col gap-2">
                <div className="flex h-12 items-center gap-3 rounded-lg bg-osu-b4 px-3" style={rowPreview ? supporterRowBackground({ image: rowPreview }) : undefined}>
                  <span className="w-6 text-[12px] font-semibold text-osu-f1">#1</span>
                  <span className="h-7 w-7 rounded-md bg-osu-b2" />
                  <span className="text-[13px] font-semibold text-white">{t`Your name`}</span>
                </div>
                <div className="flex h-12 items-center gap-3 rounded-lg bg-osu-b4/60 px-3 opacity-60">
                  <span className="w-6 text-[12px] font-semibold text-osu-f1">#2</span>
                  <span className="h-7 w-7 rounded-md bg-osu-b2" />
                  <span className="h-2 w-20 rounded bg-white/40" />
                </div>
                <p className="text-[11px] text-osu-f1">{t`Drag the box to move it, scroll over it to zoom.`}</p>
              </div>
            </div>
          </Group>

          <Group title={t`Sharing`}>
            <div className="flex flex-wrap gap-1.5">
              <Toggle on={visibility === "private"} onClick={() => setVisibility("private")}>{t`Just me`}</Toggle>
              <Toggle on={visibility === "gallery"} onClick={() => setVisibility("gallery")}>{t`In the gallery`}</Toggle>
            </div>
            <p className="mt-1.5 text-[11.5px] text-osu-f1">
              {visibility === "gallery" ? t`Other supporters can wear it and remix its code.` : t`Only you can wear it.`}
            </p>
            <input
              value={credits}
              onChange={(event) => setCredits(event.target.value.slice(0, 300))}
              placeholder={t`Credits (optional): artists, shaders it builds on`}
              className="mt-2 h-9 w-full rounded-lg border border-white/10 bg-osu-b6 px-3 text-[12.5px] text-white placeholder:text-osu-f1 focus:border-osu-pink/50 focus:outline-none"
            />
            <div className="mt-3 flex items-start gap-2.5 text-[12.5px] text-osu-l2">
              <span className="mt-px"><Switch checked={rights} onChange={setRights} label={t`I understand`} /></span>
              <span>
                <Trans>
                  I understand I'm responsible for what I put in my themes, and that one breaking the{" "}
                  <Link to="/terms" className="text-osu-f1 underline underline-offset-2 hover:text-white">Terms</Link> can be taken down.
                </Trans>
              </span>
            </div>
          </Group>

          <div className="flex flex-wrap items-center gap-3 border-t border-white/[0.07] pt-4">
            <button
              type="button"
              onClick={() => void save()}
              disabled={blockers.length > 0 || saving}
              className="h-9 cursor-pointer rounded-full bg-osu-pink px-5 text-[13px] font-semibold text-white transition hover:brightness-110 disabled:cursor-default disabled:opacity-50 disabled:hover:brightness-100"
            >
              {saving ? t`Saving...` : themeId === null ? t`Save and put it live` : t`Save changes`}
            </button>
            {status ? (
              <span className={`text-[12.5px] ${status.tone === "good" ? "text-emerald-300" : "text-osu-red-light"}`}>{status.text}</span>
            ) : blockers.length ? (
              <span className="text-[12px] text-osu-f1">{blockers[0]}</span>
            ) : null}
          </div>
        </div>
      </section>
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

function Group({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="text-xs font-semibold uppercase tracking-wider text-osu-f1">{title}</h3>
      {hint ? <p className="mb-2 mt-0.5 text-[11.5px] text-osu-f1/80">{hint}</p> : <div className="mb-2" />}
      {children}
    </section>
  );
}

function Toggle({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={`h-7 cursor-pointer rounded-full px-3 text-[11.5px] font-semibold transition-colors ${on ? "bg-osu-pink/20 text-osu-pink-light" : "bg-osu-b4 text-osu-f1 hover:text-white"}`}
    >
      {children}
    </button>
  );
}

function SmallButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="h-7 cursor-pointer rounded-lg bg-osu-b4 px-2.5 text-[11.5px] font-semibold text-osu-f1 transition-colors hover:bg-osu-b3 hover:text-white">
      {children}
    </button>
  );
}

function Stat({ label, tone, children }: { label: string; tone?: "bad" | "warn"; children: ReactNode }) {
  return (
    <span>
      {label}{" "}
      <span className={`font-semibold ${tone === "bad" ? "text-osu-red-light" : tone === "warn" ? "text-amber-300" : "text-osu-l2"}`}>{children}</span>
    </span>
  );
}

function Hairline() {
  return <span aria-hidden className="h-3 w-px bg-white/15" />;
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
