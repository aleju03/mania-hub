// Static region geography: named groups of ISO 3166-1 alpha-2 codes.
//
// Regions are a read-time filter over per-country data — they must never grow
// their own projections, jobs, snapshot rows, or disk caches. Membership shown
// to users is always `countries ∩ country_registry`, computed when serving.
//
// Region codes are namespaced with the "R-" prefix so they can never collide
// with an ISO country code or satisfy the `^[A-Z]{2}$` country validators.
// Every ISO code appears in at most one region.
//
// Groupings follow the UN M49 subregions, adjusted where the everyday reading
// wins over the statistical one: Mexico sits in North America (M49 files it
// under Central America), Armenia/Azerbaijan/Georgia in Eastern Europe and
// Cyprus in Southern Europe (M49: all "Western Asia"), Iran in the Middle East
// (M49: "Southern Asia"). Taiwan and Kosovo are added where they sit on the
// map (M49 omits both). Uninhabited codes (Bouvet, Svalbard, ...) are left out
// of every region.
//
// Continents are unions of those subregions, for picking just "Europe" without
// caring which part. They are the same kind of scope (a bigger read-time
// filter), never a projection of their own.

export interface RegionDef {
  code: string;
  name: string;
  /** Full geographic membership, independent of what the registry tracks. */
  countries: readonly string[];
}

export const REGION_CODE_PREFIX = "R-";

export const REGIONS: readonly RegionDef[] = [
  {
    code: "R-NAMERICA",
    name: "North America",
    countries: ["BM", "CA", "GL", "MX", "PM", "US"],
  },
  {
    code: "R-CAMERICA",
    name: "Central America",
    countries: ["BZ", "CR", "GT", "HN", "NI", "PA", "SV"],
  },
  {
    code: "R-CARIB",
    name: "Caribbean",
    countries: [
      "AG", "AI", "AW", "BB", "BL", "BQ", "BS", "CU", "CW", "DM", "DO", "GD",
      "GP", "HT", "JM", "KN", "KY", "LC", "MF", "MQ", "MS", "PR", "SX", "TC",
      "TT", "VC", "VG", "VI",
    ],
  },
  {
    code: "R-SAMERICA",
    name: "South America",
    countries: [
      "AR", "BO", "BR", "CL", "CO", "EC", "FK", "GF", "GY", "PE", "PY", "SR",
      "UY", "VE",
    ],
  },
  {
    code: "R-NEUROPE",
    name: "Northern Europe",
    countries: [
      "AX", "DK", "EE", "FI", "FO", "GB", "GG", "IE", "IM", "IS", "JE", "LT",
      "LV", "NO", "SE",
    ],
  },
  {
    code: "R-WEUROPE",
    name: "Western Europe",
    countries: ["AT", "BE", "CH", "DE", "FR", "LI", "LU", "MC", "NL"],
  },
  {
    code: "R-EEUROPE",
    name: "Eastern Europe",
    countries: [
      "AM", "AZ", "BG", "BY", "CZ", "GE", "HU", "MD", "PL", "RO", "RU", "SK",
      "UA",
    ],
  },
  {
    code: "R-SEUROPE",
    name: "Southern Europe",
    countries: [
      "AD", "AL", "BA", "CY", "ES", "GI", "GR", "HR", "IT", "ME", "MK", "MT",
      "PT", "RS", "SI", "SM", "VA", "XK",
    ],
  },
  {
    code: "R-MIDEAST",
    name: "Middle East",
    countries: [
      "AE", "BH", "IL", "IQ", "IR", "JO", "KW", "LB", "OM", "PS", "QA", "SA",
      "SY", "TR", "YE",
    ],
  },
  {
    code: "R-NAFRICA",
    name: "Northern Africa",
    countries: ["DZ", "EG", "EH", "LY", "MA", "SD", "TN"],
  },
  {
    code: "R-WAFRICA",
    name: "Western Africa",
    countries: [
      "BF", "BJ", "CI", "CV", "GH", "GM", "GN", "GW", "LR", "ML", "MR", "NE",
      "NG", "SH", "SL", "SN", "TG",
    ],
  },
  {
    code: "R-MAFRICA",
    name: "Middle Africa",
    countries: ["AO", "CD", "CF", "CG", "CM", "GA", "GQ", "ST", "TD"],
  },
  {
    code: "R-EAFRICA",
    name: "Eastern Africa",
    countries: [
      "BI", "DJ", "ER", "ET", "IO", "KE", "KM", "MG", "MU", "MW", "MZ", "RE",
      "RW", "SC", "SO", "SS", "TZ", "UG", "YT", "ZM", "ZW",
    ],
  },
  {
    code: "R-SAFRICA",
    name: "Southern Africa",
    countries: ["BW", "LS", "NA", "SZ", "ZA"],
  },
  {
    code: "R-CASIA",
    name: "Central Asia",
    countries: ["KG", "KZ", "TJ", "TM", "UZ"],
  },
  {
    code: "R-SASIA",
    name: "Southern Asia",
    countries: ["AF", "BD", "BT", "IN", "LK", "MV", "NP", "PK"],
  },
  {
    code: "R-EASIA",
    name: "East Asia",
    countries: ["CN", "HK", "JP", "KP", "KR", "MN", "MO", "TW"],
  },
  {
    code: "R-SEASIA",
    name: "Southeast Asia",
    countries: ["BN", "ID", "KH", "LA", "MM", "MY", "PH", "SG", "TH", "TL", "VN"],
  },
  {
    code: "R-OCEANIA",
    name: "Oceania",
    countries: [
      "AS", "AU", "CK", "FJ", "FM", "GU", "KI", "MH", "MP", "NC", "NF", "NR",
      "NU", "NZ", "PF", "PG", "PN", "PW", "SB", "TK", "TO", "TV", "VU", "WF",
      "WS",
    ],
  },
];

