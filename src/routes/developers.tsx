import { useCallback, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { createFileRoute, useLocation } from "@tanstack/react-router";
import { Trans, useLingui } from "@lingui/react/macro";
import { msg } from "@lingui/core/macro";
import { Check, Copy, Eye, EyeOff, Plus } from "lucide-react";

import { PageHeader } from "#/components/layout/PageHeader";
import { ConfirmModal } from "#/components/ui/ConfirmModal";
import { useAuth } from "#/lib/auth-context";
import { formatDate, formatTimeAgo } from "#/lib/format";
import { getI18n } from "#/lib/i18n";
import { getLiveBackendUrl } from "#/lib/live-backend";
import { useLocale } from "#/lib/locale-context";
import { pageSeo } from "#/lib/seo";
import { useBodyScrollLock } from "#/lib/use-body-scroll-lock";
import {
  fetchOwnDeveloperKeys,
  mutateOwnDeveloperKeys,
  revealOwnDeveloperKey,
  type DeveloperKey,
  type DeveloperKeys,
} from "#/lib/developer-keys";

/*
 * /developers: Mania Tracker API keys and the API's docs, laid out as a docs
 * portal (section nav, prose beside pinned code samples). Reached by direct
 * URL only (no nav or footer link), noindex. A signed-in player makes up to
 * two keys and can show or copy them again later.
 * Backend: backend/src/features/api-keys.ts and http/routes/public-api.ts.
 */

export const Route = createFileRoute("/developers")({
  head: ({ match }) => {
    const i18n = getI18n(match.context.locale);
    return pageSeo({
      title: i18n._(msg`Mania Tracker API`),
      description: i18n._(msg`API keys and docs for reading osu!mania skill ratings from Mania Tracker.`),
      path: "/developers",
      origin: match.context.origin,
      imageTitle: "Mania Tracker API",
      noindex: true,
    });
  },
  component: DevelopersPage,
});

const DEFAULT_API_BASE = "https://api.mania-tracker.com";
const SKILLS_PATH = "/api/public/v1/players/{user}/skills";
const BATCH_PATH = "/api/public/v1/players/skills?users={users}";
const MAX_BATCH = 50;
const DEFAULT_RATE = 60;

const EXAMPLE_RESPONSE = `{
  "userId": 12345,
  "username": "PlayerName",
  "tracked": true,
  "status": "ready",
  "refreshing": false,
  "computedAt": "2026-11-23T10:15:00.000Z",
  "keymodes": {
    "4": {
      "analyzedPlays": 182,
      "provisional": false,
      "overall": 24.31,
      "msd": {
        "Overall": 25.1,
        "Stream": 23.9,
        "Jumpstream": 24.8,
        "Handstream": 23.2,
        "Stamina": 24.6,
        "JackSpeed": 18.4,
        "Chordjack": 21.7,
        "Technical": 24.1,
        "EtternaOverall": 24.31
      },
      "patterns": {
        "jumpstream": 24.9,
        "tech": 24.5,
        "jack": 22.1
      },
      "dan": {
        "rc": {
          "label": "8+",
          "value": 8.71,
          "beyondTable": false
        },
        "ln": null
      }
    }
  }
}`;

const BATCH_RESPONSE = `{
  "players": [
    {
      "userId": 12345,
      "username": "PlayerName",
      "tracked": true,
      "status": "ready",
      "refreshing": false,
      "computedAt": "2026-11-23T10:15:00.000Z",
      "keymodes": {
        "4": { ... }
      }
    }
  ],
  "notFound": [
    "@someone"
  ]
}`;

function batchSamples(base: string): Record<string, string> {
  const url = `${base}/api/public/v1/players/skills?users=12345,@PlayerName,67890`;
  return {
    cURL: `curl "${url}" \\\n  -H "Authorization: Bearer $MANIA_TRACKER_KEY"`,
    Node: `const res = await fetch(\n  "${url}",\n  { headers: { Authorization: \`Bearer \${process.env.MANIA_TRACKER_KEY}\` } },\n);\nconst { players, notFound } = await res.json();`,
    Python: `import os, requests\n\nres = requests.get(\n    "${base}/api/public/v1/players/skills",\n    params={"users": "12345,@PlayerName,67890"},\n    headers={"Authorization": f"Bearer {os.environ['MANIA_TRACKER_KEY']}"},\n)\ndata = res.json()`,
  };
}

function samples(base: string): Record<string, string> {
  const url = `${base}/api/public/v1/players/12345/skills`;
  return {
    cURL: `curl ${url} \\\n  -H "Authorization: Bearer $MANIA_TRACKER_KEY"`,
    Node: `const res = await fetch(\n  "${url}",\n  { headers: { Authorization: \`Bearer \${process.env.MANIA_TRACKER_KEY}\` } },\n);\nconst skills = await res.json();`,
    Python: `import os, requests\n\nres = requests.get(\n    "${url}",\n    headers={"Authorization": f"Bearer {os.environ['MANIA_TRACKER_KEY']}"},\n)\nskills = res.json()`,
  };
}

const SECTIONS = ["keys", "auth", "skills", "batch", "limits", "errors"] as const;
type SectionId = (typeof SECTIONS)[number];

function DevelopersPage() {
  const { t } = useLingui();
  const apiBase = getLiveBackendUrl() ?? DEFAULT_API_BASE;
  const active = useActiveSection();

  const nav: Array<[string, Array<[SectionId, string]>]> = [
    [t`Getting started`, [["keys", t`API keys`], ["auth", t`Authentication`]]],
    [t`Reference`, [["skills", t`Player skills`], ["batch", t`Several players`], ["limits", t`Rate limits`], ["errors", t`Errors`]]],
  ];

  return (
    <div className="flex flex-1 flex-col">
      <PageHeader iconSrc="/images/icons/changelog.svg" title={t`Mania Tracker API`} />
      <div className="flex-1 bg-osu-b5 text-osu-f1">
        <div className="mx-auto grid w-full max-w-[1200px] gap-10 px-5 pb-20 pt-8 lg:grid-cols-[190px_1fr]">
          <nav className="hidden lg:block" aria-label={t`Sections`}>
            <div className="sticky top-20 space-y-6">
              {nav.map(([group, items]) => (
                <div key={group}>
                  <div className="mb-2 px-2.5 text-[11px] font-semibold uppercase tracking-wider text-osu-f1/80">{group}</div>
                  {items.map(([id, label]) => (
                    <a
                      key={id}
                      href={`#${id}`}
                      className={`block rounded-md px-2.5 py-1.5 text-sm transition-colors ${
                        active === id ? "bg-osu-b4 font-semibold text-white" : "text-osu-f1 hover:text-white"
                      }`}
                    >
                      {label}
                    </a>
                  ))}
                </div>
              ))}
            </div>
          </nav>

          <main className="min-w-0 space-y-14">
            <h1 className="text-3xl font-black text-white sm:text-4xl"><Trans>Mania Tracker API</Trans></h1>
            <KeysSection />
            <AuthSection />
            <SkillsSection apiBase={apiBase} />
            <BatchSection apiBase={apiBase} />
            <section className="space-y-3">
              <H2 id="limits"><Trans>Rate limits</Trans></H2>
              <p className="max-w-2xl text-sm leading-6">
                <Trans>
                  {DEFAULT_RATE} requests a minute per key, and each player in a batch counts as one request. Responses can be
                  cached for 10 minutes. Over the limit you get a 429 with a <Code>Retry-After</Code> header.
                </Trans>
              </p>
            </section>
            <ErrorsSection />
          </main>
        </div>
      </div>
    </div>
  );
}

/* The section nearest the top of the viewport, for the nav highlight. */
function useActiveSection(): SectionId {
  const [active, setActive] = useState<SectionId>("keys");
  useEffect(() => {
    const update = () => {
      let current: SectionId = "keys";
      for (const id of SECTIONS) {
        const element = document.getElementById(id);
        if (element && element.getBoundingClientRect().top < 140) current = id;
      }
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) current = "errors";
      setActive(current);
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    return () => window.removeEventListener("scroll", update);
  }, []);
  return active;
}

/* ---------- keys ---------- */

function KeysSection() {
  const { t } = useLingui();
  const auth = useAuth();
  const location = useLocation();
  const [state, setState] = useState<DeveloperKeys | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<DeveloperKey | null>(null);
  const [revealed, setRevealed] = useState<Record<number, string>>({});
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!auth.viewer) return;
    let cancelled = false;
    fetchOwnDeveloperKeys()
      .then((result) => {
        if (cancelled) return;
        if (result) setState(result);
        else setLoadFailed(true);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [auth.viewer]);

  const keys = state?.keys.filter((key) => key.revokedAt == null) ?? [];
  const maxKeys = state?.maxActiveKeys ?? 2;
  const rate = state?.ratePerMinute ?? DEFAULT_RATE;
  const atLimit = state != null && keys.length >= maxKeys;
  const used = keys.length;

  /* The full key, from memory or the backend. Null when it can't be shown. */
  const reveal = useCallback(async (key: DeveloperKey): Promise<string | null> => {
    if (revealed[key.id]) return revealed[key.id];
    setNotice(null);
    try {
      const result = await revealOwnDeveloperKey({ data: { id: key.id } });
      if (result?.status === "ok") {
        setRevealed((previous) => ({ ...previous, [key.id]: result.key }));
        return result.key;
      }
      setNotice(result?.status === "refused" && result.reason === "not_revealable"
        ? t`This key can't be shown again. Revoke it and make a new one.`
        : t`Couldn't load that key. Refresh and try again.`);
    } catch {
      setNotice(t`Couldn't load that key. Refresh and try again.`);
    }
    return null;
  }, [revealed, t]);

  const revoke = useCallback(async (key: DeveloperKey) => {
    setNotice(null);
    try {
      const result = await mutateOwnDeveloperKeys({ data: { action: "revoke", id: key.id } });
      if (result?.status === "ok") setState(result.state);
      else setNotice(t`Couldn't revoke the key. Try again.`);
    } catch {
      setNotice(t`Couldn't revoke the key. Try again.`);
    }
  }, [t]);

  const onCreated = useCallback((next: DeveloperKeys, key: DeveloperKey | null, full: string) => {
    setState(next);
    if (key) setRevealed((previous) => ({ ...previous, [key.id]: full }));
  }, []);

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <H2 id="keys"><Trans>API keys</Trans></H2>
          {auth.viewer && state ? (
            <p className="mt-1 text-[13px]">
              <Trans>{used} of {maxKeys} keys used. Each key can make {rate} requests a minute.</Trans>
            </p>
          ) : null}
        </div>
        {auth.viewer ? (
          <PrimaryButton onClick={() => setCreating(true)} disabled={!state || atLimit}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            <Trans>Create key</Trans>
          </PrimaryButton>
        ) : (
          <a
            href={`/api/auth/osu?next=${encodeURIComponent(location.pathname)}`}
            className="inline-flex h-9 items-center rounded-lg bg-osu-pink px-4 text-sm font-bold text-white transition hover:brightness-110"
          >
            <Trans>Sign in with osu!</Trans>
          </a>
        )}
      </div>

      <div className="overflow-x-auto rounded-xl bg-osu-b4/60">
        <table className="w-full min-w-[680px] text-left text-sm">
          <thead>
            <tr className="text-[11px] font-semibold uppercase tracking-wider text-osu-f1">
              <th className="px-4 pb-2 pt-3 font-semibold"><Trans>Name</Trans></th>
              <th className="px-4 pb-2 pt-3 font-semibold"><Trans>Key</Trans></th>
              <th className="px-4 pb-2 pt-3 font-semibold"><Trans>Created</Trans></th>
              <th className="px-4 pb-2 pt-3 font-semibold"><Trans>Last used</Trans></th>
              <th className="px-4 pb-2 pt-3" />
            </tr>
          </thead>
          <tbody>
            {!auth.viewer ? (
              <EmptyRow><Trans>Sign in to see and make your keys.</Trans></EmptyRow>
            ) : loadFailed ? (
              <EmptyRow><Trans>Couldn't load your keys. Refresh to try again.</Trans></EmptyRow>
            ) : !state ? (
              <tr className="border-t border-white/[0.07]">
                <td colSpan={5} className="px-4 py-3"><div className="h-7 animate-pulse rounded-md bg-osu-b3/40" /></td>
              </tr>
            ) : keys.length === 0 ? (
              <EmptyRow><Trans>No keys yet.</Trans></EmptyRow>
            ) : keys.map((key) => (
              <KeyRow
                key={key.id}
                apiKey={key}
                full={revealed[key.id] ?? null}
                reveal={() => reveal(key)}
                onRevoke={() => setRevoking(key)}
              />
            ))}
          </tbody>
        </table>
      </div>
      {notice ? <p className="text-[13px] text-osu-yellow">{notice}</p> : null}

      {creating ? <CreateKeyModal onCreated={onCreated} onClose={() => setCreating(false)} /> : null}
      {revoking ? (
        <ConfirmModal
          title={t`Revoke ${revoking.label || revoking.prefix}?`}
          body={t`Requests that use this key stop working right away.`}
          confirmLabel={t`Revoke key`}
          cancelLabel={t`Cancel`}
          danger
          onConfirm={() => void revoke(revoking)}
          onClose={() => setRevoking(null)}
        />
      ) : null}
    </section>
  );
}

