/* CanvasRenderingContext2D.roundRect does not exist on Safari < 16 or
   Chrome < 99, and those browsers are still real in the analytics (the packs
   page threw "e.roundRect is not a function" for them). Same subpath, drawn
   with arcTo where the native call is missing. Only the single-radius form,
   which is all this codebase uses; the native call gets it as a one-element
   sequence because early implementations (still live in CN/VN mobile
   browsers) reject a bare number with "cannot be converted to a sequence". */
export function pathRoundRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  if (typeof context.roundRect === "function") {
    context.roundRect(x, y, width, height, [radius]);
    return;
  }
  const r = Math.max(0, Math.min(radius, Math.abs(width) / 2, Math.abs(height) / 2));
  context.moveTo(x + r, y);
  context.arcTo(x + width, y, x + width, y + height, r);
  context.arcTo(x + width, y + height, x, y + height, r);
  context.arcTo(x, y + height, x, y, r);
  context.arcTo(x, y, x + width, y, r);
  context.closePath();
}
