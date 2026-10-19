import { useLingui } from "@lingui/react/macro";
import { Recycle } from "lucide-react";
import { WysiDigits } from "./chain/Wysi";

/* A shard amount in the run, drawn with the same mark as the wallet's count
   at the top of /packs, since it is the same wallet. */
export function Shards({ value, className = "", sign = false, lit727 = false }: { value: number; className?: string; sign?: boolean; lit727?: boolean }) {
  const { t } = useLingui();
  return (
    <span className={`inline-flex items-center gap-[0.3em] tabular-nums ${className}`} title={t`${value} shards`}>
      <Recycle className="h-[0.9em] w-[0.9em] shrink-0" aria-hidden="true" />
      {sign && value > 0 ? "+" : ""}
      {/* The chain run lights a 727 in its shard count. */}
      {lit727 ? <WysiDigits text={value.toLocaleString("en-US")} /> : value.toLocaleString("en-US")}
    </span>
  );
}
