import { useLingui } from "@lingui/react/macro";
import { useEffect, useState } from "react";
import { Loader2, X } from "lucide-react";
import {
  COMMUNITY_PITCH_MAX_LENGTH,
  type CommunitySummary,
} from "../../lib/communities-shared";
import { deleteMyCommunity, updateMyCommunity } from "../../lib/communities";
import { useAuth } from "../../lib/auth-context";
import { useBodyScrollLock } from "../../lib/use-body-scroll-lock";
import { SelectMenu } from "../ui/SelectMenu";
import { CommunityStatusNote } from "./CommunityStatusNote";
import { AccessScopePicker } from "./AccessScopePicker";
import { useCommunityErrorMessage, useCountrySelectOptions, useLanguageSelectOptions } from "./field-options";
import { TagInput } from "./TagInput";

/*
 * Editing a listing you posted, opened from the pencil on its own card.
 *
 * There used to be a panel above the grid holding a second copy of every
 * listing you own just to hang these two buttons off. The card is already on
 * screen and already yours; this is the same work without the duplicate row.
 *
 * The server it points at cannot be changed here. Swapping the guild is not an
 * edit, it is a different listing, and it would walk around the Discord
 * ownership proof that was taken when this one was posted.
 */

const FIELD_CLASS =
  "w-full rounded-lg border border-osu-b3/30 bg-osu-b4 px-3 py-2 text-[13px] text-osu-l1 transition-colors placeholder:text-osu-f1/55 focus:border-osu-pink/50 focus:outline-none";

