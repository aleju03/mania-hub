import { useEffect, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { useLocation } from "@tanstack/react-router";
import { fetchLivePlayerSharedImportDirect } from "../../lib/live-backend";
import { companellaRowToOsuScore } from "../../lib/companella-scores";
import type { OsuScore } from "../../lib/types";
import { ScorePlayDetailModal } from "./ScorePlayDetailModal";

const IMPORT_ID = /^[A-Za-z0-9_-]{16,64}$/;

/** Opens the play a `?import=` link names, read from the backend so it still opens once osu!'s own row replaced it on the list. */
export function SharedRecentPlay({ userId, username }: { userId: number; username: string }) {
  const { t } = useLingui();
  const searchStr = useLocation({ select: (location) => location.searchStr });
  const raw = new URLSearchParams(searchStr).get("import");
  const importId = raw && IMPORT_ID.test(raw) ? raw : null;
  const [score, setScore] = useState<OsuScore | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "missing" | "error" | "closed">("loading");
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (!importId) return;
    let cancelled = false;
    setScore(null);
    setState("loading");
    fetchLivePlayerSharedImportDirect(userId, importId)
      .then((row) => {
        if (cancelled) return;
        if (!row) return setState("missing");
        setScore(companellaRowToOsuScore(row));
        setState("ready");
      })
      .catch(() => { if (!cancelled) setState("error"); });
    return () => { cancelled = true; };
  }, [userId, importId, retry]);

  if (!importId || state === "closed") return null;
  if (state === "ready" && score) return <ScorePlayDetailModal score={score} username={username} onClose={() => setState("closed")} />;
  return (
    <div role="status" className="mb-4 flex items-center justify-between gap-3 rounded-xl bg-osu-b4 p-4 text-sm text-osu-l2">
      <span>{state === "loading" ? t`Loading shared score…` : state === "error" ? t`Could not load this score.` : t`This score is no longer on the player's profile.`}</span>
      {state === "error" && <button type="button" onClick={() => setRetry((value) => value + 1)} className="text-osu-pink"><Trans>Retry</Trans></button>}
      <button type="button" onClick={() => setState("closed")} className="text-osu-f1"><Trans>Dismiss</Trans></button>
    </div>
  );
}
