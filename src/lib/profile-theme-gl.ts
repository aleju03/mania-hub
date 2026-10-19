import { PROFILE_THEME_SHADERS, PROFILE_THEME_VERTEX } from "./profile-theme-shaders";
import { HIGHWAY_MAX_LANES, type HighwayChart, type HighwayNotes, type SupporterProfileThemeId } from "./supporter-profile-themes";

/* Runs the profile theme backdrops (profile-theme-shaders.ts). Loaded on
   demand, the first time a themed profile or the theme drawer shows.

   - A backdrop is one WebGL2 canvas filling its host, drawn at a capped
     pixel count (they are soft, so a little upscaling never shows) and at
     most 60 times a second, only while on screen. It follows the page's
     scroll and the pointer.
   - Swatches (the drawer's tiles) share one offscreen context, drawn in turn
     at 30fps and copied into each tile's 2D canvas, like the foil swatches.
   - Under reduced motion every one draws a single still.
   - The Note highway can be handed a player's replay skin notes
     (use-highway-notes.ts): the lane count, an atlas of each lane's note and
     their colours, as uniforms the other themes simply do not declare. */

interface Compiled {
  program: WebGLProgram;
  time: WebGLUniformLocation | null;
  res: WebGLUniformLocation | null;
  pointer: WebGLUniformLocation | null;
  scroll: WebGLUniformLocation | null;
  lanes: WebGLUniformLocation | null;
  noteArt: WebGLUniformLocation | null;
  noteColors: WebGLUniformLocation | null;
  noteAspect: WebGLUniformLocation | null;
  noteColor: WebGLUniformLocation | null;
  notes: WebGLUniformLocation | null;
  accent: WebGLUniformLocation | null;
  chart: WebGLUniformLocation | null;
  chartNotes: WebGLUniformLocation | null;
  chartIndex: WebGLUniformLocation | null;
  chartPeriod: WebGLUniformLocation | null;
  chartBucket: WebGLUniformLocation | null;
  chartLaneEnd: WebGLUniformLocation | null;
  judgements: WebGLUniformLocation | null;
  sprite: WebGLUniformLocation | null;
}

/* Licensed art a theme's shader draws (sources in public/images/profile-themes/SOURCES.md). */
const THEME_SPRITES: Partial<Record<SupporterProfileThemeId, string>> = {
  koi: "/images/profile-themes/koi-pads.png",
  vaporwave: "/images/profile-themes/palm.png",
};

const STILL_TIME = 6.5;

function reducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

class ThemeContext {
  private programs = new Map<SupporterProfileThemeId, Compiled | null>();
  private vertex: WebGLShader | null;
  private noteTexture: WebGLTexture | null;
  private noteKey: string | null = null;
  private chartNotesTexture: WebGLTexture | null;
  private chartIndexTexture: WebGLTexture | null;
  private chartKey: string | null = null;
  private judgementTexture: WebGLTexture | null;
  private judgementSource: HTMLCanvasElement | null = null;
  /* Each theme's sprite once it has loaded (unit 4), and a blank until then. */
  private sprites = new Map<SupporterProfileThemeId, WebGLTexture | null>();
  private blank: WebGLTexture | null = null;
  /* The site's default judgements, built once the first time a shader asks. */
  private defaultJudgements: HTMLCanvasElement | null | undefined;

  constructor(readonly gl: WebGL2RenderingContext) {
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    this.vertex = this.compile(gl.VERTEX_SHADER, PROFILE_THEME_VERTEX);
    // Unit 0 always holds something, so a shader that samples it never reads an unbound unit.
    this.noteTexture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.noteTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // Units 1 and 2: a real chart's notes and its per-lane index, read texel by texel.
    this.chartNotesTexture = this.dataTexture(1, gl.RGBA32F, gl.RGBA, 1, 1, new Float32Array(4));
    this.chartIndexTexture = this.dataTexture(2, gl.R32F, gl.RED, 1, 1, new Float32Array([-1]));
    // Unit 3: the judgements atlas, blank until one is ready.
    this.judgementTexture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.judgementTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
    gl.activeTexture(gl.TEXTURE0);
  }

