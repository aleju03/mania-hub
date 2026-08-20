import { Trans } from "@lingui/react/macro";
import { displayCountryName } from "../lib/country";
import { useLocale } from "../lib/locale-context";
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
  const locale = useLocale();
  const name = displayCountryName(country, locale);

  return (
    <div className="relative max-w-[1200px] mx-auto px-4 sm:px-5 py-12 sm:py-20">
      <div className="mx-auto max-w-md rounded-xl border border-osu-b3/30 bg-osu-b4/80 px-6 py-10 text-center backdrop-blur-sm">
        <CountryFlag code={country} size="lg" className="mx-auto shadow-sm" />
        <p className="mt-5 text-sm font-medium text-osu-c2">
          <Trans>Snipes aren't tracked for {name}</Trans>
        </p>
        <p className="mt-2 text-[12px] leading-relaxed text-osu-f1">
          <Trans>
            Snipe tracking runs for a small set of countries because it's an
            expensive operation.
          </Trans>{" "}
          {hasOldData ? (
            <Trans>{name} isn't one of them, so the snipes below are older history and won't update.</Trans>
          ) : (
            <Trans>{name} isn't one of them.</Trans>
          )}
        </p>
      </div>
    </div>
  );
}