const SUBREGION_BY_CODE = new Map(REGIONS.map((region) => [region.code, region]));

const CONTINENT_GROUPINGS: ReadonlyArray<{ code: string; name: string; regions: readonly string[] }> = [
  { code: "R-AFRICA", name: "Africa", regions: ["R-NAFRICA", "R-WAFRICA", "R-MAFRICA", "R-EAFRICA", "R-SAFRICA"] },
  { code: "R-AMERICAS", name: "Americas", regions: ["R-NAMERICA", "R-CAMERICA", "R-CARIB", "R-SAMERICA"] },
  { code: "R-ASIA", name: "Asia", regions: ["R-CASIA", "R-EASIA", "R-MIDEAST", "R-SASIA", "R-SEASIA"] },
  { code: "R-EUROPE", name: "Europe", regions: ["R-NEUROPE", "R-WEUROPE", "R-EEUROPE", "R-SEUROPE"] },
];

// Oceania has no subregion split here, so its single entry doubles as the
// continent.
export const CONTINENTS: readonly RegionDef[] = [
  ...CONTINENT_GROUPINGS.map(({ code, name, regions }) => ({
    code,
    name,
    countries: regions
      .flatMap((regionCode) => {
        const region = SUBREGION_BY_CODE.get(regionCode);
        if (!region) throw new Error(`continent ${code} references unknown region ${regionCode}`);
        return [...region.countries];
      })
      .sort(),
  })),
  SUBREGION_BY_CODE.get("R-OCEANIA")!,
];

export const REGION_BY_CODE: ReadonlyMap<string, RegionDef> = new Map(
  [...REGIONS, ...CONTINENTS].map((region) => [region.code, region]),
);

const REGION_BY_COUNTRY: ReadonlyMap<string, RegionDef> = new Map(
  REGIONS.flatMap((region) => region.countries.map((country) => [country, region])),
);

export function isRegionCode(value: string): boolean {
  return REGION_BY_CODE.has(value);
}

export function getRegion(code: string): RegionDef | null {
  return REGION_BY_CODE.get(code) ?? null;
}

export function regionForCountry(country: string): RegionDef | null {
  return REGION_BY_COUNTRY.get(country) ?? null;
}