  /* Binds the theme's sprite on unit 4, loading it the first time. */
  private bindSprite(theme: SupporterProfileThemeId) {
    const { gl } = this;
    if (!this.blank) {
      this.blank = gl.createTexture();
      gl.activeTexture(gl.TEXTURE4);
      gl.bindTexture(gl.TEXTURE_2D, this.blank);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
    }
    const url = THEME_SPRITES[theme];
    if (url && !this.sprites.has(theme)) {
      this.sprites.set(theme, null);
      const image = new Image();
      image.decoding = "async";
      image.onload = () => {
        const texture = gl.createTexture();
        gl.activeTexture(gl.TEXTURE4);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.activeTexture(gl.TEXTURE0);
        this.sprites.set(theme, texture);
      };
      image.src = url;
    }
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this.sprites.get(theme) ?? this.blank);
    gl.activeTexture(gl.TEXTURE0);
  }

  /* Premultiplied and mipmapped, so a blurred lookup gives the sprite's glow. */
  private uploadJudgements(own: HTMLCanvasElement | null) {
    if (!own && this.defaultJudgements === undefined) {
      this.defaultJudgements = null;
      void import("./judgement-atlas").then(({ buildJudgementAtlas }) => buildJudgementAtlas()).then((atlas) => {
        this.defaultJudgements = atlas;
      }).catch(() => {});
    }
    const source = own ?? this.defaultJudgements ?? null;
    if (source === this.judgementSource || !source) return;
    const { gl } = this;
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.judgementTexture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.judgementSource = source;
    } catch {
      // a tainted canvas: keep what was there
    }
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.activeTexture(gl.TEXTURE0);
  }

  private dataTexture(unit: number, internal: number, format: number, width: number, height: number, data: Float32Array, texture?: WebGLTexture | null): WebGLTexture | null {
    const { gl } = this;
    const target = texture ?? gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, target);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, width, height, 0, format, gl.FLOAT, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.activeTexture(gl.TEXTURE0);
    return target;
  }

  private uploadChart(chart: HighwayChart | null) {
    const key = chart?.key ?? null;
    if (key === this.chartKey) return;
    const { gl } = this;
    if (chart) {
      this.dataTexture(1, gl.RGBA32F, gl.RGBA, chart.notesWidth, chart.notesHeight, chart.notes, this.chartNotesTexture);
      this.dataTexture(2, gl.R32F, gl.RED, chart.buckets, chart.lanes, chart.index, this.chartIndexTexture);
    }
    this.chartKey = key;
  }

  /* Uploads the notes' atlas when it changes; false if the browser refused it. */
  private uploadNotes(notes: HighwayNotes | null): boolean {
    const atlas = notes?.atlas ?? null;
    const key = atlas ? notes!.key : null;
    if (key === this.noteKey) return true;
    const { gl } = this;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.noteTexture);
    try {
      if (atlas) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlas);
      else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
    } catch {
      return false;
    }
    this.noteKey = key;
    return true;
  }

  private compile(type: number, source: string): WebGLShader | null {
    const { gl } = this;
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
    if (import.meta.env.DEV) console.warn("profile theme shader", gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }

  /* Compiled once per theme and kept, so switching back is instant. Null if it failed. */
  private compiled(theme: SupporterProfileThemeId): Compiled | null {
    if (this.programs.has(theme)) return this.programs.get(theme)!;
    const { gl } = this;
    const fragment = this.compile(gl.FRAGMENT_SHADER, PROFILE_THEME_SHADERS[theme]);
    const program = gl.createProgram();
    let compiled: Compiled | null = null;
    if (this.vertex && fragment && program) {
      gl.attachShader(program, this.vertex);
      gl.attachShader(program, fragment);
      gl.bindAttribLocation(program, 0, "a_position");
      gl.linkProgram(program);
      if (gl.getProgramParameter(program, gl.LINK_STATUS)) {
        compiled = {
          program,
          time: gl.getUniformLocation(program, "u_time"),
          res: gl.getUniformLocation(program, "u_res"),
          pointer: gl.getUniformLocation(program, "u_pointer"),
          scroll: gl.getUniformLocation(program, "u_scroll"),
          lanes: gl.getUniformLocation(program, "u_lanes"),
          noteArt: gl.getUniformLocation(program, "u_noteArt"),
          noteColors: gl.getUniformLocation(program, "u_noteColors"),
          noteAspect: gl.getUniformLocation(program, "u_noteAspect"),
          noteColor: gl.getUniformLocation(program, "u_noteColor"),
          notes: gl.getUniformLocation(program, "u_notes"),
          accent: gl.getUniformLocation(program, "u_accent"),
          chart: gl.getUniformLocation(program, "u_chart"),
          chartNotes: gl.getUniformLocation(program, "u_chartNotes"),
          chartIndex: gl.getUniformLocation(program, "u_chartIndex"),
          chartPeriod: gl.getUniformLocation(program, "u_chartPeriod"),
          chartBucket: gl.getUniformLocation(program, "u_chartBucket"),
          chartLaneEnd: gl.getUniformLocation(program, "u_chartLaneEnd"),
          judgements: gl.getUniformLocation(program, "u_judgements"),
          sprite: gl.getUniformLocation(program, "u_sprite"),
        };
      }
    }
    this.programs.set(theme, compiled);
    return compiled;
  }

  draw(theme: SupporterProfileThemeId, width: number, height: number, time: number, pointer: [number, number], scroll: number, notes: HighwayNotes | null = null, chart: HighwayChart | null = null): boolean {
    const compiled = this.compiled(theme);
    if (!compiled) return false;
    const { gl } = this;
    gl.viewport(0, 0, width, height);
    gl.useProgram(compiled.program);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.uniform1f(compiled.time, time);
    gl.uniform2f(compiled.res, width, height);
    gl.uniform2f(compiled.pointer, pointer[0], pointer[1]);
    gl.uniform1f(compiled.scroll, scroll);
    if (compiled.lanes) {
      const art = this.uploadNotes(notes) && !!notes?.atlas;
      const aspects = new Float32Array(HIGHWAY_MAX_LANES);
      const colors = new Float32Array(HIGHWAY_MAX_LANES * 3);
      notes?.aspects.forEach((aspect, lane) => (aspects[lane] = aspect));
      notes?.colors.forEach((color, lane) => colors.set(color, lane * 3));
      // a real chart plays in the skin's keymode; one that does not match it waits
      const playing = chart && (!notes || notes.lanes === chart.lanes) ? chart : null;
      this.uploadChart(playing);
      gl.uniform1f(compiled.lanes, notes?.lanes ?? playing?.lanes ?? 4);
      gl.uniform1f(compiled.chart, playing ? 1 : 0);
      gl.uniform1i(compiled.chartNotes, 1);
      gl.uniform1i(compiled.chartIndex, 2);
      gl.uniform1f(compiled.chartPeriod, playing?.period ?? 1);
      gl.uniform2f(compiled.chartBucket, playing?.bucketMs ?? 100, playing?.buckets ?? 1);
      const laneEnd = new Float32Array(HIGHWAY_MAX_LANES);
      playing?.laneEnd.forEach((end, lane) => (laneEnd[lane] = end));
      gl.uniform1fv(compiled.chartLaneEnd, laneEnd);
      gl.uniform1f(compiled.noteArt, art ? 1 : 0);
      gl.uniform1f(compiled.noteColors, notes ? 1 : 0);
      gl.uniform1fv(compiled.noteAspect, aspects);
      gl.uniform3fv(compiled.noteColor, colors);
      gl.uniform1i(compiled.notes, 0);
      const accent = notes?.accent ?? [0.3, 0.5, 1];
      gl.uniform3f(compiled.accent, accent[0], accent[1], accent[2]);
    }
    if (compiled.sprite) {
      this.bindSprite(theme);
      gl.uniform1i(compiled.sprite, 4);
    }
    if (compiled.judgements) {
      this.uploadJudgements(notes?.judgements ?? null);
      gl.uniform1i(compiled.judgements, 3);
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return true;
  }
}

function webgl2(canvas: HTMLCanvasElement): WebGL2RenderingContext | null {
  return canvas.getContext("webgl2", { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: "low-power" });
}

/* --- Backdrops ----------------------------------------------------------- */

export interface ProfileBackdrop {
  setTheme(theme: SupporterProfileThemeId): void;
  setNotes(notes: HighwayNotes | null): void;
  setChart(chart: HighwayChart | null): void;
  dispose(): void;
}

/* Fills `host` with the theme's backdrop. `scroll` makes it follow the page's
   scroll (the profile); the /supporter stage leaves it still. Null without
   WebGL2, where the host's flat colour stays. */
export function mountProfileBackdrop(
  host: HTMLElement,
  initial: SupporterProfileThemeId,
  { scroll = false, maxPixels = 1_000_000 }: { scroll?: boolean; maxPixels?: number } = {},
): ProfileBackdrop | null {
  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block;opacity:0;transition:opacity .6s ease";
  const gl = webgl2(canvas);
  if (!gl) return null;
  host.appendChild(canvas);
  const context = new ThemeContext(gl);
  const still = reducedMotion();
  const start = performance.now();
  let theme = initial;
  let notes: HighwayNotes | null = null;
  let chart: HighwayChart | null = null;
  let frame = 0;
  let last = 0;
  let visible = true;
  let disposed = false;
  let shown = false;
  const pointer: [number, number] = [0.5, 0.65];
  let target: [number, number] = [0.5, 0.65];
  let client: [number, number] | null = null;

  const size = () => {
    const width = host.clientWidth, height = host.clientHeight;
    if (!width || !height) return false;
    const ratio = Math.min(window.devicePixelRatio || 1, Math.sqrt(maxPixels / (width * height)));
    const w = Math.max(1, Math.round(width * ratio)), h = Math.max(1, Math.round(height * ratio));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    return true;
  };

  const render = (now: number) => {
    if (!size()) return;
    if (client) {
      const box = host.getBoundingClientRect();
      target = [(client[0] - box.left) / box.width, 1 - (client[1] - box.top) / box.height];
    }
    pointer[0] += (target[0] - pointer[0]) * 0.06;
    pointer[1] += (target[1] - pointer[1]) * 0.06;
    const time = still ? STILL_TIME : (now - start) / 1000;
    const scrolled = scroll ? window.scrollY / Math.max(window.innerHeight, 1) : 0;
    if (context.draw(theme, canvas.width, canvas.height, time, pointer, scrolled, notes, chart) && !shown) {
      shown = true;
      canvas.style.opacity = "1";
    }
  };

  let drawnScroll = -1;
  const loop = (now: number) => {
    frame = 0;
    if (disposed) return;
    // ~60fps at most: a 120Hz or 144Hz screen draws every other frame. While
    // the page scrolls it draws every frame, or whatever the shader ties to
    // the page (the hero's sun, the black hole) trails the content and steps,
    // plainly so on a 240Hz screen.
    const scrolling = scroll && window.scrollY !== drawnScroll;
    if (visible && (scrolling || now - last >= 15)) {
      last = now;
      drawnScroll = window.scrollY;
      render(now);
    }
    frame = requestAnimationFrame(loop);
  };

  const onPointer = (event: PointerEvent) => {
    client = [event.clientX, event.clientY];
  };
  const resizer = new ResizeObserver(() => {
    if (still) render(performance.now());
  });
  resizer.observe(host);
  const watcher = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
  });
  watcher.observe(host);
  const onLost = (event: Event) => {
    event.preventDefault();
    cancelAnimationFrame(frame);
    disposed = true;
  };
  canvas.addEventListener("webglcontextlost", onLost);

  if (still) render(performance.now());
  else {
    window.addEventListener("pointermove", onPointer, { passive: true });
    frame = requestAnimationFrame(loop);
  }

  return {
    setTheme(next) {
      if (next === theme) return;
      theme = next;
      if (still) render(performance.now());
    },
    setNotes(next) {
      if (next === notes) return;
      notes = next;
      if (still) render(performance.now());
    },
    setChart(next) {
      if (next === chart) return;
      chart = next;
      if (still) render(performance.now());
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(frame);
      resizer.disconnect();
      watcher.disconnect();
      window.removeEventListener("pointermove", onPointer);
      canvas.removeEventListener("webglcontextlost", onLost);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      canvas.remove();
    },
  };
}

