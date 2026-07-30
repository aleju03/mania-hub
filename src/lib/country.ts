export const DEFAULT_COUNTRY_CODE = "CR";

// "Global" is a synthetic scope, not a real country: it aggregates every tracked
// country into one view. It deliberately stays out of COUNTRY_OPTIONS (the
// searchable country list) and is surfaced as a pinned entry by the selector.
export const GLOBAL_SCOPE_CODE = "GLOBAL";
export const GLOBAL_SCOPE_NAME = "Global";

// The scope a visitor lands on when we have no better signal (no cookie, no
// trackable geo-IP country, backend offline). Global aggregates every tracked
// country, so it is never empty regardless of which countries are live.
// Distinct from DEFAULT_COUNTRY_CODE, which is the default for the searchable
// single-country list, not the initial landing view.
export const DEFAULT_INITIAL_SCOPE = GLOBAL_SCOPE_CODE;

export function isGlobalScope(code?: string | null): boolean {
  return code?.trim().toUpperCase() === GLOBAL_SCOPE_CODE;
}

export function normalizeCountryScope(code?: string | null): string {
  const normalized = code?.trim().toUpperCase();
  if (normalized === GLOBAL_SCOPE_CODE) return GLOBAL_SCOPE_CODE;
  return normalizeCountryCode(normalized);
}

export function isSupportedCountryScope(code?: string | null): boolean {
  return isGlobalScope(code) || isSupportedCountryCode(code);
}

