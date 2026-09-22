import type { ReactNode } from "react";
import { createFileRoute } from "@tanstack/react-router";

import { PageHeader } from "#/components/layout/PageHeader";
import { pageSeo } from "#/lib/seo";

/*
 * /companella/docs: the public developer page for the Companella API, the one
 * link a client author is sent. It is the web form of
 * docs/companella-client-guide.md; keep the two in step. English only on
 * purpose, like the OpenAPI spec it points to: the audience is the person
 * writing the client, and a translated protocol page would drift from the
 * spec it has to match.
 */

export const Route = createFileRoute("/companella_/docs")({
  head: ({ match }) =>
    pageSeo({
      title: "Companella API",
      description: "How a client connects to Mania Tracker and sends osu!mania plays through the Companella API.",
      path: "/companella/docs",
      origin: match.context.origin,
      imageTitle: "Companella API",
      noindex: true,
    }),
  component: CompanellaDocsPage,
});

const API = "/api/integrations/companella/v1";
const UPDATED = "September 22, 2026";

type Method = "GET" | "POST" | "PUT";

const ENDPOINTS: Array<[Method, string, string]> = [
  ["GET", "/capabilities", "Endpoints, limits and supported mods. No auth."],
  ["POST", "/oauth/token", "Exchange the sign-in code for tokens, or refresh."],
  ["POST", "/oauth/revoke", "Disconnect this installation. Needs a proof too."],
  ["GET", "/me", "The connected account and installation."],
  ["POST", "/submissions", "Reserve a play."],
  ["PUT", "/submissions/{id}/replay", "Upload the replay."],
  ["PUT", "/submissions/{id}/beatmap", "Upload the .osu, when the server asks for it."],
  ["POST", "/submissions/{id}/complete", "Finish uploading and queue the play."],
  ["GET", "/submissions/{id}", "Read the play's state and result."],
];

const ERRORS: Array<[string, string]> = [
  ["401, token expired", "Refresh once and retry with a new proof."],
  ["401, invalid proof or wrong key", "Stop. Don't fall back to a bearer token or a cookie."],
  ["401 with a DPoP-Nonce header", "Sign again with that nonce and retry once."],
  ["400 use_dpop_nonce from /oauth/token or /oauth/revoke", "Sign again with the nonce from the DPoP-Nonce header and retry once."],
  ["400 invalid_grant, \"This account is not in the beta.\"", "Stop sending plays and tell the player. If they're let back in, the same tokens work again."],
  ["Installation revoked", "Stop uploading and ask the player to connect again."],
  ["error=access_denied on the callback", "The player cancelled, so nothing was connected."],
  ["needs_beatmap: true", "Upload the .osu file."],
  ["Connection dropped during an upload", "Read the submission again, then resend the same bytes."],
  ["409 assets_missing on complete", "Read the submission again and upload the file it asks for."],
  ["413", "The file is too big. Don't retry it."],
  ["504 on an upload", "The upload took more than 4 minutes, or the server was unreachable. Retry later."],
  ["429", "Wait for Retry-After. Keep the queue and don't retry in parallel."],
  ["503, or state deferred", "Retry later. Don't show a zero result in the meantime."],
  ["digest_mismatch, not_mania, broken file", "Don't retry the same file."],
  ["Rejected with contradictory_mods, replay_header_too_long or beatmap_checksum_mismatch", "Don't retry the same replay."],
  ["404 on a submission", "Treat it as deleted. Don't try other ids."],
  ["Quarantined", "Show the server's message. Don't move the play to another account."],
];