function EmptyRow({ children }: { children: ReactNode }) {
  return (
    <tr className="border-t border-white/[0.07]">
      <td colSpan={5} className="px-4 py-5 text-[13px]">{children}</td>
    </tr>
  );
}

function KeyRow({
  apiKey,
  full,
  reveal,
  onRevoke,
}: {
  apiKey: DeveloperKey;
  full: string | null;
  reveal: () => Promise<string | null>;
  onRevoke: () => void;
}) {
  const { t } = useLingui();
  const locale = useLocale();
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);

  const toggle = async () => {
    if (shown) {
      setShown(false);
      return;
    }
    setBusy(true);
    const key = await reveal();
    setBusy(false);
    if (key) setShown(true);
  };

  return (
    <tr className="border-t border-white/[0.07]">
      <td className="px-4 py-3 font-semibold text-white">{apiKey.label || <span className="text-osu-f1"><Trans>Unnamed</Trans></span>}</td>
      <td className="px-4 py-2">
        <div className="flex min-w-0 items-center gap-1">
          <code className="min-w-0 truncate font-mono text-[13px] text-osu-c2">
            {shown && full ? full : `${apiKey.prefix}${"•".repeat(16)}`}
          </code>
          <IconButton onClick={() => void toggle()} disabled={busy} label={shown ? t`Hide key` : t`Show key`}>
            {shown ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          </IconButton>
          <CopyButton getText={reveal} />
        </div>
      </td>
      <td className="whitespace-nowrap px-4 py-3 text-[13px]">
        {formatDate(new Date(apiKey.createdAt).toISOString(), "UTC", locale)}
      </td>
      <td className="whitespace-nowrap px-4 py-3 text-[13px]">
        {apiKey.lastUsedAt ? formatTimeAgo(new Date(apiKey.lastUsedAt).toISOString(), locale) : <Trans>Never</Trans>}
      </td>
      <td className="px-4 py-3 text-right">
        <button
          type="button"
          onClick={onRevoke}
          className="cursor-pointer rounded-md px-2 py-1 text-[12px] font-semibold text-rose-300 transition-colors hover:bg-rose-500/15"
        >
          <Trans>Revoke</Trans>
        </button>
      </td>
    </tr>
  );
}

