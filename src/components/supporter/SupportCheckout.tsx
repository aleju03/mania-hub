import { useEffect, useState } from "react";
import { useLingui } from "@lingui/react/macro";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { ExternalLink } from "lucide-react";

import { useAuth } from "../../lib/auth-context";
import { track } from "../../lib/analytics";
import { readEdgeCountry } from "../../lib/country-cookie";
import { GOOGLE_RRM_PUBLICATION_ID, startGoogleContributions } from "../../lib/google-contributions";
import { claimGoogleContribution, claimPayments, rememberLavaEmail, type PaymentClaimProvider } from "../../lib/supporter-look-settings";
import { useNearView } from "./SupportMotion";
import { KofiNameSteps } from "./KofiNameSteps";

/* Where a visitor pays, at the end of /support: a choice of Ko-fi, Google's
   checkout (admins only for now) and lava.top, with the one that fits the
   visitor's country picked first. */

export const KOFI_PAGE_URL = "https://ko-fi.com/aleju03";
/* lava.top sells supporter time as a membership (monthly tiers that renew
   by themselves) rather than taking tips: the "Supporter" tier, priced in
   rubles (330 a month, 990 for 3, 1,980 for 6, 3,300 a year) since lava.top
   will not take under $5 in dollars. Its payment button widget (lava.top
   Integrations, verified for the domain) can replace the link later.
   A first payment arrives as payment.success and each renewal as
   subscription.recurring.payment.success (backend features/donations.ts). */
const LAVA_MEMBERSHIP_URL: string | null = "https://app.lava.top/products/603971ba-4480-486a-98da-56ac49111836/93f366c4-0444-4c22-8cab-091697845ba6";
const LAVA_PAGE_URL = "https://app.lava.top/mania-tracker";
const LAVA_FOR_EVERYONE = true;

// lava.top's payment webhook names the buyer by email only (its docs list no
// UTM tags on it), so a signed-in visitor gives the email they will pay with
// first (LavaPay) and the payment links by it. The link still carries their
// osu! id, read if lava.top ever sends it back (backend LAVA_UTM_PREFIX).
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

/* The signed-in way to pay on lava.top: the email they will pay with goes to
   the backend first, then lava.top opens. The tab is opened inside the click
   and pointed at lava.top once the email is saved, so no popup blocker
   stops it. */
function LavaPay({ viewerId }: { viewerId: number }) {
  const { t } = useLingui();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="flex w-full max-w-[360px] flex-col items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!email.trim() || busy) return;
        const tab = window.open("", "_blank");
        setBusy(true);
        setError(null);
        rememberLavaEmail({ data: { email: email.trim() } })
          .then(() => {
            track("support_lava_open");
            const url = lavaUrl(viewerId);
            if (tab) {
              tab.opener = null;
              tab.location.href = url;
            } else {
              window.location.href = url;
            }
          })
          .catch((reason: unknown) => {
            tab?.close();
            setError(reason instanceof Error ? reason.message : String(reason));
          })
          .finally(() => setBusy(false));
      }}
    >
      <label htmlFor="lava-pay-email" className="max-w-[320px] text-[12px] text-osu-f1">{t`lava.top asks for your email when you pay. Type the same one here, so the payment reaches your account.`}</label>
      <input
        id="lava-pay-email"
        type="email"
        autoComplete="email"
        required
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        placeholder={t`Email`}
        maxLength={254}
        className="h-8 w-full rounded-md bg-osu-b5 px-2.5 text-[12.5px] text-white outline-none ring-1 ring-inset ring-white/[0.08] placeholder:text-osu-f1 focus:ring-osu-pink/60"
      />
      <button
        type="submit"
        disabled={busy}
        className="inline-flex cursor-pointer items-center gap-1.5 rounded-full bg-osu-pink px-5 py-2.5 text-[13px] font-semibold text-white transition hover:brightness-110 disabled:cursor-default disabled:opacity-50"
      >
        {t`Pay on lava.top`}
        <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      <p className="text-[11px] text-osu-f1">{t`The email itself is never saved, only a code made from it to match the payment.`}</p>
      {error && <p className="text-[12px] text-osu-red-light">{error}</p>}
    </form>
  );
}

/* A payment that reached no account (lava.top paid outside the button's
   link or signed out, Ko-fi under a name and message that match no osu!
   username); the payer names it here by the email they paid with. */
