import { describe, expect, it } from "vitest";

import {
  COMPANELLA_API_PREFIX,
  COMPANELLA_NATIVE_ROUTES,
  describeMatchOutcome,
  effectiveSpeed,
  encodeActorName,
} from "./shared";

describe("shared contract", () => {
  it("keeps the public prefix and the route table in step with the API document", () => {
    expect(COMPANELLA_API_PREFIX).toBe("/api/integrations/companella/v1");
    // Every route the proxy can reach is a fixed template; no route is built
    // from anything a caller supplies but the id.
    for (const template of Object.values(COMPANELLA_NATIVE_ROUTES)) {
      expect(template.includes("://")).toBe(false);
      expect(template.startsWith("/")).toBe(false);
      const placeholders = template.match(/:[a-z]+/g) ?? [];
      expect(placeholders.every((name) => name === ":id")).toBe(true);
    }
  });

  it("multiplies the baked rate by the runtime rate exactly once", () => {
    expect(effectiveSpeed(null, 1)).toBe(1);
    expect(effectiveSpeed(1.2, 1)).toBe(1.2);
    expect(effectiveSpeed(1.2, 1.5)).toBe(1.8);
    expect(effectiveSpeed(1.2, 0.75)).toBe(0.9);
  });

  it("does not describe an unfinished or unmatched lookup as a confident negative", () => {
    expect(describeMatchOutcome(null)).toBe("Not checked yet");
    const base = {
      relationship: null, referenceBeatmapId: null, familyAlias: null, timeScale: null,
      timeOffsetMs: null, relativeRate: null, unmatchedNoteCount: null, maxTimingErrorMs: null,
      gameplaySettingDifferences: [], notes: null,
    };
    expect(describeMatchOutcome({ ...base, outcome: "deferred" })).toBe("Still checking");
    expect(describeMatchOutcome({ ...base, outcome: "ambiguous" })).toBe("Matches more than one known chart");
    expect(describeMatchOutcome({ ...base, outcome: "unmatched_in_index" })).toBe("Not found in the index");
    expect(describeMatchOutcome({ ...base, outcome: "matched", relationship: "strict_note_rate_copy" }))
      .toBe("Rate copy of a known chart");
  });

  it("encodes the actor name whole, so the backend decodes the name the player has", () => {
    expect(encodeActorName("Some Player")).toBe("Some%20Player");
    expect(decodeURIComponent(encodeActorName("[Bracket] name_"))).toBe("[Bracket] name_");
    // Cut before encoding: a long name never ends in half an escape sequence.
    const long = encodeActorName("é".repeat(100));
    expect(decodeURIComponent(long)).toBe("é".repeat(60));
  });
});
