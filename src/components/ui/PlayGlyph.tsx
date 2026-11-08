/**
 * Drawn play triangle for replay buttons. The U+25B6 text glyph renders as a
 * color emoji on iOS, so the buttons use this instead.
 */
export function PlayGlyph({ className = "" }: { className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 10 12" fill="currentColor" className={`shrink-0 ${className}`}>
      <path d="M1.6 0.6C0.9 0.15 0 0.65 0 1.48v9.04c0 .83.9 1.33 1.6.88l7.6-4.52a1.03 1.03 0 0 0 0-1.76L1.6.6Z" />
    </svg>
  );
}
