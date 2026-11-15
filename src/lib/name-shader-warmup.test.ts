import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { SHADER_MOUNT_VERTEX } from "./name-shader-warmup";

describe("name shader warm-up", () => {
  it("compiles the same vertex shader ShaderMount does, or the warm program misses the cache", () => {
    const entry = createRequire(import.meta.url).resolve("@paper-design/shaders");
    const source = readFileSync(join(dirname(entry), "vertex-shader.js"), "utf8");
    const match = /const vertexShaderSource = `([\s\S]*?)`;/.exec(source);
    expect(match?.[1]).toBe(SHADER_MOUNT_VERTEX);
  });
});
