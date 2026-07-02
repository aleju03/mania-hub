// URL slug for a skin page, derived from the skin name: "pl0x Aleju03 mix"
// becomes "pl0x-aleju03-mix". Pure string transform; uniqueness (the -2/-3
// suffixes) is handled where rows are written, in features/skins.ts.
export function slugifySkinName(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    // Strip combining diacritics left over from NFKD so "café" slugs as "cafe".
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return base || "skin";
}
