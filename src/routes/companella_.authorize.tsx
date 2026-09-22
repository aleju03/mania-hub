import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Check, Link2 } from "lucide-react";
import { Trans, useLingui } from "@lingui/react/macro";
import { msg } from "@lingui/core/macro";

import { getI18n } from "../lib/i18n";

import { useAuth } from "../lib/auth-context";
import { pageSeo } from "../lib/seo";
import { Avatar } from "../components/ui/Avatar";
import {
  approveCompanellaAuthorization,
  createCompanellaAuthorizationRequest,
  denyCompanellaAuthorization,
  fetchCompanellaAuthorizationRequest,
  type AuthorizationDetail,
} from "../lib/companella-integration/manage-server";

/*
 * The consent screen.
 *
 * Approval is an explicit same-origin POST, never something that happens
 * because the page loaded or because a browser session already exists. The
 * account is named on the page, the two consents are separate, and a request
 * someone else sent you is something the copy warns about, because that is
 * exactly the shape of a phishing attempt here.
 */

const text = (value: unknown): string => (typeof value === "string" ? value : "");

export const Route = createFileRoute("/companella_/authorize")({
  // Two ways in. A native client arrives with the OAuth parameters and this
  // page opens the request; the browser test client already has one and
  // arrives with its id. Either way the consent token never leaves the server
  // except to this page, and approval is still an explicit POST.
  validateSearch: (search: Record<string, unknown>) => ({
    requestId: text(search.requestId),
    consent: text(search.consent),
    client_id: text(search.client_id),
    redirect_uri: text(search.redirect_uri),
    state: text(search.state),
    code_challenge: text(search.code_challenge),
    code_challenge_method: text(search.code_challenge_method),
    scope: text(search.scope),
    dpop_jkt: text(search.dpop_jkt),
  }),
  head: ({ match }) => {
    const i18n = getI18n(match.context.locale);
    return pageSeo({
      title: i18n._(msg`Connect Companella`),
      description: i18n._(msg`Approve a Companella installation for your osu! account.`),
      path: "/companella/authorize",
      origin: match.context.origin,
      imageTitle: "Connect Companella",
      noindex: true,
    });
  },
  component: AuthorizePage,
});

