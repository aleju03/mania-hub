// Shape guards for fetched .osu text: it must look like a real beatmap, not an
// error page or an unrelated text file. Converters such as qua2osu write `//`
// comment lines above the format header, and osu! serves those files as they
// are (its checksum covers the comment), so the header check skips them. Same
// rule as the live backend's isLikelyBeatmapFile.

export function hasOsuFileHeader(content: string): boolean {
  return content.trimStart().replace(/^(?:\/\/[^\n]*\n\s*)*/, "").startsWith("osu file format");
}

export function isLikelyBeatmapFile(content: string): boolean {
  return hasOsuFileHeader(content) && content.includes("[HitObjects]");
}
