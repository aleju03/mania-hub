import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, Loader2, ShieldCheck, X } from "lucide-react";
import {
  COMMUNITY_PITCH_MAX_LENGTH,
  communityErrorMessage,
  communityInviteExpiryLabel,
  type CommunityInvitePreview,
  type CommunitySummary,
  type ManageableGuild,
} from "../../lib/communities-shared";
import { SelectMenu } from "../ui/SelectMenu";
import { DiscordLogo, DISCORD_BLURPLE } from "../ui/DiscordLogo";
import {
  checkCommunityInvite,
  disconnectDiscord,
  fetchManageableGuilds,
  submitCommunity,
} from "../../lib/communities";
import { useBodyScrollLock } from "../../lib/use-body-scroll-lock";
import { useAuth } from "../../lib/auth-context";
import { CommunityCard } from "./CommunityCard";
// Both pickers get a filter box: one is every country, the other is most of the
// languages people play in, and scrolling either for one entry is worse than
// typing three letters. Shared with the edit form, so the two agree.
import { countrySelectOptions, LANGUAGE_SELECT_OPTIONS } from "./field-options";
import { AccessScopePicker } from "./AccessScopePicker";
import { TagInput } from "./TagInput";

/*
 * Posting a server, in four steps: connect Discord, pick one of your servers,
 * give an invite for it, describe it.
 *
 * The picker only ever lists servers this Discord account owns or has Manage
 * Server on, and the submit handler re-derives that list server-side rather than
 * trusting what was picked here. So this component is a convenience, not the
 * ownership check.
 */

type Step = "connect" | "pick" | "details" | "done";

const FIELD_CLASS =
  "w-full rounded-lg border border-osu-b3/30 bg-osu-b4 px-3 py-2 text-[13px] text-osu-l1 transition-colors placeholder:text-osu-f1/55 focus:border-osu-pink/50 focus:outline-none";

// What the OAuth consent screen is about to ask for, said plainly here first so
// the Discord screen holds no surprises. These are exactly the identify and
// guilds scopes in buildDiscordAuthorizeUrl; keep the two in step.
const CONSENT_LINES = [
  "Your Discord username and avatar",
  // Deliberately not "the servers you own or manage": the guilds scope hands
  // over the whole list and we filter it here, and Discord's own screen says as
  // much a click later. Saying the smaller thing would read as a cover-up the
  // moment the two are seen together, so this says the true thing and why.
  "Which servers you are in, so we can show you the ones you can post",
];

// Long enough that pasting a link does not fire a lookup per character, short
// enough that the answer feels like it came from the paste.
const INVITE_CHECK_DELAY_MS = 600;

// Past this many servers the picker scrolls, and scrolling a list of names
// looking for one name is worse than typing it.
const GUILD_FILTER_THRESHOLD = 6;

type InviteCheck =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "ok"; preview: CommunityInvitePreview }
  | { status: "error"; message: string };

