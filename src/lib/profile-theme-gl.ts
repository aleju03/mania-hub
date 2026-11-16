import { CUSTOM_THEME_INPUTS, CUSTOM_THEME_TEXTURES } from "#custom-themes/inputs";
import { customThemeKey, reportCustomThemeCrash, type CustomTheme } from "./custom-themes";
import { mirrorGlCanvas } from "./gl-mirror";
import { createSakuraPetals, type ThemeOverlay } from "./profile-theme-petals";
import { createMapleLeaves } from "./profile-theme-maple";
import { PROFILE_THEME_MAIN, PROFILE_THEME_PRELUDE, PROFILE_THEME_SHADERS, PROFILE_THEME_VERTEX } from "./profile-theme-shaders";
import { HIGHWAY_MAX_LANES, type HighwayChart, type HighwayNotes, type HighwayPlay, type SupporterProfileThemeId } from "./supporter-profile-themes";
import { takeGpuSlot } from "./gpu-queue";
import { corsImageUrl } from "./cors-image-url";

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
     their colours, as uniforms the other themes simply do not declare.
   - A supporter's own theme (custom-themes.ts) runs the code the backend
     checked and guarded, with its images on units 5 to 12. A stranger wrote
     it, so it has to prove itself: its first frames are drawn tiny and timed
     before it goes full size, it gives up to its still (onFallback) if it is
     too slow even at the governor's floor (remembered on the device and
     reported, like a crash), and a context lost while it proves itself or
     just after, with the tab in front, is reported as its crash. */

/* A built-in theme by id, or a supporter's own. */
export type BackdropTheme = SupporterProfileThemeId | CustomTheme;

function themeKey(theme: BackdropTheme): string {
  return typeof theme === "string" ? theme : customThemeKey(theme);
}

function themeSource(theme: BackdropTheme): string | null {
  if (typeof theme === "string") return PROFILE_THEME_SHADERS[theme];
  return theme.compiled ? `${PROFILE_THEME_PRELUDE}\n${CUSTOM_THEME_INPUTS}\n${theme.compiled}\n${PROFILE_THEME_MAIN}` : null;
}

/* The unit a custom theme's first image sits on; the rest follow. */
const CUSTOM_TEXTURE_UNIT = 5;

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
  play: WebGLUniformLocation | null;
  keyDown: WebGLUniformLocation | null;
  pressAge: WebGLUniformLocation | null;
  hitAge: WebGLUniformLocation | null;
  hitUntil: WebGLUniformLocation | null;
  judgements: WebGLUniformLocation | null;
  sprite: WebGLUniformLocation | null;
  textures: (WebGLUniformLocation | null)[];
  textureSizes: (WebGLUniformLocation | null)[];
}

/* Licensed art a theme's shader draws (sources in public/images/profile-themes/SOURCES.md). */
const THEME_SPRITES: Partial<Record<SupporterProfileThemeId, string>> = {
  hanabi: "/images/profile-themes/lantern.png",
  vaporwave: "/images/profile-themes/palm.png",
  maple: "/images/profile-themes/maple-built-2.webp",
  fireflies: "/images/profile-themes/firefly-built.webp",
  aero: "/images/profile-themes/aero-built.webp",
};

/* Geometry a theme draws over its shader, in the same canvas. */
const THEME_OVERLAYS: Partial<Record<SupporterProfileThemeId, (gl: WebGL2RenderingContext) => ThemeOverlay | null>> = {
  sakura: createSakuraPetals,
  maple: createMapleLeaves,
};

const STILL_TIME = 6.5;

function reducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

class ThemeContext {
  private programs = new Map<string, Compiled | null>();
  /* Linked but not yet checked: with KHR_parallel_shader_compile the driver
     compiles in the background and the check waits until it says it is done. */
  private pending = new Map<string, { program: WebGLProgram; fragment: WebGLShader }>();
  private parallel: { COMPLETION_STATUS_KHR: number } | null;
  private overlays = new Map<SupporterProfileThemeId, ThemeOverlay | null>();
  private quad: WebGLBuffer | null;
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
  /* Custom themes' images by URL once loaded, with their size; null while loading or if it failed. */
  private images = new Map<string, { texture: WebGLTexture; width: number; height: number } | null>();
  /* Called once a custom theme's image has loaded, so a still drawn before it can be drawn again. */
  onImageLoaded: (() => void) | null = null;

