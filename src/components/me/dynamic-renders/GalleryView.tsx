import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronLeft } from "lucide-react";
import { useLingui } from "@lingui/react/macro";

import {
  signatureDesigns,
  SIGNATURE_TYPE_LABELS,
  type SignatureDesign,
  type SignatureType,
} from "../../../lib/signature-shared";
import { CopyButton, KeyModeControls, LinkActions, PreviewImage, StyleControls } from "./controls";
import { useSignaturePreview } from "./use-signature-preview";
import type { DynamicRenders } from "./use-dynamic-renders";

/* Gallery: every layout of a type drawn with the player's own data, so a
   layout is picked by looking at it rather than by its name. Picking one
   opens it large with its style and the copy button right under it.

   Thumbnails wait longer than the main preview and only exist while the grid
   is on screen, so editing a style never re-renders the whole grid. */
const THUMB_DEBOUNCE_MS = 260;

/* A layout as wide as the column takes the whole row; narrower ones pair up. */
function isWide(spec: SignatureDesign): boolean {
  return spec.width >= 700;
}

function Thumbnail({
  renders,
  type,
  spec,
  onOpen,
}: { renders: DynamicRenders; type: SignatureType; spec: SignatureDesign; onOpen: () => void }) {
  const { i18n } = useLingui();
  const preview = useSignaturePreview({
    type,
    design: spec.design,
    style: renders.styles[type],
    skillsKeyCount: renders.skillsKeyCount,
    debounceMs: THUMB_DEBOUNCE_MS,
  });
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`group flex cursor-pointer flex-col items-start gap-2.5 text-left ${isWide(spec) ? "sm:col-span-2" : ""}`}
    >
      <motion.div
        layoutId={`gallery-${type}-${spec.design}`}
        className="flex w-full justify-center rounded-xl bg-white/[0.03] p-3 transition-[filter,background-color] group-hover:bg-white/[0.05] group-hover:brightness-110"
      >
        <PreviewImage spec={spec} imageUrl={preview.imageUrl} state={preview.state} />
      </motion.div>
      <div className="flex w-full items-baseline justify-between gap-3 px-1">
        <span className="text-[13.5px] font-bold text-white">{i18n._(spec.label)}</span>
        <span className="text-[11px] tabular-nums text-osu-f1">{spec.width} x {spec.height}</span>
      </div>
    </button>
  );
}

function Editor({
  renders,
  type,
  spec,
  onBack,
}: { renders: DynamicRenders; type: SignatureType; spec: SignatureDesign; onBack: () => void }) {
  const { t, i18n } = useLingui();
  const preview = useSignaturePreview({
    type,
    design: spec.design,
    style: renders.styles[type],
    skillsKeyCount: renders.skillsKeyCount,
  });
  const url = renders.urlFor(type, spec.design);

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={onBack}
          className="-ml-1 inline-flex cursor-pointer items-center gap-1 rounded-md px-1 py-1 text-[12.5px] font-semibold text-osu-f1 transition-colors hover:text-white"
        >
          <ChevronLeft className="h-4 w-4" />
          {t`All layouts`}
        </button>
        <span className="text-[15px] font-bold text-white">{i18n._(spec.label)}</span>
      </div>

      <motion.div
        layoutId={`gallery-${type}-${spec.design}`}
        className="flex justify-center rounded-xl bg-white/[0.03] p-4"
      >
        <PreviewImage spec={spec} imageUrl={preview.imageUrl} state={preview.state} />
      </motion.div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2.5">
        <KeyModeControls renders={renders} type={type} />
        <div className="flex min-w-[260px] flex-1 gap-2">
          <input
            readOnly
            value={url}
            onFocus={(event) => event.currentTarget.select()}
            className="h-11 min-w-0 flex-1 rounded-lg bg-white/[0.04] px-3 text-[12.5px] text-osu-l2 outline-none focus:bg-white/[0.06]"
          />
          <CopyButton renders={renders} text={url} types={[type]} />
        </div>
      </div>

      {spec.ownArt ? null : (
        <div className="mt-5 border-t border-white/[0.07] pt-5">
          <StyleControls key={type} renders={renders} type={type} />
        </div>
      )}
    </div>
  );
}

export function GalleryView({ renders }: { renders: DynamicRenders }) {
  const { i18n } = useLingui();
  const { visibleTypes, enabledTypes } = renders;
  const [type, setType] = useState<SignatureType>(() => enabledTypes[0] ?? visibleTypes[0]!);
  const [open, setOpen] = useState<number | null>(null);

  const designs = signatureDesigns(type);
  const openSpec = open === null ? null : designs.find((entry) => entry.design === open) ?? null;

  return (
    <>
      <div className="-mx-1 overflow-x-auto border-b border-white/[0.07] scrollbar-hide">
        <div className="flex min-w-max px-1">
          {visibleTypes.map((entry) => (
            <button
              key={entry}
              type="button"
              onClick={() => {
                setType(entry);
                setOpen(null);
              }}
              className={`relative shrink-0 cursor-pointer whitespace-nowrap px-3.5 py-2.5 text-[13px] font-semibold transition-colors duration-[120ms] ${
                type === entry ? "text-white" : "text-osu-f1 hover:text-osu-l2"
              }`}
            >
              {i18n._(SIGNATURE_TYPE_LABELS[entry])}
              {type === entry ? (
                <motion.span
                  layoutId="gallery-type-indicator"
                  className="absolute inset-x-2.5 bottom-0 h-[2px] rounded-full bg-osu-h1"
                  transition={{ type: "spring", stiffness: 420, damping: 34 }}
                />
              ) : null}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-5">
        <AnimatePresence mode="popLayout" initial={false}>
          {openSpec ? (
            <motion.div
              key={`editor-${type}-${openSpec.design}`}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.16 }}
            >
              <Editor renders={renders} type={type} spec={openSpec} onBack={() => setOpen(null)} />
            </motion.div>
          ) : (
            <motion.div
              key={`grid-${type}`}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.16 }}
              className="grid grid-cols-1 gap-x-4 gap-y-6 sm:grid-cols-2"
            >
              {designs.map((spec) => (
                <Thumbnail
                  key={spec.design}
                  renders={renders}
                  type={type}
                  spec={spec}
                  onOpen={() => setOpen(spec.design)}
                />
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="mt-8 border-t border-white/[0.07] pt-4">
        <LinkActions renders={renders} type={type} />
      </div>
    </>
  );
}
