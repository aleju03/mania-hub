import { Trans, useLingui } from "@lingui/react/macro";
import { Star, X } from "lucide-react";
import { useRef } from "react";
import { SKIN_MAX_SCREENSHOTS, SKIN_SCREENSHOT_LABEL_MAX_LENGTH } from "../../lib/skins";

// The screenshots a skin carries, as a form: name each one, star one as the
// card cover, and (where the caller allows it) add and remove them. Shared by
// the upload modal, the bulk queue's per-file editor, and the post-publish
// preview editor, which all offer the same thing over different sources - two
// hold local drafts, one holds what is already stored, and only the drafts can
// still grow or shrink.
//
// Naming a shot is what titles it in the skin page's gallery ("Score screen"
// rather than "Shot 2"); starring one puts it on the browse card in place of a
// rendered playfield.

export interface SkinScreenshotField {
  url: string;
  label: string;
}

export function SkinScreenshotFields({
  screenshots,
  onRename,
  onAdd,
  onRemove,
  cover,
  onCover,
  disabled = false,
}: {
  screenshots: SkinScreenshotField[];
  onRename: (index: number, label: string) => void;
  // Left out where images cannot arrive or leave: a published skin's shots are
  // fixed, and only their names and the cover star are still editable.
  onAdd?: (files: FileList | null) => void;
  onRemove?: (index: number) => void;
  // Which shot fronts the browse card, if one does. Leaving onCover out drops
  // the star, for a form where the cover is not this component's business.
  cover?: number | null;
  onCover?: (index: number | null) => void;
  disabled?: boolean;
}) {
  const { t } = useLingui();
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-osu-f1/55">
        {t`Screenshots`}
        {onAdd && (
          <span className="normal-case tracking-normal text-osu-f1/70"> <Trans>(optional, up to {SKIN_MAX_SCREENSHOTS})</Trans></span>
        )}
      </span>
      {screenshots.map((shot, index) => (
        <div key={shot.url} className="flex items-center gap-2">
          <img
            src={shot.url}
            alt={t`Screenshot ${index + 1}`}
            loading="lazy"
            className="h-11 w-[74px] shrink-0 rounded-md border border-osu-b3/40 object-cover"
          />
          <input
            type="text"
            value={shot.label}
            maxLength={SKIN_SCREENSHOT_LABEL_MAX_LENGTH}
            disabled={disabled}
            onChange={(event) => onRename(index, event.target.value)}
            placeholder={t`Shot ${index + 1}`}
            aria-label={t`Name for screenshot ${index + 1}`}
            className="min-w-0 flex-1 rounded-lg border border-osu-b3/30 bg-osu-b4 px-2.5 py-1.5 text-[12.5px] text-osu-l1 transition-colors placeholder:text-osu-f1/45 focus:border-osu-pink/50 focus:outline-none"
          />
          {onCover && (
            <button
              type="button"
              disabled={disabled}
              onClick={() => onCover(cover === index ? null : index)}
              aria-pressed={cover === index}
              title={cover === index ? t`Fronts the browse card` : t`Use this screenshot as the card cover`}
              aria-label={cover === index ? t`Fronts the browse card` : t`Use screenshot ${index + 1} as the card cover`}
              className={`shrink-0 rounded p-1 transition-colors cursor-pointer disabled:cursor-default disabled:opacity-50 ${
                cover === index ? "text-osu-pink" : "text-osu-f1 hover:text-osu-l1"
              }`}
            >
              <Star className="h-3.5 w-3.5" fill={cover === index ? "currentColor" : "none"} />
            </button>
          )}
          {onRemove && (
            <button
              type="button"
              disabled={disabled}
              onClick={() => onRemove(index)}
              aria-label={t`Remove screenshot ${index + 1}`}
              className="shrink-0 rounded p-1 text-osu-f1 transition-colors cursor-pointer hover:text-white disabled:cursor-default disabled:opacity-50"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      ))}
      {onAdd && screenshots.length < SKIN_MAX_SCREENSHOTS && !disabled && (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="flex h-11 items-center justify-center rounded-md border border-dashed border-osu-b3/60 text-[12px] font-semibold text-osu-f1 transition-colors cursor-pointer hover:border-osu-pink/45 hover:text-osu-l2"
        >
          {t`Add a screenshot`}
        </button>
      )}
      {onAdd && (
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          multiple
          className="sr-only"
          onChange={(event) => {
            onAdd(event.target.files);
            event.target.value = "";
          }}
        />
      )}
    </div>
  );
}
