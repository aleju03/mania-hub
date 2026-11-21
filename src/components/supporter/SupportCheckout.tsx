import { useCallback, useEffect, useRef, useState } from "react";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { ExternalLink } from "lucide-react";

import { useAuth } from "../../lib/auth-context";
import { track } from "../../lib/analytics";
import { readEdgeCountry } from "../../lib/country-cookie";
import { GOOGLE_RRM_PUBLICATION_ID, startGoogleContributions } from "../../lib/google-contributions";
import {
  checkLavaPayment,
  claimGoogleContribution,
  claimPayments,
  createLavaCheckout,
  checkWalletTransfer,
  claimWalletTransfer,
  openWalletTransfer,
  readCryptoOptions,
  type WalletNetwork,
  type WalletTransfer,
  PACK_MONTHS,
  type PackMonths,
  LAVA_CHECKOUT_CURRENCIES,
  LAVA_CHECKOUT_MONTHS,
  readPatreonConnection,
  rememberLavaEmail,
  type LavaCheckoutCurrency,
  type LavaCheckoutMonths,
  type PaymentClaimProvider,
} from "../../lib/supporter-look-settings";
import { rememberViewerSupporter } from "../../lib/viewer-supporter";
import { useNearView } from "./SupportMotion";
import { useShowcaseViewer } from "./SupportShowcase";
import { KofiNameSteps } from "./KofiNameSteps";
import { requestSupporterWelcome } from "./SupporterWelcome";

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
/* Patreon's Supporter tier ($4 a month). A payment counts once the payer has
   connected their Patreon here (backend features/patreon.ts). */
const PATREON_JOIN_URL = "https://www.patreon.com/c/maniatracker/membership";
const PATREON_FOR_EVERYONE = true;
/* Crypto: USDT sent straight to the owner's wallet (backend
   features/crypto-wallet.ts). Admins only until it is set up; then only
   where CRYPTO_SUPPORT_COUNTRIES says. */
const CRYPTO_FOR_EVERYONE = false;
/* What each crypto pack length costs, in dollars: $4 a month, $40 a year. */
const PACK_PRICE_USD: Record<PackMonths, number> = { 1: 4, 3: 12, 6: 24, 12: 40 };
/* Signed-in buyers pay on an invoice the site makes through lava.top's API
   (LavaApiPay) instead of the public page above, whose payments never reach
   the site. Admins only while this is false; once true, a signed-out visitor
   is asked to sign in rather than given the public link. */
const LAVA_API_CHECKOUT_FOR_EVERYONE = true;

/* The Supporter offer's price for each length, in each currency lava.top
   takes. Shown only: lava.top charges its own listed price, so these follow
   any change made there. */
const LAVA_PRICES: Record<LavaCheckoutCurrency, Record<LavaCheckoutMonths, number>> = {
  RUB: { 1: 330, 3: 990, 6: 1980, 12: 3300 },
  USD: { 1: 4.03, 3: 12.08, 6: 24.16, 12: 40.26 },
  EUR: { 1: 3.66, 3: 10.99, 6: 21.98, 12: 36.63 },
};

function lavaPrice(currency: LavaCheckoutCurrency, months: LavaCheckoutMonths): string {
  const value = LAVA_PRICES[currency][months];
  const whole = Number.isInteger(value);
  return new Intl.NumberFormat("en-US", { style: "currency", currency, currencyDisplay: "narrowSymbol", minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 }).format(value);
}

// lava.top's payment webhook names the buyer by email and passes back the
// invoice's `clientUtm`. Invoices made through the API (LavaApiPay) carry the
// osu! id there as utm_content (backend LAVA_UTM_PREFIX), so their payments
// link by it. Payments on the public page have not been seen to reach the
// webhook or the API at all; the old flow (LavaPay) still records the email
// the visitor will pay with first, and its link carries the same UTM tags.
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

// Countries where crypto is offered: where Ko-fi's PayPal can't take a
// payment (lava.top's list above, and others PayPal does not serve) and
// mainland China, where PayPal is rare and Alipay and WeChat Pay can't be
// taken. Everywhere else the card and PayPal routes cover it, so the tab
// stays out of the way. Admins see it everywhere.
const CRYPTO_SUPPORT_COUNTRIES = new Set([...LAVA_SUPPORT_COUNTRIES, "CN", "PK", "BD", "AF", "IQ", "LB", "LY", "SD", "MM"]);

/* The visitor's country, read after load like getSupportUsesLava: whether
   lava.top comes first and whether crypto is offered. */
