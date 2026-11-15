import { ShaderMount } from "@paper-design/shaders";

/* Name styles draw through ShaderMount (@paper-design/shaders, Apache-2.0).
   Its constructor compiles and links its program and asks the GPU at once
   whether that worked, so the page waits for the whole compile: 300 ms for
   the galaxy style on a cold shader cache, on a fast desktop GPU.

   Here the canvas and context it will use are made first, the program is
   built on that context with the driver's parallel compile, and its finish is
   checked once a frame, so nothing waits. ShaderMount is then constructed
   with that canvas and handed the finished program: for the length of the
   constructor, its context's compile calls return the ready program instead
   of compiling again. Without parallel compile it is constructed as before. */

/* ShaderMount's vertex shader, copied from the package (it isn't exported);
   name-shader-warmup.test.ts fails when the package's copy changes. */
export const SHADER_MOUNT_VERTEX = `#version 300 es
precision mediump float;

layout(location = 0) in vec4 a_position;

uniform vec2 u_resolution;
uniform float u_pixelRatio;
uniform float u_imageAspectRatio;
uniform float u_originX;
uniform float u_originY;
uniform float u_worldWidth;
uniform float u_worldHeight;
uniform float u_fit;
uniform float u_scale;
uniform float u_rotation;
uniform float u_offsetX;
uniform float u_offsetY;

out vec2 v_objectUV;
out vec2 v_objectBoxSize;
out vec2 v_responsiveUV;
out vec2 v_responsiveBoxGivenSize;
out vec2 v_patternUV;
out vec2 v_patternBoxSize;
out vec2 v_imageUV;

vec3 getBoxSize(float boxRatio, vec2 givenBoxSize) {
  vec2 box = vec2(0.);
  // fit = none
  box.x = boxRatio * min(givenBoxSize.x / boxRatio, givenBoxSize.y);
  float noFitBoxWidth = box.x;
  if (u_fit == 1.) { // fit = contain
    box.x = boxRatio * min(u_resolution.x / boxRatio, u_resolution.y);
  } else if (u_fit == 2.) { // fit = cover
    box.x = boxRatio * max(u_resolution.x / boxRatio, u_resolution.y);
  }
  box.y = box.x / boxRatio;
  return vec3(box, noFitBoxWidth);
}

void main() {
  gl_Position = a_position;

  vec2 uv = gl_Position.xy * .5;
  vec2 boxOrigin = vec2(.5 - u_originX, u_originY - .5);
  vec2 givenBoxSize = vec2(u_worldWidth, u_worldHeight);
  givenBoxSize = max(givenBoxSize, vec2(1.)) * u_pixelRatio;
  float r = u_rotation * 3.14159265358979323846 / 180.;
  mat2 graphicRotation = mat2(cos(r), sin(r), -sin(r), cos(r));
  vec2 graphicOffset = vec2(-u_offsetX, u_offsetY);


  // ===================================================

  float fixedRatio = 1.;
  vec2 fixedRatioBoxGivenSize = vec2(
  (u_worldWidth == 0.) ? u_resolution.x : givenBoxSize.x,
  (u_worldHeight == 0.) ? u_resolution.y : givenBoxSize.y
  );

  v_objectBoxSize = getBoxSize(fixedRatio, fixedRatioBoxGivenSize).xy;
  vec2 objectWorldScale = u_resolution.xy / v_objectBoxSize;

  v_objectUV = uv;
  v_objectUV *= objectWorldScale;
  v_objectUV += boxOrigin * (objectWorldScale - 1.);
  v_objectUV += graphicOffset;
  v_objectUV /= u_scale;
  v_objectUV = graphicRotation * v_objectUV;

  // ===================================================

  v_responsiveBoxGivenSize = vec2(
  (u_worldWidth == 0.) ? u_resolution.x : givenBoxSize.x,
  (u_worldHeight == 0.) ? u_resolution.y : givenBoxSize.y
  );
  float responsiveRatio = v_responsiveBoxGivenSize.x / v_responsiveBoxGivenSize.y;
  vec2 responsiveBoxSize = getBoxSize(responsiveRatio, v_responsiveBoxGivenSize).xy;
  vec2 responsiveBoxScale = u_resolution.xy / responsiveBoxSize;

  #ifdef ADD_HELPERS
  v_responsiveHelperBox = uv;
  v_responsiveHelperBox *= responsiveBoxScale;
  v_responsiveHelperBox += boxOrigin * (responsiveBoxScale - 1.);
  #endif

  v_responsiveUV = uv;
  v_responsiveUV *= responsiveBoxScale;
  v_responsiveUV += boxOrigin * (responsiveBoxScale - 1.);
  v_responsiveUV += graphicOffset;
  v_responsiveUV /= u_scale;
  v_responsiveUV.x *= responsiveRatio;
  v_responsiveUV = graphicRotation * v_responsiveUV;
  v_responsiveUV.x /= responsiveRatio;

  // ===================================================

  float patternBoxRatio = givenBoxSize.x / givenBoxSize.y;
  vec2 patternBoxGivenSize = vec2(
  (u_worldWidth == 0.) ? u_resolution.x : givenBoxSize.x,
  (u_worldHeight == 0.) ? u_resolution.y : givenBoxSize.y
  );
  patternBoxRatio = patternBoxGivenSize.x / patternBoxGivenSize.y;

  vec3 boxSizeData = getBoxSize(patternBoxRatio, patternBoxGivenSize);
  v_patternBoxSize = boxSizeData.xy;
  float patternBoxNoFitBoxWidth = boxSizeData.z;
  vec2 patternBoxScale = u_resolution.xy / v_patternBoxSize;

  v_patternUV = uv;
  v_patternUV += graphicOffset / patternBoxScale;
  v_patternUV += boxOrigin;
  v_patternUV -= boxOrigin / patternBoxScale;
  v_patternUV *= u_resolution.xy;
  v_patternUV /= u_pixelRatio;
  if (u_fit > 0.) {
    v_patternUV *= (patternBoxNoFitBoxWidth / v_patternBoxSize.x);
  }
  v_patternUV /= u_scale;
  v_patternUV = graphicRotation * v_patternUV;
  v_patternUV += boxOrigin / patternBoxScale;
  v_patternUV -= boxOrigin;
  // x100 is a default multiplier between vertex and fragmant shaders
  // we use it to avoid UV presision issues
  v_patternUV *= .01;

  // ===================================================

  vec2 imageBoxSize;
  if (u_fit == 1.) { // contain
    imageBoxSize.x = min(u_resolution.x / u_imageAspectRatio, u_resolution.y) * u_imageAspectRatio;
  } else if (u_fit == 2.) { // cover
    imageBoxSize.x = max(u_resolution.x / u_imageAspectRatio, u_resolution.y) * u_imageAspectRatio;
  } else {
    imageBoxSize.x = min(10.0, 10.0 / u_imageAspectRatio * u_imageAspectRatio);
  }
  imageBoxSize.y = imageBoxSize.x / u_imageAspectRatio;
  vec2 imageBoxScale = u_resolution.xy / imageBoxSize;

  v_imageUV = uv;
  v_imageUV *= imageBoxScale;
  v_imageUV += boxOrigin * (imageBoxScale - 1.);
  v_imageUV += graphicOffset;
  v_imageUV /= u_scale;
  v_imageUV.x *= u_imageAspectRatio;
  v_imageUV = graphicRotation * v_imageUV;
  v_imageUV.x /= u_imageAspectRatio;

  v_imageUV += .5;
  v_imageUV.y = 1. - v_imageUV.y;
}`;

