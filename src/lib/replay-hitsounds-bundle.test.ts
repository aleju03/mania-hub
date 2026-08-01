import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import JSZip from "jszip";

const sampleFiles = [
  "normal-hitnormal.wav",
  "normal-hitwhistle.wav",
  "normal-hitfinish.wav",
  "normal-hitclap.wav",
  "soft-hitnormal.wav",
  "soft-hitwhistle.wav",
  "soft-hitfinish.wav",
  "soft-hitclap.wav",
  "drum-hitnormal.wav",
  "drum-hitwhistle.wav",
  "drum-hitfinish.wav",
  "drum-hitclap.wav",
  "combobreak.mp3",
];

describe("replay default hitsound bundle", () => {
  it("contains the current bytes of every default sample", async () => {
    const root = path.resolve(__dirname, "../..");
    const bundle = fs.readFileSync(path.join(root, "public/assets/replay-default-hitsounds-v1.zip"));
    const zip = await JSZip.loadAsync(bundle);

    expect(Object.values(zip.files).filter((entry) => !entry.dir).map((entry) => entry.name)).toEqual(sampleFiles);
    await Promise.all(sampleFiles.map(async (filename) => {
      const bundled = await zip.file(filename)?.async("nodebuffer");
      const source = fs.readFileSync(path.join(root, "public/audio/hitsounds", filename));
      expect(bundled, filename).toEqual(source);
    }));
  }, 15_000);
});
