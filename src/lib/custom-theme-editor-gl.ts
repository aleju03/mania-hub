import { CUSTOM_THEME_INPUTS, CUSTOM_THEME_TEXTURES } from "#custom-themes/inputs";
import { COST_REFERENCE_SHADER, PROFILE_THEME_MAIN, PROFILE_THEME_PRELUDE, PROFILE_THEME_VERTEX } from "./profile-theme-shaders";
import type { SupporterProfileThemeId } from "./supporter-profile-themes";
import { corsImageUrl } from "./cors-image-url";

/* The theme editor's own WebGL: one canvas that previews the author's theme,
   compiles their code to find the driver's errors on their own lines, times
   it against the heaviest built-in theme, and renders the still and the
   banner row. Kept apart from the profiles' renderer (profile-theme-gl.ts),
   which reports crashes and falls back to stills: none of that applies to a
   draft. It only ever draws the guarded code the checker made, so a loop that
   never ends can't hang the author's GPU either. */

/* The built-in every theme is measured against: the heaviest one shipped. */
export const COST_REFERENCE: SupporterProfileThemeId = "blackhole";
/* A frame this slow even at PROBE_SIZE would stall the page at full size. */
const PROBE_LIMIT_MS = 40;
const PROBE_SIZE = { width: 96, height: 54 } as const;
const COST_SIZE = { width: 960, height: 540 } as const;
const COST_FRAMES = 6;
const COST_ROUNDS = 3;
const TEXTURE_UNIT = 5;

export interface DriverError {
  /** The author's line, when the driver named one. */
  line: number | null;
  message: string;
}

interface Program {
  program: WebGLProgram;
  time: WebGLUniformLocation | null;
  res: WebGLUniformLocation | null;
  pointer: WebGLUniformLocation | null;
  scroll: WebGLUniformLocation | null;
  textures: (WebGLUniformLocation | null)[];
  textureSizes: (WebGLUniformLocation | null)[];
  /** A layer theme's live numbers (custom-theme-layers.ts), when it reads them. */
  params: WebGLUniformLocation | null;
}

export interface FrameInputs {
  time: number;
  pointer: [number, number];
  scroll: number;
}

/* "ERROR: 0:12: 'x' : undeclared identifier" (ANGLE) and "0:12(5): error:
   `x' undeclared" (Mesa), one per line. */
export function parseDriverLog(log: string): DriverError[] {
  const errors: DriverError[] = [];
  for (const raw of log.split("\n")) {
    const line = raw.trim();
    if (!line || /^WARNING/i.test(line)) continue;
    const match = /^(?:ERROR:\s*)?\d+:(\d+)(?:\(\d+\))?:\s*(?:error:\s*)?(.*)$/.exec(line);
    if (match) errors.push({ line: Number(match[1]), message: match[2].replace(/\s+/g, " ").trim() });
    else if (!/compilation errors?/i.test(line) && line !== "\u0000") errors.push({ line: null, message: line });
  }
  return errors;
}

export class ThemeEditorGl {
  readonly gl: WebGL2RenderingContext;
  private readonly quad: WebGLVertexArrayObject | null;
  private readonly vertex: WebGLShader | null;
  private current: Program | null = null;
  private reference: Program | null = null;
  private readonly images = new Map<string, { texture: WebGLTexture; width: number; height: number } | null>();
  private assets: string[] = [];
  private blank: WebGLTexture | null = null;
  private liveSource: string | null = null;
  private params: Float32Array | null = null;
  private target: { framebuffer: WebGLFramebuffer; texture: WebGLTexture; width: number; height: number } | null = null;

  static create(canvas: HTMLCanvasElement): ThemeEditorGl | null {
    const gl = canvas.getContext("webgl2", { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false });
    return gl ? new ThemeEditorGl(gl) : null;
  }