  constructor(readonly gl: WebGL2RenderingContext) {
    this.parallel = gl.getExtension("KHR_parallel_shader_compile");
    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
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
    this.ensureBlank();
    const url = THEME_SPRITES[theme];
    if (url && !this.sprites.has(theme)) {
      this.sprites.set(theme, null);
      const image = new Image();
      image.decoding = "async";
      // decoded off the main thread first: an undecoded image is decoded
      // inside texImage2D, a long stall for the photo-sized sprites
      image.onload = () => void image.decode().catch(() => {}).then(() => {
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
      });
      image.src = url;
    }
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this.sprites.get(theme) ?? this.blank);
    gl.activeTexture(gl.TEXTURE0);
  }

  /* Binds a custom theme's images on units 5 to 12, loading each the first
     time; a blank stands in while one loads, or for none. */
  private bindImages(theme: CustomTheme, compiled: Compiled) {
    const { gl } = this;
    this.ensureBlank();
    for (let index = 0; index < CUSTOM_THEME_TEXTURES; index++) {
      const url = theme.assets[index];
      if (url && !this.images.has(url)) {
        this.images.set(url, null);
        const image = new Image();
        image.crossOrigin = "anonymous";
        image.decoding = "async";
        image.onload = () => {
          const texture = gl.createTexture();
          if (!texture) return;
          gl.activeTexture(gl.TEXTURE0 + CUSTOM_TEXTURE_UNIT + index);
          gl.bindTexture(gl.TEXTURE_2D, texture);
          gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
          gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
          gl.generateMipmap(gl.TEXTURE_2D);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
          gl.activeTexture(gl.TEXTURE0);
          this.images.set(url, { texture, width: image.naturalWidth, height: image.naturalHeight });
          this.onImageLoaded?.();
        };
        image.src = corsImageUrl(url);
      }
      const loaded = url ? this.images.get(url) : null;
      gl.activeTexture(gl.TEXTURE0 + CUSTOM_TEXTURE_UNIT + index);
      gl.bindTexture(gl.TEXTURE_2D, loaded?.texture ?? this.blank);
      gl.uniform1i(compiled.textures[index], CUSTOM_TEXTURE_UNIT + index);
      gl.uniform2f(compiled.textureSizes[index], loaded?.width ?? 1, loaded?.height ?? 1);
    }
    gl.activeTexture(gl.TEXTURE0);
  }

  private ensureBlank() {
    if (this.blank) return;
    const { gl } = this;
    this.blank = gl.createTexture();
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this.blank);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
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

  /* Compiled once per theme and kept, so switching back is instant. Null if
     it failed, undefined while it is still compiling: a compile holds the main
     thread until it finishes, so without the parallel extension they take
     turns (gpu-queue.ts) and a page of swatches fills in over a few frames
     instead of freezing while every one compiles. */
  private compiled(theme: BackdropTheme): Compiled | null | undefined {
    const key = themeKey(theme);
    if (this.programs.has(key)) return this.programs.get(key)!;
    const { gl } = this;
    let pending = this.pending.get(key);
    if (!pending) {
      const source = themeSource(theme);
      if (!source) {
        this.programs.set(key, null);
        return null;
      }
      if (!this.parallel && !takeGpuSlot()) return undefined;
      const fragment = gl.createShader(gl.FRAGMENT_SHADER);
      const program = gl.createProgram();
      if (!this.vertex || !fragment || !program) {
        this.programs.set(key, null);
        return null;
      }
      gl.shaderSource(fragment, source);
      gl.compileShader(fragment);
      gl.attachShader(program, this.vertex);
      gl.attachShader(program, fragment);
      gl.bindAttribLocation(program, 0, "a_position");
      gl.linkProgram(program);
      pending = { program, fragment };
      this.pending.set(key, pending);
    }
    if (this.parallel && !gl.getProgramParameter(pending.program, this.parallel.COMPLETION_STATUS_KHR)) return undefined;
    this.pending.delete(key);
    const { program, fragment } = pending;
    let compiled: Compiled | null = null;
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
        play: gl.getUniformLocation(program, "u_play"),
        keyDown: gl.getUniformLocation(program, "u_keyDown"),
        pressAge: gl.getUniformLocation(program, "u_pressAge"),
        hitAge: gl.getUniformLocation(program, "u_hitAge"),
        hitUntil: gl.getUniformLocation(program, "u_hitUntil"),
        judgements: gl.getUniformLocation(program, "u_judgements"),
        sprite: gl.getUniformLocation(program, "u_sprite"),
        textures: Array.from({ length: CUSTOM_THEME_TEXTURES }, (_, index) => gl.getUniformLocation(program, `u_tex${index}`)),
        textureSizes: Array.from({ length: CUSTOM_THEME_TEXTURES }, (_, index) => gl.getUniformLocation(program, `u_texSize${index}`)),
      };
    } else if (import.meta.env.DEV) {
      console.warn("profile theme shader", gl.getShaderInfoLog(fragment) || gl.getProgramInfoLog(program));
    }
    gl.deleteShader(fragment);
    this.programs.set(key, compiled);
    return compiled;
  }

  /* Whether the theme's program is still on its way (draw() skips it until then). */
  compiling(theme: BackdropTheme): boolean {
    return !this.programs.has(themeKey(theme));
  }

  /* Whether a theme's art is still on its way: a still frame drawn now would
     show the blank in its place and never be redrawn. */
  loading(theme: BackdropTheme): boolean {
    if (typeof theme !== "string") return false;
    if (THEME_SPRITES[theme] && !this.sprites.get(theme)) return true;
    return this.overlays.get(theme)?.ready?.() === false;
  }

  /* Whether the theme can't be drawn at all: it failed to compile, or only shows its still. */
  failed(theme: BackdropTheme): boolean {
    const key = themeKey(theme);
    return this.programs.has(key) && this.programs.get(key) === null;
  }

  private overlay(theme: SupporterProfileThemeId): ThemeOverlay | null {
    const make = THEME_OVERLAYS[theme];
    if (!make) return null;
    // its own program, so it waits its turn too; the backdrop draws without it until then
    if (!this.overlays.has(theme)) {
      if (!takeGpuSlot()) return null;
      this.overlays.set(theme, make(this.gl));
    }
    return this.overlays.get(theme) ?? null;
  }

  draw(theme: BackdropTheme, width: number, height: number, time: number, pointer: [number, number], scroll: number, notes: HighwayNotes | null = null, chart: HighwayChart | null = null, play: HighwayPlay | null = null): boolean {
    const compiled = this.compiled(theme);
    if (!compiled) return false;
    const { gl } = this;
    gl.viewport(0, 0, width, height);
    gl.useProgram(compiled.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
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
      // a visitor playing it: their keys light the lanes and the notes they hit go
      const played = play?.on && playing ? play : null;
      const keyDown = new Float32Array(HIGHWAY_MAX_LANES);
      const pressAge = new Float32Array(HIGHWAY_MAX_LANES).fill(99);
      const hitAge = new Float32Array(HIGHWAY_MAX_LANES).fill(99);
      const hitUntil = new Float32Array(HIGHWAY_MAX_LANES).fill(-1);
      if (played) {
        for (let lane = 0; lane < Math.min(HIGHWAY_MAX_LANES, played.down.length); lane += 1) {
          keyDown[lane] = played.down[lane] ? 1 : 0;
          if (played.pressedAt[lane] >= 0) pressAge[lane] = Math.max(0, time - played.pressedAt[lane]);
          if (played.hitAt[lane] >= 0) hitAge[lane] = Math.max(0, time - played.hitAt[lane]);
          hitUntil[lane] = played.hitUntil[lane];
        }
      }
      gl.uniform1f(compiled.play, played ? 1 : 0);
      gl.uniform1fv(compiled.keyDown, keyDown);
      gl.uniform1fv(compiled.pressAge, pressAge);
      gl.uniform1fv(compiled.hitAge, hitAge);
      gl.uniform1fv(compiled.hitUntil, hitUntil);
      gl.uniform1f(compiled.noteArt, art ? 1 : 0);
      gl.uniform1f(compiled.noteColors, notes ? 1 : 0);
      gl.uniform1fv(compiled.noteAspect, aspects);
      gl.uniform3fv(compiled.noteColor, colors);
      gl.uniform1i(compiled.notes, 0);
      const accent = notes?.accent ?? [0.3, 0.5, 1];
      gl.uniform3f(compiled.accent, accent[0], accent[1], accent[2]);
    }
    if (compiled.sprite && typeof theme === "string") {
      this.bindSprite(theme);
      gl.uniform1i(compiled.sprite, 4);
    }
    if (typeof theme !== "string") this.bindImages(theme, compiled);
    if (compiled.judgements) {
      this.uploadJudgements(notes?.judgements ?? null);
      gl.uniform1i(compiled.judgements, 3);
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    if (typeof theme === "string") this.overlay(theme)?.draw(width, height, time, pointer, scroll);
    return true;
  }
}