const FINISH_TIMEOUT_MS = 8000;

type MountArgs = ConstructorParameters<typeof ShaderMount>;

/* ShaderMount raises medium precision to high where the GPU's medium float
   is short; the program built here must be the one it would build. */
function asShaderMountWould(gl: WebGL2RenderingContext, vertex: string, fragment: string): [string, string] {
  const format = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.MEDIUM_FLOAT);
  if (!format || format.precision >= 23) return [vertex, fragment];
  return [
    vertex.replace(/precision\s+(lowp|mediump)\s+float;/g, "precision highp float;"),
    fragment.replace(/precision\s+(lowp|mediump)\s+float/g, "precision highp float").replace(/\b(uniform|varying|attribute)\s+(lowp|mediump)\s+(\w+)/g, "$1 highp $3"),
  ];
}

/* Links `fragment` on `gl` in the background; resolves with the program once
   the driver says it is done and it linked, or null (then ShaderMount
   compiles it itself and reports the error as it always did). */
function buildInBackground(gl: WebGL2RenderingContext, fragment: string, isCancelled: () => boolean): Promise<WebGLProgram | null> {
  const parallel = gl.getExtension("KHR_parallel_shader_compile") as { COMPLETION_STATUS_KHR: number } | null;
  if (!parallel) return Promise.resolve(null);
  const [vertexSource, fragmentSource] = asShaderMountWould(gl, SHADER_MOUNT_VERTEX, fragment);
  const vertex = gl.createShader(gl.VERTEX_SHADER);
  const shader = gl.createShader(gl.FRAGMENT_SHADER);
  const program = gl.createProgram();
  if (!vertex || !shader || !program) return Promise.resolve(null);
  gl.shaderSource(vertex, vertexSource);
  gl.shaderSource(shader, fragmentSource);
  gl.compileShader(vertex);
  gl.compileShader(shader);
  gl.attachShader(program, vertex);
  gl.attachShader(program, shader);
  gl.linkProgram(program);
  const started = performance.now();
  return new Promise((resolve) => {
    const settle = (ok: boolean) => {
      gl.detachShader(program, vertex);
      gl.detachShader(program, shader);
      gl.deleteShader(vertex);
      gl.deleteShader(shader);
      if (!ok) gl.deleteProgram(program);
      resolve(ok ? program : null);
    };
    const check = () => {
      if (isCancelled() || gl.isContextLost()) return settle(false);
      const done = gl.getProgramParameter(program, parallel.COMPLETION_STATUS_KHR);
      if (!done && performance.now() - started < FINISH_TIMEOUT_MS) {
        requestAnimationFrame(check);
        return;
      }
      settle(!!gl.getProgramParameter(program, gl.LINK_STATUS));
    };
    requestAnimationFrame(check);
  });
}

