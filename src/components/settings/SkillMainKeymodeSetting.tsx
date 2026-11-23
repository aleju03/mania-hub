import { useEffect, useState } from "react";
import { useLingui } from "@lingui/react/macro";

import { useAuth } from "../../lib/auth-context";
import { fetchLivePlayerSkillsDirect, refreshLivePlayerSkillsDirect } from "../../lib/live-backend";
import { qualifyingSkillModes } from "../../lib/skill-axes";
import { getMySkillMainKeymode, setMySkillMainKeymode } from "../../lib/skill-privacy";
import { SelectMenu } from "../ui/SelectMenu";
import { DanVerifiedClearsSetting } from "./DanVerifiedClearsSetting";
import { PanelGroup } from "./PanelGroup";

/* Before the player's own ratings load (or when they are hidden from the
   public read), the keymodes anyone is rated in. */
const FALLBACK_KEY_COUNTS = [4, 5, 6, 7, 8, 9, 10];
/* Waits before each retry of the first read, ms. */
const LOAD_RETRIES_MS = [1_500, 4_000, 10_000];

/* Which keymode the signed-in player's profile Skills tab opens on, for
   everyone who visits it. Automatic leads with the keymode they have the most
   rated plays in. */
export function SkillMainKeymodeSetting() {
  const { t } = useLingui();
  const viewerId = useAuth().viewer?.id ?? null;
  const [keyCount, setKeyCount] = useState<number | null | undefined>(undefined);
  const [rated, setRated] = useState<number[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    if (viewerId == null) return;
    let cancelled = false;
    let timer = 0;
    // A failed read (the backend restarting, a blip) tries again a few times
    // before saying so, rather than leaving the menu greyed out.
    const attempt = (tries: number) => {
      void getMySkillMainKeymode()
        .catch(() => ({ ok: false as const }))
        .then((result) => {
          if (cancelled) return;
          if (result.ok) setKeyCount(result.keyCount);
          else if (tries < LOAD_RETRIES_MS.length) timer = window.setTimeout(() => attempt(tries + 1), LOAD_RETRIES_MS[tries]);
          else setLoadFailed(true);
        });
    };
    attempt(0);
    void fetchLivePlayerSkillsDirect(viewerId)
      .then((skills) => {
        // the keymodes the profile shows a panel for
        const keys = qualifyingSkillModes(skills).map((mode) => mode.keyCount);
        if (!cancelled && keys.length > 0) setRated([...keys].sort((a, b) => a - b));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [viewerId]);

  if (viewerId == null) return null;

  const save = async (next: number | null) => {
    setSaving(true);
    setFailed(false);
    const result = await setMySkillMainKeymode({ data: { keyCount: next } }).catch(() => null);
    setSaving(false);
    if (result?.ok) {
      setKeyCount(result.keyCount);
      void refreshLivePlayerSkillsDirect(viewerId).catch(() => {});
    } else setFailed(true);
  };

  const keys = rated ?? FALLBACK_KEY_COUNTS;
  // A saved keymode stays pickable even before the ratings list arrives.
  const shown = keyCount != null && !keys.includes(keyCount) ? [...keys, keyCount].sort((a, b) => a - b) : keys;
  const detail = failed
    ? t`Could not save that. Try again in a bit.`
    : keyCount === undefined
      ? loadFailed
        ? t`Could not load this. Close and reopen settings to try again.`
        : t`Loading…`
    : keyCount != null
      ? t`Your profile's Skills tab opens on ${keyCount}K.`
      : t`Your profile's Skills tab opens on the keymode with the most rated plays.`;

  return (
    <PanelGroup label={t`Skills`}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[12px] font-semibold text-osu-l1">{t`Main keymode`}</div>
          <div className={`text-[11px] ${failed || loadFailed ? "text-osu-red" : "text-osu-f1"}`}>{detail}</div>
        </div>
        <SelectMenu
          value={keyCount == null ? "auto" : String(keyCount)}
          align="right"
          className="shrink-0 whitespace-nowrap"
          disabled={keyCount === undefined || saving}
          ariaLabel={t`Main keymode`}
          options={[
            { value: "auto", label: t`Automatic` },
            ...shown.map((keys) => ({ value: String(keys), label: `${keys}K` })),
          ]}
          onChange={(next) => {
            const value = next === "auto" ? null : Number(next);
            if (value === (keyCount ?? null)) return;
            void save(value);
          }}
        />
      </div>
      <DanVerifiedClearsSetting />
    </PanelGroup>
  );
}
