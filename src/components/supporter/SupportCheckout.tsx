import { useEffect, useState } from "react";
import { useLingui } from "@lingui/react/macro";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { ExternalLink } from "lucide-react";

import { useAuth } from "../../lib/auth-context";
import { track } from "../../lib/analytics";
import { readEdgeCountry } from "../../lib/country-cookie";
import { GOOGLE_RRM_PUBLICATION_ID, startGoogleContributions } from "../../lib/google-contributions";
import { claimGoogleContribution } from "../../lib/supporter-look-settings";
import { useNearView } from "./SupportMotion";
import { KofiNameSteps } from "./KofiNameSteps";

/* Where a visitor pays, at the end of /support: a choice of Ko-fi, Google's
   checkout (admins only for now) and lava.top, with the one that fits the
   visitor's country picked first. */

export const KOFI_PAGE_URL = "https://ko-fi.com/aleju03";
/* lava.top sells supporter time as a membership (monthly tiers that renew
   by themselves) rather than taking tips. Until the membership exists only
   admins see the option, on the creator page; set the membership's own link
   here (and LAVA_FOR_EVERYONE) once it is up. Its payment button widget
   (lava.top Integrations, verified for the domain) can replace the link then.
   A first payment arrives as payment.success and each renewal as
   subscription.recurring.payment.success (backend features/donations.ts). */
const LAVA_MEMBERSHIP_URL: string | null = null;
const LAVA_PAGE_URL = "https://app.lava.top/mania-tracker";
const LAVA_FOR_EVERYONE = false;

// A signed-in visitor's link carries their osu! id, which lava.top hands
// back on the webhook so the purchase counts toward their supporter time
// (backend features/donations.ts, LAVA_UTM_PREFIX).
function lavaUrl(viewerId: number | null | undefined): string {
  const base = LAVA_MEMBERSHIP_URL ?? LAVA_PAGE_URL;
  if (!viewerId) return base;
  return `${base}${base.includes("?") ? "&" : "?"}utm_source=mania-tracker&utm_content=osu-${viewerId}`;
}

// Countries where Ko-fi cannot take a payment (no PayPal, and local cards do
// not work abroad): lava.top is picked first there, once it is offered.
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
    <div className="px-4 py-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[12px] text-osu-f1">
          {viewerId ? t`Pick an amount in Google's checkout.` : t`Sign in first so it counts toward your account.`}
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

/* The three ways to pay: Ko-fi (cards and PayPal), Google (Google Pay and
   the cards saved there) and lava.top (cards in rubles, dollars or euros,
   and Apple Pay), which also works where Ko-fi does not. */
export type SupportMethod = "kofi" | "google" | "lava";

/* Google's checkout stays with admins until one real payment has gone
   through it: it refuses every host but mania-tracker.com, so it can only
   be tried live. Flip this once it has. */
const GOOGLE_FOR_EVERYONE = false;

/* The methods this visitor can pick, and the one picked first: lava.top
   where Ko-fi cannot take a card, Ko-fi everywhere else. Null while the
   visitor's country is being asked. */
export function useSupportMethods() {
  const auth = useAuth();
  const [lavaFirst, setLavaFirst] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    getSupportUsesLava()
      .then((value) => !cancelled && setLavaFirst(value))
      .catch(() => !cancelled && setLavaFirst(false));
    return () => {
      cancelled = true;
    };
  }, []);
  const google = !!GOOGLE_RRM_PUBLICATION_ID && (GOOGLE_FOR_EVERYONE || auth.isAdmin);
  const lava = LAVA_FOR_EVERYONE || auth.isAdmin;
  const methods: SupportMethod[] = ["kofi", ...(google ? ["google" as const] : []), ...(lava ? ["lava" as const] : [])];
  const initial: SupportMethod | null = lavaFirst == null ? null : lavaFirst && lava ? "lava" : "kofi";
  return { methods, initial };
}