export function CommunityEditModal({
  community,
  onChanged,
  onRemoved,
  onClose,
}: {
  community: CommunitySummary;
  onChanged: (community: CommunitySummary) => void;
  onRemoved: (id: string) => void;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const errorMessage = useCommunityErrorMessage();
  const auth = useAuth();
  const countryOptions = useCountrySelectOptions(auth.viewer?.countryCode ?? null);
  const languageOptions = useLanguageSelectOptions();
  const [pitch, setPitch] = useState(community.pitch);
  const [tags, setTags] = useState<string[]>(community.tags);
  const [countryCode, setCountryCode] = useState(community.countryCode ?? "");
  const [language, setLanguage] = useState(community.language ?? "");
  const [accessScopes, setAccessScopes] = useState<string[]>(community.accessScopes ?? []);
  const [accessHidden, setAccessHidden] = useState(community.accessHidden === true);
  const [invite, setInvite] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  useBodyScrollLock(true);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await updateMyCommunity({
        data: { id: community.id, invite, pitch, countryCode, language, tags, accessScopes, accessHidden },
      });
      if (!result.ok) {
        setError(errorMessage(result.error));
        return;
      }
      onChanged(result.community);
      onClose();
    } catch {
      setError(t`Could not save that. Try again.`);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await deleteMyCommunity({ data: { id: community.id } });
      if (result.ok) {
        onRemoved(community.id);
        onClose();
        return;
      }
      setError(t`Could not remove that listing.`);
    } catch {
      setError(t`Could not remove that listing.`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      /* Padded a side at a time so the right side can carry the scrollbar width
         the body lock takes away, the way every other modal on the site does. */
      className="fixed inset-0 z-50 flex justify-center overflow-y-auto bg-black/70 py-3 pl-3 pr-[calc(0.75rem+var(--modal-scrollbar-compensation,0px))] sm:py-4 sm:pl-4 sm:pr-[calc(1rem+var(--modal-scrollbar-compensation,0px))]"
      role="dialog"
      aria-modal="true"
      aria-label={`Edit ${community.name}`}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      {/* No overflow-hidden: the country and language popovers open downward and
          would be cut off by it. */}
      <div className="my-auto w-full max-w-lg rounded-xl border border-osu-b3/30 bg-osu-b5">
        <div className="flex items-center gap-2.5 border-b border-osu-b3/30 px-4 py-3">
          {community.iconUrl ? (
            <img
              src={community.iconUrl}
              alt=""
              width={28}
              height={28}
              className="h-7 w-7 shrink-0 rounded-xl object-cover"
            />
          ) : (
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-xl bg-osu-b3/40 text-[12px] font-bold text-osu-l2" aria-hidden="true">
              {community.name.slice(0, 1).toUpperCase()}
            </span>
          )}
          <h2 className="min-w-0 flex-1 truncate text-[14px] font-bold text-white">{community.name}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t`Close`}
            className="shrink-0 text-osu-f1 transition-colors cursor-pointer hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3.5 px-4 py-4">
          <CommunityStatusNote community={community} />

          <label className="block">
            <span className="mb-1 block text-[11px] font-bold uppercase tracking-[0.08em] text-osu-f1/55">
              {t`What is it for`}
            </span>
            <textarea
              value={pitch}
              onChange={(event) => setPitch(event.target.value.slice(0, COMMUNITY_PITCH_MAX_LENGTH))}
              rows={6}
              className={`${FIELD_CLASS} resize-y`}
            />
            <span className="mt-1 block text-right text-[11px] text-osu-f1/70 tabular-nums">
              {pitch.length}/{COMMUNITY_PITCH_MAX_LENGTH}
            </span>
          </label>

          <div>
            <span className="mb-1 block text-[11px] font-bold uppercase tracking-[0.08em] text-osu-f1/55">
              {t`Tags`}
            </span>
            <TagInput tags={tags} onChange={setTags} />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <span className="mb-1 block text-[11px] font-bold uppercase tracking-[0.08em] text-osu-f1/55">
                {t`Country`}
              </span>
              <SelectMenu
                value={countryCode}
                options={countryOptions}
                onChange={setCountryCode}
                ariaLabel={t`Country`}
                block
                searchable
                searchPlaceholder={t`Search countries`}
              />
            </div>
            <div>
              <span className="mb-1 block text-[11px] font-bold uppercase tracking-[0.08em] text-osu-f1/55">
                {t`Language`}
              </span>
              <SelectMenu
                value={language}
                options={languageOptions}
                onChange={setLanguage}
                ariaLabel={t`Language`}
                block
                searchable
                searchPlaceholder={t`Search languages`}
              />
            </div>
          </div>

          <div>
            <span className="mb-1 block text-[11px] font-bold uppercase tracking-[0.08em] text-osu-f1/55">
              {t`Who can join`}
            </span>
            <AccessScopePicker
              scopes={accessScopes}
              hidden={accessHidden}
              onChange={(next) => {
                setAccessScopes(next.scopes);
                setAccessHidden(next.hidden);
              }}
            />
          </div>

          <label className="block">
            <span className="mb-1 block text-[11px] font-bold uppercase tracking-[0.08em] text-osu-f1/55">
              {t`New invite link`}
            </span>
            <input
              type="text"
              value={invite}
              onChange={(event) => setInvite(event.target.value)}
              placeholder={t`leave empty to keep the current one`}
              className={FIELD_CLASS}
            />
          </label>

          {error && <p className="text-[11.5px] text-osu-pink-light">{error}</p>}

          <div className="flex items-center gap-3 pt-0.5">
            <button
              type="button"
              onClick={save}
              disabled={busy || pitch.trim() === ""}
              className="inline-flex items-center justify-center gap-2 rounded-full bg-osu-pink px-4 py-1.5 text-[12.5px] font-bold text-white transition cursor-pointer hover:brightness-110 disabled:cursor-default disabled:opacity-40"
            >
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
              {t`Save`}
            </button>
            {/* Removing asks in the row it lives in rather than through a
                browser dialog, the same two-step shape the skin delete uses. */}
            <div className="ml-auto flex items-center gap-3 text-[12px]">
              {confirmingRemove && <span className="text-osu-f1">{t`Take it down for good?`}</span>}
              <button
                type="button"
                onClick={() => (confirmingRemove ? void remove() : setConfirmingRemove(true))}
                disabled={busy}
                className={`font-semibold transition-colors cursor-pointer disabled:opacity-40 ${
                  confirmingRemove ? "text-osu-red hover:brightness-125" : "text-osu-f1 hover:text-osu-red-light"
                }`}
              >
                {confirmingRemove ? t`remove` : t`remove listing`}
              </button>
              {confirmingRemove && (
                <button
                  type="button"
                  onClick={() => setConfirmingRemove(false)}
                  disabled={busy}
                  className="font-semibold text-osu-f1 transition-colors cursor-pointer hover:text-white disabled:opacity-40"
                >
                  {t`keep it`}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
