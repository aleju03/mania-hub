import { useState } from "react";
import { useLingui } from "@lingui/react/macro";

import { useAuth } from "../../lib/auth-context";
import type { SupportPlan } from "./SupportCheckout";

/* How a Ko-fi payment finds its account, spelled out: the backend links a tip
   by the Ko-fi name being the osu! username, or by a message of the form
   "osu: <username>" (features/supporters.ts, usernameInMessage). The signed-in
   viewer sees their own name in both, ready to copy. */
export function KofiNameSteps({ plan = "once" }: { plan?: SupportPlan }) {
  const { t } = useLingui();
  const viewer = useAuth().viewer;
  const name = viewer?.username ?? null;
  const message = `osu: ${name ?? t`YourName`}`;
  return (
    <div className="mt-2 text-[13px] leading-snug text-osu-l2">
      <p>{plan === "monthly"
        ? t`Pick Monthly at the top of Ko-fi's panel. So the time reaches your account, do one of these there:`
        : t`Pick an amount on Ko-fi. So the time reaches your account, do one of these there:`}</p>
      <ol className="mt-2 flex flex-col gap-1.5">
        <li className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
          <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-osu-b3 text-[11px] font-bold text-white">1</span>
          <span>{t`Put your osu! username as your name:`}</span>
          {name ? <Copyable text={name} /> : <span className="font-semibold text-white">{t`your osu! username`}</span>}
        </li>
        <li className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
          <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-osu-b3 text-[11px] font-bold text-white">2</span>
          <span>{t`Or write this as the message:`}</span>
          <Copyable text={message} />
        </li>
      </ol>
    </div>
  );
}

/* The exact text to type, in a code box with a copy button. */
function Copyable({ text }: { text: string }) {
  const { t } = useLingui();
  const [copied, setCopied] = useState(false);
  return (
    <span className="inline-flex items-center overflow-hidden rounded-md bg-osu-b5 ring-1 ring-inset ring-white/[0.08]">
      <code className="px-1.5 py-0.5 font-mono text-[12.5px] font-semibold text-white">{text}</code>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1400);
          });
        }}
        className="cursor-pointer border-l border-white/[0.08] px-2 py-0.5 text-[11px] font-semibold text-osu-l2 transition-colors hover:bg-white/[0.06] hover:text-white"
      >
        {copied ? t`Copied` : t`Copy`}
      </button>
    </span>
  );
}
