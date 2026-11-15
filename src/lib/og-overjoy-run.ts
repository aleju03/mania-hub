import { createElement as h } from "react";
import type { ReactNode } from "react";
import { ImageResponse } from "./og-image-response";
import { getFont, loadOgFonts, ogAvatarUrl, ogFontList, OgFallbackError } from "./og-render";
import { getServerLiveBackendUrl } from "./live-backend";
import { getAssetOrigin } from "./origin";
import { CHAIN_SCENE_NAMES, chainIsEndless, formatChainScore, type ChainRunShare } from "./chain-run";
import { SCENE_ART_ID, sceneArtUrl } from "../components/packs/run/sceneArt";

/* An Overjoy run's share link as a social card: how far the run got in the
   table's marker hand, its best row and rows, the scene cards it ended with
   in their gold medallions, the faces of its best row, and who played it. */

/* Bumped when the layout changes, so cached cards render anew. */
export const OVERJOY_RUN_OG_LAYOUT = 3;

const W = 1200;
const H = 630;
const CREAM = "#f3e9d8";
const GOLD = "#ffd36b";
const PINK = "#ff7ab8";
const MARKER = '"Overjoy Marker"';

export async function fetchOverjoyShare(id: string): Promise<ChainRunShare | null> {
  const base = getServerLiveBackendUrl();
  if (!base) throw new OgFallbackError("live backend not configured");
  const response = await fetch(`${base}/api/chain-run/share/${encodeURIComponent(id)}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new OgFallbackError(`overjoy share ${response.status}`);
  return (await response.json()) as ChainRunShare;
}

/* Satori can't draw WebP, and the scene art and medallion are WebP (or an
   SVG print): each goes through sharp to a PNG data URL first. */
const pngCache = new Map<string, Promise<string | null>>();
function pngDataUrl(request: Request, src: string, size: number): Promise<string | null> {
  const key = `${src}@${size}`;
  const cached = pngCache.get(key);
  if (cached) return cached;
  const promise = (async () => {
    let bytes: Buffer;
    if (src.startsWith("data:image/svg+xml")) {
      bytes = Buffer.from(decodeURIComponent(src.slice(src.indexOf(",") + 1)), "utf8");
    } else {
      const response = await fetch(new URL(src, getAssetOrigin(request)).toString());
      if (!response.ok) return null;
      bytes = Buffer.from(await response.arrayBuffer());
    }
    const { default: sharp } = await import("sharp");
    const png = await sharp(bytes).resize(size, size, { fit: "cover" }).png().toBuffer();
    return `data:image/png;base64,${png.toString("base64")}`;
  })().catch(() => null);
  pngCache.set(key, promise);
  void promise.then((value) => {
    if (!value) pngCache.delete(key);
  });
  return promise;
}

const MEDALLION = "/images/packs/run/medallion-v1.webp";
const BACKDROP = { over: "/images/packs/run/share/backdrop-over-v1.png", won: "/images/packs/run/share/backdrop-round-v1.png" };

function medallion(key: string, size: number, frame: string | null, art: string | null): ReactNode {
  const hole = size * 0.476;
  return h(
    "div",
    { key, style: { position: "relative", display: "flex", width: `${size}px`, height: `${size}px` } },
    [
      art
        ? h("img", {
            key: "art",
            src: art,
            width: hole,
            height: hole,
            style: { position: "absolute", left: `${size * 0.5 - hole / 2}px`, top: `${size * 0.574 - hole / 2}px`, borderRadius: "50%" },
          })
        : null,
      frame ? h("img", { key: "frame", src: frame, width: size, height: size, style: { position: "absolute", left: "0px", top: "0px" } }) : null,
    ],
  );
}

export async function renderOverjoyRunOg(request: Request, id: string): Promise<Response> {
  const [[regularFont, heavyFont], markerFont, share] = await Promise.all([
    loadOgFonts(request),
    getFont(request, "PermanentMarker-Regular.ttf"),
    fetchOverjoyShare(id),
  ]);
  if (!share) throw new OgFallbackError(`no overjoy share ${id}`);

  const scenes = share.scenes.slice(0, 3);
  const sceneSize = scenes.length > 2 ? 150 : 170;
  const [frame, ...arts] = await Promise.all([
    pngDataUrl(request, MEDALLION, sceneSize * 2),
    ...scenes.map((scene) => pngDataUrl(request, sceneArtUrl(SCENE_ART_ID[scene]), Math.round(sceneSize * 0.476 * 2))),
  ]);
  const faces = share.bestRowCards.slice(0, 6);
  const endless = chainIsEndless(share.round);
  const roundInk = share.won || endless ? GOLD : PINK;
  const roundText = endless ? `Endless round ${share.round}` : `Round ${share.round}`;
  const title = share.won ? "Run won" : "Run over";

  const stat = (label: string, value: string, ink: string) =>
    h("div", { key: label, style: { display: "flex", flexDirection: "column" } }, [
      h("div", { key: "l", style: { fontSize: "20px", fontWeight: 900, letterSpacing: "4px", color: "rgba(243,233,216,0.5)" } }, label.toUpperCase()),
      h("div", { key: "v", style: { fontFamily: MARKER, fontSize: "56px", color: ink, lineHeight: 1.1 } }, value),
    ]);

  const response = new ImageResponse(
    h(
      "div",
      {
        style: {
          width: `${W}px`,
          height: `${H}px`,
          display: "flex",
          position: "relative",
          overflow: "hidden",
          background: "#120608",
          fontFamily: '"Tracker Round OG"',
          color: CREAM,
          textShadow: "0 2px 8px rgba(0,0,0,0.75)",
        },
      },
      [
        // The table's own backdrop: a still of its paint shader (PaintBackdrop),
        // the end screen's red for a run over, the round's pink for a run won.
        h("img", {
          key: "table",
          src: new URL(share.won ? BACKDROP.won : BACKDROP.over, getAssetOrigin(request)).toString(),
          width: W,
          height: H,
          style: { position: "absolute", left: "0px", top: "0px" },
        }),
        // Left: the run.
        h(
          "div",
          {
            key: "run",
            style: { position: "absolute", left: "72px", top: "56px", width: "620px", height: `${H - 112}px`, display: "flex", flexDirection: "column" },
          },
          [
            h("div", { key: "game", style: { display: "flex", alignItems: "center", fontFamily: MARKER, fontSize: "34px", color: "rgba(243,233,216,0.55)" } }, [
              h("span", { key: "n" }, "OVERJOY"),
              share.daily
                ? h("span", { key: "d", style: { marginLeft: "18px", fontFamily: '"Tracker Round OG"', fontWeight: 900, fontSize: "20px", color: GOLD, border: `2px solid ${GOLD}`, borderRadius: "999px", padding: "2px 14px" } }, "DAILY")
                : null,
            ]),
            h("div", { key: "title", style: { fontFamily: MARKER, fontSize: "64px", lineHeight: 1.1, marginTop: "6px" } }, title),
            h("div", { key: "round", style: { fontFamily: MARKER, fontSize: endless ? "84px" : "112px", lineHeight: 1.05, color: roundInk, marginTop: "4px" } }, roundText),
            h("div", { key: "stats", style: { display: "flex", gap: "64px", marginTop: "22px" } }, [
              stat("Best row", formatChainScore(share.bestRow), GOLD),
              stat("Rows", String(share.rows), CREAM),
            ]),
            h("div", { key: "who", style: { display: "flex", alignItems: "center", marginTop: "auto" } }, [
              h("img", { key: "a", src: ogAvatarUrl(request, null, share.userId), width: 56, height: 56, style: { borderRadius: "14px" } }),
              h("div", { key: "u", style: { marginLeft: "18px", fontSize: "36px", fontWeight: 900 } }, share.username || "A player"),
            ]),
          ],
        ),
        // Right: the scene cards held, then the best row's faces.
        h(
          "div",
          {
            key: "build",
            style: { position: "absolute", left: "700px", top: "56px", width: "440px", height: `${H - 112}px`, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" },
          },
          [
            scenes.length
              ? h(
                  "div",
                  { key: "scenes", style: { display: "flex", gap: "8px" } },
                  scenes.map((scene, index) => medallion(scene, sceneSize, frame, arts[index] ?? null)),
                )
              : null,
            scenes.length
              ? h(
                  "div",
                  { key: "names", style: { display: "flex", fontSize: "20px", fontWeight: 900, color: "rgba(243,233,216,0.7)", marginTop: "6px", textAlign: "center" } },
                  scenes.map((scene) => CHAIN_SCENE_NAMES[scene]).join("  |  "),
                )
              : null,
            faces.length
              ? h("div", { key: "faces-label", style: { display: "flex", marginTop: "34px", fontSize: "18px", fontWeight: 900, letterSpacing: "4px", color: "rgba(243,233,216,0.5)" } }, "BEST ROW")
              : null,
            faces.length
              ? h(
                  "div",
                  { key: "faces", style: { display: "flex", gap: "10px", marginTop: "12px" } },
                  faces.map((card, index) =>
                    h("img", {
                      key: `f${index}`,
                      src: ogAvatarUrl(request, card.avatarUrl, card.id > 0 ? card.id : undefined),
                      width: 62,
                      height: 62,
                      style: { borderRadius: "12px", border: "3px solid rgba(243,233,216,0.85)", objectFit: "cover" },
                    }),
                  ),
                )
              : null,
          ],
        ),
      ],
    ),
    {
      width: W,
      height: H,
      fonts: [...ogFontList(regularFont, heavyFont), { name: "Overjoy Marker", data: markerFont, style: "normal", weight: 400 }],
    },
  );
  response.headers.set("Cache-Control", "public, max-age=86400, s-maxage=2592000, stale-while-revalidate=604800");
  return response;
}
