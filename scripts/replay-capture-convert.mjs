#!/usr/bin/env node
// Convert a custom tosu frame log (jsonl rows of {type:"frame"|"meta"|"resultsScreen"})
// into the sample ndjson format that replay-compare-capture.ts reads.
//
// Usage:
//   npm run replay:convert-capture -- "20260731-195937__Song__.jsonl" out.ndjson

import { readFileSync, writeFileSync } from "node:fs";

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
  console.error("Usage: npm run replay:convert-capture -- <capture.jsonl> <out.ndjson>");
  process.exit(2);
}

const lines = readFileSync(inPath, "utf8").split("\n").filter(Boolean);
const out = [];
let sequence = 0;

for (const line of lines) {
  const row = JSON.parse(line);
  if (row.type === "frame") {
    if (row.state !== "play") continue;
    const hits = row.hits ?? {};
    out.push(JSON.stringify({
      type: "sample",
      sequence,
      elapsedMs: sequence,
      raw: {
        state: { name: "play" },
        beatmap: { time: { live: row.t } },
        play: {
          hits: {
            geki: hits.geki ?? 0,
            "300": hits.c300 ?? 0,
            katu: hits.katu ?? 0,
            "100": hits.c100 ?? 0,
            "50": hits.c50 ?? 0,
            "0": hits.miss ?? 0,
            sliderBreaks: hits.sliderBreaks ?? 0,
          },
          accuracy: row.acc,
          combo: { current: row.combo, max: row.maxCombo },
          score: row.score,
          hitErrorArray: [],
        },
      },
    }));
    sequence++;
  } else if (row.type === "resultsScreen") {
    out.push(JSON.stringify({
      type: "sample",
      sequence,
      elapsedMs: sequence,
      raw: { resultsScreen: row },
    }));
    sequence++;
  }
}

writeFileSync(outPath, `${out.join("\n")}\n`);
console.log(`wrote ${out.length} samples to ${outPath}`);