/* For the constructor only: the context's compile calls hand back `program`
   (ShaderMount's createProgram makes two shaders and one program, checks
   them, then detaches and deletes the shaders). */
function adoptProgram<T>(gl: WebGL2RenderingContext, program: WebGLProgram, construct: () => T): T {
  const target = gl as unknown as Record<string, unknown>;
  const fakeShaders = new Set<object>();
  const overrides: Record<string, (...args: unknown[]) => unknown> = {
    createShader: () => {
      const fake = {};
      fakeShaders.add(fake);
      return fake;
    },
    shaderSource: () => undefined,
    compileShader: () => undefined,
    getShaderParameter: () => true,
    createProgram: () => program,
    attachShader: () => undefined,
    linkProgram: () => undefined,
    detachShader: () => undefined,
    deleteShader: (shader: unknown) => {
      if (!fakeShaders.has(shader as object)) return WebGL2RenderingContext.prototype.deleteShader.call(gl, shader as WebGLShader);
    },
  };
  // the real method, since the context's own property is overridden here
  const realGetProgramParameter = WebGL2RenderingContext.prototype.getProgramParameter;
  overrides.getProgramParameter = (_program: unknown, pname: unknown) => (pname === gl.LINK_STATUS ? true : realGetProgramParameter.call(gl, program, pname as number));
  for (const [name, fn] of Object.entries(overrides)) target[name] = fn;
  try {
    return construct();
  } finally {
    for (const name of Object.keys(overrides)) delete target[name];
  }
}

/* A ShaderMount whose program was compiled without holding the page. Its
   canvas is made here, with the context ShaderMount would ask for, and handed
   to it through the one createElement("canvas") call its constructor makes.
   Resolves null if `isCancelled` turns true first. */
export async function mountShaderInBackground(isCancelled: () => boolean, ...args: MountArgs): Promise<ShaderMount | null> {
  const [host, fragment, , attributes] = args;
  const doc = host.ownerDocument;
  const canvas = doc.createElement("canvas");
  const gl = canvas.getContext("webgl2", attributes);
  if (!gl) return isCancelled() ? null : new ShaderMount(...args);
  const program = await buildInBackground(gl, fragment, isCancelled);
  if (isCancelled()) {
    if (program) gl.deleteProgram(program);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return null;
  }
  const create = doc.createElement.bind(doc);
  const handOver = ((tag: string, options?: ElementCreationOptions) => (tag === "canvas" ? canvas : create(tag, options))) as typeof doc.createElement;
  doc.createElement = handOver;
  try {
    return program ? adoptProgram(gl, program, () => new ShaderMount(...args)) : new ShaderMount(...args);
  } finally {
    // only the constructor's own createElement("canvas") may get it
    if (doc.createElement === handOver) delete (doc as unknown as Record<string, unknown>).createElement;
  }
}
