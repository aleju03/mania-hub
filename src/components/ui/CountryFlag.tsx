import { Globe } from "lucide-react";
import {
  UNKNOWN_FLAG_URL,
  getCountryFlagLargeUrl,
  getCountryFlagUrl,
  getCountryName,
  isGlobalScope,
} from "../../lib/country";

type CountryFlagSize = "xs" | "sm" | "md" | "lg";

const sizeClass: Record<CountryFlagSize, string> = {
  xs: "h-[10px] w-[15px] rounded-[1px]",
  sm: "h-[12px] w-[18px] rounded-[1px]",
  md: "h-[15px] w-[22px] rounded-[2px]",
  lg: "h-8 w-[48px] rounded-sm",
};

const globeSizeClass: Record<CountryFlagSize, string> = {
  xs: "h-[8px] w-[8px]",
  sm: "h-[10px] w-[10px]",
  md: "h-[12px] w-[12px]",
  lg: "h-5 w-5",
};

export function CountryFlag({
  code,
  size = "sm",
  muted = false,
  decorative = false,
  className = "",
}: {
  code?: string | null;
  size?: CountryFlagSize;
  muted?: boolean;
  decorative?: boolean;
  className?: string;
}) {
  const normalized = code?.trim().toUpperCase() || "XX";
  const title = normalized === "XX" ? "Unknown country" : getCountryName(normalized);
  const labelProps = decorative ? { alt: "", title: undefined } : { alt: title, title };
  const outerClassName = `inline-flex shrink-0 items-center justify-center overflow-hidden align-middle ${sizeClass[size]} ${muted ? "opacity-50 saturate-75" : ""} ${className}`;

  if (isGlobalScope(normalized)) {
    return (
      <span
        className={`${outerClassName} bg-osu-pink/25 text-osu-pink-light ${muted ? "opacity-60" : ""}`}
        role={decorative ? undefined : "img"}
        aria-label={decorative ? undefined : title}
        title={decorative ? undefined : title}
      >
        <Globe className={globeSizeClass[size]} strokeWidth={2.4} aria-hidden="true" />
      </span>
    );
  }

  return (
    <span className={outerClassName}>
      <img
        src={getCountryFlagUrl(normalized)}
        {...labelProps}
        className="block h-full w-full object-cover"
        loading="lazy"
        onError={(event) => {
          const img = event.currentTarget;
          // osu! is missing flags for a handful of countries (e.g. Curaçao).
          // Fall through to flagcdn's broader set, then osu!'s unknown-flag
          // placeholder -- never resolve an unrecognised code to a default
          // country's flag.
          const flagcdn = getCountryFlagLargeUrl(normalized);
          if (flagcdn !== UNKNOWN_FLAG_URL && img.src !== flagcdn) {
            img.src = flagcdn;
          } else if (img.src !== UNKNOWN_FLAG_URL) {
            img.src = UNKNOWN_FLAG_URL;
          }
        }}
      />
    </span>
  );
}