  private constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.vertex = this.shader(gl.VERTEX_SHADER, PROFILE_THEME_VERTEX).shader;
    this.quad = gl.createVertexArray();
    gl.bindVertexArray(this.quad);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  }

  private shader(type: number, source: string): { shader: WebGLShader | null; log: string } {
    const { gl } = this;
    const shader = gl.createShader(type);
    if (!shader) return { shader: null, log: "The browser couldn't make a shader." };
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return { shader, log: "" };
    const log = gl.getShaderInfoLog(shader) ?? "";
    gl.deleteShader(shader);
    return { shader: null, log };
  }

  private link(fragmentSource: string): { program: Program | null; log: string } {
    const { gl } = this;
    const fragment = this.shader(gl.FRAGMENT_SHADER, fragmentSource);
    if (!fragment.shader || !this.vertex) return { program: null, log: fragment.log };
    const program = gl.createProgram();
    if (!program) return { program: null, log: "The browser couldn't make a program." };
    gl.attachShader(program, this.vertex);
    gl.attachShader(program, fragment.shader);
    gl.bindAttribLocation(program, 0, "a_position");
    gl.linkProgram(program);
    gl.deleteShader(fragment.shader);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program) ?? "";
      gl.deleteProgram(program);
      return { program: null, log };
    }
    return {
      program: {
        program,
        time: gl.getUniformLocation(program, "u_time"),
        res: gl.getUniformLocation(program, "u_res"),
        pointer: gl.getUniformLocation(program, "u_pointer"),
        scroll: gl.getUniformLocation(program, "u_scroll"),
        textures: Array.from({ length: CUSTOM_THEME_TEXTURES }, (_, index) => gl.getUniformLocation(program, `u_tex${index}`)),
        textureSizes: Array.from({ length: CUSTOM_THEME_TEXTURES }, (_, index) => gl.getUniformLocation(program, `u_texSize${index}`)),
        params: gl.getUniformLocation(program, "u_lp"),
      },
      log: "",
    };
  }

  /* Compiles the author's code as written (customThemeLineProgram), never
     drawing it, for errors on the author's own lines. */
  driverErrors(lineProgram: string): DriverError[] {
    const result = this.shader(this.gl.FRAGMENT_SHADER, `${PROFILE_THEME_PRELUDE}\n${CUSTOM_THEME_INPUTS}\n${lineProgram}\n${PROFILE_THEME_MAIN}`);
    if (result.shader) {
      this.gl.deleteShader(result.shader);
      return [];
    }
    return parseDriverLog(result.log);
  }

  /* Swaps in the checker's guarded code. Errors here (rare: the checker
     passed and the driver didn't) have no author lines to point at. */
  use(compiled: string): DriverError[] {
    const linked = this.link(`${PROFILE_THEME_PRELUDE}\n${CUSTOM_THEME_INPUTS}\n${compiled}\n${PROFILE_THEME_MAIN}`);
    if (!linked.program) return parseDriverLog(linked.log).map((error) => ({ ...error, line: null }));
    if (this.current) this.gl.deleteProgram(this.current.program);
    this.current = linked.program;
    this.liveSource = null;
    return [];
  }

  /* A layer theme's live code: generated here, never sent anywhere, its
     numbers read from u_lp so a slider never recompiles it. */
  useLive(glsl: string): DriverError[] {
    if (glsl === this.liveSource && this.current) return [];
    const failed = this.use(glsl);
    if (!failed.length) this.liveSource = glsl;
    return failed;
  }

  setParams(params: Float32Array) {
    this.params = params;
  }

  get ready(): boolean {
    return this.current !== null;
  }

  setAssets(urls: string[]) {
    this.assets = urls.slice(0, CUSTOM_THEME_TEXTURES);
    const { gl } = this;
    for (const url of this.assets) {
      if (this.images.has(url)) continue;
      this.images.set(url, null);
      const image = new Image();
      image.crossOrigin = "anonymous";
      image.onload = () => {
        const texture = gl.createTexture();
        if (!texture) return;
        gl.activeTexture(gl.TEXTURE0 + TEXTURE_UNIT);
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
      };
      image.src = corsImageUrl(url);
    }
  }

  private bindImages(program: Program) {
    const { gl } = this;
    if (!this.blank) {
      this.blank = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.blank);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
    }
    for (let index = 0; index < CUSTOM_THEME_TEXTURES; index++) {
      const url = this.assets[index];
      const loaded = url ? this.images.get(url) : null;
      gl.activeTexture(gl.TEXTURE0 + TEXTURE_UNIT + index);
      gl.bindTexture(gl.TEXTURE_2D, loaded?.texture ?? this.blank);
      gl.uniform1i(program.textures[index], TEXTURE_UNIT + index);
      gl.uniform2f(program.textureSizes[index], loaded?.width ?? 1, loaded?.height ?? 1);
    }
    gl.activeTexture(gl.TEXTURE0);
  }

  private drawWith(program: Program, width: number, height: number, inputs: FrameInputs) {
    const { gl } = this;
    gl.viewport(0, 0, width, height);
    gl.useProgram(program.program);
    gl.uniform1f(program.time, inputs.time);
    gl.uniform2f(program.res, width, height);
    gl.uniform2f(program.pointer, inputs.pointer[0], inputs.pointer[1]);
    gl.uniform1f(program.scroll, inputs.scroll);
    if (program.params && this.params) gl.uniform4fv(program.params, this.params);
    this.bindImages(program);
    gl.bindVertexArray(this.quad);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /* One frame of the author's theme onto the canvas. */
  draw(inputs: FrameInputs) {
    if (!this.current) return;
    const canvas = this.gl.canvas as HTMLCanvasElement;
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
    this.drawWith(this.current, canvas.width, canvas.height, inputs);
  }

  private bindTarget(width: number, height: number) {
    const { gl } = this;
    if (!this.target || this.target.width !== width || this.target.height !== height) {
      if (this.target) {
        gl.deleteFramebuffer(this.target.framebuffer);
        gl.deleteTexture(this.target.texture);
      }
      const texture = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      const framebuffer = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      this.target = { framebuffer, texture, width, height };
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.target.framebuffer);
  }

  /* Milliseconds per frame at a size, waited out with a one-pixel read. */
  private timeFrames(program: Program, width: number, height: number, frames: number): number {
    const { gl } = this;
    this.bindTarget(width, height);
    const pixel = new Uint8Array(4);
    const start = performance.now();
    for (let frame = 0; frame < frames; frame++) this.drawWith(program, width, height, { time: 3 + frame * 0.37, pointer: [0.5, 0.5], scroll: 0 });
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    const elapsed = (performance.now() - start) / frames;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return elapsed;
  }

  /* A few tiny frames: false when even those are too slow to show live. */
  probe(): boolean {
    if (!this.current) return false;
    this.timeFrames(this.current, PROBE_SIZE.width, PROBE_SIZE.height, 1);
    return this.timeFrames(this.current, PROBE_SIZE.width, PROBE_SIZE.height, 2) <= PROBE_LIMIT_MS;
  }

  /* The theme's cost against COST_REFERENCE in this browser, as a ratio:
     the fastest of a few rounds each, alternating, so a busy moment hits
     both. Ratios carry over between devices far better than milliseconds. */
  measureCost(): number | null {
    if (!this.current) return null;
    if (!this.probe()) return Number.POSITIVE_INFINITY;
    this.reference ??= this.link(COST_REFERENCE_SHADER).program;
    if (!this.reference) return null;
    const { width, height } = COST_SIZE;
    // first draws compile lazily on some drivers: one of each before timing
    this.timeFrames(this.reference, width, height, 1);
    this.timeFrames(this.current, width, height, 1);
    let theirs = Number.POSITIVE_INFINITY;
    let ours = Number.POSITIVE_INFINITY;
    for (let round = 0; round < COST_ROUNDS; round++) {
      ours = Math.min(ours, this.timeFrames(this.reference, width, height, COST_FRAMES));
      theirs = Math.min(theirs, this.timeFrames(this.current, width, height, COST_FRAMES));
    }
    return ours > 0 ? theirs / ours : null;
  }

  /* A frame's raw pixels at any size (bottom row first), for measuring. */
  pixels(width: number, height: number, inputs: FrameInputs): Uint8ClampedArray | null {
    if (!this.current) return null;
    const { gl } = this;
    this.bindTarget(width, height);
    this.drawWith(this.current, width, height, inputs);
    const pixels = new Uint8ClampedArray(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return pixels;
  }

  /* A frame at any size, read back right way up into a 2D canvas. */
  capture(width: number, height: number, inputs: FrameInputs): HTMLCanvasElement | null {
    if (!this.current) return null;
    const { gl } = this;
    this.bindTarget(width, height);
    this.drawWith(this.current, width, height, inputs);
    const pixels = new Uint8ClampedArray(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const flipped = new Uint8ClampedArray(pixels.length);
    const row = width * 4;
    for (let y = 0; y < height; y++) flipped.set(pixels.subarray(y * row, (y + 1) * row), (height - 1 - y) * row);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d")!.putImageData(new ImageData(flipped, width, height), 0, 0);
    return canvas;
  }

  dispose() {
    const { gl } = this;
    if (this.current) gl.deleteProgram(this.current.program);
    if (this.reference) gl.deleteProgram(this.reference.program);
    for (const image of this.images.values()) if (image) gl.deleteTexture(image.texture);
    if (this.target) {
      gl.deleteFramebuffer(this.target.framebuffer);
      gl.deleteTexture(this.target.texture);
    }
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

/* --- Reading a frame ----------------------------------------------------- */

const luminance = (r: number, g: number, b: number) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

/* Mean brightness 0..1 of a small frame. The built-ins sit around 0.05 to
   0.15: white text and the page's panels go on top. */
export function frameBrightness(frame: HTMLCanvasElement): number {
  const { data } = frame.getContext("2d")!.getImageData(0, 0, frame.width, frame.height);
  let sum = 0;
  for (let index = 0; index < data.length; index += 4) sum += luminance(data[index], data[index + 1], data[index + 2]);
  return sum / (data.length / 4);
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  const light = (max + min) / 2;
  if (max === min) return [0, 0, light];
  const delta = max - min;
  const sat = delta / (1 - Math.abs(2 * light - 1));
  const [rr, gg, bb] = [r / 255, g / 255, b / 255];
  const hue = max === rr ? ((gg - bb) / delta) % 6 : max === gg ? (bb - rr) / delta + 2 : (rr - gg) / delta + 4;
  return [(hue * 60 + 360) % 360, Math.min(1, sat), light];
}

const hex = (value: number) => Math.round(Math.max(0, Math.min(255, value))).toString(16).padStart(2, "0");

/* The site tint a frame suggests: its brightest quarter for the hue, its
   darker half (pressed very dark) for the page's base colour. */
export function suggestLook(frame: HTMLCanvasElement): { hue: number; sat: number; base: string } {
  const { data } = frame.getContext("2d")!.getImageData(0, 0, frame.width, frame.height);
  const pixels: [number, number, number, number][] = [];
  for (let index = 0; index < data.length; index += 4) pixels.push([data[index], data[index + 1], data[index + 2], luminance(data[index], data[index + 1], data[index + 2])]);
  pixels.sort((a, b) => a[3] - b[3]);
  const mean = (slice: typeof pixels) => {
    const total = slice.reduce((acc, pixel) => [acc[0] + pixel[0], acc[1] + pixel[1], acc[2] + pixel[2]], [0, 0, 0]);
    return total.map((value) => value / Math.max(1, slice.length)) as [number, number, number];
  };
  const bright = mean(pixels.slice(Math.floor(pixels.length * 0.75)));
  const dark = mean(pixels.slice(0, Math.ceil(pixels.length / 2)));
  const [hue, sat] = rgbToHsl(...bright);
  const darkLight = luminance(...dark);
  const press = darkLight > 0.035 ? 0.035 / darkLight : 1;
  return {
    hue: Math.round(hue),
    sat: Math.round(Math.min(0.95, Math.max(0.25, sat)) * 100) / 100,
    base: `#${hex(dark[0] * press)}${hex(dark[1] * press)}${hex(dark[2] * press)}`,
  };
}

/* --- The banner row ------------------------------------------------------ */

export interface RowFraming {
  /** 1 shows the whole frame's width; more crops in. */
  zoom: number;
  /** Where the crop sits, 0..1 across and down. */
  x: number;
  y: number;
}

/* A list row's banner from a frame: cropped to 16:10 at the framing, with
   the fade the built-in strips have (clear on the left, 0.2 at 28%, 0.62 at
   the right; foundry designs/row-banner/make_strips.py), so a row lays it
   under its right side with no mask. */
/* The crop a framing takes out of a frame, as fractions of it: the largest
   box of the output's shape that fits, shrunk by the zoom and slid by x, y. */
export function rowCrop(frameWidth: number, frameHeight: number, framing: RowFraming, aspect: number): { left: number; top: number; width: number; height: number } {
  let width = frameWidth / Math.max(1, framing.zoom);
  let height = width / aspect;
  if (height > frameHeight / Math.max(1, framing.zoom)) {
    height = frameHeight / Math.max(1, framing.zoom);
    width = height * aspect;
  }
  const w = width / frameWidth;
  const h = height / frameHeight;
  return { left: (1 - w) * Math.min(1, Math.max(0, framing.x)), top: (1 - h) * Math.min(1, Math.max(0, framing.y)), width: w, height: h };
}

export function bakeRow(frame: CanvasImageSource & { width: number; height: number }, framing: RowFraming, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d")!;
  const crop = rowCrop(frame.width, frame.height, framing, width / height);
  context.drawImage(frame, crop.left * frame.width, crop.top * frame.height, crop.width * frame.width, crop.height * frame.height, 0, 0, width, height);
  context.globalCompositeOperation = "destination-in";
  const fade = context.createLinearGradient(0, 0, width, 0);
  fade.addColorStop(0, "rgba(0,0,0,0)");
  fade.addColorStop(0.28, "rgba(0,0,0,0.2)");
  fade.addColorStop(1, "rgba(0,0,0,0.62)");
  context.fillStyle = fade;
  context.fillRect(0, 0, width, height);
  return canvas;
}

export function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Could not render the image."))), "image/webp", 0.92);
  });
}

/* --- Flashing ------------------------------------------------------------ */

/* A theme plays behind someone's whole profile, so it must not strobe: the
   flash rule of WCAG 2.3.1, more than three flashes in any one second over a
   quarter of the screen or more, where a flash is a pair of opposite swings
   of at least a tenth of the brightest relative luminance, the darker side
   under 0.8. The editor samples the loop at FLASH_FPS and refuses to save a
   theme past FLASH_LIMIT. */
export const FLASH_FPS = 30;
export const FLASH_LIMIT = 3;
const FLASH_SWING = 0.1;
const FLASH_DARK = 0.8;

const linear = (channel: number) => {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/* Relative luminance of the whole frame and of each quarter. */
function regionLuminance(pixels: Uint8ClampedArray, width: number, height: number): number[] {
  const sums = [0, 0, 0, 0, 0];
  const counts = [0, 0, 0, 0, 0];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4;
      const value = 0.2126 * linear(pixels[at]) + 0.7152 * linear(pixels[at + 1]) + 0.0722 * linear(pixels[at + 2]);
      const quarter = 1 + (x < width / 2 ? 0 : 1) + (y < height / 2 ? 0 : 2);
      sums[0] += value;
      counts[0] += 1;
      sums[quarter] += value;
      counts[quarter] += 1;
    }
  }
  return sums.map((sum, index) => (counts[index] ? sum / counts[index] : 0));
}

