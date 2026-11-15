/* Keeps a WebGL canvas off the page and shows a plain 2D copy of it instead.

   A WebGL canvas on the page whose context is lost paints as a white box
   until something notices, and contexts get lost all the time: a reload
   while the old page's contexts are still dying, a GPU reset, the browser
   culling the oldest past its limit. A 2D canvas never does that; it just
   keeps its last frame. So the GL canvas draws out of sight and `copy()`,
   called right after each draw, mirrors the frame onto `canvas`, which goes
   on the page in its place (style it, observe it, take pointer events on it).

   A loss on the GL canvas clears the copy and is raised again on it, so
   listeners on the page (gl-budget.ts watches for losses there) still hear
   about it. */

export interface GlMirror {
  /** The 2D canvas to put on the page. */
  canvas: HTMLCanvasElement;
  /** Mirrors the GL canvas' current frame; call it right after drawing. */
  copy(): void;
  dispose(): void;
}

export function mirrorGlCanvas(gl: HTMLCanvasElement): GlMirror {
  const canvas = document.createElement("canvas");
  const view = canvas.getContext("2d");
  const onLost = () => {
    view?.clearRect(0, 0, canvas.width, canvas.height);
    canvas.dispatchEvent(new Event("webglcontextlost"));
  };
  gl.addEventListener("webglcontextlost", onLost);
  return {
    canvas,
    copy() {
      if (!view) return;
      if (canvas.width !== gl.width || canvas.height !== gl.height) {
        canvas.width = gl.width;
        canvas.height = gl.height;
      }
      view.clearRect(0, 0, canvas.width, canvas.height);
      view.drawImage(gl, 0, 0);
    },
    dispose() {
      gl.removeEventListener("webglcontextlost", onLost);
    },
  };
}

/* The same for a Paper Shaders mount (@paper-design/shaders): its canvas
   leaves the page for a 2D copy in the same spot (Paper's stylesheet styles
   any canvas in the mount), and every render it makes is copied over.
   Returns the cleanup, to run with the mount's own dispose(). */
export function mirrorShaderMount(mount: { canvasElement: HTMLCanvasElement }): () => void {
  const mirror = mirrorGlCanvas(mount.canvasElement);
  mount.canvasElement.replaceWith(mirror.canvas);
  // `render` is private in Paper's typings; Paper schedules frames with
  // `requestAnimationFrame(this.render)`, which reads the property each time
  const target = mount as unknown as { render: (time: number) => void };
  const render = target.render;
  target.render = (time: number) => {
    render(time);
    mirror.copy();
  };
  mirror.copy();
  return () => {
    mirror.dispose();
    mirror.canvas.remove();
  };
}