/* With a depth buffer, for an overlay's geometry (the Sakura petals). */
function webgl2(canvas: HTMLCanvasElement): WebGL2RenderingContext | null {
  return canvas.getContext("webgl2", { alpha: false, antialias: false, depth: true, stencil: false, powerPreference: "low-power" });
}

/* --- Backdrops ----------------------------------------------------------- */

const GOVERNOR_WINDOW = 30;
/* Below ~42fps a backdrop is costing the page frames. */
const SLOW_FRAME_MS = 24;
const FAST_FRAME_MS = 18;
const MIN_PIXEL_SCALE = 0.12;
/* Frames not judged after it starts (~1.5s): a page still loading, hydrating
   and decoding images says nothing about the GPU. */
const WARMUP_FRAMES = 90;
/* Frames in a window judged during the warm-up, when it started from a guess. */
const GUESS_WINDOW = 10;
/* Fast windows (~0.5s each) before it climbs a step under its ceiling. */
const CLIMB_WINDOWS = 8;
/* Fast windows at its ceiling before it tries above it, doubling up to the
   most each time a try runs slow again. */
const RETRY_WINDOWS = 8;
const MAX_RETRY_WINDOWS = 128;
/* While starved it draws only every STARVED_FRAME_MS (~30fps), so a gap that
   long is its own cadence, not a slow GPU: it is falling behind even that
   only past this. */
