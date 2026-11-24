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
  fetchOwnWebhooks,
  mutateOwnWebhooks,
  type DeveloperWebhook,
  type DeveloperWebhookEvent,
  type DeveloperWebhooks,
} from "#/lib/developer-webhooks";
import {
  fetchOwnDeveloperKeys,
  mutateOwnDeveloperKeys,
  revealOwnDeveloperKey,
  type DeveloperAccessStatus,
  type DeveloperKey,
  type DeveloperKeys,
} from "#/lib/developer-keys";

/*
 * /developers: Mania Tracker API keys and the API's docs, laid out as a docs
 * portal (section nav, prose beside pinned code samples). Reached by direct
 * URL only (no nav or footer link), noindex. Access is invite only for now:
 * the docs are open to everyone, the keys part is locked until a signed-in
 * player asks and the owner lets them in (admin live-backend, API access).
 * Then they make up to two keys and can show or copy them again later.
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
const BEATMAP_PATH = "/api/public/v1/beatmaps/{beatmap}";
const BEATMAPS_PATH = "/api/public/v1/beatmaps?ids={ids}";
const SKILL_RANKINGS_PATH = "/api/public/v1/rankings/skills";
const DAN_RANKINGS_PATH = "/api/public/v1/rankings/dan";
const RANKING_PAGE_SIZE = 50;
const TOP_PLAYS_PATH = "/api/public/v1/top-plays";
const SNIPES_PATH = "/api/public/v1/snipes";

const WEBHOOK_BODY = `{
  "type": "top_play",
  "id": "top_play:US:4567890123",
  "createdAt": "2026-11-24T17:44:02.118Z",
  "country": "US",
  "data": {
    "scoreId": 4567890123,
    "userId": 12345,
    "username": "PlayerName",
    "pp": 512.35,
    "ppGain": 8.12,
    ...
  }
}`;

const SNIPES_RESPONSE = `{
  "country": "US",
  "snipes": [
    {
      "scoreId": 4567890123,
      "board": "US",
      "beatmapId": 123456,
      "beatmapsetId": 54321,
      "title": "Song Title",
      "artist": "Artist",
      "version": "Insane",
      "keyCount": 4,
      "sniper": { "userId": 12345, "username": "PlayerName" },
      "victim": { "userId": 67890, "username": "OtherPlayer" },
      "boardRank": 1,
      "totalScore": 987654,
      "accuracy": 0.9852,
      "pp": 301.2,
      "rank": "S",
      "mods": ["HD"],
      "setAt": "2026-11-24T17:40:51Z"
    }
  ]
}`;

const VERIFY_SAMPLES: Record<string, string> = {
  Node: `import { createHmac, timingSafeEqual } from "node:crypto";\n\nfunction verify(req, rawBody) {\n  const timestamp = req.headers["x-mania-tracker-timestamp"];\n  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;\n  const expected = "sha256=" + createHmac("sha256", process.env.WEBHOOK_SECRET)\n    .update(\`\${timestamp}.\${rawBody}\`)\n    .digest("hex");\n  const given = req.headers["x-mania-tracker-signature"] ?? "";\n  return given.length === expected.length\n    && timingSafeEqual(Buffer.from(given), Buffer.from(expected));\n}`,
  Python: `import hashlib, hmac, os, time\n\ndef verify(headers, raw_body: bytes) -> bool:\n    timestamp = headers["X-Mania-Tracker-Timestamp"]\n    if abs(time.time() - int(timestamp)) > 300:\n        return False\n    expected = "sha256=" + hmac.new(\n        os.environ["WEBHOOK_SECRET"].encode(),\n        f"{timestamp}.".encode() + raw_body,\n        hashlib.sha256,\n    ).hexdigest()\n    return hmac.compare_digest(headers.get("X-Mania-Tracker-Signature", ""), expected)`,
};

const TOP_PLAYS_RESPONSE = `{
  "country": "US",
  "window": "24h",
  "sort": "recent",
  "page": 1,
  "pageSize": 50,
  "total": 83,
  "plays": [
    {
      "scoreId": 4567890123,
      "userId": 12345,
      "username": "PlayerName",
      "countryCode": "US",
      "beatmapId": 123456,
      "beatmapsetId": 54321,
      "title": "Song Title",
      "artist": "Artist",
      "version": "Insane",
      "keyCount": 4,
      "pp": 512.35,
      "ppGain": 8.12,
      "accuracy": 0.9877,
      "rank": "S",
      "mods": ["DT"],
      "maxCombo": 1200,
      "setAt": "2026-11-24T17:42:10Z"
    }
  ]
}`;

const BEATMAP_RESPONSE = `{
  "beatmapId": 123456,
  "beatmapsetId": 54321,
  "title": "Song Title",
  "artist": "Artist",
  "creator": "Mapper",
  "version": "Insane",
  "status": "ranked",
  "keyCount": 4,
  "od": 8,
  "bpm": 180,
  "length": 142,
  "analyzed": true,
  "dan": {
    "label": "7+",
    "family": "rc",
    "value": 7.34
  },
  "skillsets": ["speed"],
  "msd": {
    "Overall": 21.42,
    "Stream": 21.9,
    "Jumpstream": 20.75,
    "Handstream": 19.6,
    "Stamina": 20.8,
    "JackSpeed": 15.2,
    "Chordjack": 17.4,
    "Technical": 19.9
  },
  "patterns": ["jumpstream", "bracket"],
  "vibro": false,
  "unrateable": false
}`;

const SKILL_RANKINGS_RESPONSE = `{
  "keyCount": 4,
  "axis": "Overall",
  "country": null,
  "page": 1,
  "pageSize": 50,
  "total": 9120,
  "updatedAt": "2026-11-24T18:05:00.000Z",
  "players": [
    {
      "rank": 1,
      "userId": 12345,
      "username": "PlayerName",
      "countryCode": "US",
      "value": 34.12,
      "analyzedPlays": 412,
      "provisional": false,
      "percentile": 99.99
    }
  ]
}`;

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

function beatmapSamples(base: string): Record<string, string> {
  const url = `${base}/api/public/v1/beatmaps/123456`;
  return {
    cURL: `curl ${url} \\\n  -H "Authorization: Bearer $MANIA_TRACKER_KEY"`,
    Node: `const res = await fetch(\n  "${url}",\n  { headers: { Authorization: \`Bearer \${process.env.MANIA_TRACKER_KEY}\` } },\n);\nconst beatmap = await res.json();`,
    Python: `import os, requests\n\nres = requests.get(\n    "${url}",\n    headers={"Authorization": f"Bearer {os.environ['MANIA_TRACKER_KEY']}"},\n)\nbeatmap = res.json()`,
  };
}

function rankingSamples(base: string): Record<string, string> {
  const url = `${base}${SKILL_RANKINGS_PATH}?keys=4&axis=Overall&country=US`;
  return {
    cURL: `curl "${url}" \\\n  -H "Authorization: Bearer $MANIA_TRACKER_KEY"`,
    Node: `const res = await fetch(\n  "${url}",\n  { headers: { Authorization: \`Bearer \${process.env.MANIA_TRACKER_KEY}\` } },\n);\nconst { players } = await res.json();`,
    Python: `import os, requests\n\nres = requests.get(\n    "${base}${SKILL_RANKINGS_PATH}",\n    params={"keys": 4, "axis": "Overall", "country": "US"},\n    headers={"Authorization": f"Bearer {os.environ['MANIA_TRACKER_KEY']}"},\n)\nplayers = res.json()["players"]`,
  };
}

function topPlaysSamples(base: string): Record<string, string> {
  const url = `${base}${TOP_PLAYS_PATH}?country=US&window=24h`;
  return {
    cURL: `curl "${url}" \\\n  -H "Authorization: Bearer $MANIA_TRACKER_KEY"`,
    Node: `const res = await fetch(\n  "${url}",\n  { headers: { Authorization: \`Bearer \${process.env.MANIA_TRACKER_KEY}\` } },\n);\nconst { plays } = await res.json();`,
    Python: `import os, requests\n\nres = requests.get(\n    "${base}${TOP_PLAYS_PATH}",\n    params={"country": "US", "window": "24h"},\n    headers={"Authorization": f"Bearer {os.environ['MANIA_TRACKER_KEY']}"},\n)\nplays = res.json()["plays"]`,
  };
}

function snipesSamples(base: string): Record<string, string> {
  const url = `${base}${SNIPES_PATH}?country=US`;
  return {
    cURL: `curl "${url}" \\\n  -H "Authorization: Bearer $MANIA_TRACKER_KEY"`,
    Node: `const res = await fetch(\n  "${url}",\n  { headers: { Authorization: \`Bearer \${process.env.MANIA_TRACKER_KEY}\` } },\n);\nconst { snipes } = await res.json();`,
    Python: `import os, requests\n\nres = requests.get(\n    "${base}${SNIPES_PATH}",\n    params={"country": "US"},\n    headers={"Authorization": f"Bearer {os.environ['MANIA_TRACKER_KEY']}"},\n)\nsnipes = res.json()["snipes"]`,
  };
}

const SECTIONS = ["keys", "webhooks", "auth", "skills", "batch", "beatmaps", "rankings", "top-plays", "snipes", "limits", "errors"] as const;
type SectionId = (typeof SECTIONS)[number];

function DevelopersPage() {
  const { t } = useLingui();
  const apiBase = getLiveBackendUrl() ?? DEFAULT_API_BASE;
  const active = useActiveSection();
  const [access, setAccess] = useState<DeveloperAccessStatus | null>(null);

  const nav: Array<[string, Array<[SectionId, string]>]> = [
    [t`Getting started`, [["keys", t`API keys`], ["webhooks", t`Webhooks`], ["auth", t`Authentication`]]],
    [t`Reference`, [
      ["skills", t`Player skills`],
      ["batch", t`Several players`],
      ["beatmaps", t`Beatmaps`],
      ["rankings", t`Rankings`],
      ["top-plays", t`Top plays`],
      ["snipes", t`Snipes`],
      ["limits", t`Rate limits`],
      ["errors", t`Errors`],
    ]],
  ];

  return (
    <div className="flex flex-1 flex-col">
      <PageHeader iconSrc="/images/icons/changelog.svg" title={t`Mania Tracker API`} />
      <div className="flex-1 bg-osu-b5 text-osu-f1">
        <div className="mx-auto grid w-full max-w-[1200px] grid-cols-[minmax(0,1fr)] gap-10 px-4 pb-20 pt-8 sm:px-5 lg:grid-cols-[190px_minmax(0,1fr)]">
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
            <KeysSection onAccess={setAccess} />
            <WebhooksSection access={access} />
            <AuthSection />
            <SkillsSection apiBase={apiBase} />
            <BatchSection apiBase={apiBase} />
            <BeatmapsSection apiBase={apiBase} />
            <RankingsSection apiBase={apiBase} />
            <TopPlaysSection apiBase={apiBase} />
            <SnipesSection apiBase={apiBase} />
            <section className="space-y-3">
              <H2 id="limits"><Trans>Rate limits</Trans></H2>
              <p className="max-w-2xl text-sm leading-6">
                <Trans>
                  {DEFAULT_RATE} requests a minute per key, and each player or beatmap in a batch counts as one request.
                  Responses can be cached for 10 minutes, rankings for 5 and top plays for 1. Over the limit you get a 429 with
                  a{" "}
                  <Code>Retry-After</Code> header.
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

function KeysSection({ onAccess }: { onAccess: (status: DeveloperAccessStatus | null) => void }) {
  const { t } = useLingui();
  const locale = useLocale();
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
  const access = state?.access.status ?? null;
  const hasAccess = access === "active" || access === "paused";
  useEffect(() => onAccess(access), [access, onAccess]);

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

  if (!auth.viewer || loadFailed || !state || !hasAccess) {
    return (
      <section className="space-y-4">
        <H2 id="keys"><Trans>API keys</Trans></H2>
        {auth.viewer && !loadFailed && !state ? (
          <div className="h-24 max-w-2xl animate-pulse rounded-xl bg-osu-b4/60" />
        ) : (
          <div className="max-w-2xl rounded-xl bg-osu-b4/60 px-5 py-4">
            {loadFailed ? (
              <p className="text-sm leading-6"><Trans>Couldn't load your keys. Refresh to try again.</Trans></p>
            ) : !auth.viewer ? (
              <LockedRow
                detail={<Trans>Sign in with osu! to request access.</Trans>}
                action={(
                  <a
                    href={`/api/auth/osu?next=${encodeURIComponent(location.pathname)}`}
                    className="inline-flex h-9 shrink-0 items-center rounded-lg bg-osu-pink px-4 text-sm font-bold text-white transition hover:brightness-110"
                  >
                    <Trans>Sign in with osu!</Trans>
                  </a>
                )}
              />
            ) : state?.access.status === "requested" ? (
              <LockedRow
                detail={state.access.requestedAt ? (
                  <Trans>
                    You requested access on {formatDate(new Date(state.access.requestedAt).toISOString(), "UTC", locale)}. Once
                    it's granted you can make keys here.
                  </Trans>
                ) : (
                  <Trans>You requested access. Once it's granted you can make keys here.</Trans>
                )}
              />
            ) : (
              <RequestAccess onAsked={setState} />
            )}
          </div>
        )}
      </section>
    );
  }

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <H2 id="keys"><Trans>API keys</Trans></H2>
          <p className="mt-1 text-[13px]">
            <Trans>{used} of {maxKeys} keys used. Each key can make {rate} requests a minute.</Trans>
          </p>
        </div>
        <PrimaryButton onClick={() => setCreating(true)} disabled={atLimit || access !== "active"}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          <Trans>Create key</Trans>
        </PrimaryButton>
      </div>
      {access === "paused" ? (
        <p className="text-[13px] text-osu-yellow"><Trans>Your access is paused, so your keys don't work right now.</Trans></p>
      ) : null}

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
            {keys.length === 0 ? (
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

function LockedRow({ detail, action }: { detail?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <div className="min-w-0">
        <p className="text-sm font-semibold leading-6 text-white"><Trans>The API is invite only for now.</Trans></p>
        {detail ? <p className="text-sm leading-6">{detail}</p> : null}
      </div>
      {action}
    </div>
  );
}

function RequestAccess({ onAsked }: { onAsked: (state: DeveloperKeys) => void }) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await mutateOwnDeveloperKeys({ data: { action: "request", note } });
      if (result?.status === "ok") onAsked(result.state);
      else setError(t`Couldn't send that. Try again.`);
    } catch {
      setError(t`Couldn't send that. Try again.`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <LockedRow
        action={open ? null : (
          <PrimaryButton onClick={() => setOpen(true)}><Trans>Request access</Trans></PrimaryButton>
        )}
      />
      {open ? (
        <form
          className="mt-3"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setOpen(false);
            }}
            maxLength={300}
            rows={2}
            autoFocus
            placeholder={t`What are you making? (optional)`}
            aria-label={t`What are you making?`}
            className="w-full resize-none rounded-lg bg-osu-b5 px-3 py-2 text-sm leading-6 text-white outline-none placeholder:text-osu-f1/60 focus:ring-1 focus:ring-osu-pink/50"
          />
          {error ? <p className="mt-2 text-[13px] text-osu-yellow">{error}</p> : null}
          <div className="mt-2 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="cursor-pointer rounded-lg px-3.5 py-2 text-[13px] font-bold text-osu-l2 transition-colors hover:bg-osu-b3/40 hover:text-white"
            >
              <Trans>Cancel</Trans>
            </button>
            <PrimaryButton type="submit" disabled={busy}><Trans>Send request</Trans></PrimaryButton>
          </div>
        </form>
      ) : null}
    </>
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
      else if (result.status === "refused") {
        setError(result.reason === "no_access"
          ? t`You don't have API access.`
          : t`You already have the most keys an account can have.`);
      }
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

/* ---------- webhooks ---------- */

