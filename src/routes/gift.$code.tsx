import { useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";

import { PageHeader } from "../components/layout/PageHeader";
import { formatGiftCode, useGiftClaimErrorText } from "../components/supporter/GiftCodePanel";
import { requestSupporterWelcome } from "../components/supporter/SupporterWelcome";
import { useAuth } from "../lib/auth-context";
import { getI18n } from "../lib/i18n";
import { claimSupporterGiftCode, peekSupporterGiftCode, type GiftClaimError } from "../lib/supporter-look-settings";
import { rememberViewerSupporter } from "../lib/viewer-supporter";

/* Where a supporter's gift link lands: who sent it, and a button that turns
   it into a week of supporter for the signed-in viewer. The claim itself
   plays the supporter welcome, as the friend's version. */

export const Route = createFileRoute("/gift/$code")({
  head: ({ match }) => {
    const i18n = getI18n(match.context.locale);
    return {
      meta: [
        { title: i18n._(msg`A week of supporter`) },
        { name: "robots", content: "noindex, nofollow" },
      ],
    };
  },
  component: GiftPage,
});

type Peek = { from: string | null; trialDays: number } | null | undefined;

function GiftPage() {
  const { t, i18n } = useLingui();
  const { code } = Route.useParams();
  const viewer = useAuth().viewer;
  const [peek, setPeek] = useState<Peek>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<GiftClaimError | null>(null);
  const [claimed, setClaimed] = useState<{ expiresAt: number | null } | null>(null);

  useEffect(() => {
    let alive = true;
    peekSupporterGiftCode({ data: { code } })
      .then((next) => alive && setPeek(next))
      .catch(() => alive && setPeek(null));
    return () => {
      alive = false;
    };
  }, [code]);

  const claim = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await claimSupporterGiftCode({ data: { code } });
      if (result.ok) {
        setClaimed({ expiresAt: result.expiresAt });
        if (viewer) rememberViewerSupporter(viewer.id, result.expiresAt);
        requestSupporterWelcome();
      } else {
        setError(result.error);
      }
    } catch {
      setError("failed");
    } finally {
      setBusy(false);
    }
  };

  const errorText = useGiftClaimErrorText();
  const loginHref = `/api/auth/osu?next=${encodeURIComponent(`/gift/${code}`)}`;
  const until = claimed?.expiresAt
    ? new Date(claimed.expiresAt).toLocaleDateString(i18n.locale, { month: "short", day: "numeric", year: "numeric" })
    : null;
  const from = peek?.from;

  return (
    <div className="flex-1">
      <PageHeader iconSrc="/images/icons/supporter-heart.svg" title={t`gift`} />
      <div className="min-h-[70vh] bg-osu-b5">
        <div className="mx-auto max-w-[560px] px-5 py-16 text-center">
          {peek === undefined ? null : claimed ? (
            <>
              <p className="text-[24px] font-semibold text-white">{t`The week is yours.`}</p>
              <p className="mt-2 text-[14px] text-osu-l2">
                {until ? t`You're a supporter until ${until}.` : null}
              </p>
              <Link to="/supporter" className="mt-6 inline-block text-[14px] font-semibold text-osu-pink-light hover:underline">
                {t`Set up your look`}
              </Link>
            </>
          ) : peek === null ? (
            <p className="text-[15px] text-osu-f1">{t`This gift code was already used or doesn't exist.`}</p>
          ) : (
            <>
              <p className="font-mono text-[12px] tracking-[0.14em] text-osu-f1">{formatGiftCode(code.toUpperCase().replace(/-/g, ""))}</p>
              <p className="mt-3 text-[24px] font-semibold leading-snug text-white">
                {from ? t`${from} sent you a week of supporter` : t`Someone sent you a week of supporter`}
              </p>
              <p className="mt-2 text-[14px] text-osu-l2">
                {t`Profile themes, avatar frames, name styles and card foils, yours for ${peek.trialDays} days.`}
              </p>
              <div className="mt-8">
                {viewer ? (
                  <button
                    type="button"
                    onClick={() => void claim()}
                    disabled={busy}
                    className="h-10 cursor-pointer rounded-full bg-osu-pink px-6 text-[14px] font-semibold text-white transition hover:brightness-110 disabled:cursor-default disabled:opacity-60"
                  >
                    {t`Claim it`}
                  </button>
                ) : (
                  <a href={loginHref} className="text-[14px] font-semibold text-osu-pink-light hover:underline">
                    {t`Log in with osu! to claim it`}
                  </a>
                )}
              </div>
              {error ? <p className="mt-4 text-[13px] text-osu-red-light">{errorText[error]}</p> : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
