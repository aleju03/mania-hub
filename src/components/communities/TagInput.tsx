import { useState } from "react";
import { X } from "lucide-react";
import {
  COMMUNITY_MAX_TAGS,
  normalizeCommunityTag,
} from "../../lib/communities-shared";

/*
 * Up to five owner-typed tags.
 *
 * Free text rather than a vocabulary, because a fixed list of keymodes and
 * purposes was the part that read wrong on a directory of Discord servers. What
 * people type here becomes the filter row on the directory, so the input shows
 * the cleaned form as it goes in: a tag that will be stored as "ln" should not
 * sit in the box looking like "LN!!".
 */
export function TagInput({
  tags,
  onChange,
  // Deliberately not a language or a country: whatever sits here is what half
  // the directory ends up tagged with, and those two are already their own
  // fields. These are kinds of server instead.
  placeholder = "tournaments, mapping, casual",
}: {
  tags: string[];
  onChange: (tags: string[]) => void;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState("");
  const full = tags.length >= COMMUNITY_MAX_TAGS;

  const add = (raw: string) => {
    const tag = normalizeCommunityTag(raw);
    setDraft("");
    if (tag === "" || tags.includes(tag) || full) return;
    onChange([...tags, tag]);
  };

  return (
    <div>
    <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-osu-b3/30 bg-osu-b4 px-2 py-1.5 focus-within:border-osu-pink/50">
      {tags.map((tag) => (
        <span
          key={tag}
          className="inline-flex items-center gap-1 rounded-full bg-osu-b3/50 py-0.5 pl-2.5 pr-1.5 text-[11.5px] font-semibold text-osu-l2"
        >
          {tag}
          <button
            type="button"
            onClick={() => onChange(tags.filter((entry) => entry !== tag))}
            aria-label={`Remove ${tag}`}
            className="text-osu-f1 transition-colors cursor-pointer hover:text-white"
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      <input
        type="text"
        value={draft}
        onChange={(event) => {
          // A comma is how most people separate tags, so treat typing one as
          // pressing enter rather than as a character.
          if (event.target.value.includes(",")) add(event.target.value);
          else setDraft(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            add(draft);
          } else if (event.key === "Backspace" && draft === "" && tags.length > 0) {
            onChange(tags.slice(0, -1));
          }
        }}
        onBlur={() => add(draft)}
        placeholder={full ? "" : tags.length === 0 ? placeholder : "add another"}
        disabled={full}
        aria-label="Tags"
        className="min-w-[7rem] flex-1 bg-transparent px-1 py-0.5 text-[13px] text-osu-l1 placeholder:text-osu-f1/55 focus:outline-none disabled:cursor-default"
      />
    </div>
    {/* The comma is the whole instruction, so it leads. It used to be implied
        by the placeholder's "tournaments, mapping, casual", which reads as
        three examples rather than as how to type them. */}
    <span className="mt-1 block text-[11px] leading-relaxed text-osu-f1/70">
      {full
        ? `That is all ${COMMUNITY_MAX_TAGS}. Remove one to add another.`
        : `Comma after each one. Up to ${COMMUNITY_MAX_TAGS}, and they become filters people browse by, so use words someone would actually search for.`}
    </span>
    </div>
  );
}