function WebhooksSection({ access }: { access: DeveloperAccessStatus | null }) {
  const { t } = useLingui();
  const [state, setState] = useState<DeveloperWebhooks | null>(null);
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<DeveloperWebhook | null>(null);
  const manage = access === "active" || access === "paused";

  useEffect(() => {
    if (!manage) return;
    let cancelled = false;
    fetchOwnWebhooks()
      .then((result) => {
        if (!cancelled && result) setState(result);
      })
      .catch(() => {
        if (!cancelled) setNotice(t`Couldn't load your webhooks. Refresh to try again.`);
      });
    return () => {
      cancelled = true;
    };
  }, [manage, t]);

  const refusal = useCallback((reason: string): string => {
    if (reason === "invalid_url") return t`That URL can't be used. It has to be https on the normal port and reach the public internet.`;
    if (reason === "invalid_events") return t`Pick top plays, snipes or both.`;
    if (reason === "invalid_country") return t`The country has to be a two-letter code.`;
    if (reason === "webhook_limit") return t`You already have the most webhooks an account can have.`;
    if (reason === "no_access") return t`You don't have API access.`;
    if (reason === "too_soon") return t`Wait a few seconds before sending another test.`;
    return t`Couldn't save that. Try again.`;
  }, [t]);

  const change = useCallback(async (data: Parameters<typeof mutateOwnWebhooks>[0]["data"]): Promise<boolean> => {
    setNotice(null);
    try {
      const result = await mutateOwnWebhooks({ data });
      if (result?.status === "ok") {
        setState(result.state);
        if (result.test) {
          setNotice(result.test.ok
            ? t`Test sent. Your URL answered ${result.test.status}.`
            : result.test.status
              ? t`Test failed. Your URL answered ${result.test.status}.`
              : t`Test failed. Your URL couldn't be reached.`);
        }
        return true;
      }
      setNotice(result?.status === "refused" ? refusal(result.reason) : t`Sign in again to change webhooks.`);
    } catch {
      setNotice(t`Couldn't save that. Try again.`);
    }
    return false;
  }, [refusal, t]);

  const hooks = state?.webhooks ?? [];
  const atLimit = state != null && hooks.length >= state.maxWebhooks;

  return (
    <section className="grid grid-cols-[minmax(0,1fr)] gap-8 xl:grid-cols-[minmax(0,1fr)_440px]">
      <div className="min-w-0 space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <H2 id="webhooks"><Trans>Webhooks</Trans></H2>
            <p className="mt-3 max-w-2xl text-sm leading-6">
              <Trans>
                New top plays and snipes sent to your URL as the site records them, so you don't have to poll. A Discord channel's
                webhook URL gets them as messages.
              </Trans>
            </p>
          </div>
          {manage && !adding ? (
            <PrimaryButton onClick={() => setAdding(true)} disabled={!state || atLimit || access !== "active"}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              <Trans>Add webhook</Trans>
            </PrimaryButton>
          ) : null}
        </div>

        {manage ? (
          <div className="space-y-3">
            {adding ? <AddWebhookForm onSave={(data) => change(data)} onClose={() => setAdding(false)} /> : null}
            {state && hooks.length > 0 ? (
              <div className="divide-y divide-white/[0.07] rounded-xl bg-osu-b4/60">
                {hooks.map((hook) => (
                  <WebhookRow
                    key={hook.id}
                    hook={hook}
                    canEnable={access === "active"}
                    onToggle={() => change({ action: "set-enabled", id: hook.id, enabled: !hook.enabled })}
                    onTest={() => change({ action: "test", id: hook.id })}
                    onDelete={() => setDeleting(hook)}
                  />
                ))}
              </div>
            ) : state && !adding ? (
              <p className="text-[13px]"><Trans>No webhooks yet.</Trans></p>
            ) : null}
            {notice ? <p className="text-[13px] text-osu-yellow">{notice}</p> : null}
          </div>
        ) : null}

        <div>
          <SubHeading><Trans>What gets sent</Trans></SubHeading>
          <FieldList
            rows={[
              ["type", "string", <Trans key="type"><Code>top_play</Code> or <Code>snipe</Code>.</Trans>],
              ["id", "string", t`The same for every retry of one event, so you can skip ones you've seen.`],
              ["data", "object", <Trans key="data">Shaped like one entry of <Code>/top-plays</Code> or <Code>/snipes</Code>.</Trans>],
              ["X-Mania-Tracker-Timestamp", "header", t`Unix seconds when it was sent. Refuse old ones, so a copied request can't be sent to you again later.`],
              ["X-Mania-Tracker-Signature", "header", <Trans key="sig"><Code>sha256=</Code> and the HMAC-SHA256 of the timestamp header, a dot and the raw body, keyed with the webhook's secret.</Trans>],
            ]}
          />
          <p className="mt-3 text-[13px] leading-6">
            <Trans>
              Answer with a 2xx within 8 seconds. A failed delivery is tried twice more. After 10 failures in a row, or once Discord
              says the webhook was deleted, it turns off until you turn it back on. Each webhook takes up to 60 events a minute (25
              messages for Discord, with up to 10 events in one).
            </Trans>
          </p>
        </div>
      </div>
      <div className="min-w-0 space-y-4 xl:sticky xl:top-20 xl:self-start">
        <CodeWindow response={WEBHOOK_BODY} title={t`Request body`} />
        <CodeWindow tabs={VERIFY_SAMPLES} />
      </div>

      {deleting ? (
        <ConfirmModal
          title={t`Delete this webhook?`}
          body={t`Nothing more is sent to ${hostOf(deleting.url)}.`}
          confirmLabel={t`Delete webhook`}
          cancelLabel={t`Cancel`}
          danger
          onConfirm={() => void change({ action: "delete", id: deleting.id })}
          onClose={() => setDeleting(null)}
        />
      ) : null}
    </section>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function WebhookRow({ hook, canEnable, onToggle, onTest, onDelete }: {
  hook: DeveloperWebhook;
  canEnable: boolean;
  onToggle: () => Promise<boolean>;
  onTest: () => Promise<boolean>;
  onDelete: () => void;
}) {
  const { t } = useLingui();
  const locale = useLocale();
  const [busy, setBusy] = useState(false);
  const [showSecret, setShowSecret] = useState(false);
  const run = async (action: () => Promise<boolean>) => {
    setBusy(true);
    await action();
    setBusy(false);
  };
  const what = [
    hook.events.includes("top_play") ? t`Top plays` : null,
    hook.events.includes("snipe") ? t`Snipes` : null,
  ].filter(Boolean).join(", ");
  const status = !hook.enabled
    ? hook.disabledReason === "gone"
      ? t`Off: Discord says this webhook was deleted.`
      : hook.disabledReason === "failing"
        ? t`Off after ${hook.failures} failed deliveries in a row.`
        : t`Off`
    : hook.lastDeliveryAt
      ? t`Last sent ${formatTimeAgo(new Date(hook.lastDeliveryAt).toISOString(), locale)}`
      : t`Nothing sent yet`;

  return (
    <div className={`space-y-2 px-4 py-3 ${hook.enabled ? "" : "opacity-70"}`}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-[13px] text-white">{hook.kind === "discord" ? t`Discord channel` : hostOf(hook.url)}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[12px]">
            <span>{what}</span>
            {hook.country ? <><span aria-hidden className="h-3 w-px bg-white/15" /><span>{hook.country}</span></> : null}
            {hook.keys ? <><span aria-hidden className="h-3 w-px bg-white/15" /><span>{hook.keys === "4" ? "4K" : t`Not 4K`}</span></> : null}
            <span aria-hidden className="h-3 w-px bg-white/15" />
            <span className={hook.enabled ? "" : "text-osu-yellow"}>{status}</span>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <SmallButton disabled={busy || !hook.enabled || !canEnable} onClick={() => void run(onTest)}><Trans>Send test</Trans></SmallButton>
          <SmallButton disabled={busy || (!hook.enabled && !canEnable)} onClick={() => void run(onToggle)}>
            {hook.enabled ? <Trans>Turn off</Trans> : <Trans>Turn on</Trans>}
          </SmallButton>
          <SmallButton danger disabled={busy} onClick={onDelete}><Trans>Delete</Trans></SmallButton>
        </div>
      </div>
      {hook.secret ? (
        <div className="flex min-w-0 items-center gap-1">
          <span className="mr-1 text-[12px]"><Trans>Secret</Trans></span>
          <code className="min-w-0 truncate font-mono text-[12px] text-osu-c2">{showSecret ? hook.secret : `whsec_${"•".repeat(16)}`}</code>
          <IconButton onClick={() => setShowSecret((value) => !value)} label={showSecret ? t`Hide secret` : t`Show secret`}>
            {showSecret ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          </IconButton>
          <CopyButton getText={async () => hook.secret} />
        </div>
      ) : null}
    </div>
  );
}

function SmallButton({ children, onClick, disabled, danger }: { children: ReactNode; onClick: () => void; disabled?: boolean; danger?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`cursor-pointer rounded-md px-2 py-1 text-[12px] font-semibold transition-colors disabled:cursor-default disabled:opacity-40 ${
        danger ? "text-rose-300 hover:bg-rose-500/15" : "text-osu-l2 hover:bg-white/[0.06] hover:text-white"
      }`}
    >
      {children}
    </button>
  );
}

function AddWebhookForm({ onSave, onClose }: {
  onSave: (data: { action: "create"; url: string; events: DeveloperWebhookEvent[]; country: string; keys: string }) => Promise<boolean>;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<DeveloperWebhookEvent[]>(["top_play"]);
  const [country, setCountry] = useState("");
  const [keys, setKeys] = useState("");
  const [busy, setBusy] = useState(false);
  const toggle = (event: DeveloperWebhookEvent) =>
    setEvents((list) => (list.includes(event) ? list.filter((entry) => entry !== event) : [...list, event]));
  const inputClass = "h-9 rounded-lg bg-osu-b5 px-3 text-sm text-white outline-none placeholder:text-osu-f1/50 focus:ring-1 focus:ring-osu-pink/50";

  return (
    <form
      className="space-y-3 rounded-xl bg-osu-b4/60 px-4 py-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (busy) return;
        setBusy(true);
        void onSave({ action: "create", url, events, country, keys }).then((ok) => {
          setBusy(false);
          if (ok) onClose();
        });
      }}
    >
      <input
        value={url}
        onChange={(event) => setUrl(event.target.value)}
        placeholder="https://"
        aria-label={t`Webhook URL`}
        autoFocus
        maxLength={500}
        className={`${inputClass} w-full font-mono text-[13px]`}
      />
      <div className="flex flex-wrap items-center gap-2">
        {([["top_play", t`Top plays`], ["snipe", t`Snipes`]] as const).map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={events.includes(value)}
            onClick={() => toggle(value)}
            className={`h-9 cursor-pointer rounded-lg px-3 text-[13px] font-semibold transition-colors ${
              events.includes(value) ? "bg-osu-pink/15 text-osu-pink-light" : "bg-osu-b5 text-osu-f1 hover:text-white"
            }`}
          >
            {label}
          </button>
        ))}
        <input
          value={country}
          onChange={(event) => setCountry(event.target.value.replace(/[^a-z]/gi, "").toUpperCase().slice(0, 2))}
          placeholder={t`Country`}
          aria-label={t`Country code, empty for every country`}
          className={`${inputClass} w-24 uppercase placeholder:normal-case`}
        />
        <select value={keys} onChange={(event) => setKeys(event.target.value)} aria-label={t`Key count`} className={`${inputClass} cursor-pointer`}>
          <option value="">{t`All key counts`}</option>
          <option value="4">4K</option>
          <option value="other">{t`Not 4K`}</option>
        </select>
      </div>
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="cursor-pointer rounded-lg px-3.5 py-2 text-[13px] font-bold text-osu-l2 transition-colors hover:bg-osu-b3/40 hover:text-white"
        >
          <Trans>Cancel</Trans>
        </button>
        <PrimaryButton type="submit" disabled={busy || !url.trim() || events.length === 0}><Trans>Add webhook</Trans></PrimaryButton>
      </div>
    </form>
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
    <section className="grid grid-cols-[minmax(0,1fr)] gap-8 xl:grid-cols-[minmax(0,1fr)_440px]">
      <div className="min-w-0 space-y-6">
        <div>
          <H2 id="skills"><Trans>Player skills</Trans></H2>
          <div className="mt-3"><Endpoint path={SKILLS_PATH} /></div>
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
      <div className="min-w-0 space-y-4 xl:sticky xl:top-20 xl:self-start">
        <CodeWindow tabs={samples(apiBase)} />
        <CodeWindow response={EXAMPLE_RESPONSE} status="200 OK" />
      </div>
    </section>
  );
}