const STARVED_SLOW_MS = 45;
/* Windows (~1s each at half rate) a starved theme holds before its first try at full rate. */
const STARVED_RETRY_WINDOWS = 3;

/* Lowers a backdrop's pixel budget while frames run slow (a weak GPU, a
   phone, a heavy theme), and raises it again once they have run fast for a
   while. A level that ran slow becomes a ceiling, but not for good: after a
   stretch of fast frames under it, it tries above it again, so a busy patch
   (another heavy tab, the page loading) does not leave it pixelated for the
   rest of the visit. A try that runs slow goes straight back to where it
   held and waits twice as long before the next. Fed the gap after each
   drawn frame to the next animation frame: a frame the GPU cannot finish in
   time pushes that gap past the display's refresh. */
export class ResolutionGovernor {
  /* The share of the pixel budget to draw at. */
  scale = 1;
  /* Frames ran slow with the scale already at its floor: nothing left to give. */
  starved = false;
  private ceiling = 1;
  private gaps: number[] = [];
  private fastWindows = 0;
  private warmup = WARMUP_FRAMES;
  private retryWindows = RETRY_WINDOWS;
  /* Where it held before trying above its ceiling, while the try is on. */
  private beforeTry: number | null = null;
  /* Starved windows that kept the half rate before it tries full rate again,
     doubling each time a try runs slow; and whether a try is on. */
  private starvedWindows = STARVED_RETRY_WINDOWS;
  private starvedTry = false;
  /* The scale came from the start-up probe's guess, and no window has run slow since. */
  private guessed = false;

  /* `floor`: the least share of the budget it goes down to. */
  constructor(private readonly floor = MIN_PIXEL_SCALE) {}

  /* Returns true when the scale changed. */
  frame(gapMs: number): boolean {
    if (this.warmup > 0) {
      this.warmup -= 1;
      // A start below full is a guess from two tiny frames timed while the
      // page loads, and it guesses low on a GPU that carries the theme. A
      // loading page only makes frames look slower, so fast ones this early
      // are real room: it climbs on short windows here and never lowers.
      if (!this.guessed || this.scale >= this.ceiling || gapMs > 250) return false;
      this.gaps.push(gapMs);
      if (this.gaps.length < GUESS_WINDOW) return false;
      const early = this.gaps.sort((a, b) => a - b)[GUESS_WINDOW >> 1];
      this.gaps.length = 0;
      if (early >= FAST_FRAME_MS) return false;
      this.scale = Math.min(this.ceiling, this.scale * 1.6);
      return true;
    }
    // a hidden tab or a long hitch says nothing about the GPU
    if (gapMs > 250) {
      this.gaps.length = 0;
      return false;
    }
    this.gaps.push(gapMs);
    if (this.gaps.length < GOVERNOR_WINDOW) return false;
    const median = this.gaps.sort((a, b) => a - b)[GOVERNOR_WINDOW >> 1];
    this.gaps.length = 0;
    if (this.starved) {
      // Drawn at half rate on purpose, its gaps only show whether it holds
      // that. Judged against full rate they always looked slow, so a theme
      // starved once (one slow frame in the start-up probe will do it) stayed
      // at the floor and half rate for the rest of the visit, however fast
      // the GPU. After a while holding it, it tries full rate again.
      if (median > STARVED_SLOW_MS) {
        this.fastWindows = 0;
        return false;
      }
      this.fastWindows += 1;
      if (this.fastWindows < this.starvedWindows) return false;
      this.fastWindows = 0;
      this.starved = false;
      this.starvedTry = true;
      return false;
    }
    if (median > SLOW_FRAME_MS) {
      this.guessed = false;
      this.fastWindows = 0;
      if (this.beforeTry !== null) {
        this.scale = this.ceiling = this.beforeTry;
        this.beforeTry = null;
        this.retryWindows = Math.min(MAX_RETRY_WINDOWS, this.retryWindows * 2);
        return true;
      }
      if (this.scale <= this.floor) {
        // a try at full rate that ran slow waits twice as long before the next
        if (this.starvedTry) this.starvedWindows = Math.min(MAX_RETRY_WINDOWS, this.starvedWindows * 2);
        this.starvedTry = false;
        this.starved = true;
        return false;
      }
      this.ceiling = this.scale * 0.8;
      this.scale = Math.max(this.floor, this.scale * 0.55);
      return true;
    }
    if (median >= FAST_FRAME_MS) return false;
    this.fastWindows += 1;
    // a try at full rate that held
    if (this.starvedTry && this.fastWindows >= 2) {
      this.starvedTry = false;
      this.starvedWindows = STARVED_RETRY_WINDOWS;
    }
    if (this.beforeTry !== null) {
      // the try held
      if (this.fastWindows >= 2) {
        this.beforeTry = null;
        this.retryWindows = RETRY_WINDOWS;
      }
      return false;
    }
    if (this.scale < this.ceiling) {
      // below where the probe guessed, with nothing slow seen yet: catch up quickly
      if (!this.guessed && this.fastWindows < CLIMB_WINDOWS) return false;
      this.fastWindows = 0;
      this.starved = false;
      this.scale = Math.min(this.ceiling, this.scale * (this.guessed ? 1.6 : 1.25));
      return true;
    }
    if (this.ceiling < 1 && this.fastWindows >= this.retryWindows) {
      this.fastWindows = 0;
      this.starved = false;
      this.beforeTry = this.scale;
      this.ceiling = Math.min(1, this.ceiling * 1.25);
      this.scale = this.ceiling;
      return true;
    }
    return false;
  }

