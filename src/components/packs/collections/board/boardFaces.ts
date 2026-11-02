import { fetchLivePackBoardFaces } from "#/lib/live-backend";
import type { CollectedCard } from "#/lib/pack-collection";
import { renderCollectionThumbnail } from "../../CardTile";
import {
  cardThumbnailKeyForCollectionCard,
  getMemoryCardThumbnail,
  loadPersistedCardThumbnail,
  loadR2CardThumbnails,
} from "../../cardThumbnailCache";

/* The real card faces for the board's close-up view.

   A face is the same thumbnail the collection grid shows, found the same way
   and in the same order of cost: this tab's memory, this browser's stored
   faces, the shared renders on R2, and only then a render here (which is then
   shared for the next viewer). The board asks for a face only while a card is
   drawn big enough to read it, so a zoomed-out board never loads one, and a
   close view loads the few dozen on screen.

   Faces are per placement owner, since two collectors' copies of a player
   carry different frozen snapshots. */

const FACE_LIMIT = 400;
const BATCH = 60;

type Face = { image: HTMLImageElement; at: number } | "loading" | "none";

export class BoardFaces {
  private faces = new Map<string, Face>();
  private queue = new Set<string>();
  private timer = 0;

  /* `wake` repaints the board when a face lands. */
  constructor(private readonly wake: () => void) {}

  dispose() {
    window.clearTimeout(this.timer);
    this.queue.clear();
  }

  /* The face for a placement and when it finished loading, or null while it
     loads (or if it has none). */
  get(owner: number, key: string): { image: HTMLImageElement; at: number } | null {
    const id = `${owner}:${key}`;
    const face = this.faces.get(id);
    if (typeof face === "object") return face.at ? face : null;
    if (face === undefined) {
      this.faces.set(id, "loading");
      this.queue.add(id);
      if (!this.timer) this.timer = window.setTimeout(() => this.flush(), 80);
    }
    return null;
  }

  private flush() {
    this.timer = 0;
    const ids = [...this.queue];
    this.queue.clear();
    for (let i = 0; i < ids.length; i += BATCH) void this.load(ids.slice(i, i + BATCH));
  }

  private async load(ids: string[]) {
    let cards: [number, string, CollectedCard][] = [];
    try {
      cards = (await fetchLivePackBoardFaces(ids)) as unknown as [number, string, CollectedCard][];
    } catch {
      // asked again the next time the card is drawn
      for (const id of ids) this.faces.delete(id);
      return;
    }
    const found = new Set(cards.map(([owner, key]) => `${owner}:${key}`));
    for (const id of ids) if (!found.has(id)) this.faces.set(id, "none");

    // stored faces first, then one R2 lookup for the rest, then renders
    const keyed = cards.map(([owner, key, card]) => ({ id: `${owner}:${key}`, card, thumb: cardThumbnailKeyForCollectionCard(card) }));
    const remote: typeof keyed = [];
    await Promise.all(keyed.map(async (entry) => {
      if (!entry.thumb) return this.faces.set(entry.id, "none");
      const url = getMemoryCardThumbnail(entry.thumb) ?? (await loadPersistedCardThumbnail(entry.thumb));
      if (url) this.show(entry.id, url);
      else remote.push(entry);
    }));
    if (remote.length === 0) return;
    const urls = await loadR2CardThumbnails(remote.map((entry) => entry.thumb!)).catch(() => ({} as Record<string, string>));
    await Promise.all(remote.map(async (entry) => {
      const url = urls[entry.thumb!];
      if (url) return this.show(entry.id, url);
      const rendered = await renderCollectionThumbnail(entry.card).catch(() => null);
      if (rendered) this.show(entry.id, rendered.url);
      else this.faces.set(entry.id, "none");
    }));
  }

  private show(id: string, url: string) {
    const image = new Image();
    const face = { image, at: 0 };
    image.decoding = "async";
    image.onload = () => {
      // stamped on arrival, which is when its fade-in starts
      face.at = performance.now();
      this.wake();
    };
    image.onerror = () => this.faces.set(id, "none");
    image.src = url;
    this.faces.delete(id);
    this.faces.set(id, face);
    while (this.faces.size > FACE_LIMIT) this.faces.delete(this.faces.keys().next().value!);
  }
}