function BatchSection({ apiBase }: { apiBase: string }) {
  const { t } = useLingui();
  return (
    <section className="grid grid-cols-[minmax(0,1fr)] gap-8 xl:grid-cols-[minmax(0,1fr)_440px]">
      <div className="min-w-0 space-y-6">
        <div>
          <H2 id="batch"><Trans>Several players</Trans></H2>
          <div className="mt-3"><Endpoint path={BATCH_PATH} /></div>
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
      <div className="min-w-0 space-y-4 xl:sticky xl:top-20 xl:self-start">
        <CodeWindow tabs={batchSamples(apiBase)} />
        <CodeWindow response={BATCH_RESPONSE} status="200 OK" />
      </div>
    </section>
  );
}

function BeatmapsSection({ apiBase }: { apiBase: string }) {
  const { t } = useLingui();
  const fields: Array<[string, string, ReactNode]> = [
    ["title / artist / creator / version", "string", t`The beatmap as osu! names it.`],
    ["status", "string", <Trans key="status"><Code>ranked</Code>, <Code>loved</Code>, <Code>qualified</Code>, <Code>pending</Code>, <Code>graveyard</Code> and so on, as on osu!.</Trans>],
    ["keyCount / od / bpm / length", "number", t`Key count, overall difficulty, BPM and length in seconds.`],
    ["analyzed", "boolean", t`False until the site has analysed the chart. Until then the fields below are empty.`],
    ["dan", "object | null", <Trans key="dan">The dan the chart is filed under at 1.0x (<Code>label</Code>), rice or LN (<Code>family</Code>: <Code>rc</Code> or <Code>ln</Code>), and its position on the ladder (<Code>value</Code>).</Trans>],
    ["skillsets", "string[]", t`The skillsets the chart files under, strongest first. LN charts list their LN skillsets.`],
    ["msd", "object | null", t`MinaCalc skillsets at 1.0x, the same numbers as the map card.`],
    ["patterns", "string[]", t`Detected pattern tags, strongest first.`],
    ["vibro", "boolean", t`Player ratings leave the chart's vibro sections out.`],
    ["unrateable", "boolean", t`Player ratings leave the whole chart out.`],
  ];
  return (
    <section className="grid grid-cols-[minmax(0,1fr)] gap-8 xl:grid-cols-[minmax(0,1fr)_440px]">
      <div className="min-w-0 space-y-6">
        <div>
          <H2 id="beatmaps"><Trans>Beatmaps</Trans></H2>
          <div className="mt-3 space-y-2">
            <Endpoint path={BEATMAP_PATH} />
            <Endpoint path={BEATMAPS_PATH} />
          </div>
          <p className="mt-3 text-sm leading-6">
            <Trans>How the site files a chart: its dan, skillsets, MSD and patterns, the same as the map card. Up to {MAX_BATCH} beatmaps in one request.</Trans>
          </p>
        </div>
        <div>
          <SubHeading><Trans>Parameters</Trans></SubHeading>
          <FieldList
            rows={[
              ["beatmap", "integer", t`An osu! beatmap id (one difficulty, not the set).`],
              ["ids", "string", t`Beatmap ids separated by commas.`],
            ]}
          />
        </div>
        <div>
          <SubHeading><Trans>Response</Trans></SubHeading>
          <FieldList rows={fields} />
          <p className="mt-3 text-[13px]">
            <Trans>
              Several beatmaps come back as <Code>beatmaps</Code>, in the order asked, and <Code>notFound</Code>, the ids the site
              doesn't have.
            </Trans>
          </p>
        </div>
      </div>
      <div className="min-w-0 space-y-4 xl:sticky xl:top-20 xl:self-start">
        <CodeWindow tabs={beatmapSamples(apiBase)} />
        <CodeWindow response={BEATMAP_RESPONSE} status="200 OK" />
      </div>
    </section>
  );
}