const getSupportRegion = createServerFn({ method: "GET" }).handler((): { lavaFirst: boolean; crypto: boolean } => {
  const country = readEdgeCountry(getRequest().headers);
  return { lavaFirst: country != null && LAVA_SUPPORT_COUNTRIES.has(country), crypto: country != null && CRYPTO_SUPPORT_COUNTRIES.has(country) };
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
        {/* Google draws its own button in here; the click still bubbles. */}
        <span onClickCapture={() => track("support_google_checkout")}>
          <button type="button" {...{ "swg-standard-button": "contribution" }} />
        </span>
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

const LAVA_CHECK_EVERY_MS = 20_000;
const LAVA_CHECK_FOR_MS = 5 * 60_000;

export type LavaCheckStatus = "idle" | "waiting" | "paid" | "missing";

/* When the viewer's last lava.top checkout started (createLavaCheckout's
   startedAt), kept for the tab lava.top sends them back to. */
const LAVA_CHECKOUT_STARTED_KEY = "lava-checkout-started";
const LAVA_CHECKOUT_STARTED_TTL_MS = 24 * 60 * 60_000;

function rememberLavaCheckoutStart(startedAt: number) {
  try {
    window.localStorage.setItem(LAVA_CHECKOUT_STARTED_KEY, String(startedAt));
  } catch {
    // no storage: the return page falls back to the last half hour
  }
}

export function readLavaCheckoutStart(): number | null {
  try {
    const at = Number(window.localStorage.getItem(LAVA_CHECKOUT_STARTED_KEY));
    return Number.isFinite(at) && at > Date.now() - LAVA_CHECKOUT_STARTED_TTL_MS ? at : null;
  } catch {
    return null;
  }
}

/* Asks the backend whether the viewer's lava.top payment has arrived (it
   looks at lava.top's invoices when asked), every 20 seconds for up to 5
   minutes while the tab is in view, and stops once a payment made since
   `since` is there. start("on-return") waits for the tab to come back into
   view first, as after the payment tab opens; start("now") asks straight
   away. The 5 minutes count from the first ask. */
export function useLavaPaymentCheck(viewerId: number | null | undefined, onPaid?: () => void): { status: LavaCheckStatus; start: (when: "now" | "on-return", since: number | null) => void } {
  const [status, setStatus] = useState<LavaCheckStatus>("idle");
  const control = useRef<((when: "now" | "on-return", since: number | null) => void) | null>(null);
  const onPaidRef = useRef(onPaid);
  onPaidRef.current = onPaid;

  useEffect(() => {
    if (!viewerId) return;
    let alive = true;
    let armed = false;
    let asking = false;
    let deadline: number | null = null;
    let since: number | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const clearTimer = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    const giveUp = () => {
      armed = false;
      clearTimer();
      setStatus("missing");
    };
    const ask = () => {
      clearTimer();
      if (!alive || !armed || asking || document.visibilityState !== "visible") return;
      if (deadline === null) deadline = Date.now() + LAVA_CHECK_FOR_MS;
      else if (Date.now() >= deadline) return giveUp();
      asking = true;
      checkLavaPayment({ data: since == null ? {} : { since } })
        .then((result) => result.paid ? result : null)
        .catch(() => null)
        .then((paid) => {
          asking = false;
          if (!alive || !armed) return;
          if (paid) {
            armed = false;
            setStatus("paid");
            rememberViewerSupporter(viewerId, paid.expiresAt);
            requestSupporterWelcome();
            onPaidRef.current?.();
            return;
          }
          if (Date.now() + LAVA_CHECK_EVERY_MS > (deadline ?? 0)) return giveUp();
          timer = setTimeout(ask, LAVA_CHECK_EVERY_MS);
        });
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") ask();
      else clearTimer();
    };
    document.addEventListener("visibilitychange", onVisibility);
    control.current = (when, from) => {
      clearTimer();
      armed = true;
      deadline = null;
      since = from;
      setStatus("waiting");
      if (when === "now") ask();
    };
    return () => {
      alive = false;
      armed = false;
      clearTimer();
      control.current = null;
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [viewerId]);

  const start = useCallback((when: "now" | "on-return", since: number | null) => control.current?.(when, since), []);
  return { status, start };
}

/* The check's one line, once the payment is there. Looking for it and not
   finding it say nothing: someone who closed lava.top without paying is
   not told about a payment they never made. */
export function LavaCheckLine({ status, className = "text-[12px]" }: { status: LavaCheckStatus; className?: string }) {
  const { t } = useLingui();
  if (status !== "paid") return null;
  return <p role="status" className={`${className} text-osu-l2`}>{t`Thank you! Your supporter time is on.`}</p>;
}

/* The signed-in way to pay on lava.top once LAVA_API_CHECKOUT_FOR_EVERYONE
   (admins before then): a length and a currency, and the email lava.top
   sends the receipt to. The backend makes an invoice through lava.top's API
   with the viewer's osu! id on it, and the tab opened inside the click goes
   to its payment page. Back on this tab, the payment is looked for. */
function LavaApiPay({ viewerId }: { viewerId: number }) {
  const { t } = useLingui();
  const [months, setMonths] = useState<LavaCheckoutMonths>(1);
  const [picked, setPicked] = useState<LavaCheckoutCurrency | null>(null);
  const [rubles, setRubles] = useState(false);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const check = useLavaPaymentCheck(viewerId);
  useEffect(() => {
    let cancelled = false;
    getSupportUsesLava()
      .then((value) => !cancelled && setRubles(value))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  const currency: LavaCheckoutCurrency = picked ?? (rubles ? "RUB" : "USD");
  const price = lavaPrice(currency, months);
  /* Every length is a lava.top membership: it charges again after that long. */
  const renews = months === 12
    ? t`Renews every year until you cancel it on lava.top.`
    : t`${plural(months, { one: "Renews every month until you cancel it on lava.top.", other: "Renews every # months until you cancel it on lava.top." })}`;
  return (
    <form
      className="flex w-full flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        if (!email.trim() || busy) return;
        const tab = window.open("", "_blank");
        setBusy(true);
        setError(null);
        createLavaCheckout({ data: { email: email.trim(), months, currency } })
          .then(({ paymentUrl, startedAt }) => {
            track("support_lava_open");
            rememberLavaCheckoutStart(startedAt);
            if (tab) {
              tab.opener = null;
              tab.location.href = paymentUrl;
              check.start("on-return", startedAt);
            } else {
              window.location.href = paymentUrl;
            }
          })
          .catch((reason: unknown) => {
            tab?.close();
            setError(reason instanceof Error ? reason.message : String(reason));
          })
          .finally(() => setBusy(false));
      }}
    >
      <div className="flex items-center justify-between pb-2.5">
        <div className="text-[18px] font-bold text-white">{t`Supporter`}</div>
        <div role="radiogroup" aria-label={t`Currency`} className="flex gap-0.5 rounded-lg bg-osu-b5 p-0.5">
          {LAVA_CHECKOUT_CURRENCIES.map((value) => {
            const on = value === currency;
            return (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => setPicked(value)}
                className={`h-7 cursor-pointer rounded-md px-2.5 text-[12px] font-semibold transition-colors ${on ? "bg-osu-b2 text-white" : "text-osu-f1 hover:text-white"}`}
              >
                {value}
              </button>
            );
          })}
        </div>
      </div>
      <LengthRows lengths={LAVA_CHECKOUT_MONTHS} picked={months} onPick={setMonths} price={(value) => lavaPrice(currency, value)} />
      <div className="flex flex-col gap-3 border-t border-white/[0.07] pt-4">
        <input
          id="lava-pay-email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          aria-label={t`Email for the lava.top receipt`}
          placeholder={t`Email for the lava.top receipt`}
          maxLength={254}
          className="h-10 w-full rounded-lg bg-osu-b5 px-3 text-[13px] text-white outline-none ring-1 ring-inset ring-white/[0.08] placeholder:text-osu-f1 focus:ring-osu-pink/60"
        />
        <button
          type="submit"
          disabled={busy}
          className="inline-flex w-full cursor-pointer items-center justify-center gap-1.5 rounded-full bg-osu-pink px-5 py-3 text-[14px] font-semibold text-white transition hover:brightness-110 disabled:cursor-default disabled:opacity-50"
        >
          {t`Pay ${price} on lava.top`}
          <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
        <p className="text-center text-[12px] text-osu-f1">{renews}</p>
        <LavaCheckLine status={check.status} className="text-center text-[12px]" />
        {error && <p className="text-center text-[12px] text-osu-red-light">{error}</p>}
      </div>
    </form>
  );
}

/* A payment that reached no account (lava.top paid outside the button's
   link or signed out, Ko-fi under a name and message that match no osu!
   username); the payer names it here by the email they paid with. */
/* The lengths to pick from, one row each with its price: the lava.top,
   crypto panels. A year is ten months' price. */
function LengthRows<M extends number>({ lengths, picked, onPick, price }: { lengths: readonly M[]; picked: M; onPick: (months: M) => void; price: (months: M) => string }) {
  const { t } = useLingui();
  const lengthLabel = (value: number) => (value === 12 ? t`1 year` : t`${plural(value, { one: "# month", other: "# months" })}`);
  return (
    <div role="radiogroup" aria-label={t`Length`}>
      {lengths.map((value) => {
        const on = value === picked;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onPick(value)}
            className={`flex w-full cursor-pointer items-center gap-3 border-t border-white/[0.07] px-0.5 py-3 text-left transition-colors ${on ? "text-white" : "text-osu-l2 hover:text-white"}`}
          >
            <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full ring-2 ring-inset ${on ? "ring-osu-pink" : "ring-white/25"}`}>
              {on ? <span className="h-2 w-2 rounded-full bg-osu-pink" /> : null}
            </span>
            <span className={`text-[15px] ${on ? "font-bold" : "font-medium"}`}>{lengthLabel(value)}</span>
            {value === 12 ? <span className="text-[11.5px] font-semibold text-osu-pink">{t`2 months free`}</span> : null}
            <span className="ml-auto text-[16px] font-bold tabular-nums">{price(value)}</span>
          </button>
        );
      })}
    </div>
  );
}

/* Crypto: USDT sent straight to the owner's wallet (backend
   features/crypto-wallet.ts). The buyer picks a length and a network and
   gets the address and an exact amount whose odd decimals are theirs alone.
   While it is open the panel asks every 20 seconds whether it has been paid
   (the backend looks at the wallet's incoming USDT), and switches to the
   thank-you on its own; pasting the transaction id is the fallback. The open
   transfer is kept in the browser for its 24 hours, so a buyer who leaves to
   pay from a phone finds it again. One-off packs only. */
const WALLET_TRANSFER_KEY = "mania-wallet-transfer";
const WALLET_NETWORK_LABEL: Record<WalletNetwork, string> = { tron: "TRON (TRC-20)", bsc: "BNB Chain (BEP-20)", polygon: "Polygon" };
const WALLET_NETWORK_NAME: Record<WalletNetwork, string> = { tron: "TRON", bsc: "BNB Chain", polygon: "Polygon" };
const WALLET_NETWORK_STANDARD: Record<WalletNetwork, string> = { tron: "TRC-20", bsc: "BEP-20", polygon: "PoS" };
/* Each network's mark: BNB Chain and Polygon from Simple Icons, TRON from
   cryptocurrency-icons (both CC0), viewBoxes cropped to the glyph. */
const WALLET_NETWORK_MARK: Record<WalletNetwork, { viewBox: string; d: string }> = {
  tron: { viewBox: "0 0 18.18 19.13", d: "M14.432 2.663L0 .007 7.595 19.12 18.178 6.225l-3.746-3.562zm-.232 1.17l2.208 2.099-6.038 1.093 3.83-3.192zM9.058 6.806L2.694 1.528l10.402 1.914-4.038 3.364zm-.453.934l-1.038 8.58L1.972 2.237 8.605 7.74zm.96.455l6.687-1.21-7.67 9.343.983-8.133z" },
  bsc: { viewBox: "1.6 0 20.7 24", d: "M5.631 3.676 12.001 0l6.367 3.676-2.34 1.358L12 2.716 7.972 5.034l-2.34-1.358Zm12.737 4.636-2.34-1.358L12 9.272 7.972 6.954l-2.34 1.358v2.716l4.026 2.318v4.636L12 19.341l2.341-1.359v-4.636l4.027-2.318V8.312Zm0 7.352v-2.716l-2.34 1.358v2.716l2.34-1.358Zm1.663.96-4.027 2.318v2.717l6.368-3.677V10.63l-2.34 1.358v4.636Zm-2.34-10.63 2.34 1.358v2.716l2.341-1.358V5.994l-2.34-1.358-2.342 1.358ZM9.657 19.926v2.716L12 24l2.341-1.358v-2.716l-2.34 1.358-2.343-1.358Zm-4.027-4.262 2.341 1.358v-2.716l-2.34-1.358v2.716Zm4.027-9.67L12 7.352l2.341-1.358-2.34-1.358-2.343 1.358Zm-5.69 1.358L6.31 5.994 3.968 4.636l-2.34 1.358V8.71l2.34 1.358V7.352Zm0 4.636-2.34-1.358v7.352l6.368 3.677v-2.717l-4.028-2.318v-4.636Z" },
  polygon: { viewBox: "0 1.4 24 21.3", d: "m17.82 16.342 5.692-3.287A.98.98 0 0 0 24 12.21V5.635a.98.98 0 0 0-.488-.846l-5.693-3.286a.98.98 0 0 0-.977 0L11.15 4.789a.98.98 0 0 0-.489.846v11.747L6.67 19.686l-3.992-2.304v-4.61l3.992-2.304 2.633 1.52V8.896L7.158 7.658a.98.98 0 0 0-.977 0L.488 10.945a.98.98 0 0 0-.488.846v6.573a.98.98 0 0 0 .488.847l5.693 3.286a.981.981 0 0 0 .977 0l5.692-3.286a.98.98 0 0 0 .489-.846V6.618l.072-.041 3.92-2.263 3.99 2.305v4.609l-3.99 2.304-2.63-1.517v3.092l2.14 1.236a.981.981 0 0 0 .978 0v-.001Z" },
};

function readStoredTransfer(): WalletTransfer | null {
  try {
    const raw = JSON.parse(window.localStorage.getItem(WALLET_TRANSFER_KEY) ?? "null") as WalletTransfer | null;
    return raw && typeof raw.address === "string" && typeof raw.amount === "string" && raw.expiresAt > Date.now() ? raw : null;
  } catch {
    return null;
  }
}

const WALLET_POLL_MS = 20_000;

function CryptoPay({ viewerId }: { viewerId: number | null | undefined }) {
  const { t } = useLingui();
  const [networks, setNetworks] = useState<WalletNetwork[] | null>(null);
  const [months, setMonths] = useState<PackMonths>(1);
  const [network, setNetwork] = useState<WalletNetwork | null>(null);
  const [transfer, setTransfer] = useState<WalletTransfer | null>(null);
  const [txHash, setTxHash] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  useEffect(() => {
    let cancelled = false;
    readCryptoOptions()
      .then((value) => {
        if (cancelled) return;
        setNetworks(value.networks);
        const stored = readStoredTransfer();
        if (stored && value.networks.includes(stored.network)) {
          setTransfer(stored);
          setMonths(stored.months);
          setNetwork(stored.network);
        } else {
          setNetwork(value.networks[0] ?? null);
        }
      })
      .catch(() => !cancelled && setNetworks([]));
    return () => {
      cancelled = true;
    };
  }, []);
  // Asks whether the open transfer is paid, every 20 seconds while the tab
  // is in front, and once more as soon as it comes back to the front.
  useEffect(() => {
    if (!transfer || done) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const ask = () => {
      if (cancelled || document.visibilityState !== "visible") return;
      checkWalletTransfer({ data: { id: transfer.id } })
        .then(({ paid }) => {
          if (cancelled || !paid) return;
          track("support_wallet_paid");
          window.localStorage.removeItem(WALLET_TRANSFER_KEY);
          setDone(true);
          requestSupporterWelcome();
        })
        .catch(() => undefined);
    };
    const loop = () => {
      ask();
      timer = setTimeout(loop, WALLET_POLL_MS);
    };
    timer = setTimeout(loop, WALLET_POLL_MS);
    const onVisible = () => document.visibilityState === "visible" && ask();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [transfer, done]);
  const pill = "inline-flex items-center justify-center gap-1.5 rounded-full px-5 text-white transition hover:brightness-110";
  if (!viewerId) {
    return (
      <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
        <p className="max-w-[300px] text-[12.5px] text-osu-f1">{t`Sign in first so it counts toward your account.`}</p>
        <a href={`/api/auth/osu?next=${encodeURIComponent("/support#checkout")}`} className={`${pill} bg-osu-pink py-2.5 text-[13px] font-semibold`}>
          {t`Log in with osu!`}
        </a>
      </div>
    );
  }
  if (!networks) return <div className="h-[360px]" />;
  if (!networks.length) {
    return <p className="px-5 py-10 text-center text-[12.5px] text-osu-f1">{t`Crypto payments aren't set up yet.`}</p>;
  }
  const errorText = (code: string): string => ({
    invalid_tier: t`Pick a length.`,
    invalid_tx: t`That isn't a transaction id. Copy it from your wallet or the block explorer.`,
    no_transfer: t`Get an address first, then send to it.`,
    not_found: t`That transaction wasn't found. Check it's on the network you picked.`,
    not_confirmed: t`That transaction isn't confirmed yet. Try again in a minute.`,
    no_match: t`That transaction didn't send the exact amount to this address.`,
    already_claimed: t`That transaction was already used.`,
    rate_limited: t`That's a lot of tries today; try again tomorrow.`,
    signin: t`Sign in first so it counts toward your account.`,
  })[code] ?? t`Crypto payments aren't available right now; try again later.`;
  const forget = () => {
    window.localStorage.removeItem(WALLET_TRANSFER_KEY);
    setTransfer(null);
    setTxHash("");
    setError(null);
  };
  const getAddress = () => {
    if (!network) return;
    setBusy(true);
    setError(null);
    openWalletTransfer({ data: { months, network } })
      .then((value) => {
        track("support_wallet_open");
        window.localStorage.setItem(WALLET_TRANSFER_KEY, JSON.stringify(value));
        setTransfer(value);
      })
      .catch((reason: unknown) => setError(errorText(reason instanceof Error ? reason.message : "")))
      .finally(() => setBusy(false));
  };
  const check = () => {
    if (!txHash.trim()) return;
    setBusy(true);
    setError(null);
    claimWalletTransfer({ data: { txHash: txHash.trim() } })
      .then(() => {
        track("support_wallet_claimed");
        window.localStorage.removeItem(WALLET_TRANSFER_KEY);
        setDone(true);
        requestSupporterWelcome();
      })
      .catch((reason: unknown) => setError(errorText(reason instanceof Error ? reason.message : "")))
      .finally(() => setBusy(false));
  };

  return (
    <div className="flex flex-col px-5 pb-6 pt-5">
      <div className="pb-2.5 text-[18px] font-bold text-white">{t`Supporter`}</div>
      {done ? (
        <p role="status" className="border-t border-white/[0.07] py-6 text-center text-[13px] text-osu-l2">{t`Thank you! Your supporter time is on.`}</p>
      ) : transfer ? (
        <div className="flex flex-col gap-3 border-t border-white/[0.07] pt-4">
          <CopyRow label={t`Send exactly`} value={`${transfer.amount} USDT`} copy={transfer.amount} big />
          <div className="-mt-2 text-[12px] text-osu-l2">{t`on ${WALLET_NETWORK_LABEL[transfer.network]}`}</div>
          <CopyRow label={t`To`} value={transfer.address} copy={transfer.address} mono />
          <p className="text-[12px] leading-relaxed text-osu-f1">
            {t`Only USDT, only on this network, and exactly this amount: the odd decimals tell your payment apart. Sending from an exchange like Binance? Its withdraw page shows a "Receive amount"; make that exactly this amount. Open for 24 hours.`}
          </p>
          <p role="status" className="flex items-center gap-2 text-[12.5px] text-osu-l2">
            <span className="relative flex h-2 w-2 shrink-0">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-osu-pink opacity-60 motion-reduce:hidden" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-osu-pink" />
            </span>
            {t`Waiting for your payment. This updates by itself once it's confirmed.`}
          </p>
          <div className="border-t border-white/[0.07] pt-3">
            <div className="mb-1.5 text-[11px] text-osu-f1">{t`Paid and it hasn't shown up? Paste the transaction id.`}</div>
            <div className="flex items-center gap-2">
              <input
                value={txHash}
                onChange={(event) => setTxHash(event.target.value)}
                placeholder={t`Transaction id`}
                aria-label={t`Transaction id`}
                spellCheck={false}
                className="h-9 min-w-0 flex-1 rounded-lg bg-osu-b5 px-3 font-mono text-[12px] text-white outline-none ring-1 ring-inset ring-white/[0.08] placeholder:font-sans placeholder:text-osu-f1 focus:ring-osu-pink/60"
              />
              <button type="button" disabled={busy || !txHash.trim()} onClick={check} className={`${pill} h-9 cursor-pointer bg-osu-b3 text-[13px] font-semibold hover:bg-osu-b2 disabled:cursor-default disabled:opacity-50`}>
                {t`Check`}
              </button>
            </div>
          </div>
          <button type="button" onClick={forget} className="cursor-pointer self-center text-[12px] text-osu-f1 transition-colors hover:text-white">
            {t`Start over`}
          </button>
        </div>
      ) : (
        <>
          <LengthRows lengths={PACK_MONTHS} picked={months} onPick={setMonths} price={(value) => `$${PACK_PRICE_USD[value]}`} />
          <div className="border-t border-white/[0.07] pt-3">
            <div className="mb-1.5 text-[11px] text-osu-f1">{t`Network`}</div>
            <div role="radiogroup" aria-label={t`Network`} className={`grid gap-0.5 rounded-lg bg-osu-b5 p-0.5 ${networks.length === 3 ? "grid-cols-3" : networks.length === 2 ? "grid-cols-2" : "grid-cols-1"}`}>
              {networks.map((value) => {
                const on = network === value;
                return (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => setNetwork(value)}
                    className={`cursor-pointer rounded-md px-2 py-1.5 text-center transition-colors ${on ? "bg-osu-b2 text-white" : "text-osu-l2 hover:text-white"}`}
                  >
                    <span className="flex items-center justify-center gap-1.5 text-[13px] font-bold">
                      <svg viewBox={WALLET_NETWORK_MARK[value].viewBox} className="h-3.5 w-3.5 shrink-0" fill="currentColor" aria-hidden="true">
                        <path d={WALLET_NETWORK_MARK[value].d} />
                      </svg>
                      {WALLET_NETWORK_NAME[value]}
                    </span>
                    <span className={`block text-[11px] ${on ? "text-osu-l2" : "text-osu-f1"}`}>{WALLET_NETWORK_STANDARD[value]}</span>
                  </button>
                );
              })}
            </div>
          </div>
          <div className="flex flex-col gap-3 border-t border-white/[0.07] pt-4">
            <button type="button" disabled={busy || !network} onClick={getAddress} className={`${pill} w-full cursor-pointer bg-osu-pink py-3 text-[14px] font-semibold disabled:cursor-default disabled:opacity-50`}>
              {t`Get the address`}
            </button>
            <p className="text-center text-[12px] text-osu-f1">{t`Paid once, it doesn't renew. Send USDT from your own wallet; this page sees it arrive.`}</p>
          </div>
        </>
      )}
      {error ? <p className="mt-2 text-center text-[12px] text-osu-red-light">{error}</p> : null}
    </div>
  );
}

/* A value to copy: the amount or the address. */
function CopyRow({ label, value, copy, big = false, mono = false }: { label: string; value: string; copy: string; big?: boolean; mono?: boolean }) {
  const { t } = useLingui();
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <div className="text-[11px] text-osu-f1">{label}</div>
      <div className="mt-0.5 flex items-center gap-2">
        <span className={`min-w-0 flex-1 break-all text-white ${big ? "text-[22px] font-bold tabular-nums" : "text-[13px]"} ${mono ? "font-mono" : ""}`}>{value}</span>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(copy).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
          className="h-7 shrink-0 cursor-pointer rounded-md bg-osu-b3 px-2.5 text-[12px] font-semibold text-white transition hover:bg-osu-b2"
        >
          {copied ? t`Copied` : t`Copy`}
        </button>
      </div>
    </div>
  );
}

function PaymentClaim({ provider, wide = false }: { provider: PaymentClaimProvider; wide?: boolean }) {
  const { t } = useLingui();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <form
      className={`flex w-full flex-col gap-1.5 text-left ${wide ? "" : "max-w-[360px]"}`}
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
  applepay: { title: "Apple Pay", viewBox: "0 4.3 24 15.4", d: "M2.15 4.318a42.16 42.16 0 0 0-.454.003c-.15.005-.303.013-.452.04a1.44 1.44 0 0 0-1.06.772c-.07.138-.114.278-.14.43-.028.148-.037.3-.04.45A10.2 10.2 0 0 0 0 6.222v11.557c0 .07.002.138.003.207.004.15.013.303.04.452.027.15.072.291.142.429a1.436 1.436 0 0 0 .63.63c.138.07.278.115.43.142.148.027.3.036.45.04l.208.003h20.194l.207-.003c.15-.004.303-.013.452-.04.15-.027.291-.071.428-.141a1.432 1.432 0 0 0 .631-.631c.07-.138.115-.278.141-.43.027-.148.036-.3.04-.45.002-.07.003-.138.003-.208l.001-.246V6.221c0-.07-.002-.138-.004-.207a2.995 2.995 0 0 0-.04-.452 1.446 1.446 0 0 0-1.2-1.201 3.022 3.022 0 0 0-.452-.04 10.448 10.448 0 0 0-.453-.003zm0 .512h19.942c.066 0 .131.002.197.003.115.004.25.01.375.032.109.02.2.05.287.094a.927.927 0 0 1 .407.407.997.997 0 0 1 .094.288c.022.123.028.258.031.374.002.065.003.13.003.197v11.552c0 .065 0 .13-.003.196-.003.115-.009.25-.032.375a.927.927 0 0 1-.5.693 1.002 1.002 0 0 1-.286.094 2.598 2.598 0 0 1-.373.032l-.2.003H1.906c-.066 0-.133-.002-.196-.003a2.61 2.61 0 0 1-.375-.032c-.109-.02-.2-.05-.288-.094a.918.918 0 0 1-.406-.407 1.006 1.006 0 0 1-.094-.288 2.531 2.531 0 0 1-.032-.373 9.588 9.588 0 0 1-.002-.197V6.224c0-.065 0-.131.002-.197.004-.114.01-.248.032-.375.02-.108.05-.199.094-.287a.925.925 0 0 1 .407-.406 1.03 1.03 0 0 1 .287-.094c.125-.022.26-.029.375-.032.065-.002.131-.002.196-.003zm4.71 3.7c-.3.016-.668.199-.88.456-.191.22-.36.58-.316.918.338.03.675-.169.888-.418.205-.258.345-.603.308-.955zm2.207.42v5.493h.852v-1.877h1.18c1.078 0 1.835-.739 1.835-1.812 0-1.07-.742-1.805-1.808-1.805zm.852.719h.982c.739 0 1.161.396 1.161 1.089 0 .692-.422 1.092-1.164 1.092h-.979zm-3.154.3c-.45.01-.83.28-1.05.28-.235 0-.593-.264-.981-.257a1.446 1.446 0 0 0-1.23.747c-.527.908-.139 2.255.374 2.995.249.366.549.769.944.754.373-.014.52-.242.973-.242.454 0 .586.242.98.235.41-.007.667-.366.915-.733.286-.417.403-.82.41-.841-.007-.008-.79-.308-.797-1.209-.008-.754.615-1.113.644-1.135-.352-.52-.9-.578-1.09-.593a1.123 1.123 0 0 0-.092-.002zm8.204.397c-.99 0-1.606.533-1.652 1.256h.777c.072-.358.369-.586.845-.586.502 0 .803.266.803.711v.309l-1.097.064c-.951.054-1.488.484-1.488 1.184 0 .72.548 1.207 1.332 1.207.526 0 1.032-.281 1.264-.727h.019v.659h.788v-2.76c0-.803-.62-1.317-1.591-1.317zm1.94.072l1.446 4.009c0 .003-.073.24-.073.247-.125.41-.33.571-.711.571-.069 0-.206 0-.267-.015v.666c.06.011.267.019.335.019.83 0 1.226-.312 1.568-1.283l1.5-4.214h-.868l-1.012 3.259h-.015l-1.013-3.26zm-1.167 2.189v.316c0 .521-.45.917-1.024.917-.442 0-.731-.228-.731-.579 0-.342.278-.56.769-.593z" },
  venmo: { title: "Venmo", viewBox: "0 9.7 24 4.5", d: "M21.772 13.119c-.267 0-.381-.251-.38-.655 0-.533.121-1.575.712-1.575.267 0 .357.243.357.598 0 .533-.13 1.632-.689 1.632Zm.502-3.377c-1.677 0-2.405 1.285-2.405 2.658 0 1.042.421 1.874 1.693 1.874 1.717 0 2.438-1.406 2.438-2.763 0-1.025-.462-1.769-1.726-1.769Zm-3.833 0c-.558 0-.964.17-1.393.477-.154-.275-.462-.477-.932-.477-.542 0-.947.219-1.247.437l-.04-.364H13.54l-.688 4.354h1.506l.479-3.053c.129-.065.323-.154.518-.154.145 0 .267.049.267.267 0 .056-.016.145-.024.218l-.429 2.722h1.498l.478-3.053c.138-.073.324-.154.51-.154.146 0 .268.049.268.267 0 .056-.017.145-.025.218l-.429 2.722h1.499l.461-2.908c.025-.153.049-.388.049-.549 0-.582-.267-.97-1.037-.97Zm-6.871 0c-.575 0-.98.219-1.287.421l-.017-.348H8.962l-.689 4.354H9.78l.478-3.053c.13-.065.324-.154.518-.154.147 0 .268.049.268.242 0 .081-.024.227-.032.299l-.422 2.666h1.499l.462-2.908c.024-.153.049-.388.049-.549 0-.582-.268-.97-1.03-.97Zm-5.631 1.834c.041-.485.413-.824.697-.824.162 0 .299.097.299.291 0 .404-.713.533-.996.533Zm.843-1.834c-1.604 0-2.382 1.39-2.382 2.698 0 1.01.478 1.817 1.814 1.817.527 0 1.07-.113 1.418-.282l.186-1.26c-.494.25-.874.347-1.271.347-.365 0-.64-.194-.64-.687.826-.008 2.252-.347 2.252-1.453 0-.687-.494-1.18-1.377-1.18Zm-4.239.267c.089.186.146.412.146.743 0 .606-.429 1.494-.777 2.06l-.373-2.989L0 9.969l.705 4.2h1.757c.77-1.01 1.718-2.448 1.718-3.554 0-.347-.073-.622-.235-.889l-1.402.283Z" },
  discover: { title: "Discover", viewBox: "0 10 24 4", d: "M14.58 12a2.023 2.023 0 1 1-2.025-2.023h.002c1.118 0 2.023.906 2.023 2.023zm-5.2-2.001c-1.124 0-2.025.884-2.025 1.99 0 1.118.878 1.984 2.007 1.984.319 0 .593-.063.93-.221v-.873c-.296.297-.559.416-.895.416-.747 0-1.277-.542-1.277-1.312 0-.73.547-1.306 1.243-1.306.354 0 .622.126.93.428v-.873a1.898 1.898 0 0 0-.913-.233zm-3.352 1.545c-.445-.165-.576-.273-.576-.479 0-.239.233-.422.553-.422.222 0 .405.091.598.308l.388-.508a1.665 1.665 0 0 0-1.117-.422c-.673 0-1.186.467-1.186 1.089 0 .524.239.792.936 1.043.291.103.438.171.513.217a.456.456 0 0 1 .222.394c0 .308-.245.536-.576.536-.354 0-.639-.177-.809-.507l-.479.461c.342.502.752.724 1.317.724.771 0 1.311-.513 1.311-1.249-.002-.603-.252-.876-1.095-1.185zM24 10.3a.29.29 0 0 1-.288.291.29.29 0 0 1-.291-.291v-.003A.29.29 0 1 1 24 10.3zm-.059.001a.235.235 0 0 0-.231-.239.234.234 0 0 0-.232.239c0 .132.104.239.232.239a.235.235 0 0 0 .231-.239zM3.472 13.887h.742v-3.803h-.742v3.803zm12.702-1.248l-1.014-2.554h-.81l1.614 3.9h.399l1.643-3.9h-.804l-1.028 2.554zm2.166 1.248h2.104v-.644h-1.362v-1.027h1.312v-.644h-1.312v-.844h1.362v-.644H18.34v3.803zm5.409-3.557l.11.138h-.097l-.094-.13v.13h-.08v-.334h.107c.081 0 .126.036.126.103.001.046-.025.08-.072.093zm-.006-.092c0-.029-.021-.043-.06-.043h-.014v.087h.014c.039 0 .06-.014.06-.044zm-1.228 2.047l1.197 1.602H22.8l-1.027-1.528h-.097v1.528h-.741v-3.803h1.1c.855 0 1.346.411 1.346 1.123 0 .583-.308.965-.866 1.078zm.103-1.038c0-.37-.251-.563-.713-.563h-.228v1.152h.217c.473-.001.724-.207.724-.589zm-19.487.742a1.91 1.91 0 0 1-.69 1.46c-.365.303-.781.439-1.357.439H.001v-3.803H1.09c1.202 0 2.041.781 2.041 1.904zm-.764-.006c0-.364-.154-.718-.411-.947-.245-.222-.536-.308-1.015-.308H.742v2.515h.199c.479 0 .782-.092 1.015-.302.256-.228.411-.593.411-.958z" },
  jcb: { title: "JCB", viewBox: "0 8.9 24 6.3", d: "M13.05 9.8643c.9723.0736 1.7257.3671 2.3545.6843v-1.31s-1.2577-.3162-2.4408-.368c-4.1256-.1849-5.295 1.4344-5.295 3.1292 0 1.6947 1.1694 3.3145 5.295 3.1296 1.1831-.0536 2.4408-.3694 2.4408-.3694v-1.3086c-.6193.3081-1.3826.6107-2.3545.683-1.6793.1272-2.6898-.6907-2.6898-2.1342 0-1.4448 1.0105-2.2613 2.6898-2.1354m7.685 4.1223c-.0513.0105-.1581.02-.215.02h-1.8005V12.376H20.52c.0568 0 .1636.01.2149.02a.8056.8056 0 01.6325.7951c0 .4162-.2872.721-.6325.796zm-2.0155-4.0374h1.6325c.059 0 .1454.0077.1772.0137.3376.0572.6256.3307.6256.7392 0 .409-.288.6815-.626.7392a1.571 1.571 0 01-.1773.0137h-1.6311V9.9506zm3.4994 1.9856v-.0364c.9133-.1331 1.4149-.726 1.4149-1.4199 0-.8828-.7343-1.3916-1.7293-1.4416-.0772-.0032-.203-.011-.3044-.011h-5.3323v5.9467h5.7548c1.13 0 1.9774-.6043 1.9774-1.5466 0-.8701-.7724-1.4222-1.781-1.4917zm-17.8644.6788c0 .8787-.5906 1.5311-1.6656 1.5311-.917 0-1.8174-.2726-2.6889-.6938V14.76s1.4021.383 3.191.383c2.9714 0 3.8374-1.125 3.8374-2.529V9.0266H4.3541v3.5876Z" },
  dinersclub: { title: "Diners Club", viewBox: "0 1.6 24 20.7", d: "M16.506 11.982a6.026 6.026 0 0 0-3.866-5.618V17.6a6.025 6.025 0 0 0 3.866-5.618zM8.33 17.598V6.365a6.03 6.03 0 0 0-3.863 5.617 6.028 6.028 0 0 0 3.863 5.616zm2.156-15.113A9.497 9.497 0 0 0 .99 11.982a9.495 9.495 0 0 0 9.495 9.494c5.245 0 9.495-4.25 9.496-9.494a9.499 9.499 0 0 0-9.496-9.497Zm-.023 19.888C4.723 22.4 0 17.75 0 12.09 0 5.905 4.723 1.626 10.463 1.627h2.69C18.822 1.627 24 5.903 24 12.09c0 5.658-5.176 10.283-10.848 10.283" },
  tether: { title: "Tether", viewBox: "0 1.6 24 20.9", d: "M18.7538 10.5176c0 .6251-2.2379 1.1483-5.2381 1.2812l.0028.0007c-.0848.0064-.5233.0325-1.5012.0325-.7778 0-1.33-.0233-1.5237-.0325-3.0059-.1322-5.2495-.6555-5.2495-1.2819s2.2436-1.149 5.2495-1.2834v2.0442c.1965.0142.7594.0474 1.5372.0474.9334 0 1.4008-.0389 1.4849-.0466V9.2356c2.9994.1337 5.2381.657 5.2381 1.282zm5.19.5466L12.1248 22.389a.1803.1803 0 0 1-.2496 0L.0562 11.0635a.1781.1781 0 0 1-.0382-.2079l4.3762-9.1921a.1767.1767 0 0 1 .1626-.1026h14.8878a.1768.1768 0 0 1 .1612.1032l4.3762 9.1922a.1782.1782 0 0 1-.0382.2079zm-4.478-.4038c0-.8068-2.5515-1.4799-5.9473-1.6369V7.195h4.186V4.4055H6.3076V7.195h4.1852v1.8286c-3.4018.1562-5.9601.83-5.9601 1.6376 0 .8075 2.5583 1.4806 5.9601 1.6376v5.8618h3.025v-5.8639c3.394-.1563 5.948-.8295 5.948-1.6363z" },
} as const;
type PaymentMark = keyof typeof PAYMENT_MARKS;
/* Drawn height of each mark, so wordmarks and badges weigh the same. */
const PAYMENT_MARK_HEIGHT: Record<PaymentMark, number> = { paypal: 14, googlepay: 14, applepay: 14, tether: 13, dinersclub: 13, mastercard: 12, visa: 10, jcb: 9, venmo: 7.5, discover: 7 };
/* Every way Patreon takes a payment (its help page "What are my members'
   payment options?"): Apple Pay only in US dollars, Venmo only in the US. */
const PATREON_MARKS = ["visa", "mastercard", "discover", "jcb", "dinersclub", "paypal", "applepay", "venmo"] as const satisfies readonly PaymentMark[];

function PaymentMarks({ marks, label, className = "mt-1 h-3.5 gap-2" }: { marks: readonly PaymentMark[]; label: string; className?: string }) {
  return (
    <span role="img" aria-label={label} className={`flex items-center justify-center ${className}`}>
      {marks.map((id) => {
        const mark = PAYMENT_MARKS[id];
        const [, , w, h] = mark.viewBox.split(" ").map(Number);
        const height = PAYMENT_MARK_HEIGHT[id];
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
export type SupportMethod = "kofi" | "google" | "lava" | "patreon" | "crypto";

/* Google's checkout. It refuses every host but mania-tracker.com, so
   locally it only shows its button. A claim that fails on the spot falls
   back to the order number from Google's receipt, and every claim is checked
   against the Publisher Center export. Hidden from everyone, admins
   included, until the payments profile has a USD bank account to pay out to. */
const GOOGLE_OFFERED = false;

/* The methods this visitor can pick, and the one picked first: lava.top
   where Ko-fi cannot take a card, Ko-fi everywhere else. Null while the
   visitor's country is being asked. */
export function useSupportMethods() {
  const auth = useAuth();
  const [region, setRegion] = useState<{ lavaFirst: boolean; crypto: boolean } | null>(null);
  useEffect(() => {
    let cancelled = false;
    getSupportRegion()
      .then((value) => !cancelled && setRegion(value))
      .catch(() => !cancelled && setRegion({ lavaFirst: false, crypto: false }));
    return () => {
      cancelled = true;
    };
  }, []);
  const google = GOOGLE_OFFERED && !!GOOGLE_RRM_PUBLICATION_ID;
  const lava = LAVA_FOR_EVERYONE || auth.isAdmin;
  const patreon = PATREON_FOR_EVERYONE || auth.isAdmin;
  const crypto = (CRYPTO_FOR_EVERYONE && !!region?.crypto) || auth.isAdmin;
  const methods: SupportMethod[] = [
    "kofi",
    ...(patreon ? ["patreon" as const] : []),
    ...(google ? ["google" as const] : []),
    ...(lava ? ["lava" as const] : []),
    ...(crypto ? ["crypto" as const] : []),
  ];
  // Back from Patreon or a crypto invoice (each return URL adds its own
  // ?name=...): that method again.
  const search = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
  const backTo: SupportMethod | null = patreon && search?.has("patreon") ? "patreon" : crypto && search?.has("crypto") ? "crypto" : null;
  const initial: SupportMethod | null = region == null ? null : backTo ?? (region.lavaFirst && lava ? "lava" : "kofi");
  return { methods, initial };
}

/* What to do so the payment reaches the account, beside the checkout. */
export function SupportMethodSteps({ method }: { method: SupportMethod }) {
  const { t } = useLingui();
  const auth = useAuth();
  const signedIn = !!auth.viewer;
  if (method === "kofi") return <KofiNameSteps />;
  if (method === "patreon") {
    return (
      <p className="mt-2 text-[14px] leading-relaxed text-osu-l2">
        {signedIn
          ? t`Connect your Patreon here, then join the Supporter tier on Patreon. Each payment adds supporter time to your account.`
          : t`Sign in first, then connect your Patreon here, so your supporter time reaches your account.`}
      </p>
    );
  }
  if (method === "crypto") {
    return (
      <p className="mt-2 text-[14px] leading-relaxed text-osu-l2">
        {signedIn
          ? t`Pick a length and a network, then send USDT from your wallet. Your supporter time starts once the payment is confirmed on the blockchain.`
          : t`Sign in first, then pay in crypto here, so your supporter time reaches your account.`}
      </p>
    );
  }
  const lavaApi = LAVA_API_CHECKOUT_FOR_EVERYONE || (signedIn && auth.isAdmin);
  return (
    <p className="mt-2 text-[14px] leading-relaxed text-osu-l2">
      {method === "google"
        ? signedIn
          ? t`Pay with Google here. Your supporter time starts as soon as the payment goes through.`
          : t`Sign in first, then pay with Google here, so your supporter time reaches your account.`
        : lavaApi
          ? signedIn
            ? t`Pick a length and a currency, then pay on lava.top. Your supporter time starts once lava.top confirms the payment.`
            : t`Sign in first, then pay on lava.top here, so your supporter time reaches your account.`
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
    patreon: { name: "Patreon", detail: t`Card, PayPal or Apple Pay`, marks: ["visa", "mastercard", "paypal", "applepay"] },
    crypto: { name: t`Crypto`, detail: t`USDT and other coins`, marks: ["tether"] },
  };

  return (
    <div className="overflow-hidden rounded-xl bg-osu-b4">
      {/* a choice only when there is one to make */}
      {methods.length > 1 && <div role="radiogroup" aria-label={t`How to pay`} className={`grid gap-1 border-b border-white/[0.07] p-1.5 ${methods.length >= 6 ? "grid-cols-3 sm:grid-cols-6" : methods.length === 5 ? "grid-cols-3 sm:grid-cols-5" : methods.length === 4 ? "grid-cols-2 sm:grid-cols-4" : methods.length === 3 ? "grid-cols-3" : "grid-cols-2"}`}>
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
                track(`support_method_${id}`);
              }}
              className={`cursor-pointer rounded-lg px-2 py-2 text-center transition-colors ${on ? "bg-osu-b2 text-white" : "text-osu-l2 hover:bg-white/[0.05] hover:text-white"}`}
            >
              <span className="block text-[13px] font-bold">{label[id].name}</span>
              <span className={on ? "text-osu-l2" : "text-osu-f1"}><PaymentMarks marks={label[id].marks} label={label[id].detail} /></span>
            </button>
          );
        })}
      </div>}
      {method === "lava" && viewerId && (LAVA_API_CHECKOUT_FOR_EVERYONE || auth.isAdmin) ? (
        <div className="flex flex-col gap-5 px-5 pb-6 pt-5">
          <LavaApiPay viewerId={viewerId} />
          <PaymentClaim provider="lava" wide />
        </div>
      ) : method === "lava" ? (
        <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
          {viewerId ? (
            <>
              <LavaPay viewerId={viewerId} />
              <PaymentClaim provider="lava" />
            </>
          ) : LAVA_API_CHECKOUT_FOR_EVERYONE ? (
            <>
              <p className="max-w-[300px] text-[12.5px] text-osu-f1">{t`Sign in first so it counts toward your account.`}</p>
              <a
                href={`/api/auth/osu?next=${encodeURIComponent("/support#checkout")}`}
                className="inline-flex items-center gap-1.5 rounded-full bg-osu-pink px-5 py-2.5 text-[13px] font-semibold text-white transition hover:brightness-110"
              >
                {t`Log in with osu!`}
              </a>
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
      {method === "patreon" ? <PatreonPay viewerId={viewerId} /> : null}
      {method === "crypto" ? <CryptoPay viewerId={viewerId} /> : null}
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

/* Patreon: connect the account here, then join the tier on Patreon. The
   webhook (or the 6-hourly member pass) does the rest. */
const PATREON_MARK = "M22.957 7.21c-.004-3.064-2.391-5.576-5.191-6.482-3.478-1.125-8.064-.962-11.384.604C2.357 3.231 1.093 7.391 1.046 11.54c-.039 3.411.302 12.396 5.369 12.46 3.765.047 4.326-4.804 6.068-7.141 1.24-1.662 2.836-2.132 4.801-2.618 3.376-.836 5.678-3.501 5.673-7.031Z";

function PatreonMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d={PATREON_MARK} />
    </svg>
  );
}

function CheckMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      <path d="M3.5 8.5l3 3 6-7" />
    </svg>
  );
}

function PatreonPay({ viewerId }: { viewerId: number | undefined }) {
  const { t } = useLingui();
  const you = useShowcaseViewer();
  const [connected, setConnected] = useState<boolean | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  useEffect(() => {
    const flag = new URLSearchParams(window.location.search).get("patreon");
    if (!flag) return;
    setOutcome(flag);
    document.getElementById("checkout")?.scrollIntoView({ block: "start" });
  }, []);
  useEffect(() => {
    if (!viewerId) return;
    let cancelled = false;
    readPatreonConnection()
      .then((result) => !cancelled && setConnected(result.connected))
      .catch(() => !cancelled && setConnected(false));
    return () => {
      cancelled = true;
    };
  }, [viewerId]);

  const pill = "inline-flex items-center justify-center gap-1.5 rounded-full px-5 text-white transition hover:brightness-110";
  if (!viewerId) {
    return (
      <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
        <p className="max-w-[300px] text-[12.5px] text-osu-f1">{t`Sign in first so it counts toward your account.`}</p>
        <a href={`/api/auth/osu?next=${encodeURIComponent("/support?patreon=signin")}`} className={`${pill} bg-osu-pink py-2.5 text-[13px] font-semibold`}>
          {t`Log in with osu!`}
        </a>
      </div>
    );
  }
  const action = `${pill} w-full bg-osu-pink py-3 text-[14px] font-semibold`;
  return (
    <div className="flex flex-col gap-4 px-5 py-6">
      {outcome === "linked_elsewhere" ? (
        <p className="text-center text-[12.5px] text-osu-red-light">{t`That Patreon is already connected to another account.`}</p>
      ) : outcome === "failed" ? (
        <p className="text-center text-[12.5px] text-osu-red-light">{t`Couldn't connect Patreon. Try again.`}</p>
      ) : null}
      <div className="flex items-center gap-4">
        <img src="/images/support/patreon-tier.webp" alt="" className="h-[72px] w-[166px] shrink-0 rounded-lg object-cover" />
        <div className="min-w-0">
          <div className="text-[18px] font-bold text-white">{t`Supporter`}</div>
          <div className="text-[13px] text-osu-l2">{t`$4 a month on Patreon`}</div>
        </div>
      </div>
      {connected === null ? (
        <div className="h-[46px]" />
      ) : connected ? (
        <a href={PATREON_JOIN_URL} target="_blank" rel="noopener noreferrer" onClick={() => track("support_patreon_open")} className={action}>
          {t`Join on Patreon`}
          <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
        </a>
      ) : (
        <a href={`/api/auth/patreon?next=${encodeURIComponent("/support")}`} onClick={() => track("support_patreon_connect")} className={action}>
          <PatreonMark className="h-3.5 w-3.5" />
          {t`Connect Patreon`}
        </a>
      )}
      {/* the player's account and their Patreon, joined once connected */}
      <div className="flex items-center justify-center gap-2.5 text-[12px] text-osu-f1">
        <div className="flex items-center" aria-hidden="true">
          <img src={you.avatar} alt="" className="h-6 w-6 rounded-md bg-osu-b3 object-cover" />
          <div className="relative mx-1.5 flex w-10 items-center justify-center">
            <span className={`h-0 w-full border-t-2 ${connected ? "border-osu-pink" : "border-dashed border-white/20"}`} />
            {connected ? (
              <span className="absolute flex h-4 w-4 items-center justify-center rounded-full bg-osu-pink text-white">
                <CheckMark className="h-2.5 w-2.5" />
              </span>
            ) : null}
          </div>
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-[#ff424d] text-white">
            <PatreonMark className="h-3.5 w-3.5" />
          </span>
        </div>
        <span>{connected ? t`Patreon connected` : t`Not connected yet`}</span>
      </div>
      <div className="border-t border-white/[0.07] pt-4 text-osu-f1">
        <PaymentMarks marks={PATREON_MARKS} label={t`Visa, Mastercard, Discover, JCB, Diners Club, PayPal, Apple Pay in US dollars, Venmo in the US`} className="flex-wrap gap-x-3.5 gap-y-2" />
      </div>
    </div>
  );
}