function PaymentClaim({ provider }: { provider: PaymentClaimProvider }) {
  const { t } = useLingui();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <form
      className="flex w-full max-w-[360px] flex-col gap-1.5 text-left"
      onSubmit={(event) => {
        event.preventDefault();
        if (!email.trim()) return;
        setBusy(true);
        setStatus(null);
        claimPayments({ data: { email: email.trim(), provider } })
          .then(() => {
            setStatus({ ok: true, text: t`Thank you! Your supporter time is on.` });
            setEmail("");
            track(provider === "kofi" ? "support_kofi_claimed" : "support_lava_claimed");
          })
          .catch((error: unknown) => setStatus({ ok: false, text: error instanceof Error ? error.message : String(error) }))
          .finally(() => setBusy(false));
      }}
    >
      <label htmlFor={`${provider}-email`} className="text-[11.5px] text-osu-f1">
        {provider === "kofi" ? t`Paid on Ko-fi and it didn't count? Enter the email you paid with.` : t`Paid on lava.top already? Enter the email you paid with.`}
      </label>
      <div className="flex items-center gap-2">
        <input
          id={`${provider}-email`}
          type="email"
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder={t`Email`}
          maxLength={254}
          className="h-7 min-w-0 flex-1 rounded-md bg-osu-b5 px-2 text-[12px] text-white outline-none ring-1 ring-inset ring-white/[0.08] placeholder:text-osu-f1 focus:ring-osu-pink/60"
        />
        <button
          type="submit"
          disabled={busy || !email.trim()}
          className="h-7 cursor-pointer rounded-md bg-osu-b3 px-3 text-[12px] font-semibold text-white transition hover:bg-osu-b2 disabled:cursor-default disabled:opacity-40"
        >
          {t`Claim`}
        </button>
      </div>
      {status && <p className={`text-[12px] ${status.ok ? "text-osu-l2" : "text-osu-red-light"}`}>{status.text}</p>}
    </form>
  );
}

/* Payment network marks for the method tabs, from Simple Icons (CC0,
   simpleicons.org), each viewBox cropped to its glyph so they line up at one
   height. Drawn in currentColor, so they follow the tab's text colour. */
const PAYMENT_MARKS = {
  paypal: { title: "PayPal", viewBox: "1.8 0 20.4 24", d: "M15.607 4.653H8.941L6.645 19.251H1.82L4.862 0h7.995c3.754 0 6.375 2.294 6.473 5.513-.648-.478-2.105-.86-3.722-.86m6.57 5.546c0 3.41-3.01 6.853-6.958 6.853h-2.493L11.595 24H6.74l1.845-11.538h3.592c4.208 0 7.346-3.634 7.153-6.949a5.24 5.24 0 0 1 2.848 4.686M9.653 5.546h6.408c.907 0 1.942.222 2.363.541-.195 2.741-2.655 5.483-6.441 5.483H8.714Z" },
  visa: { title: "Visa", viewBox: "0 8.1 24 7.9", d: "M9.112 8.262L5.97 15.758H3.92L2.374 9.775c-.094-.368-.175-.503-.461-.658C1.447 8.864.677 8.627 0 8.479l.046-.217h3.3a.904.904 0 01.894.764l.817 4.338 2.018-5.102zm8.033 5.049c.008-1.979-2.736-2.088-2.717-2.972.006-.269.262-.555.822-.628a3.66 3.66 0 011.913.336l.34-1.59a5.207 5.207 0 00-1.814-.333c-1.917 0-3.266 1.02-3.278 2.479-.012 1.079.963 1.68 1.698 2.04.756.367 1.01.603 1.006.931-.005.504-.602.725-1.16.734-.975.015-1.54-.263-1.992-.473l-.351 1.642c.453.208 1.289.39 2.156.398 2.037 0 3.37-1.006 3.377-2.564m5.061 2.447H24l-1.565-7.496h-1.656a.883.883 0 00-.826.55l-2.909 6.946h2.036l.405-1.12h2.488zm-2.163-2.656l1.02-2.815.588 2.815zm-8.16-4.84l-1.603 7.496H8.34l1.605-7.496z" },
  mastercard: { title: "Mastercard", viewBox: "0 4.4 24 15.2", d: "M11.343 18.031c.058.049.12.098.181.146-1.177.783-2.59 1.238-4.107 1.238C3.32 19.416 0 16.096 0 12c0-4.095 3.32-7.416 7.416-7.416 1.518 0 2.931.456 4.105 1.238-.06.051-.12.098-.165.15C9.6 7.489 8.595 9.688 8.595 12c0 2.311 1.001 4.51 2.748 6.031zm5.241-13.447c-1.52 0-2.931.456-4.105 1.238.06.051.12.098.165.15C14.4 7.489 15.405 9.688 15.405 12c0 2.31-1.001 4.507-2.748 6.031-.058.049-.12.098-.181.146 1.177.783 2.588 1.238 4.107 1.238C20.68 19.416 24 16.096 24 12c0-4.094-3.32-7.416-7.416-7.416zM12 6.174c-.096.075-.189.15-.28.231C10.156 7.764 9.169 9.765 9.169 12c0 2.236.987 4.236 2.551 5.595.09.08.185.158.28.232.096-.074.189-.152.28-.232 1.563-1.359 2.551-3.359 2.551-5.595 0-2.235-.987-4.236-2.551-5.595-.09-.08-.184-.156-.28-.231z" },
  googlepay: { title: "Google Pay", viewBox: "0 7.1 24 10.3", d: "M3.963 7.235A3.963 3.963 0 00.422 9.419a3.963 3.963 0 000 3.559 3.963 3.963 0 003.541 2.184c1.07 0 1.97-.352 2.627-.957.748-.69 1.18-1.71 1.18-2.916a4.722 4.722 0 00-.07-.806H3.964v1.526h2.14a1.835 1.835 0 01-.79 1.205c-.356.241-.814.379-1.35.379-1.034 0-1.911-.697-2.225-1.636a2.375 2.375 0 010-1.517c.314-.94 1.191-1.636 2.225-1.636a2.152 2.152 0 011.52.594l1.132-1.13a3.808 3.808 0 00-2.652-1.033zm6.501.55v6.9h.886V11.89h1.465c.603 0 1.11-.196 1.522-.588a1.911 1.911 0 00.635-1.464 1.92 1.92 0 00-.635-1.456 2.125 2.125 0 00-1.522-.598zm2.427.85a1.156 1.156 0 01.823.365 1.176 1.176 0 010 1.686 1.171 1.171 0 01-.877.357H11.35V8.635h1.487a1.156 1.156 0 01.054 0zm4.124 1.175c-.842 0-1.477.308-1.907.925l.781.491c.288-.417.68-.626 1.175-.626a1.255 1.255 0 01.856.323 1.009 1.009 0 01.366.785v.202c-.34-.193-.774-.289-1.3-.289-.617 0-1.11.145-1.479.434-.37.288-.554.677-.554 1.165a1.476 1.476 0 00.525 1.156c.35.308.785.463 1.305.463.61 0 1.098-.27 1.465-.81h.038v.655h.848v-2.909c0-.61-.19-1.09-.568-1.44-.38-.35-.896-.525-1.551-.525zm2.263.154l1.946 4.422-1.098 2.38h.915L24 9.963h-.965l-1.368 3.391h-.02l-1.406-3.39zm-2.146 2.368c.494 0 .88.11 1.156.33 0 .372-.147.696-.44.973a1.413 1.413 0 01-.997.414 1.081 1.081 0 01-.69-.232.708.708 0 01-.293-.578c0-.257.12-.47.363-.647.24-.173.54-.26.9-.26Z" },
} as const;
type PaymentMark = keyof typeof PAYMENT_MARKS;