function CompanellaDocsPage() {
  const { origin } = Route.useRouteContext();
  const base = origin.replace(/\/+$/, "");

  return (
    <div className="flex flex-1 flex-col">
      <PageHeader iconSrc="/images/icons/changelog.svg" title="Companella API" />
      <div className="flex-1 bg-osu-b5 text-osu-f1">
        <div className="mx-auto w-full max-w-3xl px-5 pb-16 pt-8 sm:px-6 sm:pt-10">
          <header>
            <h1 className="text-2xl font-black text-white sm:text-4xl">Sending plays to Mania Tracker</h1>
            <p className="mt-4 text-[15px] leading-7 text-osu-f1">
              Once a player connects Companella to their account, Companella sends each finished osu!stable mania play
              to Mania Tracker with its replay and <Code>.osu</Code> file, and Mania Tracker checks and rates it.
            </p>
            <div className="mt-5 flex flex-wrap gap-2 text-sm">
              <HeaderLink href="/companella/docs/openapi.yaml">OpenAPI spec</HeaderLink>
              <HeaderLink href="/companella/docs/reference-client.mjs">Reference client</HeaderLink>
              <HeaderLink href={`${API}/capabilities`}>Capabilities</HeaderLink>
            </div>
          </header>

          <Section title="The short version">
            <ol className="mt-3 divide-y divide-osu-b3/30 rounded-xl border border-osu-b3/30 bg-osu-b4/40 px-4">
              <Step n={1} title="Connect" call="POST /oauth/token">
                The player signs in with osu! in the browser and approves Companella. You get an access token and a
                refresh token tied to Companella's key.
              </Step>
              <Step n={2} title="Reserve" call="POST /submissions">
                After a play, send the hashes of the replay and the <Code>.osu</Code>.
              </Step>
              <Step n={3} title="Upload" call="PUT .../replay, .../beatmap">
                Upload the files the server asks for, usually only the replay. It asks for the <Code>.osu</Code> when
                it doesn't have that exact file.
              </Step>
              <Step n={4} title="Complete" call="POST .../complete">
                Tell the server the uploads are done so the play gets queued.
              </Step>
              <Step n={5} title="Check" call="GET /submissions/{id}">
                Poll the submission until it's accepted or rejected.
              </Step>
            </ol>
            <P>
              The <A href="/companella/docs/reference-client.mjs">reference client</A> does all five steps in one Node
              file, so you can compare your requests against it.
            </P>
          </Section>

          <Section title="Endpoints">
            <P>
              All endpoints are under <Code>{base + API}</Code>. <Code>/capabilities</Code> needs no auth and lists the
              endpoints, scopes, supported mods and key counts, and the current limits.
            </P>
            <div className="mt-4 overflow-x-auto rounded-xl border border-osu-b3/30 bg-osu-b4/40 px-4 py-1">
              <table className="w-full text-left text-sm">
                <tbody>
                  {ENDPOINTS.map(([method, path, what]) => (
                    <tr key={method + path} className="border-b border-osu-b3/30 last:border-0">
                      <td className="w-14 py-2.5 pr-3 align-top"><MethodTag method={method} /></td>
                      <td className="whitespace-nowrap py-2.5 pr-5 align-top font-mono text-[13px] text-white">{path}</td>
                      <td className="py-2.5 align-top text-osu-f1/80">{what}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          <Section n={1} title="Connecting">
            <P>
              OAuth authorization code flow with PKCE (S256) and DPoP, using the system browser and a loopback
              redirect.
            </P>
            <ol className="mt-3 list-decimal space-y-2 pl-5 leading-7 marker:text-osu-f1/50">
              <li>Generate a P-256 key pair and store the private key on the machine. Each key pair is one installation.</li>
              <li>
                Listen on <Code>127.0.0.1</Code> or <Code>[::1]</Code> on any free port, with the path{" "}
                <Code>/companella/callback</Code>. <Code>localhost</Code> is not accepted.
              </li>
              <li>Generate a PKCE verifier and a random <Code>state</Code> for this attempt.</li>
              <li>Open the browser at this URL, URL-encoding each value:</li>
            </ol>
            <CodeBlock label="browser">{`${base}/companella/authorize
  ?client_id=companella
  &response_type=code
  &redirect_uri=http://127.0.0.1:{port}/companella/callback
  &state={state}
  &code_challenge={base64url(sha256(verifier))}
  &code_challenge_method=S256
  &scope=companella:scores:submit companella:submissions:read
         companella:charts:upload companella:installation:read
  &dpop_jkt={RFC 7638 thumbprint of your public key}`}</CodeBlock>
            <P>
              The player names the installation and approves. Your callback receives <Code>code</Code> and{" "}
              <Code>state</Code>; check that <Code>state</Code> matches, then stop listening. If the player cancels,
              the callback gets <Code>error=access_denied</Code> instead. A request nobody answers expires after 10
              minutes without calling back, so add a timeout on your side as well.
            </P>
            <CodeBlock label="exchange the code">{`POST ${base}${API}/oauth/token
DPoP: <proof, without ath>
Content-Type: application/json

{
  "grant_type": "authorization_code",
  "code": "...",
  "code_verifier": "...",
  "client_id": "companella",
  "redirect_uri": "http://127.0.0.1:{port}/companella/callback"
}`}</CodeBlock>
            <P>
              The response has an access token (valid for 5 minutes), a refresh token, the scope and the installation
              id. Refresh at the same URL with:
            </P>
            <CodeBlock label="refresh">{`{ "grant_type": "refresh_token", "refresh_token": "..." }`}</CodeBlock>
            <P>
              A refresh gives you a new access token and the same refresh token back. The refresh token doesn't rotate,
              so if a refresh response gets lost, refresh again.
            </P>
            <P>
              If the token response from the code exchange gets lost, run the authorization again. Connecting the same
              key to the same account reuses the existing installation.
            </P>
            <P>
              To disconnect, send the refresh token to <Code>/oauth/revoke</Code> with a proof from the same key. The
              server answers <Code>{`{ "revoked": true }`}</Code> even if the token was already gone.
            </P>
            <CodeBlock label="disconnect">{`POST ${base}${API}/oauth/revoke
DPoP: <proof, without ath>
Content-Type: application/json

{ "token": "..." }`}</CodeBlock>
          </Section>

          <Section n={2} title="Signing requests">
            <P>
              Every request after sign-in carries <Code>{"Authorization: DPoP <access token>"}</Code> and a{" "}
              <Code>DPoP</Code> header created for that request alone. The DPoP header is a JWT signed with the
              installation's private key.
            </P>
            <CodeBlock label="dpop header">{`{ "typ": "dpop+jwt", "alg": "ES256", "jwk": { your public key } }`}</CodeBlock>
            <CodeBlock label="dpop payload">{`{
  "jti": "new random id every time",
  "htm": "POST",
  "htu": "${base}${API}/submissions",
  "iat": 1790000000,
  "ath": "base64url(sha256(access token))",
  "nonce": "only once the server has sent you one"
}`}</CodeBlock>
            <ul className="mt-4 list-disc space-y-2 pl-5 leading-7 marker:text-osu-f1/50">
              <li><Code>htu</Code> is the URL you called, without the query string or fragment.</li>
              <li><Code>ath</Code> goes on every request except the token endpoint.</li>
              <li>
                Each proof can be used once, within 60 seconds of when the request starts. A slow upload is fine as
                long as it started in time and finishes within 4 minutes.
              </li>
              <li>
                When a response includes a <Code>DPoP-Nonce</Code> header, put that nonce in your next proofs. A nonce
                stays valid for a few minutes, so parallel uploads can share one. The token and revoke endpoints ask for
                a nonce with a 400 and <Code>use_dpop_nonce</Code>. Everything else asks with a 401.
              </li>
              <li>The <Code>jwk</Code> in the header is the public key only, without the <Code>d</Code> field.</li>
            </ul>
            <Note>
              The ES256 signature must be the raw 64-byte <Code>r || s</Code> value. Many crypto libraries output DER by
              default, which the server rejects. If every request returns 401, check this first.
            </Note>
          </Section>

          <Section n={3} title="Sending a play">
            <P>
              Send only completed osu!stable mania plays that have a full replay. Skip replays being watched,
              spectating, old result screens and autoplay. The server rejects those anyway, so filtering them in the
              client saves requests.
            </P>
            <CodeBlock label="reserve">{`POST ${base}${API}/submissions
Authorization: DPoP <access token>
DPoP: <proof>
Idempotency-Key: <a UUID saved with this play>
Content-Type: application/json

{
  "protocol_version": 1,
  "client_version": "companella/1.2.3",
  "game_client": "stable",
  "capture_kind": "automatic_completed_play",
  "replay": { "sha256": "<64 hex>", "byte_length": 123456 },
  "chart":  { "md5": "<32 hex>", "sha256": "<64 hex>", "byte_length": 54321 }
}`}</CodeBlock>
            <P>
              Hash the files byte for byte as they are on disk, without changing line endings or removing a BOM. Don't
              send accuracy, mods, rate, beatmap id, username or any other play details. The server reads those from
              the files and rejects requests that include them.
            </P>
            <CodeBlock label="response">{`{
  "submission_id": "...",
  "state": "awaiting_assets",
  "needs_replay": true,
  "needs_beatmap": false,
  "replay_upload_path": "${API}/submissions/.../replay",
  "beatmap_upload_path": null,
  "expires_at": "..."
}`}</CodeBlock>
            <P>
              Upload each file the server asks for with <Code>PUT</Code> to the path it returned, as{" "}
              <Code>application/octet-stream</Code> with the raw bytes (no base64 or gzip). The size limits are in{" "}
              <Code>/capabilities</Code> under <Code>limits</Code>: 25 MiB for a replay, 8 MiB for a chart and 16 KiB
              for JSON by default. An upload has to finish within 4 minutes. Sending the same bytes twice is safe. Then
              call <Code>POST .../complete</Code>, which returns{" "}
              <Code>202</Code> once the play is queued. If a file went missing on the server in the meantime, it answers{" "}
              <Code>409 assets_missing</Code> and the submission asks for that file again.
            </P>
            <P>Poll the submission with backoff. The state goes through:</P>
            <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-2 font-mono text-[13px]">
              <State>awaiting_assets</State>
              <Arrow />
              <State>queued</State>
              <Arrow />
              <State>validating</State>
              <Arrow />
              <State>analyzing</State>
              <Arrow />
              <State tone="good">accepted</State>
              <span className="text-osu-f1/60">or</span>
              <State tone="bad">rejected</State>
            </div>
            <P>
              <Code>deferred</Code> means the server will retry the play by itself. It tries up to six times over about
              half an hour, then marks the play <Code>rejected</Code> with <Code>processing_failed</Code>. Calling{" "}
              <Code>POST .../complete</Code> again on a deferred play retries it right away. <Code>expired</Code> and{" "}
              <Code>deleted</Code> are also final states.
            </P>
          </Section>

          <Section n={4} title="Errors">
            <div className="mt-3 overflow-x-auto rounded-xl border border-osu-b3/30 bg-osu-b4/40 px-4 py-1">
              <table className="w-full text-left text-sm">
                <tbody>
                  {ERRORS.map(([when, what]) => (
                    <tr key={when} className="border-b border-osu-b3/30 last:border-0">
                      <td className="py-2.5 pr-5 align-top font-medium text-white sm:w-[42%]">{when}</td>
                      <td className="py-2.5 align-top text-osu-f1/80">{what}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          <Section n={5} title="The queue">
            <P>
              Save each play and its Idempotency-Key before the first request, along with the account and installation
              it was captured under. Retries reuse the same key and the same bytes, with a new proof.
            </P>
            <P>
              If a different account connects later, don't move old pending plays to it. The server refuses the same
              play under a new key, so every retry would come back as a duplicate.
            </P>
            <P>
              Two installs on the same PC, for example with dual boot, are two installations on one account, each with
              its own key. Give them names the player can tell apart on <A href="/companella">/companella</A>.
            </P>
          </Section>

          <Section n={6} title="What the server checks">
            <P>
              The rating is computed from the key presses in the replay. Every press is matched to its note and scored
              by how many milliseconds it was off, so the replay has to contain the real input of the play. A replay
              rebuilt from score data without the key presses can't be rated. Send the .osr exactly as osu! saved
              it.
            </P>
            <P>
              The judgement counts in the header are what the site displays. If the key presses don't back them up, the
              play is held for review.
            </P>
            <P>
              Plays from 4K to 10K are rated. Wider keymodes are stored without a rating. Mods that can't be played
              together, like DT with HT, get the play rejected. <Code>/capabilities</Code> lists them.
            </P>
            <P>
              Only plays on charts the site already knows count toward the rating, rate-changed copies included. A copy
              with different scroll speed changes, or a chart the site doesn't know, is still rated per play but doesn't
              count.
            </P>
            <P>
              The server also checks that the files are intact, that the name in the replay matches the connected
              account, and that the judgements add up to a finished chart. It can't confirm that a person set the score,
              since the key only shows which installation sent it and a replay file can be edited.
            </P>
          </Section>

          <Section title="Before release">
            <P>Things to agree on with us first:</P>
            <ul className="mt-3 list-disc space-y-2 pl-5 leading-7 marker:text-osu-f1/50">
              <li>whether the app can capture the full replay with its key presses</li>
              <li>which callback setup you tested</li>
              <li>which platforms the app supports</li>
              <li>which plays should count at first</li>
            </ul>
            <P>
              So far only the reference client's generated replays have been tested. We should also send one real
              Companella capture through together.
            </P>
          </Section>

          <footer className="mt-14 border-t border-osu-b3/40 pt-5 text-xs text-osu-f1/60">Last changed {UPDATED}</footer>
        </div>
      </div>
    </div>
  );
}

function Section({ n, title, children }: { n?: number; title: string; children: ReactNode }) {
  return (
    <section className="mt-12">
      <h2 className="flex items-baseline gap-3 text-xl font-bold text-white">
        {n ? <span className="font-mono text-sm font-normal text-osu-pink-light/70">0{n}</span> : null}
        {title}
      </h2>
      <div className="mt-3 leading-7 text-osu-f1/85">{children}</div>
    </section>
  );
}

function P({ children }: { children: ReactNode }) {
  return <p className="mt-3 leading-7 text-osu-f1/85">{children}</p>;
}

function A({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} className="text-osu-pink-light underline decoration-osu-pink-light/30 underline-offset-2 hover:decoration-current">
      {children}
    </a>
  );
}

function HeaderLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      className="rounded-md bg-osu-b4 px-3 py-1.5 font-semibold text-osu-c2 transition-colors hover:bg-osu-b3 hover:text-white"
    >
      {children}
    </a>
  );
}

function Code({ children }: { children: ReactNode }) {
  return <code className="rounded bg-osu-b3/60 px-1 py-px font-mono [overflow-wrap:anywhere] text-[0.85em] text-white/90">{children}</code>;
}

function CodeBlock({ label, children }: { label: string; children: string }) {
  return (
    <div className="mt-4 overflow-hidden rounded-lg border border-osu-b3/30 bg-osu-b6/70">
      <div className="px-4 pt-2.5 font-mono text-[11px] text-osu-f1/50">{label}</div>
      <pre className="overflow-x-auto px-4 pb-4 pt-1.5 font-mono text-[12.5px] leading-6 text-osu-c2">{children}</pre>
    </div>
  );
}

function Note({ children }: { children: ReactNode }) {
  return <div className="mt-5 border-l-2 border-osu-yellow/70 pl-4 leading-7 text-osu-c2">{children}</div>;
}

const METHOD_TONE: Record<Method, string> = {
  GET: "text-osu-blue",
  POST: "text-osu-green-light",
  PUT: "text-osu-orange",
};

function MethodTag({ method }: { method: Method }) {
  return <span className={`font-mono text-[12px] font-bold ${METHOD_TONE[method]}`}>{method}</span>;
}

function Step({ n, title, call, children }: { n: number; title: string; call: string; children: ReactNode }) {
  return (
    <li className="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-3 py-3.5 sm:grid-cols-[1.75rem_minmax(0,1fr)_13rem] sm:gap-x-5">
      <span className="pt-px font-mono text-sm text-osu-pink-light/70">{n}</span>
      <div>
        <div className="font-semibold text-white">{title}</div>
        <div className="mt-0.5 leading-7 text-osu-f1/80">{children}</div>
      </div>
      <div className="col-start-2 mt-1 font-mono text-[12px] leading-6 text-osu-f1/60 sm:col-start-3 sm:mt-0 sm:pt-px sm:text-right">
        {call}
      </div>
    </li>
  );
}

function State({ tone, children }: { tone?: "good" | "bad"; children: ReactNode }) {
  const color = tone === "good" ? "text-osu-green-light" : tone === "bad" ? "text-osu-red-light" : "text-osu-c2";
  return <span className={`rounded bg-osu-b4 px-2 py-0.5 ${color}`}>{children}</span>;
}

function Arrow() {
  return <span className="text-osu-f1/40">→</span>;
}
