import { useState, type ReactNode } from "react";
import { Trans, useLingui } from "@lingui/react/macro";

interface PaginationProps {
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  // Crawlable catalogue routes supply router links; other surfaces keep
  // their existing buttons. Unavailable destinations always stay disabled.
  renderPageLink?: (page: number, props: { className: string; title: string; children: ReactNode }) => ReactNode;
}

export function Pagination({ page, totalPages, onPageChange, renderPageLink }: PaginationProps) {
  const { t } = useLingui();
  const [inputValue, setInputValue] = useState("");
  const [showInput, setShowInput] = useState(false);

  const handleInputSubmit = () => {
    const parsed = parseInt(inputValue, 10);
    if (parsed >= 1 && parsed <= totalPages) {
      onPageChange(parsed - 1);
    }
    setShowInput(false);
    setInputValue("");
  };

  if (totalPages <= 1) return null;

  // Round controls with drawn chevrons (the arrow glyphs render oddly in the
  // site font). Prev/next carry their label from sm up; on phones every
  // control is a 40px icon button so the row fits on one line.
  const pageControl = (target: number, disabled: boolean, title: string, children: ReactNode, labelled = false) => {
    const className = `inline-flex h-10 items-center justify-center gap-1.5 rounded-full bg-osu-b4 text-[13px] font-semibold text-osu-l2 transition-colors hover:bg-osu-b3 hover:text-osu-l1 cursor-pointer disabled:opacity-30 disabled:cursor-default disabled:hover:bg-osu-b4 disabled:hover:text-osu-l2 sm:h-9 ${labelled ? "w-10 sm:w-auto sm:px-4" : "w-10 sm:w-9"}`;
    if (renderPageLink && !disabled) return renderPageLink(target, { className, title, children });
    return (
      <button type="button" onClick={() => onPageChange(target)} disabled={disabled} className={className} title={title} aria-label={title}>
        {children}
      </button>
    );
  };

  return (
    <div className="flex items-center justify-center gap-2 mt-6">
      {pageControl(0, page === 0, t`First page`, <Chevrons dir="left" double />)}
      {pageControl(page - 1, page === 0, t`Previous page`, (
        <>
          <Chevrons dir="left" />
          <span className="hidden sm:inline"><Trans>Previous</Trans></span>
        </>
      ), true)}

      {/* Page indicator / input */}
      {showInput ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleInputSubmit();
          }}
          className="flex items-center gap-1 px-1"
        >
          <input
            type="number"
            min={1}
            max={totalPages}
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onBlur={handleInputSubmit}
            autoFocus
            className="w-12 px-1.5 py-1 rounded bg-osu-b5 text-xs text-osu-l1 text-center border border-osu-b3 outline-none focus:border-osu-l3 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
            placeholder={String(page + 1)}
          />
          <span className="text-xs text-osu-f1">/ {totalPages}</span>
        </form>
      ) : (
        <button
          onClick={() => {
            setInputValue(String(page + 1));
            setShowInput(true);
          }}
          className="whitespace-nowrap px-2 py-1 text-[13px] tabular-nums text-osu-f1 rounded-full hover:text-osu-l1 transition-colors cursor-pointer"
          title={t`Click to jump to page`}
        >
          <Trans>Page {page + 1} of {totalPages}</Trans>
        </button>
      )}

      {pageControl(page + 1, page >= totalPages - 1, t`Next page`, (
        <>
          <span className="hidden sm:inline"><Trans>Next</Trans></span>
          <Chevrons dir="right" />
        </>
      ), true)}
      {pageControl(totalPages - 1, page >= totalPages - 1, t`Last page`, <Chevrons dir="right" double />)}
    </div>
  );
}

function Chevrons({ dir, double = false }: { dir: "left" | "right"; double?: boolean }) {
  const path = dir === "left" ? "m15 18-6-6 6-6" : "m9 18 6-6-6-6";
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 shrink-0" aria-hidden="true">
      {double ? (
        <>
          <path d={path} transform={`translate(${dir === "left" ? -3.5 : 3.5} 0)`} />
          <path d={path} transform={`translate(${dir === "left" ? 3.5 : -3.5} 0)`} />
        </>
      ) : (
        <path d={path} />
      )}
    </svg>
  );
}