function AuthorizePage() {
  const { t } = useLingui();
  const auth = useAuth();
  const navigate = useNavigate();
  const search = Route.useSearch();
  const [requestId, setRequestId] = useState(search.requestId);
  const [consent, setConsent] = useState(search.consent);
  const [detail, setDetail] = useState<AuthorizationDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");

  useEffect(() => {
    // Grant parameters must not linger in history or reach an analytics
    // breadcrumb; the page keeps them in memory and clears the bar.
    if (typeof window !== "undefined" && window.location.search.includes("consent=")) {
      const url = new URL(window.location.href);
      url.searchParams.delete("consent");
      window.history.replaceState({}, "", url.toString());
    }
  }, []);

  // A native client's parameters become a request here, once, after the
  // browser has a session to attach to it. Guarded by a ref rather than an
  // effect cleanup: dev StrictMode re-runs effects, and a cleanup-cancelled
  // first call would still have created a request the page then abandons.
  const requestStarted = useRef(false);
  useEffect(() => {
    if (requestId || !search.client_id || !auth.viewer || requestStarted.current) return;
    requestStarted.current = true;
    void createCompanellaAuthorizationRequest({
      data: {
        clientId: search.client_id,
        redirectUri: search.redirect_uri,
        state: search.state,
        codeChallenge: search.code_challenge,
        scope: search.scope || null,
        dpopJkt: search.dpop_jkt,
      },
    })
      .then((created) => {
        if (!created.requestId || !created.consentToken) {
          setError(created.error ?? "request_failed");
          setLoading(false);
          return;
        }
        setRequestId(created.requestId);
        setConsent(created.consentToken);
      })
      .catch(() => {
        setError("request_failed");
        setLoading(false);
      });
  }, [auth.viewer, requestId, search.client_id, search.code_challenge, search.dpop_jkt, search.redirect_uri, search.scope, search.state]);

  useEffect(() => {
    if (search.code_challenge_method && search.code_challenge_method !== "S256") {
      setError("unsupported_code_challenge_method");
    }
  }, [search.code_challenge_method]);

  useEffect(() => {
    if (!requestId || !auth.viewer) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    void fetchCompanellaAuthorizationRequest({ data: { requestId } })
      .then((result) => {
        if (cancelled) return;
        setDetail(result);
        setName(result?.loopback ? "Companella" : "Browser test client");
      })
      .catch(() => {
        if (!cancelled) setDetail(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [auth.viewer, requestId]);

  // Rebuilt from the validated search, never from window.location, so the
  // return path cannot carry anything the route did not accept.
  const signInReturnPath = (() => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(search)) {
      if (typeof value === "string" && value && key !== "consent") params.set(key, value);
    }
    const query = params.toString();
    return query ? `/companella/authorize?${query}` : "/companella/authorize";
  })();

  const approve = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await approveCompanellaAuthorization({
        data: {
          requestId,
          consentToken: consent,
          displayName: name,
          platformHint: null,
          consentScores: true,
          consentCharts: true,
        },
      });
      if (!result.ok || !result.redirectUrl) {
        setError(result.error ?? "approve_failed");
        return;
      }
      // Back to the client's own callback. The code travels in the URL; no
      // token ever does.
      window.location.href = result.redirectUrl;
    } catch {
      setError("approve_failed");
    } finally {
      setBusy(false);
    }
  }, [consent, name, requestId]);

  // The server registers exactly two client ids and no dynamic registration
  // (see companella-integration.md), so the display name and icon are a
  // fixed lookup on the id the request was created with, not a claim the
  // client gets to make about itself.
  const client = (() => {
    switch (detail?.client_id) {
      case "companella-test":
        return { name: t`Browser test client`, icon: null };
      case "companella":
      case undefined:
        return { name: "Companella", icon: "/images/companella-icon.png" };
      default:
        return { name: detail?.client_id ?? "", icon: null };
    }
  })();
  const appName = client.name;
  // Where the browser goes after approval, shown so the loopback address the
  // app registered is visible before the click.
  const redirectHost = (() => {
    if (!detail) return "";
    try {
      return new URL(detail.redirect_uri).host;
    } catch {
      return "";
    }
  })();

  const signInHref = `/api/auth/osu?next=${encodeURIComponent(signInReturnPath)}`;

  // The backend's refusal codes, in the user's terms. Anything unlisted is a
  // transport failure and reads as one.
  const describeError = (code: string): { text: string; signIn: boolean } => {
    switch (code) {
      case "not_signed_in":
        return { text: t`Your session ended. Sign in again, then approve.`, signIn: true };
      case "request_expired":
        return { text: t`This request expired. Start the connection again from the app.`, signIn: false };
      case "request_settled":
        return { text: t`This request was already answered. Start the connection again from the app.`, signIn: false };
      case "account_not_allowed":
        return { text: t`Your account is not on the list for this beta.`, signIn: false };
      case "request_not_found":
      case "invalid_consent_token":
      case "unsupported_code_challenge_method":
        return { text: t`This request is not valid any more. Start the connection again from the app.`, signIn: false };
      default:
        return { text: t`Could not reach the server. Try again.`, signIn: false };
    }
  };
  const errorInfo = error ? describeError(error) : null;

  const shell = (children: ReactNode) => (
    <div className="flex flex-1 items-start justify-center bg-osu-b5 px-4 py-10 sm:py-16">
      <div className="w-full max-w-[420px]">{children}</div>
    </div>
  );

  const identityRow = (
    <div className="mb-6 flex items-center justify-center gap-3">
      {client.icon ? (
        <img src={client.icon} alt={appName} width={56} height={56} className="h-14 w-14 rounded-full" />
      ) : (
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-osu-b4 text-2xl font-bold text-white">
          {appName.charAt(0)}
        </div>
      )}
      <div className="flex items-center gap-1 text-osu-f1/60">
        <span className="h-px w-5 bg-current" />
        <Link2 size={16} />
        <span className="h-px w-5 bg-current" />
      </div>
      <img src="/images/favicon-256.png" alt="Mania Tracker" width={56} height={56} className="h-14 w-14 rounded-full" />
    </div>
  );

  if (!auth.viewer) {
    return shell(
      <>
        {identityRow}
        <h1 className="text-center text-xl font-bold text-white">
          <Trans>Sign in to connect {appName}</Trans>
        </h1>
        <p className="mt-2 text-center text-sm text-osu-f1">
          <Trans>{appName} needs your Mania Tracker account to send plays to.</Trans>
        </p>
        {/* The return path is this same request, normalized server-side so it
            can only ever be a path on this site. */}
        <a
          href={signInHref}
          className="mt-6 inline-flex w-full items-center justify-center rounded-full bg-osu-pink px-4 py-2.5 text-sm font-bold text-white transition hover:brightness-110"
        >
          <Trans>Sign in with osu!</Trans>
        </a>
      </>,
    );
  }

  if (loading) {
    return shell(<div className="h-72 animate-pulse rounded-2xl bg-osu-b4/40" />);
  }

  if (!detail || detail.outcome) {
    return shell(
      <>
        {identityRow}
        <h1 className="text-center text-xl font-bold text-white">
          {detail?.outcome ? <Trans>Already answered</Trans> : <Trans>This request has expired</Trans>}
        </h1>
        <p className="mt-2 text-center text-sm text-osu-f1">
          {detail?.outcome
            ? <Trans>This connection request has already been answered.</Trans>
            : <Trans>Start the connection again from the app.</Trans>}
        </p>
      </>,
    );
  }

  return shell(
    <>
      {identityRow}
      <h1 className="text-center text-xl font-bold leading-snug text-white">
        <Trans>
          <span className="text-osu-pink-light">{appName}</span> wants to access your Mania Tracker account
        </Trans>
      </h1>

      <div className="mt-6 flex items-center gap-3 rounded-xl bg-osu-b4/50 px-3 py-2.5">
        <Avatar url={auth.viewer.avatarUrl} userId={auth.viewer.id} size={36} />
        <div className="min-w-0">
          <div className="text-[11px] text-osu-f1"><Trans>Signed in as</Trans></div>
          <div className="truncate text-sm font-semibold text-white">{auth.viewer.username}</div>
        </div>
      </div>

      <div className="mt-6 text-[11px] font-semibold uppercase tracking-wider text-osu-f1">
        <Trans>This will allow {appName} to</Trans>
      </div>
      <ul className="mt-2 divide-y divide-osu-b3/30 rounded-xl border border-osu-b3/30">
        <li className="flex items-start gap-3 px-3 py-3">
          <Check size={18} className="mt-0.5 shrink-0 text-emerald-300" />
          <div className="text-sm text-white">
            <Trans>Import your completed osu!mania plays</Trans>
          </div>
        </li>
        <li className="flex items-start gap-3 px-3 py-3">
          <Check size={18} className="mt-0.5 shrink-0 text-emerald-300" />
          <div className="text-sm text-white">
            <Trans>Send the chart file when the site does not already have it</Trans>
          </div>
        </li>
      </ul>

      <label className="mt-5 block text-[11px] font-semibold uppercase tracking-wider text-osu-f1">
        <Trans>Installation name</Trans>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={60}
          className="mt-1.5 w-full rounded-lg bg-osu-b4 px-3 py-2 text-sm font-normal normal-case tracking-normal text-white outline-none focus:ring-1 focus:ring-osu-pink"
        />
      </label>

      {errorInfo && (
        <p className="mt-3 text-center text-xs text-rose-300">
          {errorInfo.text}
          {errorInfo.signIn && (
            <>
              {" "}
              <a href={signInHref} className="font-semibold underline underline-offset-2 hover:text-white">
                <Trans>Sign in with osu!</Trans>
              </a>
            </>
          )}
        </p>
      )}

      <button
        type="button"
        onClick={() => void approve()}
        disabled={busy || !name.trim()}
        className="mt-6 inline-flex w-full items-center justify-center rounded-full bg-osu-pink px-4 py-2.5 text-sm font-bold text-white transition cursor-pointer hover:brightness-110 disabled:cursor-default disabled:opacity-40 disabled:hover:brightness-100"
      >
        <Trans>Authorize {appName}</Trans>
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          // The app is told, not left waiting: the deny goes back to its
          // callback as error=access_denied. Only when there is nowhere to
          // send it (already answered) does the page fall back to /companella.
          void denyCompanellaAuthorization({ data: { requestId } })
            .then((result) => {
              if (result.redirectUrl) {
                window.location.href = result.redirectUrl;
                return;
              }
              void navigate({ to: "/companella", search: { code: undefined, state: undefined } });
            })
            .catch(() => {
              void navigate({ to: "/companella", search: { code: undefined, state: undefined } });
            });
        }}
        className="mt-2 w-full py-2 text-center text-sm text-osu-f1 transition cursor-pointer hover:text-white disabled:opacity-40"
      >
        <Trans>Cancel</Trans>
      </button>

      <div className="mt-6 space-y-1.5 text-center text-xs text-osu-f1/80">
        {redirectHost && (
          <p>
            <Trans>Authorizing will redirect to <span className="font-mono text-osu-f1">{redirectHost}</span> on this computer.</Trans>
          </p>
        )}
        <p>
          <Trans>Only approve a request you started yourself. If someone sent you this link, close it.</Trans>
        </p>
        <p>
          <Trans>This does not give the app your osu! account. You can revoke it any time on your Companella page.</Trans>
        </p>
        <p>
          <Trans>If your osu! account is restricted, imported plays show on your Mania Tracker profile.</Trans>
        </p>
      </div>
    </>,
  );
}
