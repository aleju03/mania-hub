import { useEffect, useState, type CSSProperties, type FormEvent } from "react";
import { useLingui } from "@lingui/react/macro";
import { Check, Link2 } from "lucide-react";

import { claimSupporterGiftCode, type GiftClaimError, type SupporterGiftState } from "../../lib/supporter-look-settings";
import { track } from "../../lib/analytics";
import { rememberViewerSupporter } from "../../lib/viewer-supporter";
import { loadViewerGift } from "../../lib/viewer-gift-code";
import { FoilPreview } from "./FoilPreview";
import { requestSupporterWelcome } from "./SupporterWelcome";

/* A paying supporter's one-time gift code, under the thank-you on /supporter:
   the code on a ticket and a button that copies the claim link. When the
   last code was claimed, who took it and that every $4 given brings
   another. Nothing at all for a supporter whose time was never paid for. */

export function formatGiftCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export function GiftCodePanel({ viewerId }: { viewerId: number }) {
  const { t } = useLingui();
  const [gift, setGift] = useState<SupporterGiftState | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    void loadViewerGift(viewerId).then((next) => alive && setGift(next));
    return () => {
      alive = false;
    };
  }, [viewerId]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(timer);
  }, [copied]);

  if (!gift || (!gift.code && !gift.lastClaim)) return null;

  if (!gift.code) {
    const name = gift.lastClaim?.username;
    return (
      <p className="mt-3 text-[12px] text-osu-f1">
        {name ? t`${name} claimed your gift week. Every $4 you give brings a new code.` : t`Your gift week was claimed. Every $4 you give brings a new code.`}
      </p>
    );
  }

  const code = gift.code;
  const copy = () => {
    const url = `${window.location.origin}/gift/${code}`;
    track("supporter_gift_copied");
    void navigator.clipboard?.writeText(url).then(() => setCopied(true)).catch(() => undefined);
  };

  return (
    <div className="mt-6 flex flex-wrap items-center gap-x-7 gap-y-4">
      <GiftCodeTicket code={code} />
      <div className="min-w-0">
        <p className="text-[15px] font-semibold text-white">{t`You have a week of supporter to give a friend.`}</p>
        <button
          type="button"
          onClick={copy}
          className="mt-3 inline-flex h-[34px] cursor-pointer items-center gap-1.5 rounded-full bg-osu-pink px-4 text-[13px] font-semibold text-white transition hover:brightness-110"
        >
          {copied ? <Check className="h-4 w-4" aria-hidden="true" /> : <Link2 className="h-4 w-4" aria-hidden="true" />}
          {copied ? t`Link copied` : t`Copy link`}
        </button>
        <p className="mt-3 max-w-[340px] text-[11px] text-osu-f1">{t`Works once, for an account that isn't a supporter and hasn't had a trial.`}</p>
      </div>
    </div>
  );
}

/* The notches where the ticket meets its stub, cut out of each half as real
   holes (a painted disc shows over a themed page and under the shadow). */
export function ticketNotchMask(side: "left" | "right"): CSSProperties {
  const hole = (corner: string) => `radial-gradient(circle 10px at ${side} ${corner}, transparent 9.5px, #000 10px)`;
  const mask = `${hole("top")} top / 100% 51% no-repeat, ${hole("bottom")} bottom / 100% 51% no-repeat`;
  return { mask, WebkitMask: mask };
}

/* Their code printed on the gift ticket from the support page: the pink
   ticket, the tear line with a notch at each end, and the holo stub. */
