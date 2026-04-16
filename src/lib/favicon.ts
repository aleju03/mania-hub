import { useEffect } from "react";
import { normalizeCountryCode } from "./country";

function setFaviconHref(href: string): void {
  if (typeof document === "undefined") return;
  const existing = document.querySelectorAll<HTMLLinkElement>("link[rel~='icon']");
  existing.forEach((el) => el.remove());
  const link = document.createElement("link");
  link.rel = "icon";
  link.type = "image/png";
  link.href = href;
  document.head.appendChild(link);
}

export function useDynamicFavicon(countryCode: string | null | undefined): void {
  useEffect(() => {
    const code = normalizeCountryCode(countryCode);
    setFaviconHref(`/api/favicon?code=${code}&v=2`);
  }, [countryCode]);
}
