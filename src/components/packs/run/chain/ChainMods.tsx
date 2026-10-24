import { motion } from "framer-motion";
import { useLingui } from "@lingui/react/macro";
import { chainModLook, type ChainModId } from "#/lib/chain-run";
import { ModChip } from "./ModPin";

/* The mods held on the table: tap one to pick it, then a card in the hand
   to use it on (tap it again to put it back). */
export function HeldMods({
  mods,
  picked,
  compact,
  disabled,
  onPick,
}: {
  mods: ChainModId[];
  picked: number | null;
  compact: boolean;
  disabled: boolean;
  onPick: (index: number | null) => void;
}) {
  const { t, i18n } = useLingui();
  if (!mods.length) return null;
  return (
    <div className={`flex items-center ${compact ? "gap-1.5" : "gap-2.5"}`}>
      {mods.map((id, index) => {
        const look = chainModLook(id, i18n);
        return (
          <motion.button
            key={`${id}-${index}`}
            type="button"
            disabled={disabled}
            title={`${look.name}: ${look.text}`}
            aria-label={t`Use ${look.name}`}
            aria-pressed={picked === index}
            onClick={() => onPick(picked === index ? null : index)}
            initial={{ scale: 0.4, opacity: 0 }}
            animate={{ scale: picked === index ? 1.12 : 1, opacity: 1, y: picked === index ? -4 : 0 }}
            transition={{ type: "spring", stiffness: 520, damping: 20 }}
            className="disabled:brightness-50"
          >
            <ModChip id={id} size={compact ? 34 : 46} picked={picked === index} />
          </motion.button>
        );
      })}
    </div>
  );
}