const RAW_COUNTRY_OPTIONS = [
  { code: "AD", name: "Andorra" },
  { code: "AE", name: "United Arab Emirates" },
  { code: "AF", name: "Afghanistan" },
  { code: "AG", name: "Antigua & Barbuda" },
  { code: "AI", name: "Anguilla" },
  { code: "AL", name: "Albania" },
  { code: "AM", name: "Armenia" },
  { code: "AO", name: "Angola" },
  { code: "AQ", name: "Antarctica" },
  { code: "AR", name: "Argentina" },
  { code: "AS", name: "Samoa (American)" },
  { code: "AT", name: "Austria" },
  { code: "AU", name: "Australia" },
  { code: "AW", name: "Aruba" },
  { code: "AX", name: "Åland Islands" },
  { code: "AZ", name: "Azerbaijan" },
  { code: "BA", name: "Bosnia & Herzegovina" },
  { code: "BB", name: "Barbados" },
  { code: "BD", name: "Bangladesh" },
  { code: "BE", name: "Belgium" },
  { code: "BF", name: "Burkina Faso" },
  { code: "BG", name: "Bulgaria" },
  { code: "BH", name: "Bahrain" },
  { code: "BJ", name: "Benin" },
  { code: "BM", name: "Bermuda" },
  { code: "BN", name: "Brunei" },
  { code: "BO", name: "Bolivia" },
  { code: "BQ", name: "Caribbean NL" },
  { code: "BR", name: "Brazil" },
  { code: "BS", name: "Bahamas" },
  { code: "BT", name: "Bhutan" },
  { code: "BW", name: "Botswana" },
  { code: "BY", name: "Belarus" },
  { code: "BZ", name: "Belize" },
  { code: "CA", name: "Canada" },
  { code: "CD", name: "Congo (Dem. Rep.)" },
  { code: "CG", name: "Congo (Rep.)" },
  { code: "CH", name: "Switzerland" },
  { code: "CI", name: "Côte d’Ivoire" },
  { code: "CL", name: "Chile" },
  { code: "CM", name: "Cameroon" },
  { code: "CN", name: "China" },
  { code: "CO", name: "Colombia" },
  { code: "CR", name: "Costa Rica" },
  { code: "CU", name: "Cuba" },
  { code: "CV", name: "Cape Verde" },
  { code: "CW", name: "Curaçao" },
  { code: "CY", name: "Cyprus" },
  { code: "CZ", name: "Czech Republic" },
  { code: "DE", name: "Germany" },
  { code: "DJ", name: "Djibouti" },
  { code: "DK", name: "Denmark" },
  { code: "DM", name: "Dominica" },
  { code: "DO", name: "Dominican Republic" },
  { code: "DZ", name: "Algeria" },
  { code: "EC", name: "Ecuador" },
  { code: "EE", name: "Estonia" },
  { code: "EG", name: "Egypt" },
  { code: "ES", name: "Spain" },
  { code: "ET", name: "Ethiopia" },
  { code: "FI", name: "Finland" },
  { code: "FJ", name: "Fiji" },
  { code: "FM", name: "Micronesia" },
  { code: "FO", name: "Faroe Islands" },
  { code: "FR", name: "France" },
  { code: "GA", name: "Gabon" },
  { code: "GB", name: "Britain (UK)" },
  { code: "GD", name: "Grenada" },
  { code: "GE", name: "Georgia" },
  { code: "GF", name: "French Guiana" },
  { code: "GG", name: "Guernsey" },
  { code: "GH", name: "Ghana" },
  { code: "GI", name: "Gibraltar" },
  { code: "GL", name: "Greenland" },
  { code: "GN", name: "Guinea" },
  { code: "GP", name: "Guadeloupe" },
  { code: "GR", name: "Greece" },
  { code: "GT", name: "Guatemala" },
  { code: "GU", name: "Guam" },
  { code: "GY", name: "Guyana" },
  { code: "HK", name: "Hong Kong" },
  { code: "HN", name: "Honduras" },
  { code: "HR", name: "Croatia" },
  { code: "HT", name: "Haiti" },
  { code: "HU", name: "Hungary" },
  { code: "ID", name: "Indonesia" },
  { code: "IE", name: "Ireland" },
  { code: "IL", name: "Israel" },
  { code: "IM", name: "Isle of Man" },
  { code: "IN", name: "India" },
  { code: "IQ", name: "Iraq" },
  { code: "IR", name: "Iran" },
  { code: "IS", name: "Iceland" },
  { code: "IT", name: "Italy" },
  { code: "JE", name: "Jersey" },
  { code: "JM", name: "Jamaica" },
  { code: "JO", name: "Jordan" },
  { code: "JP", name: "Japan" },
  { code: "KE", name: "Kenya" },
  { code: "KG", name: "Kyrgyzstan" },
  { code: "KH", name: "Cambodia" },
  { code: "KN", name: "St Kitts & Nevis" },
  { code: "KR", name: "Korea (South)" },
  { code: "KW", name: "Kuwait" },
  { code: "KY", name: "Cayman Islands" },
  { code: "KZ", name: "Kazakhstan" },
  { code: "LA", name: "Laos" },
  { code: "LB", name: "Lebanon" },
  { code: "LC", name: "St Lucia" },
  { code: "LI", name: "Liechtenstein" },
  { code: "LK", name: "Sri Lanka" },
  { code: "LT", name: "Lithuania" },
  { code: "LU", name: "Luxembourg" },
  { code: "LV", name: "Latvia" },
  { code: "LY", name: "Libya" },
  { code: "MA", name: "Morocco" },
  { code: "MC", name: "Monaco" },
  { code: "MD", name: "Moldova" },
  { code: "ME", name: "Montenegro" },
  { code: "MF", name: "St Martin (French)" },
  { code: "MG", name: "Madagascar" },
  { code: "MH", name: "Marshall Islands" },
  { code: "MK", name: "North Macedonia" },
  { code: "ML", name: "Mali" },
  { code: "MM", name: "Myanmar (Burma)" },
  { code: "MN", name: "Mongolia" },
  { code: "MO", name: "Macau" },
  { code: "MP", name: "Northern Mariana Islands" },
  { code: "MQ", name: "Martinique" },
  { code: "MR", name: "Mauritania" },
  { code: "MT", name: "Malta" },
  { code: "MU", name: "Mauritius" },
  { code: "MV", name: "Maldives" },
  { code: "MW", name: "Malawi" },
  { code: "MX", name: "Mexico" },
  { code: "MY", name: "Malaysia" },
  { code: "MZ", name: "Mozambique" },
  { code: "NA", name: "Namibia" },
  { code: "NC", name: "New Caledonia" },
  { code: "NE", name: "Niger" },
  { code: "NG", name: "Nigeria" },
  { code: "NI", name: "Nicaragua" },
  { code: "NL", name: "Netherlands" },
  { code: "NO", name: "Norway" },
  { code: "NP", name: "Nepal" },
  { code: "NZ", name: "New Zealand" },
  { code: "OM", name: "Oman" },
  { code: "PA", name: "Panama" },
  { code: "PE", name: "Peru" },
  { code: "PF", name: "French Polynesia" },
  { code: "PG", name: "Papua New Guinea" },
  { code: "PH", name: "Philippines" },
  { code: "PK", name: "Pakistan" },
  { code: "PL", name: "Poland" },
  { code: "PM", name: "St Pierre & Miquelon" },
  { code: "PR", name: "Puerto Rico" },
  { code: "PS", name: "Palestine" },
  { code: "PT", name: "Portugal" },
  { code: "PW", name: "Palau" },
  { code: "PY", name: "Paraguay" },
  { code: "QA", name: "Qatar" },
  { code: "RE", name: "Réunion" },
  { code: "RO", name: "Romania" },
  { code: "RS", name: "Serbia" },
  { code: "RU", name: "Russia" },
  { code: "RW", name: "Rwanda" },
  { code: "SA", name: "Saudi Arabia" },
  { code: "SC", name: "Seychelles" },
  { code: "SD", name: "Sudan" },
  { code: "SE", name: "Sweden" },
  { code: "SG", name: "Singapore" },
  { code: "SI", name: "Slovenia" },
  { code: "SK", name: "Slovakia" },
  { code: "SM", name: "San Marino" },
  { code: "SN", name: "Senegal" },
  { code: "SO", name: "Somalia" },
  { code: "SR", name: "Suriname" },
  { code: "ST", name: "Sao Tome & Principe" },
  { code: "SV", name: "El Salvador" },
  { code: "SX", name: "St Maarten (Dutch)" },
  { code: "SY", name: "Syria" },
  { code: "SZ", name: "Eswatini (Swaziland)" },
  { code: "TC", name: "Turks & Caicos Is" },
  { code: "TG", name: "Togo" },
  { code: "TH", name: "Thailand" },
  { code: "TJ", name: "Tajikistan" },
  { code: "TL", name: "East Timor" },
  { code: "TM", name: "Turkmenistan" },
  { code: "TN", name: "Tunisia" },
  { code: "TR", name: "Turkey" },
  { code: "TT", name: "Trinidad & Tobago" },
  { code: "TW", name: "Taiwan" },
  { code: "TZ", name: "Tanzania" },
  { code: "UA", name: "Ukraine" },
  { code: "UG", name: "Uganda" },
  { code: "US", name: "United States" },
  { code: "UY", name: "Uruguay" },
  { code: "UZ", name: "Uzbekistan" },
  { code: "VA", name: "Vatican City" },
  { code: "VC", name: "St Vincent" },
  { code: "VE", name: "Venezuela" },
  { code: "VG", name: "Virgin Islands (UK)" },
  { code: "VI", name: "Virgin Islands (US)" },
  { code: "VN", name: "Vietnam" },
  { code: "YE", name: "Yemen" },
  { code: "YT", name: "Mayotte" },
  { code: "ZA", name: "South Africa" },
  { code: "ZM", name: "Zambia" },
  { code: "ZW", name: "Zimbabwe" },
] as const;

