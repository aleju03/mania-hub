import { useCallback, useEffect, useRef, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";

import { createCompanellaAuthorizationRequest } from "#/lib/companella-integration/manage-server";
import {
  clearTestKey,
  clearTransaction,
  exchangeCode,
  fetchIdentity,
  getOrCreateTestKey,
  readTransaction,
  startTransaction,
  submitPlay,
  type SubmitProgress,
  type TestCredentials,
  type TestKeyPair,
} from "#/lib/companella-integration/test-client";
import { ActionButton, Field, Panel, Pill } from "./primitives";

/*
 * The beta-only browser test client.
 *
 * It runs the same public protocol a native client would, so the page can be
 * exercised before Companella ships. What it is not: a simulation of a real
 * installation's security. The key lives in the browser, the credentials live
 * in memory, and refreshing the page means connecting again.
 */

const CLIENT_ID = "companella-test";

export function TestClientPanel({ onSubmitted }: { onSubmitted: () => void }) {
  const { t } = useLingui();
  const [key, setKey] = useState<TestKeyPair | null>(null);
  const [credentials, setCredentials] = useState<TestCredentials | null>(null);
  const [identity, setIdentity] = useState<Record<string, unknown> | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const replayRef = useRef<HTMLInputElement>(null);
  const chartRef = useRef<HTMLInputElement>(null);

  const note = useCallback((line: string) => {
    setLog((previous) => [...previous.slice(-30), line]);
  }, []);

  useEffect(() => {
    void getOrCreateTestKey().then(setKey).catch(() => setKey(null));
  }, []);

  // Coming back from the consent page: finish the exchange with the verifier
  // that was kept only for this transaction.
  useEffect(() => {
    if (!key) return;
    const url = new URL(window.location.href);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state) return;
    const transaction = readTransaction();
    // Remove the grant parameters from history before anything else, so a
    // shared URL or a back button cannot carry them.
    url.searchParams.delete("code");
    url.searchParams.delete("state");
    window.history.replaceState({}, "", url.toString());
    if (!transaction || transaction.state !== state) {
      note(t`The callback did not match this browser's transaction; connect again.`);
      clearTransaction();
      return;
    }
    setBusy(true);
    void exchangeCode(key, code, transaction.verifier, `${window.location.origin}/companella/test-callback`, CLIENT_ID)
      .then(async (result) => {
        clearTransaction();
        if (!result) {
          note(t`The code exchange was refused.`);
          return;
        }
        setCredentials(result);
        note(t`Connected as ${result.username}.`);
        setIdentity(await fetchIdentity(key, result));
      })
      .finally(() => setBusy(false));
  }, [key, note, t]);

  const connect = useCallback(async () => {
    if (!key) return;
    setBusy(true);
    try {
      const transaction = await startTransaction();
      const created = await createCompanellaAuthorizationRequest({
        data: {
          clientId: CLIENT_ID,
          redirectUri: `${window.location.origin}/companella/test-callback`,
          state: transaction.state,
          codeChallenge: transaction.challenge,
          scope: "companella:scores:submit companella:submissions:read companella:charts:upload companella:installation:read",
          dpopJkt: key.thumbprint,
          appName: "Browser test client",
        },
      });
      if (!created.requestId) {
        note(t`Could not start an authorization request (${created.error ?? "unknown"}).`);
        return;
      }
      window.location.href = `/companella/authorize?requestId=${encodeURIComponent(created.requestId)}&consent=${encodeURIComponent(created.consentToken ?? "")}`;
    } finally {
      setBusy(false);
    }
  }, [key, note, t]);

  const submit = useCallback(async () => {
    if (!key || !credentials) return;
    const replayFile = replayRef.current?.files?.[0];
    const chartFile = chartRef.current?.files?.[0];
    if (!replayFile || !chartFile) {
      note(t`Pick both a .osr and the .osu it was played on.`);
      return;
    }
    setBusy(true);
    try {
      const [replay, chart] = await Promise.all([
        replayFile.arrayBuffer().then((buffer) => new Uint8Array(buffer)),
        chartFile.arrayBuffer().then((buffer) => new Uint8Array(buffer)),
      ]);
      const result = await submitPlay(
        key,
        credentials,
        { replay, chart },
        `browser-test-${crypto.randomUUID()}`,
        (progress: SubmitProgress) => note(progress.detail ? `${progress.step} (${progress.detail})` : progress.step),
      );
      note(result.ok
        ? t`Submission ${result.submissionId ?? ""} finished.`
        : t`Submission refused: ${result.error ?? "unknown"}`);
      onSubmitted();
    } finally {
      setBusy(false);
    }
  }, [credentials, key, note, onSubmitted, t]);

  return (
    <Panel
      title={<Trans>Test client</Trans>}
      right={credentials ? <Pill tone="good"><Trans>Connected</Trans></Pill> : <Pill><Trans>Not connected</Trans></Pill>}
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Field label={<Trans>Key</Trans>}>{key ? `${key.thumbprint.slice(0, 12)}...` : t`Creating`}</Field>
        <Field label={<Trans>Account</Trans>}>{credentials?.username ?? "-"}</Field>
        <Field label={<Trans>Connection</Trans>}>{credentials?.installationId?.slice(0, 10) ?? "-"}</Field>
        <Field label={<Trans>Scopes</Trans>}>{String((identity?.scopes as string[] | undefined)?.length ?? 0)}</Field>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <ActionButton onClick={() => void connect()} disabled={busy || !key}>
          <Trans>Create test connection</Trans>
        </ActionButton>
        <ActionButton
          tone="danger"
          disabled={busy}
          onClick={() => {
            void clearTestKey().then(() => {
              setCredentials(null);
              setIdentity(null);
              setKey(null);
              note(t`Test key cleared.`);
              void getOrCreateTestKey().then(setKey);
            });
          }}
        >
          <Trans>Reset test key</Trans>
        </ActionButton>
      </div>

      {credentials && (
        <div className="mt-3 flex flex-col gap-2">
          <label className="text-xs text-osu-f1">
            <Trans>Replay (.osr)</Trans>
            <input ref={replayRef} type="file" accept=".osr" className="mt-1 block w-full text-xs text-osu-f1" />
          </label>
          <label className="text-xs text-osu-f1">
            <Trans>Chart (.osu)</Trans>
            <input ref={chartRef} type="file" accept=".osu" className="mt-1 block w-full text-xs text-osu-f1" />
          </label>
          <div>
            <ActionButton onClick={() => void submit()} disabled={busy}>
              <Trans>Submit play</Trans>
            </ActionButton>
          </div>
        </div>
      )}

      {log.length > 0 && (
        <ul className="mt-3 flex flex-col gap-0.5 font-mono text-[11px] text-osu-f1">
          {log.map((line, index) => <li key={index}>{line}</li>)}
        </ul>
      )}

      <p className="mt-3 text-xs text-osu-f1">
        <Trans>
          The test client keeps its signing key in this browser and its tokens in memory only, so refreshing the page
          means connecting again. Everything it submits is marked as test evidence and is removed automatically after a
          week.
        </Trans>
      </p>
    </Panel>
  );
}
