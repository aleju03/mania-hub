import { describe, expect, it } from "vitest";
import {
  buildCardGrant,
  emptyCardForm,
  formSkills,
  formTier,
  fromLocalInput,
  numberOrUndefined,
  SKILL_FIELDS,
  toLocalInput,
} from "./admin-collections-form";

const identity = { cardUserId: 2531335, username: "Fullerene-", avatarUrl: "https://a.ppy.sh/2531335", countryCode: "JP" };

describe("blank means keep", () => {
  it("sends nothing for the fields that were left empty", () => {
    const grant = buildCardGrant(emptyCardForm(), identity);
    expect(grant.pp).toBeUndefined();
    expect(grant.globalRank).toBeUndefined();
    expect(grant.recycledCopies).toBeUndefined();
    expect(grant.firstPulledAt).toBeUndefined();
    expect(grant.lastPulledAt).toBeUndefined();
    expect(grant.serial).toBeUndefined();
  });

  it("never clears a snapshot unless the form asked to", () => {
    // The trap this pins: a grant of one extra copy must not wipe the skills
    // the collector's own pull froze, since nothing can recover them.
    expect(buildCardGrant(emptyCardForm(), identity).clearSkills).toBe(false);
    expect(buildCardGrant({ ...emptyCardForm(), skillsMode: "set" }, identity).clearSkills).toBe(false);
    expect(buildCardGrant({ ...emptyCardForm(), skillsMode: "clear" }, identity).clearSkills).toBe(true);
  });

  it("defaults to adding one copy rather than setting the count", () => {
    const grant = buildCardGrant(emptyCardForm(), identity);
    expect(grant.copies).toBe(1);
    expect(grant.copiesMode).toBe("add");
  });

  it("leaves the mint registry alone by default", () => {
    expect(buildCardGrant(emptyCardForm(), identity).serialMode).toBe("keep");
  });
});

describe("tier", () => {
  it("reads the unrated option as no tier", () => {
    expect(formTier(emptyCardForm())).toBeNull();
    expect(formTier({ ...emptyCardForm(), tier: "worldClass" })).toBe("worldClass");
  });

  it("sends no label when none was typed, so the tier's own name answers", () => {
    // Sending "GOAT" here would be indistinguishable from someone deliberately
    // typing it, and would then beat an honorary player's own card label.
    expect(buildCardGrant({ ...emptyCardForm(), tier: "goat" }, identity).tierLabel).toBeNull();
    expect(buildCardGrant({ ...emptyCardForm(), tier: "superRare" }, identity).tierLabel).toBeNull();
    expect(buildCardGrant(emptyCardForm(), identity).tierLabel).toBeNull();
  });

  it("sends a typed label, trimmed", () => {
    expect(buildCardGrant({ ...emptyCardForm(), tier: "rare", tierLabel: " Handmade " }, identity).tierLabel).toBe("Handmade");
    expect(buildCardGrant({ ...emptyCardForm(), tier: "goat", tierLabel: "manolo" }, identity).tierLabel).toBe("manolo");
  });
});

describe("the skills snapshot", () => {
  it("is null unless the form is writing one", () => {
    expect(formSkills(emptyCardForm())).toBeNull();
    expect(formSkills({ ...emptyCardForm(), skillsMode: "clear" })).toBeNull();
  });

  it("fills every field the card front reads, blanks included", () => {
    const skills = formSkills({ ...emptyCardForm(), skillsMode: "set", skills: { cardPower: "712" } });
    expect(skills).not.toBeNull();
    for (const field of SKILL_FIELDS) expect(typeof skills?.[field.key]).toBe("number");
    expect(skills?.cardPower).toBe(712);
    expect(skills?.speed).toBe(0);
    expect(skills?.archetype).toBe("Allrounder");
  });

  it("keeps a typed archetype", () => {
    expect(formSkills({ ...emptyCardForm(), skillsMode: "set", archetype: " Technician " })?.archetype).toBe("Technician");
  });
});

describe("identity fallback", () => {
  it("falls back to the picked player so an untracked card still has a face", () => {
    const grant = buildCardGrant(emptyCardForm(), identity);
    expect(grant.username).toBe("Fullerene-");
    expect(grant.avatarUrl).toBe("https://a.ppy.sh/2531335");
    expect(grant.countryCode).toBe("JP");
  });

  it("prefers what was typed over the picked player", () => {
    const grant = buildCardGrant({ ...emptyCardForm(), username: "peppy", countryCode: "AU" }, identity);
    expect(grant.username).toBe("peppy");
    expect(grant.countryCode).toBe("AU");
  });

  it("does not repaint the shared face unless asked", () => {
    expect(buildCardGrant(emptyCardForm(), identity).overwriteIdentity).toBe(false);
  });
});

describe("pull stamps", () => {
  it("round-trips a local wall-clock value through the input", () => {
    const stamp = new Date(2026, 4, 17, 9, 30).getTime();
    expect(fromLocalInput(toLocalInput(stamp))).toBe(stamp);
  });

  it("reads an empty or unparseable box as no opinion", () => {
    expect(fromLocalInput("")).toBeUndefined();
    expect(fromLocalInput("not a date")).toBeUndefined();
  });
});

describe("numberOrUndefined", () => {
  it("tells an empty box from a zero", () => {
    expect(numberOrUndefined("")).toBeUndefined();
    expect(numberOrUndefined("   ")).toBeUndefined();
    expect(numberOrUndefined("0")).toBe(0);
    expect(numberOrUndefined("-3")).toBe(-3);
    expect(numberOrUndefined("nonsense")).toBeUndefined();
  });
});
