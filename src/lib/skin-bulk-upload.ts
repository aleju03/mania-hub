import { importReplaySkinFromOsk } from "./replay-skin-import";
import { BackdropDealer, drawSkinPreviewBackdrops, SKIN_BACKDROP_POOL_SIZE } from "./skin-preview-backdrops";
import { PatternDealer } from "./skin-preview-patterns";
import { loadSkinPreviewBackgroundForSet, renderSkinPreview } from "./skin-preview-render";
import {
  finishSkinUpload,
  hashOskFile,
  SKIN_OSK_MAX_BYTES,
  SkinUploadError,
  startAdminSkinUpload,
  uploadSkinPart,
  type DuplicateSkinRef,
  type SkinPreviewRecipe,
  type SkinSummary,
} from "./skins";

// The publishing engine behind the admin bulk uploader. Same path a single
// upload takes (parse in the browser, compose previews on a canvas, stream the
// parts against a ticket), run one file after another so a collection can be
// seeded in one go. Sequential on purpose: rendering is main-thread work, and
// a stampede of parallel uploads would only spend the rate limit faster.

export type BulkPhase = "queued" | "reading" | "rendering" | "uploading" | "published" | "duplicate" | "failed";

export interface BulkUploadUpdate {
  phase: BulkPhase;
  // 0..1 within the current phase, for the row's progress bar.
  progress?: number;
  message?: string | null;
  skin?: SkinSummary | null;
  duplicate?: DuplicateSkinRef | null;
}

// Everything the per-file editor prepared ahead of the run. The renders come
// in ready-made (the editor already parsed the archive and drew them against
// the chosen backdrops), so publishing an edited item skips the parse and
// render phases entirely and only hashes the file before streaming the parts.
export interface BulkPreparedRender {
  keys: number;
  blob: Blob;
  width: number;
  height: number;
  accent: string;
  recipe: SkinPreviewRecipe;
}

export interface BulkPreparedScreenshot {
  blob: Blob;
  width: number;
  height: number;
  // What the uploader called this shot; empty leaves it numbered.
  label: string;
}

export interface BulkPreparedDetails {
  description: string;
  coverKeymode: number;
  // A screenshot starred over the rendered playfields; null leaves the card to
  // coverKeymode.
  coverScreenshot?: number | null;
  renders: BulkPreparedRender[];
  screenshots: BulkPreparedScreenshot[];
}

export interface BulkUploadItemInput {
  file: File;
  name: string;
  author: string | null;
  details?: BulkPreparedDetails | null;
}

// A rate-limited response says how long to wait; sleeping exactly that long
// beats guessing a pace, and beats failing a row that only needed a moment.
const MAX_RATE_LIMIT_RETRIES = 8;
const RATE_LIMIT_FALLBACK_MS = 20_000;

export function isRateLimited(error: unknown): error is SkinUploadError {
  return error instanceof SkinUploadError && error.code === "rate_limited";
}

// How long to hold off after a 429. The backend states it outright, so this
// only clamps: never busier than a second, never asleep for more than a minute
// even if the window is wider than that.
export function rateLimitWaitMs(error: SkinUploadError): number {
  return Math.min(60_000, Math.max(1_000, error.retryAfterMs ?? RATE_LIMIT_FALLBACK_MS));
}

