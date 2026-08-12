// The geometry the BBCode editor has to imitate to be worth trusting.
//
// osu! renders a profile [img] at the file's own pixel width: the page ships
// `style="width:<intrinsic>px; aspect-ratio:<w/h>"` on every image, with
// `max-width: 100%` and no height cap, inside a "me!" column that is a fixed
// 890px wide at 14px - measured off a live profile page at viewport widths from
// 700px to 2560px, where it never moved. The profile page does not reflow.
//
// So there is exactly one number that decides how big an image looks on someone
// else's screen: how many pixels wide the file is. An editor that shows images
// at some other size is guessing, and the only way to make a picture smaller on
// a profile is to re-encode the file with fewer pixels (osu!'s [img] takes no
// width parameter).

/** Content width of osu!'s profile "me!" column, in CSS px. */
export const OSU_PROFILE_COLUMN_WIDTH = 890;

/** Horizontal padding the editor puts either side of that column, in CSS px. */
export const EDITOR_COLUMN_GUTTER = 16;

/**
 * Scale to apply to the column so it fits `paneWidth` without reflowing.
 *
 * Never scales up: a pane wider than the column shows it at 1:1 and centres it,
 * because rendering the column bigger than osu! does would misprice images in
 * the other direction.
 */
export function columnFitScale(paneWidth: number): number {
  const needed = OSU_PROFILE_COLUMN_WIDTH + 2 * EDITOR_COLUMN_GUTTER;
  if (!Number.isFinite(paneWidth) || paneWidth <= 0) return 1;
  return Math.min(1, paneWidth / needed);
}