/* --- Swatches ------------------------------------------------------------ */

interface Swatch {
  canvas: HTMLCanvasElement;
  target: CanvasRenderingContext2D | null;
  theme: SupporterProfileThemeId;
  visible: boolean;
  /* When it went live: it runs on from the still frame it showed before. */
  start: number;
}

const swatches = new Set<Swatch>();
let shared: { canvas: HTMLCanvasElement; context: ThemeContext } | null | undefined;
let swatchFrame = 0;
let swatchLast = 0;

function sharedContext() {
  if (shared !== undefined) return shared;
  const canvas = document.createElement("canvas");
  const gl = webgl2(canvas);
  shared = gl ? { canvas, context: new ThemeContext(gl) } : null;
  return shared;
}

function drawSwatch(swatch: Swatch, time: number) {
  const context = sharedContext();
  const { width, height } = swatch.canvas;
  if (!context || !width || !height) return;
  if (context.canvas.width !== width || context.canvas.height !== height) {
    context.canvas.width = width;
    context.canvas.height = height;
  }
  if (!context.context.draw(swatch.theme, width, height, time, [0.5, 0.6], 0)) return;
  swatch.target ??= swatch.canvas.getContext("2d");
  swatch.target?.drawImage(context.canvas, 0, 0);
}

function swatchLoop(now: number) {
  if (now - swatchLast >= 1000 / 30) {
    swatchLast = now;
    for (const swatch of swatches) if (swatch.visible) drawSwatch(swatch, STILL_TIME + (now - swatch.start) / 1000);
  }
  swatchFrame = swatches.size > 0 ? requestAnimationFrame(swatchLoop) : 0;
}

/* Draws the theme into `canvas` (sized by the caller), live while on screen
   unless `still`. Returns the cleanup. */
export function mountThemeSwatch(canvas: HTMLCanvasElement, theme: SupporterProfileThemeId, still: boolean): () => void {
  const swatch: Swatch = { canvas, target: null, theme, visible: true, start: performance.now() };
  if (still || reducedMotion()) {
    drawSwatch(swatch, STILL_TIME);
    return () => {};
  }
  swatches.add(swatch);
  // The first live frame now, not on the loop's next turn.
  drawSwatch(swatch, STILL_TIME);
  const watcher = new IntersectionObserver(([entry]) => {
    swatch.visible = entry.isIntersecting;
  });
  watcher.observe(canvas);
  if (!swatchFrame) swatchFrame = requestAnimationFrame(swatchLoop);
  return () => {
    watcher.disconnect();
    swatches.delete(swatch);
  };
}
