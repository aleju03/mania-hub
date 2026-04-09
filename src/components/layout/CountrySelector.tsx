import { COUNTRY_OPTIONS, getCountryFlagEmoji } from "../../lib/country";
import { useAppStore } from "../../store";

interface CountrySelectorProps {
  className?: string;
}

export function CountrySelector({ className = "" }: CountrySelectorProps) {
  const selectedCountry = useAppStore((state) => state.selectedCountry);
  const setSelectedCountry = useAppStore((state) => state.setSelectedCountry);

  return (
    <label className={`relative flex items-center gap-2 rounded-lg border border-osu-b3/30 bg-osu-b4/60 px-2.5 py-1.5 text-osu-l2 ${className}`.trim()}>
      <span className="text-sm leading-none" aria-hidden="true">
        {getCountryFlagEmoji(selectedCountry)}
      </span>
      <select
        value={selectedCountry}
        onChange={(event) => setSelectedCountry(event.target.value)}
        className="min-w-0 appearance-none bg-transparent pr-5 text-[11px] font-semibold outline-none cursor-pointer"
        aria-label="Select country"
      >
        {COUNTRY_OPTIONS.map((country) => (
          <option key={country.code} value={country.code}>
            {getCountryFlagEmoji(country.code)} {country.name} ({country.code})
          </option>
        ))}
      </select>
      <svg
        viewBox="0 0 20 20"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        className="pointer-events-none absolute right-2 h-3.5 w-3.5 text-osu-f1"
        aria-hidden="true"
      >
        <path d="m5 7 5 5 5-5" />
      </svg>
    </label>
  );
}
