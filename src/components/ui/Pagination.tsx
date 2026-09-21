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

  const pageControl = (target: number, disabled: boolean, title: string, children: ReactNode, compact = false) => {
    const className = `${compact ? "px-2.5" : "px-3"} py-2 rounded-lg bg-osu-b4 text-xs text-osu-l2 hover:bg-osu-b3 transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-default disabled:hover:bg-osu-b4`;
    if (renderPageLink && !disabled) return renderPageLink(target, { className, title, children });
    return (
      <button type="button" onClick={() => onPageChange(target)} disabled={disabled} className={className} title={title}>
        {children}
      </button>
    );
  };

  return (
    <div className="flex items-center justify-center gap-1.5 mt-6">
      {/* First */}
      {pageControl(0, page === 0, t`First page`, "«", true)}

      {/* Prev */}
      {pageControl(page - 1, page === 0, t`Previous page`, <Trans>&larr; Prev</Trans>)}

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
          className="text-xs text-osu-f1 px-3 py-1 rounded hover:bg-osu-b4 transition-colors cursor-pointer"
          title={t`Click to jump to page`}
        >
          <Trans>Page {page + 1} of {totalPages}</Trans>
        </button>
      )}

      {/* Next */}
      {pageControl(page + 1, page >= totalPages - 1, t`Next page`, <Trans>Next &rarr;</Trans>)}

      {/* Last */}
      {pageControl(totalPages - 1, page >= totalPages - 1, t`Last page`, "»", true)}
    </div>
  );
}