/* The frames at which one luminance series swings the other way by a flash's worth. */
function swings(series: number[]): number[] {
  const out: number[] = [];
  let low = series[0] ?? 0;
  let high = low;
  let direction = 0;
  series.forEach((value, index) => {
    if (direction >= 0 && value > high) high = value;
    if (direction <= 0 && value < low) low = value;
    if (direction >= 0 && high - value >= FLASH_SWING && Math.min(value, high) < FLASH_DARK && (direction > 0 || high - value >= FLASH_SWING)) {
      out.push(index);
      direction = -1;
      low = value;
    } else if (direction <= 0 && value - low >= FLASH_SWING && Math.min(value, low) < FLASH_DARK) {
      out.push(index);
      direction = 1;
      high = value;
    }
  });
  return out;
}

/* The most flashes in any one second over any region, and when (seconds). */
export function flashReport(frames: readonly Uint8ClampedArray[], width: number, height: number, fps = FLASH_FPS): { flashes: number; at: number } {
  const regions = frames.map((pixels) => regionLuminance(pixels, width, height));
  let worst = { flashes: 0, at: 0 };
  for (let region = 0; region < 5; region++) {
    const marks = swings(regions.map((values) => values[region]));
    for (let first = 0, last = 0; last < marks.length; last++) {
      while (marks[last] - marks[first] >= fps) first++;
      const flashes = Math.floor((last - first + 1) / 2);
      if (flashes > worst.flashes) worst = { flashes, at: marks[first] / fps };
    }
  }
  return worst;
}