function RankingsSection({ apiBase }: { apiBase: string }) {
  const { t } = useLingui();
  return (
    <section className="grid grid-cols-[minmax(0,1fr)] gap-8 xl:grid-cols-[minmax(0,1fr)_440px]">
      <div className="min-w-0 space-y-6">
        <div>
          <H2 id="rankings"><Trans>Rankings</Trans></H2>
          <div className="mt-3 space-y-2">
            <Endpoint path={SKILL_RANKINGS_PATH} />
            <Endpoint path={DAN_RANKINGS_PATH} />
          </div>
          <p className="mt-3 text-sm leading-6">
            <Trans>The skill and dan rankings from the Rankings page, {RANKING_PAGE_SIZE} players a page.</Trans>
          </p>
        </div>
        <div>
          <SubHeading><Trans>Query parameters</Trans></SubHeading>
          <FieldList
            rows={[
              ["keys", "integer", t`Key count, 4 if left out. Skill rankings cover 4K to 18K, dan rankings 4K, 6K and 7K.`],
              ["axis", "string", <Trans key="axis">Skills only. The skillset as the Rankings page names it, like <Code>Stream</Code> on 4K or <Code>Bracket</Code> on 7K. <Code>Overall</Code> if left out. A wrong one answers with the list for that key count.</Trans>],
              ["side", "string", <Trans key="side">Dan only. <Code>rc</Code> (rice, the default) or <Code>ln</Code>.</Trans>],
              ["skillset", "string", <Trans key="skillset">Dan only. <Code>overall</Code> if left out, or one skillset, like <Code>jack</Code>. A wrong one answers with the list.</Trans>],
              ["country", "string", t`A two-letter country code. Leave it out for the global ranking.`],
              ["page", "integer", t`1 if left out.`],
            ]}
          />
        </div>
        <div>
          <SubHeading><Trans>Response</Trans></SubHeading>
          <FieldList
            rows={[
              ["total", "integer", t`Players in the ranking.`],
              ["updatedAt", "string | null", t`When the ranking was last built. It's rebuilt every 5 minutes.`],
              ["players.*.value", "number", t`Skills only. The rating, the same number the profile shows.`],
              ["players.*.dan", "object", <Trans key="dan">Dan only. Shaped like <Code>dan.rc</Code> in player skills.</Trans>],
              ["players.*.provisional", "boolean", t`Skills only. Too few plays for a settled number.`],
              ["players.*.percentile", "number | null", t`Skills only. Where the rating sits among every rated player, 0 to 100.`],
            ]}
          />
        </div>
      </div>
      <div className="min-w-0 space-y-4 xl:sticky xl:top-20 xl:self-start">
        <CodeWindow tabs={rankingSamples(apiBase)} />
        <CodeWindow response={SKILL_RANKINGS_RESPONSE} status="200 OK" />
      </div>
    </section>
  );
}

