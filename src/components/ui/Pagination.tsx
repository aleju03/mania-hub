import { useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";

interface PaginationProps {
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
}

export function Pagination({ page, totalPages, onPageChange }: PaginationProps) {
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

  return (
    <div className="flex items-center justify-center gap-1.5 mt-6">
      {/* First */}
      <button
        onClick={() => onPageChange(0)}
        disabled={page === 0}
        className="px-2.5 py-2 rounded-lg bg-osu-b4 text-xs text-osu-l2 hover:bg-osu-b3 transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-default disabled:hover:bg-osu-b4"
        title={t`First page`}
      >
        &laquo;
      </button>

      {/* Prev */}
      <button
        onClick={() => onPageChange(page - 1)}
        disabled={page === 0}
        className="px-3 py-2 rounded-lg bg-osu-b4 text-xs text-osu-l2 hover:bg-osu-b3 transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-default disabled:hover:bg-osu-b4"
        title={t`Previous page`}
      >
        <Trans>&larr; Prev</Trans>
      </button>

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
      <button
        onClick={() => onPageChange(page + 1)}
        disabled={page >= totalPages - 1}
        className="px-3 py-2 rounded-lg bg-osu-b4 text-xs text-osu-l2 hover:bg-osu-b3 transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-default disabled:hover:bg-osu-b4"
        title={t`Next page`}
      >
        <Trans>Next &rarr;</Trans>
      </button>

      {/* Last */}
      <button
        onClick={() => onPageChange(totalPages - 1)}
        disabled={page >= totalPages - 1}
        className="px-2.5 py-2 rounded-lg bg-osu-b4 text-xs text-osu-l2 hover:bg-osu-b3 transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-default disabled:hover:bg-osu-b4"
        title={t`Last page`}
      >
        &raquo;
      </button>
    </div>
  );
}
