import { Container, Text } from "pixi.js";

/**
 * Text rasterizes at the renderer's resolution, so a container scaled up
 * stretches it into a blur while sprites beside it stay sharp. Raster every
 * Text under `root` at the pixels it actually covers instead.
 */
export function setTextResolution(root: Container, resolution: number | undefined) {
  if (resolution === undefined) return;
  for (const child of root.children) {
    if (child instanceof Text) {
      if (child.resolution !== resolution) child.resolution = resolution;
    } else if (child instanceof Container) {
      setTextResolution(child, resolution);
    }
  }
}