function TopPlaysSection({ apiBase }: { apiBase: string }) {
  const { t } = useLingui();
  return (
    <section className="grid grid-cols-[minmax(0,1fr)] gap-8 xl:grid-cols-[minmax(0,1fr)_440px]">
      <div className="min-w-0 space-y-6">
        <div>
          <H2 id="top-plays"><Trans>Top plays</Trans></H2>
          <div className="mt-3"><Endpoint path={TOP_PLAYS_PATH} /></div>
          <p className="mt-3 text-sm leading-6">
            <Trans>
              New top plays from the Top plays page, {RANKING_PAGE_SIZE} a page. It covers the players in each country's top 100,
              for the last 30 days.
            </Trans>
          </p>
        </div>
        <div>
          <SubHeading><Trans>Query parameters</Trans></SubHeading>
          <FieldList
            rows={[
              ["country", "string", t`A two-letter country code. Leave it out for every country.`],
              ["window", "string", <Trans key="window"><Code>24h</Code> (the default), <Code>3d</Code>, <Code>7d</Code> or <Code>30d</Code>, counted from when the play was set.</Trans>],
              ["sort", "string", <Trans key="sort"><Code>recent</Code> (the default), <Code>pp</Code>, or <Code>gain</Code> for the pp the play added.</Trans>],
              ["keys", "string", <Trans key="keys"><Code>4</Code> for 4K only, <Code>other</Code> for every other key count. Leave it out for all.</Trans>],
              ["page", "integer", t`1 if left out, up to 20.`],
            ]}
          />
        </div>
        <div>
          <SubHeading><Trans>Response</Trans></SubHeading>
          <FieldList
            rows={[
              ["plays.*.pp", "number", t`The play's pp.`],
              ["plays.*.ppGain", "number", t`What the play added to the player's total pp.`],
              ["plays.*.accuracy", "number", t`0 to 1.`],
              ["plays.*.mods", "string[]", t`Mod acronyms.`],
              ["plays.*.setAt", "string", t`When the play was set.`],
            ]}
          />
          <p className="mt-3 text-[13px]">
            <Trans>To post new top plays as they come in, use a <a href="#webhooks" className="text-osu-l1 underline underline-offset-2 hover:text-white">webhook</a>.</Trans>
          </p>
        </div>
      </div>
      <div className="min-w-0 space-y-4 xl:sticky xl:top-20 xl:self-start">
        <CodeWindow tabs={topPlaysSamples(apiBase)} />
        <CodeWindow response={TOP_PLAYS_RESPONSE} status="200 OK" />
      </div>
    </section>
  );
}