export const COUNTRY_OPTIONS = [...RAW_COUNTRY_OPTIONS].sort((a, b) => {
  return a.name.localeCompare(b.name);
});

const COUNTRY_NAME_BY_CODE = new Map<string, string>(
  RAW_COUNTRY_OPTIONS.map(({ code, name }) => [code, name]),
);

export function normalizeCountryCode(code?: string | null): string {
  const normalized = code?.trim().toUpperCase();
  if (!normalized || !COUNTRY_NAME_BY_CODE.has(normalized)) {
    return DEFAULT_COUNTRY_CODE;
  }
  return normalized;
}

export function isSupportedCountryCode(code?: string | null): boolean {
  const normalized = code?.trim().toUpperCase();
  return !!normalized && COUNTRY_NAME_BY_CODE.has(normalized);
}

export function getCountryName(code?: string | null): string {
  if (isGlobalScope(code)) return GLOBAL_SCOPE_NAME;
  const normalized = normalizeCountryCode(code);
  return COUNTRY_NAME_BY_CODE.get(normalized) ?? normalized;
}

export function getCountryFlagEmoji(code?: string | null): string {
  if (isGlobalScope(code)) return "\u{1F30D}";
  const normalized = normalizeCountryCode(code);
  return String.fromCodePoint(
    ...normalized
      .split("")
      .map((char) => 127397 + char.charCodeAt(0)),
  );
}

