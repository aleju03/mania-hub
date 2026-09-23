import { useLingui } from "@lingui/react/macro";

// Marks a score row that came from a Companella import instead of osu!. The
// icon is full colour on a solid disc, so it is an <img>, not a mask like the
// mod glyphs. The 48px copy keeps a row from pulling the 256px original.
export function CompanellaMark({ className = "h-4 w-4" }: { className?: string }) {
  const { t } = useLingui();
  const label = t`Sent through Companella`;
  return (
    <img
      src="/images/companella-mark.png"
      alt={label}
      title={label}
      width={48}
      height={48}
      loading="lazy"
      className={`inline-block flex-shrink-0 rounded-full align-middle ${className}`}
    />
  );
}
