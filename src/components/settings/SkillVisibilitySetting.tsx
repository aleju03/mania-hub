import { useEffect, useState } from "react";
import { useLingui } from "@lingui/react/macro";

import { useAuth } from "../../lib/auth-context";
import { getMySkillVisibility, setMySkillVisibility, type SkillVisibility } from "../../lib/skill-privacy";
import { ConfirmModal } from "../ui/ConfirmModal";
import { SelectMenu } from "../ui/SelectMenu";
import { PanelGroup } from "./PanelGroup";

/* Who may see the signed-in player's skill ratings and dans: one ordinary row
   at the foot of Preferences, the line under its name saying what the current
   choice does. Turning ratings off asks first. */
/* Waits before each retry of the first read, ms. */
const LOAD_RETRIES_MS = [1_500, 4_000, 10_000];

export function SkillVisibilitySetting() {
  const { t } = useLingui();
  const viewerId = useAuth().viewer?.id ?? null;
  const [visibility, setVisibility] = useState<SkillVisibility | null>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  // A failed read (the backend restarting, a blip) tries again a few times
  // before saying so, rather than leaving the menu greyed out.
  useEffect(() => {
    if (viewerId == null) return;
    let cancelled = false;
    let timer = 0;
    const attempt = (tries: number) => {
      void getMySkillVisibility()
        .catch(() => ({ ok: false as const }))
        .then((result) => {
          if (cancelled) return;
          if (result.ok) setVisibility(result.visibility);
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

  const save = async (next: SkillVisibility) => {
    setSaving(true);
    setFailed(false);
    const result = await setMySkillVisibility({ data: { visibility: next } }).catch(() => null);
    setSaving(false);
    if (result?.ok) setVisibility(result.visibility);
    else setFailed(true);
  };

  const detail = failed
    ? t`Could not save that. Try again in a bit.`
    : visibility == null
      ? loadFailed
        ? t`Could not load this. Close and reopen settings to try again.`
        : t`Loading…`
    : visibility === "private"
      ? t`Only you see your skill ratings and dans. You are left out of the skill rankings.`
      : visibility === "off"
        ? t`Your plays are not rated, and nothing shows, not even to you.`
        : t`Your skill ratings and dans show on your profile and in the rankings.`;

  return (
    <PanelGroup label={t`Privacy`}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[12px] font-semibold text-osu-l1">{t`Skill ratings visible to`}</div>
          <div className={`text-[11px] ${failed || loadFailed ? "text-osu-red" : "text-osu-f1"}`}>{detail}</div>
        </div>
        <SelectMenu
          value={visibility ?? "public"}
          align="right"
          className="shrink-0 whitespace-nowrap"
          disabled={visibility == null || saving}
          ariaLabel={t`Skill ratings visible to`}
          options={[
            { value: "public" as const, label: t`Everyone` },
            { value: "private" as const, label: t`Only me` },
            { value: "off" as const, label: t`Nobody` },
          ]}
          onChange={(next) => {
            if (next === visibility) return;
            if (next === "off") setConfirmOff(true);
            else void save(next);
          }}
        />
      </div>
      {confirmOff ? (
        <ConfirmModal
          title={t`Turn off your skill ratings?`}
          body={t`Your plays stop being rated and your ratings and dans show to nobody, you included. Turning them back on rates your plays again.`}
          confirmLabel={t`Turn off`}
          danger
          onConfirm={() => {
            setConfirmOff(false);
            void save("off");
          }}
          onClose={() => setConfirmOff(false)}
        />
      ) : null}
    </PanelGroup>
  );
}
