import { useEffect, useState } from "react";
import { useLingui } from "@lingui/react/macro";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { ExternalLink } from "lucide-react";

import { SupportGoalBar } from "../layout/SupportGoalBar";
import { useAuth } from "../../lib/auth-context";
import { track } from "../../lib/analytics";
import { readEdgeCountry } from "../../lib/country-cookie";
import { GOOGLE_RRM_PUBLICATION_ID, startGoogleContributions } from "../../lib/google-contributions";
import { claimGoogleContribution } from "../../lib/supporter-look-settings";

/* Where a visitor pays, at the end of /support: the month's hosting bar, the
   Ko-fi panel, lava.top for the countries Ko-fi cannot take a card from, and
   Google's checkout once its publication id is set. */

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

/* Google's checkout: its own button and dialog. A signed-in payer's order is
   claimed for them on the spot; anyone can paste one from Google's receipt. */
function GoogleContribution({ viewerId }: { viewerId: number | null | undefined }) {
  const { t, i18n } = useLingui();
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [orderId, setOrderId] = useState("");
  const [busy, setBusy] = useState(false);

  const claim = (order: string, amountUsd: number | null) => {
    setBusy(true);
    setStatus(null);
    claimGoogleContribution({ data: { orderId: order, amountUsd } })
      .then(() => {
        setStatus({ ok: true, text: t`Thank you! Your supporter time is on.` });
        setOrderId("");
        track("support_google_claimed");
      })
      .catch((error: unknown) => setStatus({ ok: false, text: error instanceof Error ? error.message : String(error) }))
      .finally(() => setBusy(false));
  };

  useEffect(() => {
    startGoogleContributions((purchase) => {
      if (purchase.orderId && viewerId) claim(purchase.orderId, purchase.amountUsd);
      else setStatus({ ok: true, text: t`Thank you! Sign in and paste the order number from Google's receipt email below to get your supporter time.` });
    }, i18n.locale);
  }, [viewerId, i18n.locale]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="border-b border-white/[0.07] px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[12px] text-osu-f1">
          {viewerId ? t`Or pay with Google. Your supporter time starts right away.` : t`Or pay with Google. Sign in first so it counts toward your account.`}
        </p>
        <button type="button" {...{ "swg-standard-button": "contribution" }} />
      </div>
      {status && <p className={`mt-2 text-[12px] ${status.ok ? "text-osu-l2" : "text-osu-red-light"}`}>{status.text}</p>}
      {viewerId ? (
        <form
          className="mt-2 flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (orderId.trim()) claim(orderId.trim(), null);
          }}
        >
          <label htmlFor="google-order" className="text-[11.5px] text-osu-f1">{t`Paid with Google already?`}</label>
          <input
            id="google-order"
            value={orderId}
            onChange={(event) => setOrderId(event.target.value)}
            placeholder={t`Order number from the receipt`}
            maxLength={64}
            className="h-7 min-w-0 flex-1 rounded-md bg-osu-b5 px-2 text-[12px] text-white outline-none ring-1 ring-inset ring-white/[0.08] placeholder:text-osu-f1 focus:ring-osu-pink/60"
          />
          <button
            type="submit"
            disabled={busy || !orderId.trim()}
            className="h-7 cursor-pointer rounded-md bg-osu-b3 px-3 text-[12px] font-semibold text-white transition hover:bg-osu-b2 disabled:cursor-default disabled:opacity-40"
          >
            {t`Claim`}
          </button>
        </form>
      ) : null}
    </div>
  );
}

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
      {GOOGLE_RRM_PUBLICATION_ID ? <GoogleContribution viewerId={viewerId} /> : null}
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