function SnipesSection({ apiBase }: { apiBase: string }) {
  const { t } = useLingui();
  return (
    <section className="grid grid-cols-[minmax(0,1fr)] gap-8 xl:grid-cols-[minmax(0,1fr)_440px]">
      <div className="min-w-0 space-y-6">
        <div>
          <H2 id="snipes"><Trans>Snipes</Trans></H2>
          <div className="mt-3"><Endpoint path={SNIPES_PATH} /></div>
          <p className="mt-3 text-sm leading-6">
            <Trans>The newest snipes on a country's leaderboards, newest first, as on the Snipes page.</Trans>
          </p>
        </div>
        <div>
          <SubHeading><Trans>Query parameters</Trans></SubHeading>
          <FieldList
            rows={[
              ["country", "string", t`A two-letter country code. Leave it out for the global board.`],
              ["limit", "integer", t`How many, 50 if left out, up to 100.`],
            ]}
          />
        </div>
        <div>
          <SubHeading><Trans>Response</Trans></SubHeading>
          <FieldList
            rows={[
              ["snipes.*.sniper / victim", "object", t`Who set the score, and the highest-placed player they passed.`],
              ["snipes.*.boardRank", "integer | null", t`The place on the board the sniper took.`],
              ["snipes.*.accuracy", "number", t`0 to 1.`],
            ]}
          />
        </div>
      </div>
      <div className="min-w-0 space-y-4 xl:sticky xl:top-20 xl:self-start">
        <CodeWindow tabs={snipesSamples(apiBase)} />
        <CodeWindow response={SNIPES_RESPONSE} status="200 OK" />
      </div>
    </section>
  );
}