// The globe motif osu! itself uses for global rankings. Doubles as the "flag"
// for the Global scope wherever a flag image is rendered generically.
export const GLOBAL_SCOPE_ICON_URL = "/images/icons/rankings.svg";

// osu!'s own neutral unknown-flag placeholder. Used whenever a code has no real
// flag so we never launder it through normalizeCountryCode's default country
// (which would render an unrelated flag, e.g. Costa Rica, for anything unmapped).
export const UNKNOWN_FLAG_URL = "https://assets.ppy.sh/old-flags/__.png";

export function getCountryFlagUrl(code?: string | null): string {
  if (isGlobalScope(code)) return GLOBAL_SCOPE_ICON_URL;
  const normalized = code?.trim().toUpperCase();
  if (!normalized || !COUNTRY_NAME_BY_CODE.has(normalized)) return UNKNOWN_FLAG_URL;
  return `https://osu.ppy.sh/images/flags/${normalized}.png`;
}

// Higher-res raster than osu!'s 70x47 flag PNG for large renders (the OG
// cards pull from the same source at w640) and a broader set than osu! ships
// (it covers countries osu! lacks, e.g. Curaçao). Callers should keep the osu!
// flag as an onError fallback.
export function getCountryFlagLargeUrl(code?: string | null): string {
  if (isGlobalScope(code)) return GLOBAL_SCOPE_ICON_URL;
  const normalized = code?.trim().toUpperCase();
  if (!normalized || !COUNTRY_NAME_BY_CODE.has(normalized)) return UNKNOWN_FLAG_URL;
  return `https://flagcdn.com/w320/${normalized.toLowerCase()}.png`;
}

/**
 * Returns a CSS gradient approximating the country's flag for use on the osu! logo circle.
 * Covers flags that stripes, crosses and hard-edged wedges can carry; returns null for
 * complex ones (emblems, the ZA/KR motifs), where the caller falls back to the flag image.
 * Entries may layer several backgrounds, first listed painting on top. Every stop pair must
 * share a position so the edges stay hard rather than smearing one colour into the next.
 * Note the favicon route only rasterises single-layer linear gradients and fetches the real
 * flag PNG for the rest, so a layered entry costs it a network hop but never breaks it.
 *
 * Emblems are drawn only when they read at ~40px: a shape in the emblem's colour and
 * footprint, never fake detail. Countries whose civil flag drops the emblem entirely
 * (CR, PE, EC, VE, BO, GT, SV, PY) are left as plain stripes, which is a real variant
 * rather than an approximation.
 */
// The one emblem worth drawing properly: at logo size Canada is otherwise just
// red/white/red, indistinguishable from Peru. Path lifted from the public-domain
// Flag_of_Canada.svg, with the viewBox cropped to the leaf's bounding box.
const CA_MAPLE_LEAF =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='2940 410 3720 4020'%3E%3Cpath fill='%23ff0000' d='m4890 4430-45-863a95 95 0 0 1 111-98l859 151-116-320a65 65 0 0 1 20-73l941-762-212-99a65 65 0 0 1-34-79l186-572-542 115a65 65 0 0 1-73-38l-105-247-423 454a65 65 0 0 1-111-57l204-1052-327 189a65 65 0 0 1-91-27l-332-652-332 652a65 65 0 0 1-91 27l-327-189 204 1052a65 65 0 0 1-111 57l-423-454-105 247a65 65 0 0 1-73 38l-542-115 186 572a65 65 0 0 1-34 79l-212 99 941 762a65 65 0 0 1 20 73l-116 320 859-151a95 95 0 0 1 111 98l-45 863z'/%3E%3C/svg%3E\") center / 40% 43% no-repeat";

