import { CUSTOM_THEME_LOOP_BUDGET, CUSTOM_THEME_SOURCE_MAX_BYTES, CUSTOM_THEME_TEXTURES } from "#custom-themes/inputs";
import { PROFILE_THEME_PRELUDE } from "./profile-theme-shaders";
import type { AppLocale } from "./locale";

/* The theme spec as one plain-text page, to copy from the editor or read at
   /workshop/themes/spec. The helpers' list is read out of the
   prelude itself, so it can't drift from what the shader really gets. */

export interface PreludeHelper {
  signature: string;
  note: string | null;
}

/* Every function the prelude defines, with the comment above it, if any. */
export function preludeHelpers(prelude = PROFILE_THEME_PRELUDE): PreludeHelper[] {
  const lines = prelude.split("\n");
  const helpers: PreludeHelper[] = [];
  lines.forEach((line, index) => {
    const match = /^(float|vec2|vec3|vec4|mat2|int|bool)\s+(\w+)\(([^)]*)\)\s*\{/.exec(line);
    if (!match) return;
    let note: string | null = null;
    const above = lines[index - 1]?.trim() ?? "";
    if (above.endsWith("*/")) {
      const comment: string[] = [];
      for (let back = index - 1; back >= 0; back--) {
        comment.unshift(lines[back].trim());
        if (lines[back].trim().startsWith("/*")) break;
      }
      note = comment.join(" ").replace(/^\/\*\s*|\s*\*\/$/g, "").replace(/\\`/g, "`").replace(/\s+/g, " ").trim();
    }
    helpers.push({ signature: `${match[1]} ${match[2]}(${match[3]})`, note });
  });
  return helpers;
}

export type SpecSectionId = "contract" | "inputs" | "helpers" | "limits" | "example";

/* Each section's heading line in the plain text, per locale. The page finds
   the sections by these, so they read in the visitor's language. */
export const SPEC_HEADINGS: Record<AppLocale, Record<SpecSectionId, string>> = {
  en: { contract: "THE CONTRACT", inputs: "INPUTS", helpers: "HELPERS", limits: "LIMITS", example: "EXAMPLE" },
  es: { contract: "EL CONTRATO", inputs: "ENTRADAS", helpers: "FUNCIONES AUXILIARES", limits: "LÍMITES", example: "EJEMPLO" },
  "zh-CN": { contract: "约定", inputs: "输入", helpers: "辅助函数", limits: "限制", example: "示例" },
};

/* What each helper does, for the ones with no comment above them in the
   prelude; outside English, for every one of them. */
const HELPER_NOTES: Record<AppLocale, Record<string, string>> = {
  en: {
    hash: "a random value 0..1 for a point",
    noise: "smooth value noise, 0..1",
    fbm: "5 octaves of noise, 0..1",
    ihash: "integer-cell hash 0..1, the same on every GPU",
    inoise: "value noise on the integer hash: use it for new code, it never tears into squares on phones",
    ifbm: "5 octaves of inoise, 0..1",
    rot: "a 2D rotation matrix: rot(a) * p",
    pointerP: "the pointer in p units (see theme() below)",
  },
  es: {
    hash: "un valor al azar 0..1 para un punto",
    noise: "ruido de valor suave, 0..1",
    fbm: "5 octavas de noise, 0..1",
    ihash: "hash de celda entera 0..1, igual en cualquier GPU",
    inoise: "ruido de valor sobre el hash entero: úsalo en código nuevo, nunca se rompe en cuadros en celulares",
    ifbm: "5 octavas de inoise, 0..1",
    rot: "una matriz de rotación 2D: rot(a) * p",
    pointerP: "el puntero en unidades de p (ver theme() abajo)",
    stars: "puntos que titilan: `scale` celdas por unidad, `density` la parte de las celdas encendidas. La cuadrícula de cada capa gira a su manera y cada estrella cae en cualquier punto de su celda, casi siempre pequeña y de vez en cuando una más grande, así que no se ven filas.",
    voronoiEdge: "distancia entre el punto de celda más cercano y el segundo más cercano: 0 en el borde de una celda.",
  },
  "zh-CN": {
    hash: "给一个点生成 0..1 的随机值",
    noise: "平滑的值噪声，0..1",
    fbm: "5 个八度的 noise，0..1",
    ihash: "整数格哈希，0..1，在所有 GPU 上结果相同",
    inoise: "基于整数哈希的值噪声：新代码请用它，在手机上不会裂成方块",
    ifbm: "5 个八度的 inoise，0..1",
    rot: "二维旋转矩阵：rot(a) * p",
    pointerP: "以 p 为单位的指针位置（见下方 theme()）",
    stars: "闪烁的星点：`scale` 是每单位的格数，`density` 是点亮格子的比例。每层网格各自旋转，星星可以落在格子里的任何位置，大多很小，偶尔有一颗大的，所以看不出成行。",
    voronoiEdge: "最近和第二近的格点之间的距离：在格子边缘处为 0。",
  },
};

export const CUSTOM_THEME_STARTER = `// Slow aurora curtains over a starfield, leaning toward the pointer.
vec3 theme(vec2 uv, vec2 p, float t) {
  vec3 col = mix(vec3(.01, .02, .04), vec3(.02, .05, .08), uv.y);
  col += vec3(.8, .9, 1.) * stars(p + vec2(0., u_scroll * .1), 60., .08, t) * .6;
  vec2 q = p + pointerP() * .05;
  float band = ifbm(vec2(q.x * 1.6 + t * .05, q.y * .6));
  float curtain = smoothstep(.15, 0., abs(q.y - .15 - (band - .5) * .5));
  col += vec3(.1, .8, .55) * curtain * (.25 + .2 * sin(t * .4 + q.x * 3.));
  return col;
}`;

export function customThemeSpec(locale: AppLocale = "en"): string {
  const notes = HELPER_NOTES[locale];
  const helpers = preludeHelpers()
    .map((helper) => {
      const name = /\s(\w+)\(/.exec(helper.signature)?.[1] ?? "";
      const note = (locale === "en" ? helper.note : null) ?? notes[name] ?? helper.note ?? HELPER_NOTES.en[name] ?? null;
      return `- ${helper.signature}${note ? `: ${note}` : ""}`;
    })
    .join("\n");
  return SPEC_TEXT[locale](SPEC_HEADINGS[locale], helpers);
}

const LAST = CUSTOM_THEME_TEXTURES - 1;
const KB = CUSTOM_THEME_SOURCE_MAX_BYTES / 1024;

const SPEC_TEXT: Record<AppLocale, (h: Record<SpecSectionId, string>, helpers: string) => string> = {
  en: (h, helpers) => `PROFILE THEME SPEC

A profile theme is a GLSL ES 3.00 (WebGL2) fragment shader drawn full-screen
behind a player's profile. White text and dark panels sit on top of it.

${h.contract}
Write one function, plus any helpers of your own:

  vec3 theme(vec2 uv, vec2 p, float t)

- uv: 0..1 across the canvas, y up.
- p: centred on the canvas and measured in canvas heights, so p.y runs
  -0.5..0.5 and p.x wider on a wide screen. Use p for shapes so circles stay
  round.
- t: seconds since the theme started.
- Return the pixel's colour, linear 0..1. Don't write main(); the site's
  main() calls theme(), clamps the colour at 0 and adds a touch of dither.

A Shadertoy shader also works as pasted: void mainImage(out vec4 fragColor,
in vec2 fragCoord), with iTime, iResolution, iMouse (no clicks), iFrame and
iChannel0..${LAST} (the theme's images). Single pass only: no Buffer A-D, no
sound, no keyboard.

${h.inputs}
- float u_time: seconds (the same as t).
- vec2 u_res: the canvas size in pixels.
- vec2 u_pointer: the pointer over the canvas, 0..1 with y up, eased.
- float u_scroll: how far the page has scrolled, in screen heights (0 at the
  top). Drift layers by it at different depths for parallax.
- float PX: one canvas pixel in p units, to keep fine detail from vanishing
  on small screens.
- sampler2D u_tex0..u_tex${LAST} and vec2 u_texSize0..u_texSize${LAST}: up to ${CUSTOM_THEME_TEXTURES} images the author
  uploads, premultiplied alpha, mipmapped, repeating. Their first row is at
  the top: sample with vec2(uv.x, 1. - uv.y). An unused slot reads as clear.

${h.helpers} (already defined; don't redefine them)
${helpers}

${h.limits}
- At most ${KB} KB of code. Outside comments, only basic keyboard
  characters: no curly quotes, accented letters, emoji or other alphabets.
- No uniform, in, out or layout declarations, no main(), and no #version,
  #extension, #pragma or #line. #define and #if work.
- Names starting with u_, gl_ or _cg_ belong to the site (reading
  gl_FragCoord is fine).
- Loops: every loop turn in a pixel counts, all loops together, and after
  ${CUSTOM_THEME_LOOP_BUDGET} turns every loop stops early. Keep raymarches and nested loops
  well under that, or parts of the image cut off.
- Cost: the theme can't be heavier than the heaviest built-in theme (Black
  hole). The editor measures it and says how far over it is. Fewer fbm
  octaves, fewer loop turns and fewer texture reads are the usual fixes.
- Stay dark: the page's text is white. A mean brightness around 0.05 to
  0.15 reads well; much above 0.3 makes the profile hard to read.
- Visitors on slow devices get a lower resolution, and the theme's still
  image if it is still too slow, so design for a still frame to look good.

${h.example}
${CUSTOM_THEME_STARTER}
`,
  es: (h, helpers) => `ESPECIFICACIÓN DE TEMAS DE PERFIL

Un tema de perfil es un fragment shader de GLSL ES 3.00 (WebGL2) que se
dibuja a pantalla completa detrás del perfil de un jugador. Encima van texto
blanco y paneles oscuros.

${h.contract}
Escribe una función, más las funciones auxiliares propias que quieras:

  vec3 theme(vec2 uv, vec2 p, float t)

- uv: 0..1 a lo ancho del canvas, con y hacia arriba.
- p: centrado en el canvas y medido en alturas del canvas, así que p.y va de
  -0.5 a 0.5 y p.x llega más lejos en una pantalla ancha. Usa p para las
  formas, así los círculos quedan redondos.
- t: segundos desde que empezó el tema.
- Devuelve el color del pixel, lineal 0..1. No escribas main(); el main() del
  sitio llama a theme(), recorta el color en 0 y le agrega un poco de dither.

Un shader de Shadertoy también funciona pegado tal cual: void mainImage(out
vec4 fragColor, in vec2 fragCoord), con iTime, iResolution, iMouse (sin
clics), iFrame e iChannel0..${LAST} (las imágenes del tema). Una sola pasada: sin
Buffer A-D, sin sonido y sin teclado.

${h.inputs}
- float u_time: segundos (lo mismo que t).
- vec2 u_res: el tamaño del canvas en pixeles.
- vec2 u_pointer: el puntero sobre el canvas, 0..1 con y hacia arriba,
  suavizado.
- float u_scroll: cuánto se ha bajado en la página, en alturas de pantalla (0
  arriba del todo). Mueve capas con él a distintas profundidades para un
  efecto parallax.
- float PX: un pixel del canvas en unidades de p, para que el detalle fino no
  desaparezca en pantallas pequeñas.
- sampler2D u_tex0..u_tex${LAST} y vec2 u_texSize0..u_texSize${LAST}: hasta ${CUSTOM_THEME_TEXTURES} imágenes que sube el
  autor, con alfa premultiplicado, mipmaps y repetidas. Su primera fila está
  arriba: muestréalas con vec2(uv.x, 1. - uv.y). Un espacio sin imagen se lee
  transparente.

${h.helpers} (ya definidas; no las vuelvas a definir)
${helpers}

${h.limits}
- Como máximo ${KB} KB de código. Fuera de los comentarios, solo caracteres
  básicos del teclado: sin comillas tipográficas, letras con tilde, emojis ni
  otros alfabetos.
- Sin declaraciones uniform, in, out ni layout, sin main(), y sin #version,
  #extension, #pragma ni #line. #define y #if sí funcionan.
- Los nombres que empiezan con u_, gl_ o _cg_ son del sitio (leer
  gl_FragCoord sí se puede).
- Bucles: cada vuelta de bucle en un pixel cuenta, todos los bucles juntos, y
  después de ${CUSTOM_THEME_LOOP_BUDGET} vueltas todos los bucles paran antes de tiempo. Deja los raymarches y
  los bucles anidados muy por debajo de eso, o partes de la imagen se cortan.
- Costo: el tema no puede ser más pesado que el tema incluido más pesado
  (Black hole). El editor lo mide y dice cuánto se pasa. Menos octavas de fbm,
  menos vueltas de bucle y menos lecturas de textura son lo que suele
  arreglarlo.
- Mantenlo oscuro: el texto de la página es blanco. Un brillo promedio de
  0.05 a 0.15 se lee bien; mucho más de 0.3 hace difícil leer el perfil.
- Quien visita desde un dispositivo lento ve una resolución más baja, y la
  imagen fija del tema si aun así va lento, así que diseña para que un
  fotograma quieto se vea bien.

${h.example}
${CUSTOM_THEME_STARTER}
`,
  "zh-CN": (h, helpers) => `个人资料主题规范

个人资料主题是一个 GLSL ES 3.00 (WebGL2) 片段着色器，全屏绘制在玩家个人资料的
背后。白色文字和深色面板叠在它上面。

${h.contract}
写一个函数，另外可以加上你自己的辅助函数：

  vec3 theme(vec2 uv, vec2 p, float t)

- uv: 在画布上从 0 到 1，y 轴向上。
- p: 以画布中心为原点，以画布高度为单位，所以 p.y 的范围是 -0.5..0.5，
  宽屏上 p.x 的范围更大。画形状时用 p，圆才会是圆的。
- t: 主题开始以来的秒数。
- 返回像素的颜色，线性 0..1。不要写 main()；网站的 main() 会调用 theme()，
  把颜色下限截到 0，并加上一点抖动。

Shadertoy 的着色器也可以直接粘贴使用：void mainImage(out vec4 fragColor,
in vec2 fragCoord)，可用 iTime、iResolution、iMouse（没有点击）、iFrame 和
iChannel0..${LAST}（主题的图片）。只支持单个 pass：没有 Buffer A-D，没有声音，
没有键盘。

${h.inputs}
- float u_time: 秒数（和 t 相同）。
- vec2 u_res: 画布的像素尺寸。
- vec2 u_pointer: 指针在画布上的位置，0..1，y 轴向上，带缓动。
- float u_scroll: 页面已滚动的距离，以屏幕高度为单位（顶部为 0）。让不同深度的
  图层按它移动，就能做出视差效果。
- float PX: 以 p 为单位的一个画布像素，让细节在小屏幕上不会消失。
- sampler2D u_tex0..u_tex${LAST} 和 vec2 u_texSize0..u_texSize${LAST}: 作者上传的最多 ${CUSTOM_THEME_TEXTURES} 张图片，
  预乘 alpha，带 mipmap，重复平铺。它们的第一行在顶部：用 vec2(uv.x, 1. - uv.y)
  采样。没有图片的槽位读出来是透明的。

${h.helpers}（已经定义好；不要重复定义）
${helpers}

${h.limits}
- 代码最多 ${KB} KB。注释以外只能用键盘上的基本字符：不能有弯引号、带重音的字母、
  emoji 或其他文字。
- 不能声明 uniform、in、out 或 layout，不能写 main()，也不能用 #version、
  #extension、#pragma 或 #line。#define 和 #if 可以用。
- 以 u_、gl_ 或 _cg_ 开头的名字归网站所有（读取 gl_FragCoord 没问题）。
- 循环：一个像素里的每一轮循环都算数，所有循环合计，超过 ${CUSTOM_THEME_LOOP_BUDGET} 轮后所有循环
  都会提前停止。光线步进和嵌套循环要远低于这个数，否则图像会有部分被截掉。
- 开销：主题不能比最重的内置主题（Black hole）更重。编辑器会测量它，并告诉你超出
  多少。减少 fbm 的八度、减少循环轮数和减少纹理读取，通常就能解决。
- 保持暗色：页面上的文字是白色的。平均亮度在 0.05 到 0.15 左右最好读；明显超过
  0.3 会让个人资料很难看清。
- 用慢设备访问的人会看到较低的分辨率，如果还是太慢，就会看到主题的静态图，所以
  要让静止的一帧也好看。

${h.example}
${CUSTOM_THEME_STARTER}
`,
};
