import { useLingui } from "@lingui/react/macro";

import type { ModDisplay } from "../../lib/score";
import { useMarkTip } from "./CompanellaMark";
import { ModBadge } from "./ModBadge";

/** A score row's mod badge. The rate a rate-edited import amounts to names the
 *  official difficulty it is measured against on hover. */
export function ScoreModBadge({ mod, size }: { mod: ModDisplay; size?: number }) {
  const { t } = useLingui();
  const rate = mod.rate != null ? `${mod.rate.toFixed(2)}×` : "";
  const { hover, tooltip } = useMarkTip(mod.basedOn ? t`${rate} of ${mod.basedOn}` : "");
  if (!mod.basedOn) return <ModBadge mod={mod.acronym} rate={mod.rate} size={size} />;
  return (
    <>
      <span className="pointer-events-auto relative z-10 inline-flex flex-shrink-0 cursor-default" {...hover}>
        <ModBadge mod={mod.acronym} rate={mod.rate} size={size} plain />
      </span>
      {tooltip}
    </>
  );
}
