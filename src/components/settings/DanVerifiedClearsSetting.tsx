import { useEffect, useState } from "react";
import { useLingui } from "@lingui/react/macro";

import { useAuth } from "../../lib/auth-context";
import { getMyDanVerifiedClears, setMyDanVerifiedClears } from "../../lib/skill-privacy";
import { Switch } from "../ui/Switch";

/* Waits before each retry of the first read, ms. */
const LOAD_RETRIES_MS = [1_500, 4_000, 10_000];

/* Whether the signed-in player's verified clears and dan course passes count
   toward their dans. Off, their dans come from their other plays alone, for
   everyone who sees their profile. A row inside the Skills group. */
export function DanVerifiedClearsSetting() {
  const { t } = useLingui();
  const viewerId = useAuth().viewer?.id ?? null;
  const [counted, setCounted] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    if (viewerId == null) return;
    let cancelled = false;
    let timer = 0;
    const attempt = (tries: number) => {
      void getMyDanVerifiedClears()
        .catch(() => ({ ok: false as const }))
        .then((result) => {
          if (cancelled) return;
          if (result.ok) setCounted(result.counted);
          else if (tries < LOAD_RETRIES_MS.length) timer = window.setTimeout(() => attempt(tries + 1), LOAD_RETRIES_MS[tries]);
          else setLoadFailed(true);
        });
    };
    attempt(0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [viewerId]);

  if (viewerId == null) return null;

  const save = async (next: boolean) => {
    if (saving || counted == null) return;
    setSaving(true);
    setFailed(false);
    const result = await setMyDanVerifiedClears({ data: { counted: next } }).catch(() => null);
    setSaving(false);
    if (result?.ok) setCounted(result.counted);
    else setFailed(true);
  };

  const detail = failed
    ? t`Could not save that. Try again in a bit.`
    : counted == null
      ? loadFailed
        ? t`Could not load this. Close and reopen settings to try again.`
        : t`Loading…`
    : counted
      ? t`A pass or near pass on a real dan course or a dan practice chart puts your dan at that level by itself.`
      : t`Your dans come from your other plays only.`;

  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="text-[12px] font-semibold text-osu-l1">{t`Count verified clears`}</div>
        <div className={`text-[11px] ${failed || loadFailed ? "text-osu-red" : "text-osu-f1"}`}>{detail}</div>
      </div>
      <div className={counted == null || saving ? "pointer-events-none opacity-50" : undefined}>
        <Switch checked={counted ?? true} onChange={(next) => void save(next)} label={t`Count verified clears`} />
      </div>
    </div>
  );
}
