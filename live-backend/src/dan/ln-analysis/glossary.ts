export interface LnTerm {
  id: string;
  name: string;
  aliases: readonly string[];
  evidence: "official" | "community" | "mapper-coined" | "engineering";
  context: string;
  /** Source numbers in docs/osu_mania_4k_ln_minacalc_agent_handoff.md. */
  sources: readonly number[];
}

// Terminology describes structures; it never selects a difficulty coefficient.
export const LN_TERMS: readonly LnTerm[] = [
  { id: "hold", name: "Long note", aliases: ["LN", "hold", "noodle"], evidence: "official", context: "A paired press and release, not a separate skill for each alias.", sources: [3] },
  { id: "coordination", name: "LN Coordination", aliases: ["control", "column lock"], evidence: "official", context: "Actions while other fingers remain held; column lock has narrower third-party usage.", sources: [1, 14] },
  { id: "density", name: "LN Density", aliases: ["LN stream", "LN speed"], evidence: "official", context: "Head geometry, durations and activity are measured separately.", sources: [1, 4] },
  { id: "release", name: "LN Release", aliases: ["release stream", "release stairs", "release trill"], evidence: "official", context: "Timing and organization of hold endings, including exposed slow releases.", sources: [1, 3] },
  { id: "inverse", name: "Inverse", aliases: ["immerse LN", "lifts", "LN walls", "walls"], evidence: "community", context: "Recurring gaps in occupied lanes. Walls is ambiguous; an imported Lift object is not automatically inverse.", sources: [3, 4, 5, 10] },
  { id: "shield", name: "Shield", aliases: ["shield stream"], evidence: "official", context: "A tap followed closely by an LN head in the same lane.", sources: [3, 5] },
  { id: "reverse_shield", name: "Reverse shield", aliases: [], evidence: "official", context: "An LN tail followed closely by a tap in the same lane.", sources: [3] },
  { id: "short_hold", name: "Short LN", aliases: ["mini-LN", "staccato LN"], evidence: "community", context: "Duration relative to surrounding intervals; not a minijack or a universal fixed-duration class.", sources: [6] },
  { id: "ln_anchor", name: "LN Anchor", aliases: ["sustained anchor", "changing anchor"], evidence: "community", context: "A sustained hold around other actions; distinct from a repeating rice anchor.", sources: [7] },
  { id: "head_geometry", name: "LN head geometry", aliases: ["LN jumpstream", "LN handstream", "LN chordstream", "LN stairs", "LN rolls", "LN trills", "LN chordtrills", "LN bursts", "LN jacks", "LN chordjacks"], evidence: "community", context: "Compound head structures; tails are analyzed independently, without additive name bonuses.", sources: [1, 4, 8] },
  { id: "hybrid", name: "LN Hybrid", aliases: ["layering", "mixed", "consistency", "wildcard", "technical hybrid", "LN dump"], evidence: "community", context: "Concurrent interactions differ from separate rice/LN sections. Dump is a mapping-style term, not a mechanical detector.", sources: [1, 2, 4, 5, 6, 9] },
  { id: "variable_gap_inverse", name: "Variable-gap inverse", aliases: ["half-inverse", "release inverse"], evidence: "engineering", context: "Half-inverse can describe gap variation; release inverse emphasizes release/repress timing.", sources: [4] },
  { id: "partial_lane_inverse", name: "Partial-lane inverse", aliases: ["half-inverse"], evidence: "engineering", context: "Inverse in a subset of lanes; not a 50% LN-content rule.", sources: [4] },
  { id: "inverse_compound", name: "Inverse compound", aliases: ["inverse jumpstream", "inverse handstream", "inverse jacks", "inverse convert", "full LN"], evidence: "community", context: "Full LN alone does not establish inverse; recognize the actual gaps and head geometry.", sources: [4] },
  { id: "held_chord_coordination", name: "Held-chord coordination", aliases: ["walls", "Slider Walls"], evidence: "mapper-coined", context: "Sustained outer holds with activity between them; not inverse without recurring gaps.", sources: [5, 10, 11] },
  { id: "swirly_long_notes", name: "Swirly Long Notes", aliases: [], evidence: "mapper-coined", context: "LN stairs with tap-chord platforms: geometry plus hybrid evidence.", sources: [11] },
  { id: "inverse_shield", name: "Inverse Shield", aliases: [], evidence: "mapper-coined", context: "Shield plus inverse evidence; explicitly not a reverse-shield alias.", sources: [11] },
  { id: "unending_slider_streams", name: "Unending Slider Streams", aliases: [], evidence: "mapper-coined", context: "Grouped holds release while another hold continues: overlap, chord release and occupancy.", sources: [11] },
  { id: "jack_in_slider_end", name: "Jack-in-Slider-End", aliases: [], evidence: "mapper-coined", context: "Inspect shield/jack interactions around an ending; no independent difficulty multiplier.", sources: [11] },
];

/** Ambiguous aliases deliberately return all meanings, never one forced tag. */
export function findLnTerms(label: string): LnTerm[] {
  const query = label.trim().toLowerCase();
  return LN_TERMS.filter((term) => [term.name, ...term.aliases].some((name) => name.toLowerCase() === query));
}
