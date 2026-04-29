const PIXI_RENDERER_LABELS: Record<number, string> = {
  1: "WebGL",
  2: "WebGPU",
  4: "Canvas",
};

export function formatPixiRendererType(type: number | undefined, name: string | undefined): string {
  if (typeof type === "number" && PIXI_RENDERER_LABELS[type]) {
    return PIXI_RENDERER_LABELS[type];
  }

  return name || "Unknown";
}