  /* Starts lower than full, for a theme whose first frames showed it is heavy. */
  start(scale: number) {
    this.scale = Math.max(this.floor, Math.min(1, scale));
    this.ceiling = 1;
    this.guessed = this.scale < 1;
  }
}

/* Built-in themes heavy enough to have their first frames timed too, so a
   weak GPU starts at a pixel count it can carry instead of stuttering at full
   size for the seconds the governor takes to come down (the Universe Shifter
   ray marches its orb). Theirs are drawn at the governor's floor share of the
   pixels: big enough that the timing is the shader's, not the draw call's, so
   it scales to full size. */
const HEAVY_THEMES: ReadonlySet<string> = new Set<SupporterProfileThemeId>(["singularity"]);

function heavyTheme(theme: BackdropTheme): boolean {
  return typeof theme === "string" && (HEAVY_THEMES.has(theme) || SHARP_THEMES.has(theme));
}

/* A backdrop's pixel budget, unless its host sets one. */
const PIXEL_BUDGET = 1_000_000;
/* Themes with hard edges, where the upscaling shows (the Universe Shifter's
   ink and orb on a 1440p screen came out at half size, stretched; the
   moon's disc and glints are the same): theirs is a 1440p screen's worth. With that many pixels they count as heavy themes, so the
   probe starts a weak GPU where it can carry them, and the governor's floor
   stays the same count of pixels as everyone's. */
const SHARP_PIXEL_BUDGET = 3_700_000;
const SHARP_THEMES: ReadonlySet<string> = new Set<SupporterProfileThemeId>(["singularity", "moonsea"]);

function pixelBudget(theme: BackdropTheme): number {
  return typeof theme === "string" && SHARP_THEMES.has(theme) ? SHARP_PIXEL_BUDGET : PIXEL_BUDGET;
}

/* At the floor and still too slow, a built-in theme draws at most this often, ms. */
const STARVED_FRAME_MS = 31;

/* A custom theme's first frames are drawn this small and timed. */
const PROBE_WIDTH = 96;
const PROBE_HEIGHT = 54;
const PROBE_FRAMES = 2;
/* A custom theme fast that small is timed again this many times wider and
   taller before its full-size cost is guessed: at 96x54 a frame's fixed cost
   (the draw, the wait for the GPU) outweighs its pixels, and scaled up ~200
   times it made every theme look heavy, so even a light one started blurry. */
const PROBE_GROW = 4;
/* Fast enough at the small size to try the bigger one, ms. */
const PROBE_GROW_MS = 4;
/* Slower than this even that small (a fraction of a phone's worth of pixels): it shows its still. */
const PROBE_GIVE_UP_MS = 40;
/* The frame time it should start at once full size, ms. */
const PROBE_TARGET_MS = 12;
/* A context lost this soon after a custom theme went full size counts as its crash, ms. */
const LOSS_BLAME_MS = 10_000;

export interface ProfileBackdrop {
  setTheme(theme: BackdropTheme): void;
  setNotes(notes: HighwayNotes | null): void;
  setChart(chart: HighwayChart | null): void;
  /** A visitor playing the Note highway; the renderer gives it its clock. */
  setPlay(play: HighwayPlay | null): void;
  dispose(): void;
}

/* Fills `host` with the theme's backdrop. `scroll` makes it follow the page's
   scroll (the profile); the /supporter stage leaves it still. Null without
   WebGL2, where the host's flat colour stays. */
