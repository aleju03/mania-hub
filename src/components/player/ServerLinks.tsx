import { Trans, useLingui } from "@lingui/react/macro";
import { Link2, Plus, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { setMyServerLink, type ServerLink, type ServerLinkResult } from "#/lib/own-profile";
import { detectPrivateServer, privateServer, privateServerLogo } from "#/lib/private-servers";

/* A player's private server profiles, in the profile's meta row after the
   osu! profile or status pill. Everyone sees the links; the owner gets a + that
   opens a popover: paste a profile link and the server is read from its domain.
   The popover floats in a portal (the header clips its overflow), so opening it
   and saving from it never moves anything on the page. */

const POPOVER_WIDTH_PX = 320;
const VIEWPORT_MARGIN_PX = 8;

export function ServerLinkPill({ link }: { link: ServerLink }) {
  const server = privateServer(link.server);
  if (!server) return null;
  return (
    <a
      href={link.url}
      target="_blank"
      rel="noopener noreferrer nofollow"
      title={link.url}
      className="inline-flex items-center gap-1.5 rounded-full bg-white/10 py-0.5 pl-0.5 pr-2 font-semibold text-white/80 transition-colors duration-150 hover:bg-white/20 hover:text-white"
    >
      <img src={privateServerLogo(server.key)} alt="" className="h-4 w-4 rounded-full object-cover" />
      {server.name}
    </a>
  );
}

/** "osu.gatari.pw/u/1234" for display: the scheme adds nothing. */
function shortLink(url: string): string {
  return url.replace(/^https?:\/\//, "");
}

export function ServerLinksButton({
  links,
  onSaved,
}: {
  links: ServerLink[];
  onSaved: (links: ServerLink[]) => void;
}) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const trimmed = value.trim();
  const detected = trimmed ? detectPrivateServer(trimmed) : undefined;
  const unknown = trimmed.length > 0 && !detected && /[.]/.test(trimmed);

  // Page coordinates, so the popover scrolls with the header it hangs from.
  // Measured again when the links change, since a new pill moves the +.
  const place = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const maxLeft = window.innerWidth - POPOVER_WIDTH_PX - VIEWPORT_MARGIN_PX;
    setPosition({
      top: rect.bottom + window.scrollY + 8,
      left: Math.max(VIEWPORT_MARGIN_PX, Math.min(rect.left, maxLeft)) + window.scrollX,
    });
  }, []);

  useLayoutEffect(() => {
    if (open) place();
  }, [links, open, place]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (popoverRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", place);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", place);
    };
  }, [open, place]);

  const describe = (result: Extract<ServerLinkResult, { ok: false }>): string => {
    switch (result.error) {
      case "invalid_url":
      case "unknown_server":
        return t`That isn't a profile link.`;
      case "not_eligible":
        return t`Sign in to link your private server profiles.`;
      default:
        return t`Couldn't save the link right now.`;
    }
  };

  const send = async (server: string, url: string): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      const result = await setMyServerLink({ data: { server, url } });
      if (!result.ok) {
        setError(describe(result));
        return false;
      }
      onSaved(result.links);
      return true;
    } catch {
      setError(t`Couldn't save the link right now.`);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!detected || busy) return;
    if (await send(detected.key, trimmed)) {
      setValue("");
      inputRef.current?.focus();
    }
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => {
          setError(null);
          setOpen((current) => !current);
        }}
        title={t`Link a private server profile`}
        aria-label={t`Link a private server profile`}
        aria-expanded={open}
        className={`flex h-5 w-5 cursor-pointer items-center justify-center rounded-full transition-colors ${
          open ? "bg-white/20 text-white" : "bg-white/10 text-white/70 hover:bg-white/20 hover:text-white"
        }`}
      >
        <Plus size={12} strokeWidth={2.5} />
      </button>
      {open && position ? createPortal(
        <div
          ref={popoverRef}
          style={{ top: position.top, left: position.left, width: POPOVER_WIDTH_PX }}
          className="absolute z-50 rounded-xl bg-osu-b4 p-2 text-[12px] shadow-[0_12px_40px_rgba(0,0,0,0.6)] ring-1 ring-white/10"
        >
          <form
            className="flex items-center gap-2 rounded-lg bg-osu-b5 py-1 pl-1.5 pr-1"
            onSubmit={(event) => { event.preventDefault(); void save(); }}
          >
            {detected ? (
              <img src={privateServerLogo(detected.key)} alt={detected.name} title={detected.name} className="h-5 w-5 shrink-0 rounded-full object-cover" />
            ) : (
              <Link2 size={16} className="mx-0.5 shrink-0 text-osu-f1" />
            )}
            <input
              ref={inputRef}
              autoFocus
              value={value}
              maxLength={300}
              onChange={(event) => {
                setValue(event.target.value);
                setError(null);
              }}
              placeholder={t`Paste a private server profile link`}
              disabled={busy}
              className="min-w-0 flex-1 bg-transparent py-1 text-[13px] text-osu-c1 outline-none placeholder:text-osu-f1"
            />
            <button
              type="submit"
              disabled={!detected || busy}
              className="shrink-0 cursor-pointer rounded-md bg-osu-pink/25 px-2.5 py-1 font-semibold text-osu-pink-light transition hover:brightness-110 disabled:cursor-default disabled:opacity-40"
            >
              <Trans>Save</Trans>
            </button>
          </form>
          {error || unknown ? (
            <div className={`px-1.5 pt-1.5 text-[11px] ${error ? "text-osu-red-light" : "text-osu-f1"}`}>
              {error ?? <Trans>Not a server we know yet.</Trans>}
            </div>
          ) : null}
          {links.length > 0 ? (
            <ul className="mt-2 border-t border-white/[0.07] pt-1">
              {links.map((link) => {
                const server = privateServer(link.server);
                if (!server) return null;
                return (
                  <li key={link.server} className="flex items-center gap-2 rounded-md px-1.5 py-1.5">
                    <img src={privateServerLogo(server.key)} alt="" className="h-5 w-5 shrink-0 rounded-full object-cover" />
                    <span className="shrink-0 font-semibold text-osu-c1">{server.name}</span>
                    <a
                      href={link.url}
                      target="_blank"
                      rel="noopener noreferrer nofollow"
                      className="min-w-0 flex-1 truncate text-[11px] text-osu-f1 hover:text-osu-l2"
                    >
                      {shortLink(link.url)}
                    </a>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void send(link.server, "")}
                      title={t`Remove ${server.name}`}
                      aria-label={t`Remove ${server.name}`}
                      className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-full text-osu-f1 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-40"
                    >
                      <X size={13} />
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>,
        document.body,
      ) : null}
    </>
  );
}