function CreateKeyModal({
  onCreated,
  onClose,
}: {
  onCreated: (state: DeveloperKeys, key: DeveloperKey | null, full: string) => void;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  useBodyScrollLock(true);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const create = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await mutateOwnDeveloperKeys({ data: { action: "create", label } });
      if (!result) setError(t`Sign in again to make a key.`);
      else if (result.status === "refused") setError(t`You already have the most keys an account can have.`);
      else if (result.key) {
        const full = result.key;
        const newest = result.state.keys.find((key) => full.startsWith(key.prefix) && key.revokedAt == null) ?? null;
        onCreated(result.state, newest, full);
        setCreated(full);
      }
    } catch {
      setError(t`Couldn't make the key. Try again.`);
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[140] flex justify-center overflow-y-auto bg-black/70 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={t`Create key`}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="my-auto w-full max-w-md rounded-xl border border-osu-b3/30 bg-osu-b5 p-5">
        <h2 className="text-base font-bold text-white">{created ? <Trans>Key created</Trans> : <Trans>Create key</Trans>}</h2>
        {created ? (
          <>
            <div className="mt-4 flex items-center gap-2 rounded-lg bg-osu-b6 py-1.5 pl-3 pr-1.5">
              <code className="min-w-0 flex-1 break-all font-mono text-[13px] text-osu-c2">{created}</code>
              <CopyButton getText={async () => created} withLabel />
            </div>
            <div className="mt-5 flex justify-end">
              <PrimaryButton onClick={onClose}><Trans>Done</Trans></PrimaryButton>
            </div>
          </>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void create();
            }}
          >
            <label className="mt-4 block text-[12px] font-semibold text-osu-f1" htmlFor="api-key-name">
              <Trans>Name</Trans>
            </label>
            <input
              id="api-key-name"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              maxLength={40}
              autoFocus
              className="mt-1.5 h-10 w-full rounded-lg bg-osu-b4 px-3 text-sm text-white outline-none placeholder:text-osu-f1/50 focus:ring-1 focus:ring-osu-pink/50"
            />
            {error ? <p className="mt-2 text-[13px] text-osu-yellow">{error}</p> : null}
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="cursor-pointer rounded-lg px-3.5 py-2 text-[13px] font-bold text-osu-l2 transition-colors hover:bg-osu-b3/40 hover:text-white"
              >
                <Trans>Cancel</Trans>
              </button>
              <PrimaryButton type="submit" disabled={busy}><Trans>Create key</Trans></PrimaryButton>
            </div>
          </form>
        )}
      </div>
    </div>,
    document.body,
  );
}

