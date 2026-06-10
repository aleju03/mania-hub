import { createCardTextures } from "../player/maniacard3d/cardTexture";
import type { ManiaCardReadyData } from "../player/maniacard3d/types";

/* Renders a card front to a small data URL for the reveal tray and the pack
   summary. Reuses the exact texture pipeline the 3D card draws with, scaled
   down so five thumbnails don't hold five full-size canvases alive. */
export async function renderCardThumbnail(data: ManiaCardReadyData, width = 280): Promise<string> {
  const textures = await createCardTextures(data);
  try {
    const source = textures.frontTexture.image;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = Math.round(width * 1.4);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("2D canvas is unavailable");
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png");
  } finally {
    textures.dispose();
  }
}
