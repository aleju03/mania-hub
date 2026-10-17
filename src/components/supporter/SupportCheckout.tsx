import { useEffect, useState } from "react";
import { useLingui } from "@lingui/react/macro";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { ExternalLink } from "lucide-react";

import { SupportGoalBar } from "../layout/SupportGoalBar";
import { useAuth } from "../../lib/auth-context";
import { track } from "../../lib/analytics";
import { readEdgeCountry } from "../../lib/country-cookie";

/* Where a visitor pays, at the end of /support: the month's hosting bar, the
   Ko-fi panel, and lava.top for the countries Ko-fi cannot take a card from. */

export const KOFI_PAGE_URL = "https://ko-fi.com/aleju03";
const LAVA_TIP_URL = "https://app.lava.top/mania-tracker?tabId=donate";

// A signed-in visitor's tip link carries their osu! id, which lava.top hands
// back on the webhook so the tip counts toward their supporter time (backend
// features/supporters.ts, LAVA_UTM_PREFIX).
function lavaTipUrl(viewerId: number | null | undefined): string {
  if (!viewerId) return LAVA_TIP_URL;
  return `${LAVA_TIP_URL}&utm_source=mania-tracker&utm_content=osu-${viewerId}`;
}

// Countries where Ko-fi cannot take a payment (no PayPal, and local cards do
// not work abroad), so the page offers lava.top, which takes ruble cards.
const LAVA_SUPPORT_COUNTRIES = new Set(["RU", "BY", "IR", "CU", "SY", "KP"]);

// Asked after the page loads rather than rendered into it, so the visitor's
// country never ends up in HTML a CDN could cache for someone else.
const getSupportUsesLava = createServerFn({ method: "GET" }).handler(() => {
  const country = readEdgeCountry(getRequest().headers);
  return country != null && LAVA_SUPPORT_COUNTRIES.has(country);
});

export function SupportCheckout() {
  const { t } = useLingui();
  const viewerId = useAuth().viewer?.id;
  // null until the server answers; Ko-fi shows meanwhile only if it says no.
  const [useLava, setUseLava] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    getSupportUsesLava()
      .then((value) => !cancelled && setUseLava(value))
      .catch(() => !cancelled && setUseLava(false));
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="overflow-hidden rounded-xl bg-osu-b4">
      <SupportGoalBar />
      {useLava === true ? (
        <div className="flex items-center justify-between gap-3 border-b border-white/[0.07] px-4 py-3">
          <p className="text-[12px] text-osu-f1">{t`Can't pay with Ko-fi? You can tip through lava.top.`}</p>
          <a
            href={lavaTipUrl(viewerId)}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => track("support_lava_open")}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-osu-pink px-4 py-2 text-[12px] font-semibold text-white transition hover:brightness-110"
          >
            {t`Send a tip`}
            <ExternalLink className="h-3 w-3" aria-hidden="true" />
          </a>
        </div>
      ) : null}
      {useLava != null ? (
        <iframe
          src={`${KOFI_PAGE_URL}/?hidefeed=true&widget=true&embed=true`}
          title={t`Support on Ko-fi`}
          loading="lazy"
          allow="payment *"
          className="block h-[600px] w-full border-0 bg-[#f9f9f9]"
        />
      ) : (
        <div className="h-[600px]" />
      )}
    </div>
  );
}