export function CommunitySubmitModal({
  discordUsername,
  discordAvatarUrl,
  ownerUsername,
  initialError,
  onClose,
  onDisconnected,
  onSubmitted,
}: {
  // Non-null when a Discord connection is already in hand, which skips step one.
  discordUsername: string | null;
  discordAvatarUrl: string | null;
  // The osu! name the card will carry, for the preview's "posted by".
  ownerUsername: string;
  // Set when the connection came back broken, so the reason is on screen
  // instead of the modal silently reopening at step one.
  initialError?: string | null;
  onClose: () => void;
  onDisconnected: () => void;
  onSubmitted: (community: CommunitySummary) => void;
}) {
  const auth = useAuth();
  const countryOptions = useMemo(() => countrySelectOptions(auth.viewer?.countryCode ?? null), [auth.viewer?.countryCode]);
  const [step, setStep] = useState<Step>(discordUsername ? "pick" : "connect");
  const [guilds, setGuilds] = useState<ManageableGuild[]>([]);
  const [guildFilter, setGuildFilter] = useState("");
  const [loadingGuilds, setLoadingGuilds] = useState(false);
  const [guild, setGuild] = useState<ManageableGuild | null>(null);
  const [invite, setInvite] = useState("");
  const [inviteCheck, setInviteCheck] = useState<InviteCheck>({ status: "idle" });
  // Which guild the widget lookup has already been tried for, so picking a
  // different server tries again and nothing tries twice.
  const [autoFilledFor, setAutoFilledFor] = useState<string | null>(null);
  const [pitch, setPitch] = useState("");
  const [countryCode, setCountryCode] = useState("");
  const [language, setLanguage] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [accessScopes, setAccessScopes] = useState<string[]>([]);
  const [accessHidden, setAccessHidden] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(initialError ?? null);

  // The form is taller than a phone, so the overlay is what scrolls. Without
  // this the page underneath scrolls with it and the modal drifts off its own
  // fields halfway through filling them in.
  useBodyScrollLock(true);

  /* Held in a ref so loadGuilds can stay a stable callback: the effect that
     calls it would otherwise re-run on every render, and for someone with no
     manageable servers the empty-list guard would never stop it. */
  const onDisconnectedRef = useRef(onDisconnected);
  useEffect(() => {
    onDisconnectedRef.current = onDisconnected;
  });

  const loadGuilds = useCallback(async () => {
    setLoadingGuilds(true);
    setError(null);
    try {
      const result = await fetchManageableGuilds();
      if (!result.ok) {
        setError(communityErrorMessage(result.error));
        setStep("connect");
        /* The connection lasts thirty minutes, so a modal opened later in the
           session finds it gone. Say so all the way up, or the header keeps
           claiming a connection while the step under it asks for one. */
        if (result.error === "no_discord") onDisconnectedRef.current();
        return;
      }
      setGuilds(result.guilds);
    } catch {
      setError("Could not read your Discord servers. Try connecting again.");
      setStep("connect");
    } finally {
      setLoadingGuilds(false);
    }
  }, []);

  useEffect(() => {
    if (step === "pick" && guilds.length === 0 && !loadingGuilds) void loadGuilds();
  }, [step, guilds.length, loadingGuilds, loadGuilds]);

  /*
   * The connection lands a moment after the page does, because it is read by a
   * server function rather than rendered in. A modal opened on the way back
   * from Discord therefore mounts while the username is still null, and without
   * this it would sit on Connect with the proof already in hand - which reads
   * as the authorise having done nothing at all.
   */
  useEffect(() => {
    if (discordUsername && step === "connect" && !error) setStep("pick");
  }, [discordUsername, step, error]);

  /*
   * The invite is checked against Discord while it is being typed, rather than
   * on submit. It is the one field that can be wrong in ways nobody can see -
   * an invite for the wrong server, one that quietly expires - and finding that
   * out after writing a description is a bad trade for one lookup.
   */
  useEffect(() => {
    const value = invite.trim();
    if (!guild || value === "") {
      setInviteCheck({ status: "idle" });
      return;
    }
    setInviteCheck({ status: "checking" });
    let cancelled = false;
    const timer = setTimeout(() => {
      checkCommunityInvite({ data: { invite: value, guildId: guild.id } })
        .then((result) => {
          if (cancelled) return;
          setInviteCheck(
            result.ok && result.invite
              ? { status: "ok", preview: result.invite }
              : { status: "error", message: communityErrorMessage(result.error) },
          );
        })
        .catch(() => {
          if (!cancelled) setInviteCheck({ status: "error", message: "Could not check that invite. Try again." });
        });
    }, INVITE_CHECK_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [invite, guild]);

  /*
   * Fill the invite in by itself where that is possible at all.
   *
   * Discord gives an OAuth app no way to create an invite - that is a bot
   * action inside the server, and identify + guilds grants nothing like it. The
   * one exception is a server that has its widget switched on, which publishes a
   * permanent invite at an unauthenticated URL; the backend looks there. For
   * every other server the field asks, which is why it says so.
   */
  useEffect(() => {
    if (step !== "details" || !guild || invite !== "" || autoFilledFor === guild.id) return;
    setAutoFilledFor(guild.id);
    setInviteCheck({ status: "checking" });
    checkCommunityInvite({ data: { invite: "", guildId: guild.id } })
      .then((result) => {
        if (result.ok && result.invite) setInvite(result.invite.inviteUrl);
        else setInviteCheck({ status: "idle" });
      })
      .catch(() => setInviteCheck({ status: "idle" }));
  }, [step, guild, invite, autoFilledFor]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const handleSubmit = async () => {
    if (!guild) return;
    if (pitch.trim() === "") {
      setError("Write a short description of the server.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await submitCommunity({
        data: {
          guildId: guild.id,
          invite,
          pitch,
          countryCode,
          language,
          tags,
          accessScopes,
          accessHidden,
        },
      });
      if (!result.ok) {
        setError(communityErrorMessage(result.error));
        return;
      }
      setStep("done");
      onSubmitted(result.community);
    } catch {
      setError("Could not submit that. Try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleDisconnect = async () => {
    await disconnectDiscord().catch(() => undefined);
    setGuilds([]);
    setGuildFilter("");
    setGuild(null);
    setError(null);
    setStep("connect");
    onDisconnected();
  };

  const connectHref = `/api/auth/discord?next=${encodeURIComponent("/communities")}`;

  /* Plain substring on the name, which is what someone typing "costa" into a
     list of their own servers means. Discord's own picker matches the same way,
     and a fuzzier match would put the wrong server under the cursor. */
  const guildQuery = guildFilter.trim().toLowerCase();
  const visibleGuilds = guildQuery
    ? guilds.filter((entry) => entry.name.toLowerCase().includes(guildQuery))
    : guilds;

  /*
   * The card as it will appear on the directory, drawn by the same component
   * that draws the real thing so nothing can look right here and wrong there.
   * Anything Discord has confirmed comes from the resolved invite; before that
   * it falls back to what the picker knew.
   */
  const resolved = inviteCheck.status === "ok" ? inviteCheck.preview : null;
  const previewCommunity: CommunitySummary | null = guild && {
    id: "preview",
    guildId: guild.id,
    name: resolved?.name ?? guild.name,
    inviteUrl: resolved?.inviteUrl ?? null,
    iconUrl: resolved?.iconUrl ?? guild.iconUrl,
    bannerUrl: resolved?.bannerUrl ?? null,
    memberCount: resolved?.memberCount ?? guild.memberCount ?? 0,
    onlineCount: resolved?.onlineCount ?? 0,
    pitch: pitch.trim() === "" ? "Your description shows up here." : pitch,
    countryCode: countryCode || null,
    language: language || null,
    tags,
    accessScopes,
    // A real id rather than a placeholder, so the preview draws your own osu!
    // avatar on the "posted by" line instead of an empty circle.
    ownerUserId: auth.viewer?.id ?? 0,
    ownerUsername,
    createdAt: new Date().toISOString(),
  };

  return (
    <div
      /* Padded a side at a time so the right side can carry the scrollbar width
         the body lock takes away, the way every other modal on the site does.
         Centring is my-auto on the card rather than items-center here: an
         align-items centre puts the top of an over-tall modal above the scroll
         area, where it cannot be reached. Auto margins collapse to zero once
         there is no room, so the details step still starts at its own header. */
      className="fixed inset-0 z-50 flex justify-center overflow-y-auto bg-black/70 py-3 pl-3 pr-[calc(0.75rem+var(--modal-scrollbar-compensation,0px))] sm:py-4 sm:pl-4 sm:pr-[calc(1rem+var(--modal-scrollbar-compensation,0px))]"
      role="dialog"
      aria-modal="true"
      aria-label="Post a Discord server"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      {/* No overflow-hidden: the country and language popovers open downward and
          would be cut off by it. */}
      {/* The details step earns the extra width: the form sits beside the card
          it is describing, so nobody has to imagine the result. */}
      <div
        className={`my-auto w-full rounded-xl border border-osu-b3/30 bg-osu-b5 ${
          step === "details" ? "max-w-3xl" : "max-w-lg"
        }`}
      >
        {/* Discord's own blurple across the top, and its mark beside the title:
            this flow hands someone to Discord and back, so it should look like
            it belongs to Discord rather than like a form asking for a password. */}
        <div className="h-1 rounded-t-xl" style={{ backgroundColor: DISCORD_BLURPLE }} aria-hidden="true" />
        <div className="flex items-center gap-2.5 border-b border-osu-b3/30 px-4 py-3">
          <DiscordLogo className="h-5 w-5 shrink-0" />
          <h2 className="flex-1 text-[14px] font-bold text-white">Post your Discord server</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-osu-f1 transition-colors cursor-pointer hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 px-4 py-4">
          {/* Who the proof belongs to, kept on screen from the moment it is in
              hand until the listing is sent. It used to live inside the picker
              step only, which left "am I connected or not" an open question on
              every other step. */}
          {discordUsername && step !== "done" && (
            <div className="flex items-center gap-2.5">
              {discordAvatarUrl ? (
                <img
                  src={discordAvatarUrl}
                  alt=""
                  width={32}
                  height={32}
                  className="h-8 w-8 shrink-0 rounded-full object-cover"
                />
              ) : (
                <span
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-white"
                  style={{ backgroundColor: DISCORD_BLURPLE }}
                  aria-hidden="true"
                >
                  <DiscordLogo className="h-4 w-4" />
                </span>
              )}
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-bold text-white">{discordUsername}</div>
                <div className="text-[11px] text-osu-f1">connected to Discord</div>
              </div>
              <button
                type="button"
                onClick={handleDisconnect}
                className="shrink-0 text-[11.5px] font-semibold text-osu-f1 transition-colors cursor-pointer hover:text-white"
              >
                disconnect
              </button>
            </div>
          )}

          {step === "connect" && (
            <>
              <p className="text-[12.5px] leading-relaxed text-osu-f1">
                Discord will ask you to authorise this site, so we can check you own or help run the
                server you are posting. It will ask for:
              </p>
              <ul className="space-y-1.5">
                {CONSENT_LINES.map((line) => (
                  <li key={line} className="flex items-start gap-2 text-[12.5px] leading-relaxed text-osu-l2">
                    <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color: DISCORD_BLURPLE }} aria-hidden="true" />
                    {line}
                  </li>
                ))}
              </ul>
              <p className="flex items-start gap-2 text-[12px] leading-relaxed text-osu-f1">
                <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" aria-hidden="true" />
                It cannot read your messages or post anything, and that access ends as soon as your
                server is posted.
              </p>
              <a
                href={connectHref}
                className="inline-flex items-center justify-center gap-2 rounded-full px-4 py-2 text-[12.5px] font-bold text-white transition cursor-pointer hover:brightness-110"
                style={{ backgroundColor: DISCORD_BLURPLE }}
              >
                <DiscordLogo className="h-4 w-4" />
                Continue with Discord
              </a>
            </>
          )}

          {step === "pick" && (
            <>
              <p className="text-[12.5px] text-osu-f1">Pick the server you want to post.</p>
              {loadingGuilds ? (
                <div className="flex items-center gap-2 py-6 text-[12.5px] text-osu-f1">
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  Reading your servers
                </div>
              ) : guilds.length === 0 ? (
                <p className="py-6 text-[12.5px] leading-relaxed text-osu-f1">
                  None of your Discord servers are ones you own or have Manage Server on, so there is
                  nothing here you can post.
                </p>
              ) : (
                <div className="space-y-2">
                  {/* Only once the list is long enough to scroll past what the
                      box costs. Someone with three servers can see all three. */}
                  {guilds.length > GUILD_FILTER_THRESHOLD && (
                    <input
                      type="text"
                      value={guildFilter}
                      onChange={(event) => setGuildFilter(event.target.value)}
                      placeholder="Search your servers"
                      aria-label="Search your servers"
                      className={FIELD_CLASS}
                    />
                  )}
                  <div className="max-h-72 space-y-1 overflow-y-auto">
                    {visibleGuilds.map((entry) => (
                      <button
                        key={entry.id}
                        type="button"
                        onClick={() => {
                          setGuild(entry);
                          setInvite("");
                          setError(null);
                          setStep("details");
                        }}
                        className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors cursor-pointer hover:bg-osu-b4"
                      >
                        {entry.iconUrl ? (
                          <img src={entry.iconUrl} alt="" width={32} height={32} className="h-8 w-8 rounded-xl object-cover" />
                        ) : (
                          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-osu-b3/40 text-[12px] font-bold text-osu-l2">
                            {entry.name.slice(0, 1).toUpperCase()}
                          </div>
                        )}
                        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-white">{entry.name}</span>
                        <span className="shrink-0 text-[11px] text-osu-f1 tabular-nums">
                          {entry.owner ? "owner" : "manager"}
                        </span>
                      </button>
                    ))}
                    {visibleGuilds.length === 0 && (
                      <p className="py-4 text-center text-[12.5px] text-osu-f1">No server by that name.</p>
                    )}
                  </div>
                </div>
              )}
            </>
          )}

          {/* grid-cols-1 rather than letting the single column be implicit: an
              implicit column is auto-sized, so the preview card's min-content
              width became the floor for the whole form and pushed it off a
              narrow phone. Tailwind's grid-cols-1 is minmax(0,1fr), which lets
              the column shrink and the card truncate as it does on the grid. */}
          {step === "details" && guild && previewCommunity && (
            <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_17rem]">
              <div className="space-y-4 lg:col-start-1 lg:row-start-1">
                <div className="flex items-center gap-2.5">
                  {guild.iconUrl && (
                    <img src={guild.iconUrl} alt="" width={32} height={32} className="h-8 w-8 rounded-xl object-cover" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-[13px] font-bold text-white">{guild.name}</span>
                  <button
                    type="button"
                    onClick={() => setStep("pick")}
                    className="shrink-0 text-[11.5px] font-semibold text-osu-f1 transition-colors cursor-pointer hover:text-white"
                  >
                    go back
                  </button>
                </div>

                <label className="block">
                  <span className="mb-1 block text-[11px] font-bold uppercase tracking-[0.08em] text-osu-f1/55">
                    Invite link
                  </span>
                  <input
                    type="text"
                    value={invite}
                    onChange={(event) => setInvite(event.target.value)}
                    placeholder="https://discord.gg/..."
                    className={FIELD_CLASS}
                  />
                  {/* Checked against Discord as it is typed, so an invite for
                      the wrong server or one that expires is caught here rather
                      than after the description is written. */}
                  {inviteCheck.status === "checking" ? (
                    <span className="mt-1 flex items-center gap-1.5 text-[11px] text-osu-f1/70">
                      <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                      Checking with Discord
                    </span>
                  ) : inviteCheck.status === "error" ? (
                    <span className="mt-1 flex items-start gap-1.5 text-[11px] leading-relaxed text-osu-pink-light">
                      <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
                      {inviteCheck.message}
                    </span>
                  ) : inviteCheck.status === "ok" ? (
                    <span className="mt-1 block text-[11px] leading-relaxed">
                      <span className="flex items-center gap-1.5 text-emerald-400">
                        <Check className="h-3 w-3 shrink-0" aria-hidden="true" />
                        {inviteCheck.preview.name}, {inviteCheck.preview.memberCount.toLocaleString()} members
                      </span>
                      {/* An expiring invite is allowed: it is a worse listing,
                          not an invalid one, and a listing whose link stops
                          working comes off the directory on its own. Worth
                          saying out loud, not worth blocking on. */}
                      {inviteCheck.preview.expiresAt && (
                        <span className="mt-0.5 flex items-start gap-1.5 text-amber-300">
                          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
                          This invite expires on {communityInviteExpiryLabel(inviteCheck.preview.expiresAt)}. When it
                          does, your server gets hidden until you paste a new link.
                        </span>
                      )}
                    </span>
                  ) : (
                    <span className="mt-1 block text-[11px] leading-relaxed text-osu-f1/70">
                      Make it permanent if you can: a temporary invite hides your server the day it
                      runs out, until you paste a new one.
                    </span>
                  )}
                </label>

                <label className="block">
                  <span className="mb-1 block text-[11px] font-bold uppercase tracking-[0.08em] text-osu-f1/55">
                    What is it for
                  </span>
                  <textarea
                    value={pitch}
                    onChange={(event) => setPitch(event.target.value.slice(0, COMMUNITY_PITCH_MAX_LENGTH))}
                    rows={6}
                    placeholder="Who the server is for, what happens in it, when it is busy. Line breaks are kept."
                    className={`${FIELD_CLASS} resize-y`}
                  />
                  <span className="mt-1 block text-right text-[11px] text-osu-f1/70 tabular-nums">
                    {pitch.length}/{COMMUNITY_PITCH_MAX_LENGTH}
                  </span>
                </label>

                <div>
                  <span className="mb-1 block text-[11px] font-bold uppercase tracking-[0.08em] text-osu-f1/55">
                    Tags
                  </span>
                  <TagInput tags={tags} onChange={setTags} />
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <span className="mb-1 block text-[11px] font-bold uppercase tracking-[0.08em] text-osu-f1/55">
                      Country
                    </span>
                    <SelectMenu
                      value={countryCode}
                      options={countryOptions}
                      onChange={setCountryCode}
                      ariaLabel="Country"
                      block
                      searchable
                      searchPlaceholder="Search countries"
                    />
                  </div>
                  <div>
                    <span className="mb-1 block text-[11px] font-bold uppercase tracking-[0.08em] text-osu-f1/55">
                      Language
                    </span>
                    <SelectMenu
                      value={language}
                      options={LANGUAGE_SELECT_OPTIONS}
                      onChange={setLanguage}
                      ariaLabel="Language"
                      block
                      searchable
                      searchPlaceholder="Search languages"
                    />
                  </div>
                </div>

                <div>
                  <span className="mb-1 block text-[11px] font-bold uppercase tracking-[0.08em] text-osu-f1/55">
                    Who can join
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

              </div>

              {/* The card the directory will show, drawn by the component that
                  draws the real ones. A phone has no second column to put it
                  in, so it sits between the fields and Submit rather than being
                  hidden there: the last thing seen before posting. */}
              <div className="lg:col-start-2 lg:row-start-1 lg:row-span-2">
                <span className="mb-1.5 block text-[11px] font-bold uppercase tracking-[0.08em] text-osu-f1/55">
                  How it will look
                </span>
                <CommunityCard community={previewCommunity} preview />
              </div>

              <button
                type="button"
                onClick={handleSubmit}
                disabled={submitting || inviteCheck.status !== "ok" || pitch.trim() === ""}
                className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-osu-pink px-4 py-2 text-[12.5px] font-bold text-white transition cursor-pointer hover:brightness-110 disabled:cursor-default disabled:opacity-40 disabled:hover:brightness-100 lg:col-start-1 lg:row-start-2"
              >
                {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
                Submit
              </button>
            </div>
          )}

          {step === "done" && (
            <div className="py-4 text-center">
              <Check className="mx-auto h-8 w-8 text-emerald-400" aria-hidden="true" />
              <p className="mt-3 text-[13px] font-bold text-white">Submission sent</p>
              <p className="mx-auto mt-1.5 max-w-sm text-[12px] leading-relaxed text-osu-f1">
                Your server shows up here once it is approved. Until then you can see it, and edit it,
                in your own listings above.
              </p>
              <button
                type="button"
                onClick={onClose}
                className="mt-4 rounded-full bg-osu-pink px-5 py-1.5 text-[12.5px] font-bold text-white transition cursor-pointer hover:brightness-110"
              >
                Done
              </button>
            </div>
          )}

          {error && <p className="text-[12px] leading-relaxed text-osu-pink-light">{error}</p>}
        </div>
      </div>
    </div>
  );
}