export function mountProfileBackdrop(
  host: HTMLElement,
  initial: BackdropTheme,
  { scroll = false, maxPixels, onFallback }: {
    scroll?: boolean;
    maxPixels?: number;
    /** A custom theme that can't run here (too slow, failed, crashed): show its still instead. */
    onFallback?: (theme: CustomTheme) => void;
  } = {},
): ProfileBackdrop | null {
  // drawn off the page; the page shows a 2D copy (gl-mirror.ts), which never paints a lost context's white box
  const canvas = document.createElement("canvas");
  const gl = webgl2(canvas);
  if (!gl) return null;
  const mirror = mirrorGlCanvas(canvas);
  const shownCanvas = mirror.canvas;
  shownCanvas.setAttribute("aria-hidden", "true");
  shownCanvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block;opacity:0;transition:opacity .6s ease";
  host.appendChild(shownCanvas);
  const context = new ThemeContext(gl);
  const still = reducedMotion();
  const start = performance.now();
  let theme = initial;
  let notes: HighwayNotes | null = null;
  let chart: HighwayChart | null = null;
  let play: HighwayPlay | null = null;
  let frame = 0;
  let last = 0;
  let visible = true;
  let disposed = false;
  let shown = false;
  const pointer: [number, number] = [0.5, 0.65];
  let target: [number, number] = [0.5, 0.65];
  let client: [number, number] | null = null;
  /* The most pixels `drawn` is drawn at, and the governor's floor as a share
     of it: the same count of pixels whatever the budget. */
  const budget = (drawn: BackdropTheme) => maxPixels ?? pixelBudget(drawn);
  const floor = (drawn: BackdropTheme) => Math.min(1, (MIN_PIXEL_SCALE * PIXEL_BUDGET) / budget(drawn));
  let governor = new ResolutionGovernor(floor(initial));
  /* A custom or heavy theme's timed first frames: how many drawn so far, and the slowest. */
  const probing = (next: BackdropTheme) => (typeof next !== "string" || (heavyTheme(next) && !still) ? { frames: 0, worst: 0, grown: false } : null);
  let probe: { frames: number; worst: number; grown: boolean } | null = probing(initial);
  let gaveUp = false;
  /* When the current custom theme first drew full size (0 until then, and for a built-in). */
  let customShownAt = 0;
  /* The context came back once after a loss: a later loss is the browser's, not the theme's. */
  let restored = false;

  /* `slow`: it froze the tab's frames, so it shows its still on this device
     from now on (the bad-theme list) and is reported like a crash. */
  const giveUp = (custom: CustomTheme, slow = false) => {
    if (gaveUp) return;
    gaveUp = true;
    if (slow) reportCustomThemeCrash(custom);
    cancelAnimationFrame(frame);
    frame = 0;
    shownCanvas.style.opacity = "0";
    onFallback?.(custom);
  };

  /* Draws a custom theme's first frames tiny (a heavy built-in's at the
     floor's share) and waits for the GPU each time: a custom theme too slow
     even so gives up; otherwise the governor starts at the share of the pixel
     budget the timing says it can carry. The page keeps showing the last
     frame meanwhile: only a full-size draw is copied to it. */
  const runProbe = (probed: BackdropTheme, time: number): boolean => {
    if (!probe) return true;
    const custom = typeof probed === "string" ? null : probed;
    const full = Math.min(budget(probed), host.clientWidth * host.clientHeight * (window.devicePixelRatio || 1) ** 2);
    const share = custom ? 0 : Math.sqrt((full * floor(probed)) / Math.max(1, host.clientWidth * host.clientHeight));
    const grow = probe.grown ? PROBE_GROW : 1;
    const width = custom ? PROBE_WIDTH * grow : Math.max(1, Math.round(host.clientWidth * share));
    const height = custom ? PROBE_HEIGHT * grow : Math.max(1, Math.round(host.clientHeight * share));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const startedAt = performance.now();
    if (!context.draw(probed, width, height, time, pointer, 0)) {
      if (custom && context.failed(custom)) giveUp(custom);
      if (!custom && context.failed(probed)) probe = null;
      return false;
    }
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    const took = performance.now() - startedAt;
    probe.frames += 1;
    // the first one also pays for the driver's warm-up
    if (probe.frames > 1) probe.worst = Math.max(probe.worst, took);
    if (probe.frames <= PROBE_FRAMES) return false;
    if (custom && probe.worst > PROBE_GIVE_UP_MS) {
      giveUp(custom, true);
      return false;
    }
    if (custom && !probe.grown && probe.worst <= PROBE_GROW_MS && PROBE_WIDTH * PROBE_HEIGHT * PROBE_GROW ** 2 < full) {
      probe = { frames: 0, worst: 0, grown: true };
      return false;
    }
    const estimate = probe.worst * (full / (width * height));
    if (estimate > PROBE_TARGET_MS) governor.start(PROBE_TARGET_MS / estimate);
    // a built-in too slow even at the floor draws at half rate from the start
    if (!custom && probe.worst > SLOW_FRAME_MS) governor.starved = true;
    probe = null;
    return true;
  };

  const size = () => {
    const width = host.clientWidth, height = host.clientHeight;
    if (!width || !height) return false;
    const ratio = Math.min(window.devicePixelRatio || 1, Math.sqrt((budget(theme) * governor.scale) / (width * height)));
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
    if ((typeof theme !== "string" || probe) && (gaveUp || !runProbe(theme, time) || !size())) return;
    const scrolled = scroll ? window.scrollY / Math.max(window.innerHeight, 1) : 0;
    if (typeof theme !== "string" && context.failed(theme)) {
      giveUp(theme);
      return;
    }
    const drew = context.draw(theme, canvas.width, canvas.height, time, pointer, scrolled, notes, chart, play);
    mirror.copy();
    if (drew && !shown) {
      shown = true;
      shownCanvas.style.opacity = "1";
      if (typeof theme !== "string") customShownAt = performance.now();
    }
  };
  /* A still frame, tried again each frame while the theme's program compiles. */
  let stillFrame = 0;
  const renderStill = () => {
    stillFrame = 0;
    if (disposed) return;
    render(performance.now());
    if (context.compiling(theme) || context.loading(theme) || (probe && !gaveUp)) stillFrame = requestAnimationFrame(renderStill);
  };

  let drawnScroll = -1;
  let drewAt = 0;
  const loop = (now: number) => {
    frame = 0;
    if (disposed) return;
    if (drewAt) governor.frame(now - drewAt);
    drewAt = 0;
    // off screen (or display:none) it stops asking for frames, so the device
    // can idle; the watcher starts it again when it comes back
    if (!visible) return;
    // a stranger's theme that can't hold its frames even at the floor stops
    if (governor.starved && typeof theme !== "string") {
      giveUp(theme, true);
      return;
    }
    // ~60fps at most: a 120Hz or 144Hz screen draws every other frame. While
    // the page scrolls it draws every frame, or whatever the shader ties to
    // the page (the hero's sun, the black hole) trails the content and steps,
    // plainly so on a 240Hz screen.
    // A built-in theme too slow even at the governor's floor (a weak phone)
    // draws at ~30fps instead, so the page around it keeps its frames.
    const scrolling = scroll && window.scrollY !== drawnScroll;
    if (visible && (scrolling || now - last >= (governor.starved ? STARVED_FRAME_MS : 15))) {
      last = now;
      drawnScroll = window.scrollY;
      render(now);
      drewAt = now;
    }
    frame = requestAnimationFrame(loop);
  };

  const onPointer = (event: PointerEvent) => {
    client = [event.clientX, event.clientY];
  };
  const resizer = new ResizeObserver(() => {
    if (still && !stillFrame) renderStill();
  });
  resizer.observe(host);
  const watcher = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    if (visible && !still && !frame && !disposed && !gaveUp) frame = requestAnimationFrame(loop);
  });
  watcher.observe(host);
  const onLost = (event: Event) => {
    event.preventDefault();
    cancelAnimationFrame(frame);
    cancelAnimationFrame(stillFrame);
    disposed = true;
    if (typeof theme === "string") return;
    // A context is also lost to a backgrounded tab, the browser evicting old
    // contexts or a GPU reset. Only a loss while the theme was proving itself
    // or just after it went full size, with the tab in front, is blamed on it.
    const fresh = !!probe || (customShownAt > 0 && performance.now() - customShownAt < LOSS_BLAME_MS);
    const blamed = fresh && !restored && !leaving && document.visibilityState === "visible";
    if (blamed) reportCustomThemeCrash(theme);
    giveUp(theme);
  };
  const onRestored = () => {
    restored = true;
  };
  // webgl-hygiene.ts lets every context go on pagehide: not the theme's doing
  let leaving = false;
  const onPageHide = () => {
    leaving = true;
  };
  canvas.addEventListener("webglcontextlost", onLost);
  canvas.addEventListener("webglcontextrestored", onRestored);
  window.addEventListener("pagehide", onPageHide);

  // a still drawn before the theme's images arrived shows blanks in their place
  context.onImageLoaded = () => {
    if (still && !stillFrame && !disposed) renderStill();
  };

  if (still) renderStill();
  else {
    window.addEventListener("pointermove", onPointer, { passive: true });
    frame = requestAnimationFrame(loop);
  }

  return {
    setTheme(next) {
      if (themeKey(next) === themeKey(theme)) return;
      // a heavy theme times itself again, and the next one starts from full
      // rather than from the heavy one's share
      if (typeof next === "string" && !gaveUp && (heavyTheme(next) || heavyTheme(theme))) {
        probe = probing(next);
        governor = new ResolutionGovernor(floor(next));
      }
      theme = next;
      // a custom theme proves itself from the start, out of sight while its
      // tiny first frames draw; built-ins swap programs under the old frame
      if (typeof next !== "string" || gaveUp) {
        probe = probing(next);
        governor = new ResolutionGovernor(floor(next));
        gaveUp = false;
        shown = false;
        customShownAt = 0;
        shownCanvas.style.opacity = "0";
      }
      if (still && !stillFrame) renderStill();
      else if (!still && !frame && !disposed) frame = requestAnimationFrame(loop);
    },
    setNotes(next) {
      if (next === notes) return;
      notes = next;
      if (still && !stillFrame) renderStill();
    },
    setChart(next) {
      if (next === chart) return;
      chart = next;
      if (still && !stillFrame) renderStill();
    },
    setPlay(next) {
      play = next;
      // one still frame has no clock to play against
      if (next) next.epoch = still ? null : start;
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(frame);
      cancelAnimationFrame(stillFrame);
      resizer.disconnect();
      watcher.disconnect();
      window.removeEventListener("pointermove", onPointer);
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      window.removeEventListener("pagehide", onPageHide);
      context.onImageLoaded = null;
      mirror.dispose();
      shownCanvas.remove();
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
}

/* --- Swatches ------------------------------------------------------------ */

interface Swatch {
  canvas: HTMLCanvasElement;
  target: CanvasRenderingContext2D | null;
  theme: SupporterProfileThemeId;
  visible: boolean;
  /* Drawn once, then dropped from the loop. */
  still: boolean;
  /* When it went live: it runs on from the still frame it showed before. */
  start: number;
}

const swatches = new Set<Swatch>();
let shared: { canvas: HTMLCanvasElement; context: ThemeContext } | null | undefined;
/* Times the shared context was lost; past a few the swatches stop asking for a new one. */
let sharedLosses = 0;
const SHARED_MAX_LOSSES = 3;
let swatchFrame = 0;
let swatchLast = 0;
const STILLS_PER_FRAME = 3;

/* A lost context is dropped and the next draw makes a new one, on a new canvas
   (a lost canvas only ever hands back its lost context). */
function dropSharedContext() {
  if (!shared) return;
  sharedLosses += 1;
  shared = sharedLosses >= SHARED_MAX_LOSSES ? null : undefined;
}

function sharedContext() {
  if (shared?.context.gl.isContextLost()) dropSharedContext();
  if (shared !== undefined) return shared;
  const canvas = document.createElement("canvas");
  const gl = webgl2(canvas);
  if (!gl) {
    shared = null;
    return shared;
  }
  const entry = { canvas, context: new ThemeContext(gl) };
  canvas.addEventListener("webglcontextlost", () => {
    if (shared === entry) dropSharedContext();
  }, { once: true });
  shared = entry;
  return shared;
}

/* False while the theme's program is still compiling. */
function drawSwatch(swatch: Swatch, time: number): boolean {
  const context = sharedContext();
  const { width, height } = swatch.canvas;
  if (!context || !width || !height) return true;
  if (context.canvas.width !== width || context.canvas.height !== height) {
    context.canvas.width = width;
    context.canvas.height = height;
  }
  if (!context.context.draw(swatch.theme, width, height, time, [0.5, 0.6], 0)) {
    // lost mid-draw: its programs read as failed, so try again on the next context
    if (context.context.gl.isContextLost()) return false;
    return !context.context.compiling(swatch.theme);
  }
  swatch.target ??= swatch.canvas.getContext("2d");
  swatch.target?.drawImage(context.canvas, 0, 0);
  return !context.context.loading(swatch.theme);
}

function swatchLoop(now: number) {
  if (now - swatchLast >= 1000 / 30) {
    swatchLast = now;
    // every copy out of the shared canvas waits on the GPU, so a page of
    // stills fills in a few per frame instead of all in one long one
    let stills = STILLS_PER_FRAME;
    for (const swatch of swatches) {
      if (!swatch.visible) continue;
      if (!swatch.still) drawSwatch(swatch, STILL_TIME + (now - swatch.start) / 1000);
      else if (stills > 0) {
        stills -= 1;
        if (drawSwatch(swatch, STILL_TIME)) swatches.delete(swatch);
      }
    }
  }
  // with none on screen the loop stops; a swatch coming into view starts it again
  let anyVisible = false;
  for (const swatch of swatches) if (swatch.visible) anyVisible = true;
  swatchFrame = anyVisible ? requestAnimationFrame(swatchLoop) : 0;
}

/* Draws the theme into `canvas` (sized by the caller), live while on screen
   unless `still`. A swatch whose theme has not compiled yet waits in the loop
   and draws once it has, so a drawer of new themes fills in over a few frames.
   Returns the cleanup. */
export function mountThemeSwatch(canvas: HTMLCanvasElement, theme: SupporterProfileThemeId, still: boolean): () => void {
  const swatch: Swatch = { canvas, target: null, theme, visible: true, still: still || reducedMotion(), start: performance.now() };
  // A live one draws its first frame now, not on the loop's next turn; stills take turns in the loop.
  if (!swatch.still) drawSwatch(swatch, STILL_TIME);
  swatches.add(swatch);
  const watcher = new IntersectionObserver(([entry]) => {
    swatch.visible = entry.isIntersecting;
    if (swatch.visible && !swatchFrame && swatches.has(swatch)) swatchFrame = requestAnimationFrame(swatchLoop);
  });
  watcher.observe(canvas);
  if (!swatchFrame) swatchFrame = requestAnimationFrame(swatchLoop);
  return () => {
    watcher.disconnect();
    swatches.delete(swatch);
  };
}
