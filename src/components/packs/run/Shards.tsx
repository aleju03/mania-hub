import { useLingui } from "@lingui/react/macro";
import { Recycle } from "lucide-react";

/* A shard amount in the run, drawn with the same mark as the wallet's count
   at the top of /packs, since it is the same wallet. */
export function Shards({ value, className = "", sign = false }: { value: number; className?: string; sign?: boolean }) {
  const { t } = useLingui();
  return (
    <span className={`inline-flex items-center gap-[0.3em] tabular-nums ${className}`} title={t`${value} shards`}>
      <Recycle className="h-[0.9em] w-[0.9em] shrink-0" aria-hidden="true" />
      {sign && value > 0 ? "+" : ""}
      {value.toLocaleString("en-US")}
    </span>
  );
}