function GiftCodeTicket({ code }: { code: string }) {
  const { t } = useLingui();
  const half = code.length / 2;
  return (
    <div className="flex w-full max-w-[400px] -rotate-1 text-white select-text [filter:drop-shadow(0_10px_20px_rgba(0,0,0,0.4))]">
      <div className="relative min-w-0 flex-1 overflow-hidden rounded-l-2xl bg-[linear-gradient(135deg,#ff7ab6_0%,#ff4f9a_45%,#c2357a_100%)] px-5 py-4" style={ticketNotchMask("right")}>
        <div className="absolute inset-0 bg-[repeating-linear-gradient(115deg,rgba(255,255,255,0.07)_0_2px,transparent_2px_9px)]" />
        <div className="relative">
          <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.2em] text-white/80">
            <img src="/images/icons/supporter-gem.svg" alt="" className="h-4 w-4 brightness-0 invert" />
            {t`Gift`}
          </div>
          <div className="mt-0.5 text-[18px] font-black leading-tight">{t`One week of supporter`}</div>
          <div className="mt-2.5 flex items-center gap-1" aria-label={formatGiftCode(code)}>
            {Array.from(code, (ch, i) => (
              <span key={i} className="contents">
                {i === half && <span className="mx-0.5 h-[3px] w-2.5 rounded-full bg-white/70" />}
                <span className="inline-flex h-9 w-[27px] items-center justify-center rounded-md bg-black/25 font-mono text-[20px] font-bold">{ch}</span>
              </span>
            ))}
          </div>
        </div>
      </div>
      <div className="relative w-0">
        <span className="absolute inset-y-3 -left-px z-10 border-l-2 border-dotted border-white/50" />
      </div>
      <div className="relative w-[92px] shrink-0 overflow-hidden rounded-r-2xl bg-[#2a2440]" style={ticketNotchMask("left")}>
        <FoilPreview foil="holo" className="absolute inset-0 h-full w-full" />
        <div className="relative flex h-full flex-col items-center justify-center text-center">
          <div className="text-[40px] font-black leading-none tabular-nums [text-shadow:0_2px_8px_rgba(0,0,0,0.35)]">7</div>
          <div className="mt-1 text-[11px] font-bold uppercase tracking-[0.18em] text-white/90">{t`days`}</div>
        </div>
      </div>
    </div>
  );
}

/* againAt: when an account gifted in the last three months can be gifted again. */
export function useGiftClaimErrorText(againAt: number | null = null): Record<GiftClaimError, string> {
  const { t, i18n } = useLingui();
  const again = againAt ? new Date(againAt).toLocaleDateString(i18n.locale, { month: "short", day: "numeric", year: "numeric" }) : null;
  return {
    invalid_code: t`This gift code doesn't exist.`,
    already_claimed: t`Someone already claimed this gift.`,
    own_code: t`This is your own gift code. Send the link to a friend.`,
    already_supporter: t`You're already a supporter, so this one is better off with a friend.`,
    trial_used: again
      ? t`You had a supporter week from a gift not long ago. You can be gifted again on ${again}.`
      : t`You had a supporter week from a gift not long ago. You can be gifted again three months after it.`,
    signed_out: t`Log in with osu! to claim it.`,
    failed: t`Could not claim it. Try again in a moment.`,
  };
}

/* The other way in: a code typed or pasted by hand, for a non-supporter on
   /supporter. A claim plays the welcome and hands the page back to reload. */
export function RedeemGiftCode({ viewerId, onClaimed }: { viewerId: number; onClaimed: () => void }) {
  const { t } = useLingui();
  const [againAt, setAgainAt] = useState<number | null>(null);
  const errorText = useGiftClaimErrorText(againAt);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<GiftClaimError | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const typed = code.trim().replace(/\s/g, "");
    if (!typed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await claimSupporterGiftCode({ data: { code: typed.slice(0, 16) } });
      if (result.ok) {
        rememberViewerSupporter(viewerId, result.expiresAt);
        track("supporter_gift_redeemed");
        requestSupporterWelcome();
        onClaimed();
      } else {
        setAgainAt(result.againAt ?? null);
        setError(result.error);
      }
    } catch {
      setError("failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
      <label htmlFor="gift-code" className="text-[13px] text-osu-l2">{t`Have a gift code?`}</label>
      <input
        id="gift-code"
        value={code}
        onChange={(event) => {
          setCode(event.target.value.toUpperCase());
          setError(null);
        }}
        placeholder="ABCD-EFGH"
        maxLength={16}
        autoComplete="off"
        spellCheck={false}
        className="h-8 w-[132px] rounded-md bg-osu-b4 px-2.5 font-mono text-[13px] font-semibold tracking-[0.12em] text-white placeholder:text-osu-f1/50 outline-none ring-1 ring-transparent focus:ring-osu-pink/60"
      />
      <button
        type="submit"
        disabled={busy || !code.trim()}
        className="h-8 cursor-pointer rounded-full bg-osu-pink px-4 text-[12px] font-semibold text-white transition hover:brightness-110 disabled:cursor-default disabled:opacity-50"
      >
        {t`Redeem`}
      </button>
      {error ? <span className="basis-full text-[12px] text-osu-red-light">{errorText[error]}</span> : null}
    </form>
  );
}
