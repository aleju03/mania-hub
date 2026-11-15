/* Two habits for every WebGL canvas on the site, installed once from the root.

   A reload doesn't run React's cleanups, so the old page's contexts stay
   alive while the new page makes its own. A few reloads in a row run the
   browser past its context limit: it kills contexts (each then paints as a
   white box) and, pushed far enough, the GPU process stalls and the tab
   freezes. So every context is let go on `pagehide`, before the next page
   starts.

   And a canvas whose context is killed anyway is hidden until it's restored,
   so a lost one never shows as a white rectangle. Components that rebuild on
   loss (gl-budget.ts) make a fresh canvas, which starts visible. */

let installed = false;

export function installWebGlHygiene(): void {
  if (installed || typeof window === "undefined" || typeof HTMLCanvasElement === "undefined") return;
  installed = true;
  /* Weakly held, and dropped once lost (a dispose's loseContext() included):
     a page that makes and drops contexts for hours must not keep every one. */
  const live = new Set<WeakRef<WebGLRenderingContext | WebGL2RenderingContext>>();
  const seen = new WeakSet<object>();
  const original = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
    const context = (original as (...args: unknown[]) => RenderingContext | null).call(this, type, ...rest);
    if (context && (type === "webgl" || type === "webgl2" || type === "experimental-webgl") && !seen.has(context)) {
      seen.add(context);
      const ref = new WeakRef(context as WebGLRenderingContext);
      live.add(ref);
      const canvas = this;
      canvas.addEventListener("webglcontextlost", () => {
        canvas.style.visibility = "hidden";
        live.delete(ref);
      });
      canvas.addEventListener("webglcontextrestored", () => {
        canvas.style.visibility = "";
        live.add(ref);
      });
    }
    return context;
  } as typeof HTMLCanvasElement.prototype.getContext;

  window.addEventListener("pagehide", (event) => {
    // a page kept in the back/forward cache comes back as it was: keep its contexts
    if (event.persisted) return;
    // hidden first, in the same frame: a lost context paints white, and the
    // old page can stay on screen a moment before the next one replaces it
    const contexts = [...live].map((ref) => ref.deref()).filter((context) => context !== undefined);
    for (const context of contexts) {
      if (context.canvas instanceof HTMLCanvasElement) context.canvas.style.visibility = "hidden";
    }
    for (const context of contexts) {
      try {
        context.getExtension("WEBGL_lose_context")?.loseContext();
      } catch {
        // already gone
      }
    }
    live.clear();
  });
}
