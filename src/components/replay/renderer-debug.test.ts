import { describe, expect, it } from "vitest";
import { formatPixiRendererType } from "./renderer-debug";

describe("formatPixiRendererType", () => {
  it("labels Pixi renderer enum values for the replay debug overlay", () => {
    expect(formatPixiRendererType(4, "canvas")).toBe("Canvas");
    expect(formatPixiRendererType(1, "webgl")).toBe("WebGL");
    expect(formatPixiRendererType(2, "webgpu")).toBe("WebGPU");
  });

  it("falls back to Pixi's renderer name when the enum is unknown", () => {
    expect(formatPixiRendererType(99, "custom-renderer")).toBe("custom-renderer");
    expect(formatPixiRendererType(undefined, undefined)).toBe("Unknown");
  });
});
