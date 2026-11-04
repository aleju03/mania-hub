import { useEffect, useState, type FormEvent } from "react";
import { useLingui } from "@lingui/react/macro";
import { Check, Link2 } from "lucide-react";

import { claimSupporterGiftCode, fetchSupporterGiftCode, type GiftClaimError, type SupporterGiftState } from "../../lib/supporter-look-settings";
import { rememberViewerSupporter } from "../../lib/viewer-supporter";
import { requestSupporterWelcome } from "./SupporterWelcome";

/* A paying supporter's one-time gift code, under the thank-you on /supporter:
   the code and a link that opens the claim page with it filled in. When the
   last code was claimed, who took it and that every $5 given brings
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
    fetchSupporterGiftCode()
      .then((next) => alive && setGift(next))
      .catch(() => undefined);
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
        {name ? t`${name} claimed your gift week. Every $5 you give brings a new code.` : t`Your gift week was claimed. Every $5 you give brings a new code.`}
      </p>
    );
  }

  const code = gift.code;
  const copy = () => {
    const url = `${window.location.origin}/gift/${code}`;
    void navigator.clipboard?.writeText(url).then(() => setCopied(true)).catch(() => undefined);
  };

  return (
    <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
      <span className="text-[13px] text-osu-l2">{t`Gift a friend a week of supporter:`}</span>
      <span className="rounded-md bg-osu-b4 px-2.5 py-1 font-mono text-[13px] font-semibold tracking-[0.12em] text-white select-all">{formatGiftCode(code)}</span>
      <button
        type="button"
        onClick={copy}
        className="inline-flex cursor-pointer items-center gap-1.5 text-[12px] font-semibold text-osu-pink-light transition-colors hover:text-white"
      >
        {copied ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Link2 className="h-3.5 w-3.5" aria-hidden="true" />}
        {copied ? t`Link copied` : t`Copy link`}
      </button>
      <span className="basis-full text-[11px] text-osu-f1">{t`Works once, for an account that isn't a supporter and hasn't had a trial.`}</span>
    </div>
  );
}

export function useGiftClaimErrorText(): Record<GiftClaimError, string> {
  const { t } = useLingui();
  return {
    invalid_code: t`This gift code doesn't exist.`,
    already_claimed: t`Someone already claimed this gift.`,
    own_code: t`This is your own gift code. Send the link to a friend.`,
    already_supporter: t`You're already a supporter, so this one is better off with a friend.`,
    trial_used: t`You've already had a supporter week from a gift.`,
    signed_out: t`Log in with osu! to claim it.`,
    failed: t`Could not claim it. Try again in a moment.`,
  };
}

/* The other way in: a code typed or pasted by hand, for a non-supporter on
   /supporter. A claim plays the welcome and hands the page back to reload. */
export function RedeemGiftCode({ viewerId, onClaimed }: { viewerId: number; onClaimed: () => void }) {
  const { t } = useLingui();
  const errorText = useGiftClaimErrorText();
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
        requestSupporterWelcome();
        onClaimed();
      } else {
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