/* ---------- docs ---------- */

function AuthSection() {
  return (
    <section className="space-y-3">
      <H2 id="auth"><Trans>Authentication</Trans></H2>
      <p className="max-w-2xl text-sm leading-6">
        <Trans>
          Send your key as a Bearer token. Call the API from a server: it sends no CORS headers, and a key in a web page can be
          read by anyone who opens it.
        </Trans>
      </p>
      <div className="max-w-2xl">
        <CodeWindow tabs={{ Header: "Authorization: Bearer mt_..." }} />
      </div>
    </section>
  );
}

function SkillsSection({ apiBase }: { apiBase: string }) {
  const { t } = useLingui();
  const fields: Array<[string, string, ReactNode]> = [
    ["username", "string | null", t`The player's osu! username as the site last saw it.`],
    ["status", "string", <Trans key="status"><Code>ready</Code>, <Code>pending</Code> (never rated) or <Code>failed</Code> (the last rating failed).</Trans>],
    ["computedAt", "string | null", t`When the ratings were last worked out. The API never asks for new ones, so this is how old they are.`],
    ["refreshing", "boolean", t`Always false on the API.`],
    ["tracked", "boolean", t`The player is tracked, so their loved and graveyard plays count too.`],
    ["keymodes", "object", t`Ratings by key count ("4", "7", ...).`],
    ["keymodes.*.analyzedPlays", "integer", t`Plays the ratings are built from.`],
    ["keymodes.*.provisional", "boolean", t`Too few plays for a settled number.`],
    ["keymodes.*.overall", "number | null", <Trans key="overall">The headline MSD the profile shows. Read this rather than picking one from <Code>msd</Code>.</Trans>],
    ["keymodes.*.msd", "object", t`MinaCalc skillsets by Etterna name.`],
    ["keymodes.*.patterns", "object", t`Pattern ratings by id.`],
    ["keymodes.*.dan.rc / .ln", "object | null", <Trans key="dan">The dan as the site shows it (<Code>label</Code>), its position on the ladder (<Code>value</Code>), and whether the player is past the last level (<Code>beyondTable</Code>).</Trans>],
  ];
  return (
    <section className="grid gap-8 xl:grid-cols-[1fr_440px]">
      <div className="min-w-0 space-y-6">
        <div>
          <H2 id="skills"><Trans>Player skills</Trans></H2>
          <div className="mt-3 flex flex-wrap items-center gap-2.5">
            <span className="rounded-md bg-emerald-500/15 px-2 py-0.5 font-mono text-[12px] font-bold text-emerald-300">GET</span>
            <code className="break-all font-mono text-[14px] text-white">{SKILLS_PATH}</code>
          </div>
          <p className="mt-3 text-sm leading-6">
            <Trans>A player's ratings by key count, the same numbers as the Skills tab on their profile.</Trans>
          </p>
        </div>
        <div>
          <SubHeading><Trans>Path parameters</Trans></SubHeading>
          <FieldList rows={[["user", "string", <Trans key="user">An osu! user id, or <Code>@</Code> and a username: <Code>12345</Code>, <Code>@PlayerName</Code>.</Trans>]]} />
        </div>
        <div>
          <SubHeading><Trans>Response</Trans></SubHeading>
          <FieldList rows={fields} />
          <p className="mt-3 text-[13px]">
            <Trans>Fields may be added to this response. None will be renamed or removed.</Trans>
          </p>
        </div>
      </div>
      <div className="space-y-4 xl:sticky xl:top-20 xl:self-start">
        <CodeWindow tabs={samples(apiBase)} />
        <CodeWindow response={EXAMPLE_RESPONSE} status="200 OK" />
      </div>
    </section>
  );
}

