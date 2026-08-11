import {
  COMMUNITY_INTERNATIONAL,
  COMMUNITY_LANGUAGES,
  COMMUNITY_LANGUAGE_LABELS,
} from "../../lib/communities-shared";
import { COUNTRY_OPTIONS } from "../../lib/country";
import { CountryFlag } from "../ui/CountryFlag";

/* The country and language pickers, shared by the form that posts a server and
   the one that edits it, so the two can never drift into offering different
   answers for the same field. */

const countryOption = (country: { code: string; name: string }) => ({
  value: country.code,
  label: country.name,
  leading: <CountryFlag code={country.code} size="sm" decorative />,
});

/* Your own country sits directly under "international" rather than wherever the
   alphabet put it, because it is the answer far more often than Afghanistan is.
   Lifted out of the run rather than repeated in it, so there is one row per
   country and searching still finds it. */
export function countrySelectOptions(viewerCountry: string | null) {
  const own = viewerCountry ? COUNTRY_OPTIONS.find((country) => country.code === viewerCountry) : undefined;
  return [
    { value: "", label: "not set" },
    { value: COMMUNITY_INTERNATIONAL, label: "international" },
    ...(own ? [countryOption(own)] : []),
    ...COUNTRY_OPTIONS.filter((country) => country.code !== own?.code).map(countryOption),
  ];
}

export const LANGUAGE_SELECT_OPTIONS = [
  { value: "", label: "not set" },
  ...COMMUNITY_LANGUAGES.map((code) => ({ value: code, label: COMMUNITY_LANGUAGE_LABELS[code] })),
];
