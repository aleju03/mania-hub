// Heuristic detector for osu!mania chart pattern types (chordjack, stream, etc.)
// derived from beatmapset tags and difficulty version names.

type PatternSource = "tags" | "version" | "title";

const PATTERN_VARIANTS: Array<{ canonical: string; variants: string[]; sources?: PatternSource[] }> = [
  { canonical: "chordjack", variants: ["chordjack", "chord jack"] },
  { canonical: "longjack", variants: ["longjack", "long jack"] },
  { canonical: "speedjack", variants: ["speedjack", "speed jack", "jackspeed", "jack speed"] },
  { canonical: "minijack", variants: ["minijack", "mini jack"] },
  { canonical: "jack", variants: ["jack"] },
  { canonical: "jumpstream", variants: ["jumpstream", "jump stream"] },
  { canonical: "chordstream", variants: ["chordstream", "chord stream"] },
  { canonical: "handstream", variants: ["handstream", "hand stream"] },
  { canonical: "dumpstream", variants: ["dumpstream", "dump stream"] },
  { canonical: "stream", variants: ["stream"] },
  { canonical: "stamina", variants: ["stamina"] },
  { canonical: "tech", variants: ["tech", "technical"] },
  { canonical: "ln", variants: ["ln", "long note", "long notes", "noodle", "noodles"] },
  { canonical: "rice", variants: ["rice"] },
  { canonical: "sv", variants: ["sv", "scroll velocity"] },
  { canonical: "bracket", variants: ["bracket", "brackets"] },
  { canonical: "speed", variants: ["speed"], sources: ["version", "title"] },
  { canonical: "tiebreaker", variants: ["tiebreaker", "tb"] },
];

// Drop the generic label when a more specific sibling is already detected.
const SUBSUMED: Record<string, string[]> = {
  jack: ["chordjack", "longjack", "speedjack", "minijack"],
  stream: ["jumpstream", "chordstream", "handstream", "dumpstream"],
};

// Mapset titles containing any of these indicate a "pack"/compilation — each
// version is a different song title rather than a pattern/difficulty label.
// In that case we ignore version names since song titles leak false positives
// like "speed" from "At the Speed of Light".
const PACK_TITLE_HINTS = ["pack", "packs", "collection", "compilation", "marathon"];

function isPackTitle(title: string): boolean {
  if (!title) return false;
  const tokens = new Set(title.toLowerCase().split(/[^a-z0-9]+/g).filter(Boolean));
  return PACK_TITLE_HINTS.some((hint) => tokens.has(hint));
}

function sourceHasVariant(text: string, variant: string): boolean {
  const tokens = text.toLowerCase().split(/[^a-z0-9]+/g).filter(Boolean);
  if (tokens.length === 0) return false;
  if (!variant.includes(" ")) return tokens.includes(variant);

  for (let i = 0; i < tokens.length - 1; i++) {
    if (`${tokens[i]} ${tokens[i + 1]}` === variant) return true;
  }
  return false;
}

export function detectManiaPatterns(
  tagsText: string,
  versionNames: string[] = [],
  title: string = "",
): string[] {
  // Packs: title acts as a pattern label ("LN Packs" → LN). Version names are
  // song titles, not pattern labels, so we drop them to avoid leaks like
  // "speed" from "At the Speed of Light".
  // Non-packs: title is the song title (also leaks), so we drop it and rely on
  // tags + version names (often contain diff labels like "[Jacks]" or "[LN]").
  const pack = isPackTitle(title);
  const sources: Array<{ kind: PatternSource; text: string }> = [
    { kind: "tags", text: tagsText },
    ...(pack
      ? [{ kind: "title" as const, text: title }]
      : versionNames.map((version) => ({ kind: "version" as const, text: version }))),
  ].filter((source) => source.text.trim());
  if (sources.length === 0) return [];

  const detected = new Set<string>();
  for (const { canonical, variants, sources: allowedSources } of PATTERN_VARIANTS) {
    const candidateSources = allowedSources
      ? sources.filter((source) => allowedSources.includes(source.kind))
      : sources;
    for (const v of variants) {
      const hit = candidateSources.some((source) => sourceHasVariant(source.text, v));
      if (hit) {
        detected.add(canonical);
        break;
      }
    }
  }

  for (const [generic, specifics] of Object.entries(SUBSUMED)) {
    if (specifics.some((s) => detected.has(s))) detected.delete(generic);
  }

  return [...detected];
}

export const MANIA_PATTERN_LABELS: Record<string, string> = {
  chordjack: "Chordjack",
  longjack: "Longjack",
  speedjack: "Speedjack",
  minijack: "Minijack",
  jack: "Jack",
  jumpstream: "Jumpstream",
  chordstream: "Chordstream",
  handstream: "Handstream",
  dumpstream: "Dumpstream",
  stream: "Stream",
  stamina: "Stamina",
  tech: "Tech",
  ln: "LN",
  rice: "Rice",
  sv: "SV",
  bracket: "Bracket",
  speed: "Speed",
  tiebreaker: "Tiebreaker",
};
