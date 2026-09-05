import type { CardMotif } from "./card-motif";

/** Render-only compatibility for finishes stored before forging was removed. */
export const PACK_FINISH_IDS = ["prismatic", "aurora", "ember"] as const;
export type PackFinishId = (typeof PACK_FINISH_IDS)[number];
export function packFinishMotif(id: PackFinishId): CardMotif {
  return { url: `https://mania-tracker.com/images/card-finishes/${id}.svg`, scale: 0.75, opacity: 0.65, palette: id };
}

// Code-native vector motifs: one source for the canvas, WebGL and OG renderer.
const FINISH_SVGS: Record<PackFinishId, string> = {
  prismatic: '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><path d="M64 8 112 64 64 120 16 64Z" fill="#c4b5fd" fill-opacity=".18" stroke="#e9d5ff" stroke-width="2"/><path d="M64 8 64 120 16 64 112 64Z" fill="none" stroke="#67e8f9" stroke-width="2"/><path d="M64 8 112 64 64 64Z" fill="#f0abfc" fill-opacity=".55"/></svg>',
  aurora: '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><path d="M12 94Q34 4 64 56T116 22" fill="none" stroke="#5eead4" stroke-width="8" stroke-linecap="round"/><path d="M12 108Q34 18 64 70T116 36" fill="none" stroke="#a5b4fc" stroke-width="4" stroke-linecap="round" opacity=".65"/><circle cx="30" cy="22" r="3" fill="#ecfeff"/></svg>',
  ember: '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><path d="M70 8C76 44 108 55 100 86C94 110 66 124 43 108C13 88 26 66 45 44C41 69 57 73 61 55C68 38 59 24 70 8Z" fill="#fb923c" fill-opacity=".6" stroke="#fed7aa" stroke-width="2"/><path d="M64 64C84 84 79 110 62 111C42 109 47 89 64 64Z" fill="#fff7ed" fill-opacity=".8"/></svg>',
};
export function packFinishSvg(url: string): string | null {
  const id = PACK_FINISH_IDS.find((id) => packFinishMotif(id).url === url);
  return id ? FINISH_SVGS[id] : null;
}
