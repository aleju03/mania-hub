import { getCountryName } from "../lib/country";
import { CountryFlag } from "./ui/CountryFlag";

/**
 * Shown on every country-scoped surface when the live backend has never seen
 * the selected country before. The backend has queued roster/maps warmup jobs;
 * the page that renders this is polling and will swap to real data once ready.
 */
export function CountryWarming({ country }: { country: string }) {
  const name = getCountryName(country);

  return (
    <div className="relative max-w-[1200px] mx-auto px-4 sm:px-5 py-12 sm:py-20">
      <div className="mx-auto max-w-md rounded-xl border border-osu-b3/30 bg-osu-b4/80 px-6 py-10 text-center backdrop-blur-sm">
          <CountryFlag code={country} size="lg" className="mx-auto shadow-sm" />
          <p className="mt-5 text-sm font-medium text-osu-c2">
            {name} added to queue, come back later :)
          </p>
          <p className="mt-2 text-[12px] leading-relaxed text-osu-f1">
            First time anyone has visited {name}. Its rankings, maps and live
            tracking are being set up in the background.
          </p>
          <div className="mx-auto mt-6 h-1 w-40 overflow-hidden rounded-full bg-osu-b3/40">
            <div className="h-full w-1/3 rounded-full bg-osu-pink animate-[indeterminate_1.5s_ease-in-out_infinite]" />
          </div>
          <p className="mt-3 text-[10px] text-osu-f1/70">
            This page will load automatically once {name} is ready.
          </p>
      </div>
    </div>
  );
}