export async function withRateLimitRetry<T>(
  run: () => Promise<T>,
  options: {
    onWait: (waitMs: number) => void;
    cancelled: () => boolean;
    // Injectable so tests do not have to sit through the real waits.
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<T> {
  const wait = options.sleep ?? sleep;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (!isRateLimited(error) || attempt >= MAX_RATE_LIMIT_RETRIES || options.cancelled()) throw error;
      const waitMs = rateLimitWaitMs(error);
      options.onWait(waitMs);
      await wait(waitMs);
      // Stopping during the wait must not spend the retry on a run the user
      // already walked away from.
      if (options.cancelled()) throw error;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The browser leg of an upload (each preview, the archive, the publish call)
// spends the backend's costly per-IP window, 30/min by default. A run of forty
// skins would burn that in seconds and then be refused - possibly on a 50MB
// archive, which would have to be sent again. Pacing under the budget keeps a
// run steady; withRateLimitRetry stays as the backstop for when this estimate
// is wrong (a raised limit, another tab, a shared address).
const REQUEST_BUDGET_PER_MINUTE = 25;
const WINDOW_MS = 60_000;

export class RequestPacer {
  private readonly sent: number[] = [];

  constructor(
    private readonly budget: number = REQUEST_BUDGET_PER_MINUTE,
    private readonly now: () => number = () => Date.now(),
  ) {}

  // How long until there is room for another request; 0 when there is room now.
  waitMs(): number {
    const cutoff = this.now() - WINDOW_MS;
    while (this.sent.length > 0 && this.sent[0] <= cutoff) this.sent.shift();
    if (this.sent.length < this.budget) return 0;
    // A little past the moment the oldest request ages out of the window.
    return Math.max(0, this.sent[0] + WINDOW_MS - this.now()) + 250;
  }

  record(): void {
    this.sent.push(this.now());
  }

  // Waits for room, then claims it.
  async take(onWait: (waitMs: number) => void, wait: (ms: number) => Promise<void> = sleep): Promise<void> {
    for (let waitMs = this.waitMs(); waitMs > 0; waitMs = this.waitMs()) {
      onWait(waitMs);
      await wait(waitMs);
    }
    this.record();
  }
}

export class BulkUploadCancelled extends Error {}

// One catalog draw per run, sized to the queue so every skin can have its own
// cover: a single catalog page holds 48, which is the ceiling here. A run
// longer than that starts a second pass over the same covers. Failures fall
// back to the flat backdrop.
const MAX_BULK_POOL = 48;

export async function drawBulkBackdrops(queueLength: number): Promise<BackdropDealer> {
  try {
    const count = Math.min(MAX_BULK_POOL, Math.max(SKIN_BACKDROP_POOL_SIZE, queueLength));
    return new BackdropDealer(await drawSkinPreviewBackdrops({ count }));
  } catch {
    return new BackdropDealer([]);
  }
}

async function backdropImageFor(
  dealer: BackdropDealer,
  cache: Map<number, HTMLImageElement | null>,
): Promise<{ backdrop: number | "flat"; image: HTMLImageElement | null }> {
  const candidate = dealer.next();
  if (!candidate) return { backdrop: "flat", image: null };
  const cached = cache.get(candidate.setId);
  if (cached !== undefined) return { backdrop: candidate.setId, image: cached };
  const image = await loadSkinPreviewBackgroundForSet(candidate.setId).catch(() => null);
  cache.set(candidate.setId, image);
  return { backdrop: candidate.setId, image };
}

export interface BulkUploadContext {
  // Deals each skin its own cover; see drawBulkBackdrops.
  dealer: BackdropDealer;
  backdrops: Map<number, HTMLImageElement | null>;
  // Deals each keymode of each skin its own chart snippet, so a bulk run does
  // not publish twenty cards showing the same notes. Optional: a run without
  // one renders the built-in layout.
  patterns?: PatternDealer;
  cancelled: () => boolean;
  // Shared across the whole run: the window is per IP, not per file.
  pacer: RequestPacer;
}

// Publishes one .osk end to end. Throws BulkUploadCancelled when the run was
// stopped; every other failure is reported through onUpdate as a failed row so
// the rest of the queue keeps going.
export async function publishBulkSkin(
  item: BulkUploadItemInput,
  context: BulkUploadContext,
  onUpdate: (update: BulkUploadUpdate) => void,
): Promise<SkinSummary | null> {
  const stopIfCancelled = () => {
    if (context.cancelled()) throw new BulkUploadCancelled();
  };

  if (item.file.size > SKIN_OSK_MAX_BYTES) {
    onUpdate({ phase: "failed", message: "Over the 50 MB limit." });
    return null;
  }

  const details = item.details ?? null;

  try {
    stopIfCancelled();
    onUpdate({ phase: "reading", progress: 0 });

    // An edited item arrives with its renders already drawn; only untouched
    // items parse the archive here.
    let name = item.name.trim();
    let author = (item.author ?? "").trim();
    let renders: BulkPreparedRender[] = details?.renders ?? [];
    let coverKeymode = details?.coverKeymode ?? 4;
    if (!details) {
      const imported = await importReplaySkinFromOsk(item.file, {
        targetKeyCount: 4,
        onProgress: (done, total) => onUpdate({ phase: "reading", progress: total > 0 ? done / total : 0 }),
      });
      stopIfCancelled();
      name = name || imported.summary.name;
      author = author || (imported.summary.author ?? "").trim();
      const keymodes = [...imported.summary.keymodes].sort((a, b) => (a === 4 ? -1 : b === 4 ? 1 : a - b));
      coverKeymode = keymodes.includes(4) ? 4 : keymodes[0];
      const background = await backdropImageFor(context.dealer, context.backdrops);
      stopIfCancelled();

      onUpdate({ phase: "rendering", progress: 0 });
      renders = [];
      for (const keys of keymodes) {
        stopIfCancelled();
        const pattern = (await context.patterns?.next(keys)) ?? null;
        stopIfCancelled();
        const render = await renderSkinPreview(imported.settings, keys, { background: background.image, pattern });
        renders.push({
          keys,
          blob: render.blob,
          width: render.width,
          height: render.height,
          accent: render.accent,
          recipe: { backdrop: background.backdrop, pattern },
        });
        onUpdate({ phase: "rendering", progress: renders.length / keymodes.length });
      }
    }
    // The editor keeps cover and renders together, so a mismatch would be a
    // bug; still, publishing with no cover flag at all is worse than fronting
    // the first render.
    if (!renders.some((render) => render.keys === coverKeymode)) coverKeymode = renders[0]?.keys ?? coverKeymode;
    stopIfCancelled();

    // Hashed before the ticket so an already-published file costs no transfer.
    const oskSha256 = await hashOskFile(item.file);
    stopIfCancelled();

    const started = await startAdminSkinUpload({
      data: { name, author, description: details?.description ?? "", oskSha256 },
    });
    if (!started.ok) {
      if (started.error === "duplicate") {
        onUpdate({ phase: "duplicate", message: "Already on the site.", duplicate: started.duplicate ?? null });
        return null;
      }
      onUpdate({ phase: "failed", message: startFailureMessage(started.error) });
      return null;
    }
    stopIfCancelled();

    const screenshots = details?.screenshots ?? [];
    // previews + screenshots + the archive + the publish call
    const steps = renders.length + screenshots.length + 2;
    let done = 0;
    const step = () => onUpdate({ phase: "uploading", progress: (done += 1) / steps });
    onUpdate({ phase: "uploading", progress: 0 });
    const waited = (waitMs: number) =>
      onUpdate({ phase: "uploading", message: `Rate limited, retrying in ${Math.ceil(waitMs / 1000)}s.` });
    const paced = (waitMs: number) =>
      onUpdate({ phase: "uploading", message: `Holding under the upload limit, ${Math.ceil(waitMs / 1000)}s.` });

    for (const render of renders) {
      stopIfCancelled();
      await context.pacer.take(paced);
      stopIfCancelled();
      await withRateLimitRetry(() => uploadSkinPart({
        id: started.id,
        token: started.token,
        part: "preview",
        blob: render.blob,
        width: render.width,
        height: render.height,
        keys: render.keys,
        cover: render.keys === coverKeymode,
        accent: render.keys === coverKeymode ? render.accent : undefined,
      }), { onWait: waited, cancelled: context.cancelled });
      step();
    }

    for (const [index, shot] of screenshots.entries()) {
      stopIfCancelled();
      await context.pacer.take(paced);
      stopIfCancelled();
      await withRateLimitRetry(() => uploadSkinPart({
        id: started.id,
        token: started.token,
        part: "screenshot",
        blob: shot.blob,
        width: shot.width,
        height: shot.height,
        label: shot.label,
        // Screenshots upload after the renders, so a starred one is the last
        // word on what fronts the card.
        cover: index === details?.coverScreenshot,
      }), { onWait: waited, cancelled: context.cancelled });
      step();
    }

    stopIfCancelled();
    await context.pacer.take(paced);
    stopIfCancelled();
    await withRateLimitRetry(() => uploadSkinPart({
      id: started.id,
      token: started.token,
      part: "osk",
      blob: item.file,
    }), { onWait: waited, cancelled: context.cancelled });
    step();

    stopIfCancelled();
    await context.pacer.take(paced);
    stopIfCancelled();
    const skin = await withRateLimitRetry(
      () => finishSkinUpload(
        started.id,
        started.token,
        renders.map((render) => ({ keys: render.keys, recipe: render.recipe })),
      ),
      { onWait: waited, cancelled: context.cancelled },
    );
    step();
    onUpdate({ phase: "published", progress: 1, message: null, skin });
    return skin;
  } catch (error) {
    if (error instanceof BulkUploadCancelled) throw error;
    if (error instanceof SkinUploadError && error.code === "duplicate") {
      onUpdate({ phase: "duplicate", message: "Already on the site.", duplicate: error.duplicate ?? null });
      return null;
    }
    onUpdate({
      phase: "failed",
      message: error instanceof Error ? error.message : "This file could not be published.",
    });
    return null;
  }
}

function startFailureMessage(error: string): string {
  if (error === "not_logged_in") return "The session expired. Log in with osu! again.";
  if (error === "invalid_name") return "The skin needs a name.";
  if (error === "storage_not_configured") return "Skin storage is not configured on the server.";
  return "The upload could not be started.";
}
