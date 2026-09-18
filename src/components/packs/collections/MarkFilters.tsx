import { useLingui } from "@lingui/react/macro";
import { UserRound } from "lucide-react";
import { PACK_CARD_MARKS, type PackCardMark } from "#/lib/pack-collection";
import { Seal, type Finish } from "./CardMarks";

/* One chip per mark a card can wear (CardMarks), each showing the seal it
   stands for, with how many cards on the surface wear it. A chip is a toggle
   rather than a row with an "all", because none of them is the resting state.
   A mark nobody on the surface earned is left off the row, so the row may be
   empty and then renders nothing. */

const SEALS: Record<Exclude<PackCardMark, "self">, { finish: Finish; label: string }> = {
  only: { finish: "holo", label: "1/1" },
  first: { finish: "gold", label: "1" },
  second: { finish: "silver", label: "2" },
  third: { finish: "bronze", label: "3" },
};

export function useMarkLabels(): Record<PackCardMark, string> {
  const { t } = useLingui();
  return {
    only: t`Only one`,
    first: t`First pull`,
    second: t`Second pull`,
    third: t`Third pull`,
    self: t`Own card`,
  };
}

export function MarkFilters({ value, counts, onChange, selfFace, className }: {
  value: PackCardMark | null;
  /* Missing until the surface has read them once; the chips wait for it. */
  counts: Record<PackCardMark, number> | null | undefined;
  onChange: (mark: PackCardMark | null) => void;
  /* The self mark's badge is a collector's own face. A surface with one
     collector passes it; the wall, with many, gets a plain figure. */
  selfFace?: string;
  className?: string;
}) {
  const labels = useMarkLabels();
  const marks = PACK_CARD_MARKS.filter((mark) => mark === value || (counts?.[mark] ?? 0) > 0);
  if (marks.length === 0) return null;
  return (
    <div className={`flex flex-wrap gap-1.5 ${className ?? ""}`} data-mark-filters="">
      {marks.map((mark) => (
        <button
          key={mark}
          type="button"
          aria-pressed={value === mark}
          onClick={() => onChange(value === mark ? null : mark)}
          className={`flex cursor-pointer items-center gap-1.5 rounded-full py-0.5 pl-1 pr-2.5 text-[11px] font-semibold transition-colors ${
            value === mark ? "bg-osu-pink/20 text-white" : "text-osu-f1 hover:text-white"
          }`}
        >
          {mark === "self" ? (
            selfFace ? (
              <img src={selfFace} alt="" width={18} height={18} draggable={false} className="size-[18px] rounded-full object-cover ring-2 ring-osu-pink" />
            ) : (
              <span className="flex size-[18px] items-center justify-center rounded-full bg-osu-b3 ring-2 ring-osu-pink"><UserRound size={11} /></span>
            )
          ) : (
            <Seal finish={SEALS[mark].finish} label={SEALS[mark].label} title={labels[mark]} size={18} />
          )}
          {labels[mark]}
          {counts?.[mark] ? <span translate="no" className="tabular-nums opacity-60">{counts[mark]}</span> : null}
        </button>
      ))}
    </div>
  );
}