function ErrorsSection() {
  const { t } = useLingui();
  const rows: Array<[string, string, ReactNode]> = [
    ["400", "invalid_user", <Trans key="400">The player isn't an id or <Code>@username</Code>.</Trans>],
    ["400", "too_many_users", t`More than ${MAX_BATCH} players in one request.`],
    ["400", "invalid_beatmap_id", t`The beatmap isn't a number.`],
    ["400", "too_many_ids", t`More than ${MAX_BATCH} beatmaps in one request.`],
    ["400", "invalid_keys", t`The rankings don't cover that key count.`],
    ["400", "invalid_axis / invalid_skillset", t`Not one of that ranking's choices. The response lists them.`],
    ["400", "invalid_country", t`Not a two-letter country code.`],
    ["400", "invalid_window / invalid_sort", t`Not one of the top plays choices. The response lists them.`],
    ["401", "invalid_api_key", t`The key is missing, wrong or revoked, or your access is paused.`],
    ["404", "player_not_found", t`The account is gone from osu!, restricted, or the player hides their ratings.`],
    ["404", "beatmap_not_found", t`The site doesn't have that beatmap.`],
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

function Endpoint({ path }: { path: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2.5">
      <span className="rounded-md bg-emerald-500/15 px-2 py-0.5 font-mono text-[12px] font-bold text-emerald-300">GET</span>
      <code className="break-all font-mono text-[14px] text-white">{path}</code>
    </div>
  );
}

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
            <div className="break-words font-mono text-[13px] text-white">{name}</div>
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

function CodeWindow({ tabs, response, status, title }: { tabs?: Record<string, string>; response?: string; status?: string; title?: string }) {
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
            {title ?? <Trans>Response</Trans>}
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