function BatchSection({ apiBase }: { apiBase: string }) {
  const { t } = useLingui();
  return (
    <section className="grid gap-8 xl:grid-cols-[1fr_440px]">
      <div className="min-w-0 space-y-6">
        <div>
          <H2 id="batch"><Trans>Several players</Trans></H2>
          <div className="mt-3 flex flex-wrap items-center gap-2.5">
            <span className="rounded-md bg-emerald-500/15 px-2 py-0.5 font-mono text-[12px] font-bold text-emerald-300">GET</span>
            <code className="break-all font-mono text-[14px] text-white">{BATCH_PATH}</code>
          </div>
          <p className="mt-3 text-sm leading-6">
            <Trans>The same ratings for up to {MAX_BATCH} players in one request.</Trans>
          </p>
        </div>
        <div>
          <SubHeading><Trans>Query parameters</Trans></SubHeading>
          <FieldList rows={[["users", "string", <Trans key="users">Ids and <Code>@usernames</Code>, separated by commas.</Trans>]]} />
        </div>
        <div>
          <SubHeading><Trans>Response</Trans></SubHeading>
          <FieldList
            rows={[
              ["players", "array", t`One entry per player found, in the order asked, shaped like the single-player response.`],
              ["notFound", "string[]", t`The entries that matched no player the API serves, as you sent them.`],
            ]}
          />
        </div>
      </div>
      <div className="space-y-4 xl:sticky xl:top-20 xl:self-start">
        <CodeWindow tabs={batchSamples(apiBase)} />
        <CodeWindow response={BATCH_RESPONSE} status="200 OK" />
      </div>
    </section>
  );
}