function PaymentMarks({ marks, label }: { marks: readonly PaymentMark[]; label: string }) {
  return (
    <span role="img" aria-label={label} className="mt-1 flex h-3.5 items-center justify-center gap-2">
      {marks.map((id) => {
        const mark = PAYMENT_MARKS[id];
        const [, , w, h] = mark.viewBox.split(" ").map(Number);
        const height = id === "paypal" || id === "googlepay" ? 14 : id === "mastercard" ? 12 : 10;
        return (
          <svg key={id} viewBox={mark.viewBox} width={(height * w) / h} height={height} fill="currentColor" aria-hidden="true">
            <path d={mark.d} />
          </svg>
        );
      })}
    </span>
  );
}

/* The three ways to pay: Ko-fi (PayPal: the owner's Ko-fi has no card
   processor), Google (Google Pay and the cards saved there) and lava.top
   (cards or PayPal, in rubles, dollars or euros), which also works where
   Ko-fi does not. */
export type SupportMethod = "kofi" | "google" | "lava";

/* Google's checkout, for everyone. It refuses every host but
   mania-tracker.com, so locally it only shows its button. A claim that fails
   on the spot falls back to the order number from Google's receipt, and
   every claim is checked against the Publisher Center export. */
const GOOGLE_FOR_EVERYONE = true;

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
          ? t`Give the email you'll pay with, then pay on lava.top. The payment finds your account by that email, so your supporter time reaches it on its own.`
          : t`Sign in first, then give the email you'll pay with and pay on lava.top, so your supporter time reaches your account.`}
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
  const label: Record<SupportMethod, { name: string; detail: string; marks: readonly PaymentMark[] }> = {
    kofi: { name: "Ko-fi", detail: t`PayPal`, marks: ["paypal"] },
    google: { name: "Google", detail: t`Google Pay`, marks: ["googlepay"] },
    lava: { name: "lava.top", detail: t`Card or PayPal`, marks: ["visa", "mastercard", "paypal"] },
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
              <span className={on ? "text-osu-l2" : "text-osu-f1"}><PaymentMarks marks={label[id].marks} label={label[id].detail} /></span>
            </button>
          );
        })}
      </div>}
      {method === "lava" ? (
        <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
          {viewerId ? (
            <>
              <LavaPay viewerId={viewerId} />
              <PaymentClaim provider="lava" />
            </>
          ) : (
            <>
              <p className="max-w-[300px] text-[12.5px] text-osu-f1">{t`Sign in first so it counts toward your account.`}</p>
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
            </>
          )}
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
        {viewerId && method !== null ? (
          <div className="flex justify-center border-t border-white/[0.07] px-4 py-4">
            <PaymentClaim provider="kofi" />
          </div>
        ) : null}
      </div>
    </div>
  );
}
