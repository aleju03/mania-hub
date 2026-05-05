import { useEffect } from "react";
import { normalizeCountryCode } from "./country";

function setFaviconHref(href: string, type = "image/png"): void {
  if (typeof document === "undefined") return;
  // Mutate the existing <link rel="icon"> in place. TanStack Router's
  // HeadContent renders the initial icon link, which React 19 tracks as a
  // HostHoistable fiber. Calling .remove() detaches the DOM node but leaves
  // React's stateNode pointer dangling; the next unmount hits
  // parentNode.removeChild on a null parent and breaks reconciliation.
  const existing = document.querySelector<HTMLLinkElement>("link[rel~='icon']");
  if (existing) {
    if (existing.getAttribute("href") !== href) existing.setAttribute("href", href);
    if (existing.getAttribute("type") !== type) existing.setAttribute("type", type);
    return;
  }
  const link = document.createElement("link");
  link.rel = "icon";
  link.type = type;
  link.href = href;
  document.head.appendChild(link);
}

export function useDynamicFavicon(countryCode: string | null | undefined): void {
  useEffect(() => {
    const code = normalizeCountryCode(countryCode);
    setFaviconHref(`/api/favicon?code=${code}&v=2`);
  }, [countryCode]);
}