function ErrorsSection() {
  const { t } = useLingui();
  const rows: Array<[string, string, ReactNode]> = [
    ["400", "invalid_user", <Trans key="400">The player isn't an id or <Code>@username</Code>.</Trans>],
    ["400", "too_many_users", t`More than ${MAX_BATCH} players in one request.`],
    ["401", "invalid_api_key", t`The key is missing, wrong or revoked.`],
    ["404", "player_not_found", t`The account is gone from osu!, restricted, or the player hides their ratings.`],
    ["429", "rate_limited", <Trans key="429">Wait the number of seconds in the <Code>Retry-After</Code> header.</Trans>],
  ];
  return (
    <section className="space-y-2">
      <H2 id="errors"><Trans>Errors</Trans></H2>
      <div className="max-w-3xl divide-y divide-white/[0.07]">
        {rows.map(([code, name, what]) => (
          <div key={name} className="grid items-baseline gap-1 py-3 sm:grid-cols-[13rem_1fr]">
            <div className="flex items-baseline gap-2 font-mono text-[13px]">
              <span className="font-bold text-white">{code}</span>
              <span className="text-osu-f1">{name}</span>
            </div>
            <div className="text-sm leading-6">{what}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ---------- pieces ---------- */

function H2({ id, children }: { id: SectionId; children: ReactNode }) {
  return <h2 id={id} className="scroll-mt-20 text-xl font-extrabold text-white">{children}</h2>;
}

function SubHeading({ children }: { children: ReactNode }) {
  return <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-osu-f1">{children}</h3>;
}

function Code({ children }: { children: ReactNode }) {
  return <code className="rounded bg-osu-b4 px-1 py-0.5 font-mono text-[12px] text-white">{children}</code>;
}

function FieldList({ rows }: { rows: Array<[string, string, ReactNode]> }) {
  return (
    <div className="divide-y divide-white/[0.07] border-t border-white/[0.07]">
      {rows.map(([name, type, what]) => (
        <div key={name} className="grid gap-1 py-3 sm:grid-cols-[13rem_1fr]">
          <div className="min-w-0">
            <div className="break-all font-mono text-[13px] text-white">{name}</div>
            <div className="font-mono text-[11px] text-osu-f1">{type}</div>
          </div>
          <div className="text-sm leading-6">{what}</div>
        </div>
      ))}
    </div>
  );
}

function PrimaryButton({
  children,
  onClick,
  disabled,
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-lg bg-osu-pink px-4 text-sm font-bold text-white transition hover:brightness-110 disabled:cursor-default disabled:opacity-40 disabled:hover:brightness-100"
    >
      {children}
    </button>
  );
}

function IconButton({ children, onClick, disabled, label }: { children: ReactNode; onClick: () => void; disabled?: boolean; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="inline-flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-osu-f1 transition-colors hover:bg-white/[0.06] hover:text-white disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function CopyButton({ getText, withLabel = false }: { getText: () => Promise<string | null>; withLabel?: boolean }) {
  const { t } = useLingui();
  const [done, setDone] = useState(false);
  const copy = async () => {
    const text = await getText();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setDone(true);
      window.setTimeout(() => setDone(false), 1500);
    } catch {
      // Clipboard refused (permissions, insecure origin): nothing to show.
    }
  };
  return (
    <button
      type="button"
      onClick={() => void copy()}
      aria-label={t`Copy`}
      title={t`Copy`}
      className={`inline-flex h-7 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-md text-[12px] font-semibold text-osu-f1 transition-colors hover:bg-white/[0.06] hover:text-white ${withLabel ? "px-2.5" : "w-7"}`}
    >
      {done ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      {withLabel ? <span>{done ? t`Copied` : t`Copy`}</span> : null}
    </button>
  );
}

function CodeWindow({ tabs, response, status }: { tabs?: Record<string, string>; response?: string; status?: string }) {
  const names = tabs ? Object.keys(tabs) : [];
  const [active, setActive] = useState(names[0] ?? "");
  const text = tabs ? tabs[active] ?? "" : response ?? "";
  return (
    <div className="overflow-hidden rounded-xl bg-osu-b6">
      <div className="flex items-center gap-1 border-b border-white/[0.07] px-2 py-1.5">
        {tabs ? names.map((name) => (
          <button
            key={name}
            type="button"
            onClick={() => setActive(name)}
            className={`h-7 cursor-pointer rounded-md px-2.5 text-[12px] font-semibold transition-colors ${
              name === active ? "bg-osu-b4 text-white" : "text-osu-f1 hover:text-white"
            }`}
          >
            {name}
          </button>
        )) : (
          <div className="flex items-center gap-2 px-2 text-[12px] font-semibold text-osu-f1">
            <Trans>Response</Trans>
            {status ? <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 font-mono text-[11px] text-emerald-300">{status}</span> : null}
          </div>
        )}
        <div className="ml-auto"><CopyButton getText={async () => text} /></div>
      </div>
      <pre className="overflow-x-auto px-4 py-3.5 font-mono text-[12.5px] leading-[1.7] text-osu-c2">
        {tabs ? highlightCode(text) : highlightJson(text)}
      </pre>
    </div>
  );
}

function highlightJson(source: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /("(?:[^"\\]|\\.)*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?)/g;
  let last = 0;
  let index = 0;
  for (let match = re.exec(source); match; match = re.exec(source)) {
    if (match.index > last) out.push(source.slice(last, match.index));
    if (match[1] && match[2]) out.push(<span key={index++} className="text-osu-l1">{match[1]}</span>, match[2]);
    else if (match[1]) out.push(<span key={index++} className="text-osu-green-light">{match[1]}</span>);
    else if (match[3]) out.push(<span key={index++} className="text-osu-orange">{match[3]}</span>);
    else out.push(<span key={index++} className="text-osu-blue">{match[4]}</span>);
    last = re.lastIndex;
  }
  out.push(source.slice(last));
  return out;
}

function highlightCode(source: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /("(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`|'(?:[^'\\]|\\.)*')|\b(const|await|import|curl|fetch|requests)\b|(-H)\b/g;
  let last = 0;
  let index = 0;
  for (let match = re.exec(source); match; match = re.exec(source)) {
    if (match.index > last) out.push(source.slice(last, match.index));
    if (match[1]) out.push(<span key={index++} className="text-osu-green-light">{match[1]}</span>);
    else if (match[2]) out.push(<span key={index++} className="text-osu-pink-light">{match[2]}</span>);
    else out.push(<span key={index++} className="text-osu-blue">{match[3]}</span>);
    last = re.lastIndex;
  }
  out.push(source.slice(last));
  return out;
}
