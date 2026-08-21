import { useState } from "react";
import { Shuffle } from "lucide-react";
import { Trans, useLingui } from "@lingui/react/macro";
import type { BackdropScope, PreviewBackdrop } from "../../lib/skin-preview-backdrops";
import type { SkinPreviewChartSnippet } from "../../lib/skin-preview-patterns";
import { SkinBackdropRow, SkinBackdropScopeToggle, type SkinBackdropRowPool } from "./SkinBackdropPicker";
import { SkinPatternRow, type SkinPatternPool } from "./SkinPatternPicker";

// What a rendered preview is dressed with: a backdrop behind the playfield and
// a pattern of notes on it. Both are rows of small thumbnails, so they share
// one section and one row of space, tabbed. Every surface that renders
// previews (upload, bulk upload, update, preview editor) uses this, so the
// tabs, the shuffle and the scope behave the same everywhere.

type PickerTab = "backdrop" | "pattern";

export function SkinPreviewPickers({
  backdrop,
  pattern,
  disabled,
}: {
  backdrop: {
    pool: SkinBackdropRowPool;
    selected: PreviewBackdrop | null;
    onPick: (choice: PreviewBackdrop) => void;
    scope: BackdropScope;
    onScopeChange: (scope: BackdropScope) => void;
    // The keymode a "this one only" pick would apply to, e.g. "4K".
    keymodeLabel: string;
    hint?: React.ReactNode;
  };
  pattern: {
    pool: SkinPatternPool;
    // Undefined is a historical flattened preview whose recipe is unknown;
    // null is the explicitly selected built-in pattern.
    selected: SkinPreviewChartSnippet | null | undefined;
    onPick: (choice: SkinPreviewChartSnippet | null) => void;
  };
  disabled: boolean;
}) {
  const { t } = useLingui();
  const [tab, setTab] = useState<PickerTab>("backdrop");
  const showing = tab === "backdrop" ? backdrop.pool : pattern.pool;

  return (
    <div className="mt-3 flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-osu-f1/55"><Trans>Preview</Trans></span>
        {/* Switching tabs is free even mid-render, so it stays live while the
            rows underneath are disabled. */}
        {(["backdrop", "pattern"] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setTab(option)}
            aria-pressed={tab === option}
            className={`border-b-2 pb-0.5 text-[10px] font-bold uppercase tracking-[0.08em] transition-colors cursor-pointer ${
              tab === option ? "border-osu-pink text-osu-l1" : "border-transparent text-osu-f1/55 hover:text-osu-l2"
            }`}
          >
            {option === "backdrop" ? <Trans>backdrop</Trans> : <Trans>pattern</Trans>}
          </button>
        ))}
        {tab === "backdrop" && (
          <SkinBackdropScopeToggle
            scope={backdrop.scope}
            onScopeChange={backdrop.onScopeChange}
            keymodeLabel={backdrop.keymodeLabel}
            disabled={disabled}
          />
        )}
        <button
          type="button"
          disabled={disabled || showing.drawing}
          onClick={() => showing.shuffle()}
          title={tab === "backdrop" ? t`Draw a different set of map covers` : t`Draw a different set of charts`}
          className="flex items-center gap-1 rounded border border-osu-b3/40 bg-osu-b5 px-1.5 py-0.5 text-[10px] font-bold text-osu-l2 transition-colors cursor-pointer hover:border-osu-f1/40 disabled:cursor-default disabled:opacity-50"
        >
          <Shuffle size={11} aria-hidden="true" />
          {showing.drawing ? <Trans>drawing</Trans> : <Trans>shuffle</Trans>}
        </button>
        {tab === "backdrop" && backdrop.hint}
      </div>
      {/* Wrapping, not scrolling: with only one picker on screen at a time
          there is room for the couple of rows a full pool takes, and nothing
          sits off an edge with no way to tell. */}
      <div className="flex flex-wrap items-center gap-1.5">
        {tab === "backdrop" ? (
          <SkinBackdropRow
            pool={backdrop.pool}
            selected={backdrop.selected}
            onPick={backdrop.onPick}
            disabled={disabled}
          />
        ) : (
          <SkinPatternRow
            pool={pattern.pool}
            selected={pattern.selected}
            onPick={pattern.onPick}
            disabled={disabled}
          />
        )}
      </div>
    </div>
  );
}
