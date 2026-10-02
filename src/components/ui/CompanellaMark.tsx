import { useLingui } from "@lingui/react/macro";

import { KNOWN_APPS, knownApp } from "../../lib/companella-integration/shared";

// Marks a score row that came from an app import (Companella, Mania Bridge) instead of osu!, with the icon of the
// app that sent it; a row without one predates the field and was Companella. The icon is full colour on a solid
// disc, so it is an <img>, not a mask like the mod glyphs. The small mark copies keep a row from pulling the originals.
export function CompanellaMark({ app, className = "h-[18px] w-[18px]" }: { app?: string; className?: string }) {
  const { t } = useLingui();
  const known = knownApp(app) ?? KNOWN_APPS.companella;
  const label = t`Sent through ${known.name}`;
  return (
    <img
      src={known.mark}
      alt={label}
      title={label}
      width={48}
      height={48}
      loading="lazy"
      className={`inline-block flex-shrink-0 rounded-full align-middle ${className}`}
    />
  );
}