/* What to do so the payment reaches the account, beside the checkout. */
export function SupportMethodSteps({ method }: { method: SupportMethod }) {
  const { t } = useLingui();
  const signedIn = !!useAuth().viewer;
  if (method === "kofi") return <KofiNameSteps />;
  return (
    <p className="mt-2 text-[14px] leading-relaxed text-osu-l2">
      {method === "google"
        ? signedIn
          ? t`Pay with Google here. Your supporter time starts as soon as the payment goes through.`
          : t`Sign in first, then pay with Google here, so your supporter time reaches your account.`
        : signedIn
          ? t`Pay on lava.top. The link carries your account, so your supporter time reaches it on its own.`
          : t`Sign in first, then pay on lava.top: the link carries your account, so your supporter time reaches it.`}
    </p>
  );
}

export function SupportCheckout({ methods, method, onMethod }: { methods: SupportMethod[]; method: SupportMethod | null; onMethod: (method: SupportMethod) => void }) {
  const { t } = useLingui();
  const auth = useAuth();
  const viewerId = auth.viewer?.id;
  // once loaded it stays, so scrolling away and back never reloads it
  const [frameRef, near] = useNearView<HTMLDivElement>("800px 0px");
  const [frameNear, setFrameNear] = useState(false);
  useEffect(() => {
    if (near) setFrameNear(true);
  }, [near]);
  // Ko-fi's panel stays loaded once shown, so switching back is instant
  const [kofiSeen, setKofiSeen] = useState(false);
  useEffect(() => {
    if (method === "kofi") setKofiSeen(true);
  }, [method]);
  const label: Record<SupportMethod, { name: string; detail: string }> = {
    kofi: { name: "Ko-fi", detail: t`Card or PayPal` },
    google: { name: "Google", detail: t`Google Pay` },
    lava: { name: "lava.top", detail: t`Cards or Apple Pay` },
  };

  return (
    <div className="overflow-hidden rounded-xl bg-osu-b4">
      {/* a choice only when there is one to make */}
      {methods.length > 1 && <div role="radiogroup" aria-label={t`How to pay`} className={`grid gap-1 border-b border-white/[0.07] p-1.5 ${methods.length === 3 ? "grid-cols-3" : "grid-cols-2"}`}>
        {methods.map((id) => {
          const on = id === method;
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => {
                onMethod(id);
                track("support_method", { method: id });
              }}
              className={`cursor-pointer rounded-lg px-2 py-2 text-center transition-colors ${on ? "bg-osu-b2 text-white" : "text-osu-l2 hover:bg-white/[0.05] hover:text-white"}`}
            >
              <span className="block text-[13px] font-bold">{label[id].name}</span>
              <span className={`block text-[11px] ${on ? "text-osu-l2" : "text-osu-f1"}`}>{label[id].detail}</span>
            </button>
          );
        })}
      </div>}
      {method === "lava" ? (
        <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
          <p className="max-w-[300px] text-[12.5px] text-osu-f1">{LAVA_MEMBERSHIP_URL ? t`lava.top opens in a new tab to pay.` : t`Admins only: the supporter membership on lava.top is not up yet.`}</p>
          <a
            href={lavaUrl(viewerId)}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => track("support_lava_open")}
            className="inline-flex items-center gap-1.5 rounded-full bg-osu-pink px-5 py-2.5 text-[13px] font-semibold text-white transition hover:brightness-110"
          >
            {t`Pay on lava.top`}
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          </a>
        </div>
      ) : null}
      {method === "google" ? <GoogleContribution viewerId={viewerId} /> : null}
      {/* Ko-fi's page is heavy to start, so it loads once the visitor has
          paused near it rather than mid-scroll on the way down */}
      <div ref={frameRef} className={method === "kofi" || method === null ? "" : "hidden"}>
        {method !== null && kofiSeen && frameNear ? (
          <iframe
            src={`${KOFI_PAGE_URL}/?hidefeed=true&widget=true&embed=true`}
            title={t`Support on Ko-fi`}
            loading="lazy"
            allow="payment *"
            className="block h-[600px] w-full border-0 bg-[#f9f9f9]"
          />
        ) : (
          <div className="h-[600px] bg-[#f9f9f9]/5" />
        )}
      </div>
    </div>
  );
}
