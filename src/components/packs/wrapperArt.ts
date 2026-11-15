import { useSyncExternalStore } from "react";

import type { SupporterWrapperId } from "#/lib/supporter-pack-style";

/* Wrappers whose stock is a render (a Blender model made for the site), not
   drawn on the canvas: the whole 600x1000 pack front, the back without its
   centrepiece, and a cut-out of the parts that take the pack's colour. The
   number in a file name is its version, since /images/ is served cache-first.

   A pack is painted synchronously, so the files load on first ask and
   whatever painted a pack before they were in repaints off the version. */
interface WrapperArtFiles {
  front: string;
  back?: string;
  tint?: string;
  /* The render is stock alone, so the pack's coin is still drawn on it. */
  coin?: boolean;
  /* How far the stretch under the pack's print is darkened (0 to 1), where the
     render alone is too bright or too busy for white type. */
  calm?: number;
}

const FILES: Partial<Record<SupporterWrapperId, WrapperArtFiles>> = {
  holo: { front: "/images/pack-wrappers/holo-1.webp", coin: true, calm: 0.5 },
  keycaps: {
    front: "/images/pack-wrappers/keycaps-1.webp",
    back: "/images/pack-wrappers/keycaps-back-1.webp",
    tint: "/images/pack-wrappers/keycaps-tint-1.webp",
  },
  cassette: {
    front: "/images/pack-wrappers/cassette-1.webp",
    back: "/images/pack-wrappers/cassette-back-1.webp",
    tint: "/images/pack-wrappers/cassette-tint-1.webp",
  },
  parcel: {
    front: "/images/pack-wrappers/parcel-1.webp",
    back: "/images/pack-wrappers/parcel-back-1.webp",
    tint: "/images/pack-wrappers/parcel-tint-1.webp",
    calm: 0.34,
  },
  antistatic: {
    front: "/images/pack-wrappers/antistatic-1.webp",
    back: "/images/pack-wrappers/antistatic-back-1.webp",
    tint: "/images/pack-wrappers/antistatic-tint-1.webp",
    calm: 0.3,
  },
};

export interface WrapperArt {
  front: HTMLImageElement;
  back: HTMLImageElement | null;
  tint: HTMLImageElement | null;
}

const loaded = new Map<SupporterWrapperId, WrapperArt>();
const loading = new Set<SupporterWrapperId>();
const listeners = new Set<() => void>();
let version = 0;

function load(url: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.decoding = "async";
  image.src = url;
  return image.decode().then(() => image);
}

export function hasWrapperArt(wrapper: SupporterWrapperId): boolean {
  return FILES[wrapper] !== undefined;
}

/** How a rendered wrapper wants the pack drawn over it. */
export function wrapperArtLook(wrapper: SupporterWrapperId): { coin: boolean; calm: number } {
  return { coin: FILES[wrapper]?.coin ?? false, calm: FILES[wrapper]?.calm ?? 0 };
}

/** The wrapper's renders once they are in; until then null, and they start loading. */
export function wrapperArt(wrapper: SupporterWrapperId): WrapperArt | null {
  const files = FILES[wrapper];
  if (!files) return null;
  const ready = loaded.get(wrapper);
  if (ready) return ready;
  if (!loading.has(wrapper) && typeof Image !== "undefined") {
    loading.add(wrapper);
    Promise.all([load(files.front), files.back ? load(files.back) : null, files.tint ? load(files.tint) : null])
      .then(([front, back, tint]) => {
        loaded.set(wrapper, { front, back, tint });
        version += 1;
        listeners.forEach((listener) => listener());
      })
      // a failed load is asked for again by the next paint
      .catch(() => loading.delete(wrapper));
  }
  return null;
}

/** True while a wrapper's pack would be painted without its renders. */
export function wrapperArtPending(wrapper: SupporterWrapperId | null | undefined): boolean {
  return !!wrapper && hasWrapperArt(wrapper) && !wrapperArt(wrapper);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Changes when a wrapper's renders arrive: a dependency for whatever painted a pack before they did. */
export function useWrapperArtVersion(): number {
  return useSyncExternalStore(subscribe, () => version, () => 0);
}
