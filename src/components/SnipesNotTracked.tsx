import { getCountryName } from "../lib/country";
import { CountryFlag } from "./ui/CountryFlag";

/**
 * Shown on the Snipes page when the selected country is below the "snipes"
 * feature tier. Snipe board seeding is an expensive, opt-in operation enabled
 * only for a small set of tracked countries, so a non-snipes country will
 * never accumulate snipe data. This explains that instead of showing an empty
 * list that looks like it's just waiting for activity.
 *
 * `hasOldData` softens the wording when stale snipe history still exists.
 */
export function SnipesNotTracked({ country, hasOldData }: { country: string; hasOldData: boolean }) {
  const name = getCountryName(country);

  return (
    <div className="relative max-w-[1200px] mx-auto px-4 sm:px-5 py-12 sm:py-20">
      <div className="mx-auto max-w-md rounded-xl border border-osu-b3/30 bg-osu-b4/80 px-6 py-10 text-center backdrop-blur-sm">
        <CountryFlag code={country} size="lg" className="mx-auto shadow-sm" />
        <p className="mt-5 text-sm font-medium text-osu-c2">
          Snipes aren't tracked for {name}
        </p>
        <p className="mt-2 text-[12px] leading-relaxed text-osu-f1">
          Snipe tracking runs for a small set of countries because it's an
          expensive operation. {name} isn't one of them
          {hasOldData ? ", so the snipes below are older history and won't update." : "."}
        </p>
      </div>
    </div>
  );
}