const FLAG_GRADIENTS: Record<string, string> = {
  // Horizontal stripes (top to bottom), sized 1:1:2:1:1 like the real flag
  CR: "linear-gradient(180deg, #002b7f 17%, #fff 17%, #fff 33%, #ce1126 33%, #ce1126 67%, #fff 67%, #fff 83%, #002b7f 83%)",
  DE: "linear-gradient(180deg, #000 33%, #dd0000 33%, #dd0000 67%, #ffcc00 67%)",
  FR: "linear-gradient(90deg, #002395 33%, #fff 33%, #fff 67%, #ed2939 67%)",
  IT: "linear-gradient(90deg, #009246 33%, #fff 33%, #fff 67%, #ce2b37 67%)",
  NL: "linear-gradient(180deg, #ae1c28 33%, #fff 33%, #fff 67%, #21468b 67%)",
  RU: "linear-gradient(180deg, #fff 33%, #0039a6 33%, #0039a6 67%, #d52b1e 67%)",
  UA: "linear-gradient(180deg, #005bbb 50%, #ffd500 50%)",
  PL: "linear-gradient(180deg, #fff 50%, #dc143c 50%)",
  AT: "linear-gradient(180deg, #ed2939 33%, #fff 33%, #fff 67%, #ed2939 67%)",
  HU: "linear-gradient(180deg, #ce2939 33%, #fff 33%, #fff 67%, #477050 67%)",
  BG: "linear-gradient(180deg, #fff 33%, #00966e 33%, #00966e 67%, #d62612 67%)",
  LU: "linear-gradient(180deg, #ed2939 33%, #fff 33%, #fff 67%, #00a1de 67%)",
  BE: "linear-gradient(90deg, #000 33%, #ffd90c 33%, #ffd90c 67%, #f31830 67%)",
  IE: "linear-gradient(90deg, #169b62 33%, #fff 33%, #fff 67%, #ff883e 67%)",
  RO: "linear-gradient(90deg, #002b7f 33%, #fcd116 33%, #fcd116 67%, #ce1126 67%)",
  CO: "linear-gradient(180deg, #fcd116 50%, #003893 50%, #003893 75%, #ce1126 75%)",
  // Sol de Mayo, sized to the white band it sits in.
  AR: "radial-gradient(circle at 50% 50%, #f6b40e 0 11%, transparent 11%), linear-gradient(180deg, #74acdf 33%, #fff 33%, #fff 67%, #74acdf 67%)",
  // Canton is a third of the width and half the height, with the star inside it.
  CL: "radial-gradient(circle at 17% 25%, #fff 0 5%, transparent 5%), linear-gradient(#0039a6, #0039a6) top left / 33% 50% no-repeat, linear-gradient(180deg, #fff 50%, #d52b1e 50%)",
  PE: "linear-gradient(90deg, #d91023 33%, #fff 33%, #fff 67%, #d91023 67%)",
  JP: "radial-gradient(circle, #bc002d 30%, #fff 30%)",
  // KR is intentionally absent: the taegeuk + trigrams can't be approximated by
  // a stripe gradient, so it falls back to the real flag image.
  TH: "linear-gradient(180deg, #ed1c24 17%, #fff 17%, #fff 33%, #241d4f 33%, #241d4f 67%, #fff 67%, #fff 83%, #ed1c24 83%)",
  ID: "linear-gradient(180deg, #ce1126 50%, #fff 50%)",
  // The white hoist triangle is a 90deg wedge pointing left, drawn from its apex
  // at 44% width (the sun and stars inside it are too fine to approximate).
  PH: "conic-gradient(from 225deg at 44% 50%, #fff 0deg 90deg, transparent 90deg), linear-gradient(180deg, #0038a8 50%, #ce1126 50%)",
  US: "linear-gradient(#3c3b6e, #3c3b6e) top left / 40% 54% no-repeat, linear-gradient(180deg, #b22234 8%, #fff 8%, #fff 15%, #b22234 15%, #b22234 23%, #fff 23%, #fff 31%, #b22234 31%, #b22234 38%, #fff 38%, #fff 46%, #b22234 46%, #b22234 54%, #fff 54%, #fff 62%, #b22234 62%, #b22234 69%, #fff 69%, #fff 77%, #b22234 77%, #b22234 85%, #fff 85%, #fff 92%, #b22234 92%)",
  CA: `${CA_MAPLE_LEAF}, linear-gradient(90deg, #ff0000 25%, #fff 25%, #fff 75%, #ff0000 75%)`,
  // Without a mark in the white band Mexico is pixel-identical to Italy, so the
  // eagle-and-cactus emblem gets a disc in its colours and footprint.
  MX: "radial-gradient(circle at 50% 50%, #7a5c2e 0 9%, transparent 9%), linear-gradient(90deg, #006847 33%, #fff 33%, #fff 67%, #ce1126 67%)",
  // Nordic crosses: a vertical bar offset toward the hoist layered over the
  // horizontal one, both the same thickness (a lone horizontal band would read
  // as a plain triband).
  SE: "linear-gradient(90deg, transparent 28%, #fecc02 28%, #fecc02 48%, transparent 48%), linear-gradient(180deg, #005293 40%, #fecc02 40%, #fecc02 60%, #005293 60%)",
  NO: "linear-gradient(90deg, transparent 28%, #002868 28%, #002868 52%, transparent 52%), linear-gradient(180deg, transparent 38%, #002868 38%, #002868 62%, transparent 62%), linear-gradient(90deg, transparent 20%, #fff 20%, #fff 60%, transparent 60%), linear-gradient(180deg, #ef2b2d 30%, #fff 30%, #fff 70%, #ef2b2d 70%)",
  DK: "linear-gradient(90deg, transparent 32%, #fff 32%, #fff 46%, transparent 46%), linear-gradient(180deg, #c8102e 43%, #fff 43%, #fff 57%, #c8102e 57%)",
  FI: "linear-gradient(90deg, transparent 28%, #003580 28%, #003580 48%, transparent 48%), linear-gradient(180deg, #fff 40%, #003580 40%, #003580 60%, #fff 60%)",
  ES: "radial-gradient(ellipse 9% 12% at 33% 50%, #ad1519 0 100%, transparent 100%), linear-gradient(180deg, #aa151b 25%, #f1bf00 25%, #f1bf00 75%, #aa151b 75%)",
  // Armillary sphere as a gold ring straddling the green/red seam.
  PT: "radial-gradient(circle at 40% 50%, transparent 0 7%, #ffd033 7% 10%, transparent 10%), linear-gradient(90deg, #006600 40%, #ff0000 40%)",
  // Square canton (five stripes tall) carrying the white cross, over the nine stripes.
  GR: "linear-gradient(90deg, transparent 40%, #fff 40%, #fff 60%, transparent 60%) top left / 56% 56% no-repeat, linear-gradient(180deg, transparent 40%, #fff 40%, #fff 60%, transparent 60%) top left / 56% 56% no-repeat, linear-gradient(#0d5eaf, #0d5eaf) top left / 56% 56% no-repeat, linear-gradient(180deg, #0d5eaf 11%, #fff 11%, #fff 22%, #0d5eaf 22%, #0d5eaf 33%, #fff 33%, #fff 44%, #0d5eaf 44%, #0d5eaf 56%, #fff 56%, #fff 67%, #0d5eaf 67%, #0d5eaf 78%, #fff 78%, #fff 89%, #0d5eaf 89%)",
  // Ashoka Chakra as a navy ring; its 24 spokes are sub-pixel at logo size.
  IN: "radial-gradient(circle at 50% 50%, transparent 0 8%, #06038d 8% 10%, transparent 10%), linear-gradient(180deg, #ff9933 33%, #fff 33%, #fff 67%, #138808 67%)",
  // Eagle of Saladin, filling the white band like the real emblem does.
  EG: "radial-gradient(circle at 50% 50%, #c09300 0 9%, transparent 9%), linear-gradient(180deg, #ce1126 33%, #fff 33%, #fff 67%, #000 67%)",
  NG: "linear-gradient(90deg, #008751 33%, #fff 33%, #fff 67%, #008751 67%)",
  // ZA is intentionally absent: the flag's green Y, black hoist triangle and gold
  // fimbriation don't survive a stripe gradient (it lost the black and gold
  // entirely), so it falls back to the real flag image.
  // Crescent carved out by laying a red disc over a white one; the five stars in
  // its opening would be sub-pixel, so they are left out.
  SG: "radial-gradient(circle at 31% 26%, #ee2536 0 11.5%, transparent 11.5%), radial-gradient(circle at 24% 26%, #fff 0 13%, transparent 13%), linear-gradient(180deg, #ee2536 50%, #fff 50%)",
  CZ: "conic-gradient(from 225deg at 50% 50%, #11457e 0deg 90deg, transparent 90deg), linear-gradient(180deg, #fff 50%, #d7141a 50%)",
  EC: "linear-gradient(180deg, #ffd100 50%, #034ea2 50%, #034ea2 75%, #ce1126 75%)",
  VE: "linear-gradient(180deg, #fcf75e 33%, #0035ad 33%, #0035ad 67%, #cf142b 67%)",
  PY: "linear-gradient(180deg, #d52b1e 33%, #fff 33%, #fff 67%, #0038a8 67%)",
  BO: "linear-gradient(180deg, #d52b1e 33%, #f9e300 33%, #f9e300 67%, #007934 67%)",
  GT: "linear-gradient(90deg, #4997d0 33%, #fff 33%, #fff 67%, #4997d0 67%)",
  // The five stars are what separate Honduras from the other blue/white/blue
  // Central American flags, so they are worth the extra layers.
  HN: "radial-gradient(circle at 50% 50%, #0073cf 0 3%, transparent 3%), radial-gradient(circle at 37% 42%, #0073cf 0 3%, transparent 3%), radial-gradient(circle at 63% 42%, #0073cf 0 3%, transparent 3%), radial-gradient(circle at 37% 58%, #0073cf 0 3%, transparent 3%), radial-gradient(circle at 63% 58%, #0073cf 0 3%, transparent 3%), linear-gradient(180deg, #0073cf 33%, #fff 33%, #fff 67%, #0073cf 67%)",
  SV: "linear-gradient(180deg, #0047ab 33%, #fff 33%, #fff 67%, #0047ab 67%)",
  NI: "radial-gradient(circle at 50% 50%, #92c1e9 0 7%, transparent 7%), linear-gradient(180deg, #0067c6 33%, #fff 33%, #fff 67%, #0067c6 67%)",
  // The arms sit in a large white disc that reads clearly even at logo size.
  BZ: "radial-gradient(circle at 50% 50%, #fff 0 27%, transparent 27%), linear-gradient(180deg, #ce1126 10%, #003f87 10%, #003f87 90%, #ce1126 90%)",
  // Quartered by a white cross: blue top-left/bottom-right, red top-right/bottom-left.
  DO: "linear-gradient(90deg, transparent 43%, #fff 43%, #fff 57%, transparent 57%), linear-gradient(180deg, transparent 43%, #fff 43%, #fff 57%, transparent 57%), linear-gradient(#ce1126, #ce1126) top right / 50% 50% no-repeat, linear-gradient(#ce1126, #ce1126) bottom left / 50% 50% no-repeat, linear-gradient(#002d62, #002d62)",
};

export function getCountryFlagGradient(code?: string | null): string | null {
  if (isGlobalScope(code)) return null;
  const normalized = normalizeCountryCode(code);
  return FLAG_GRADIENTS[normalized] ?? null;
}
