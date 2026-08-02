// The viewer's replay skin, for any stage outside the replay page (chart
// previews, the maps page's preview).
//
// Reading localStorage is not enough on its own: while a custom skin is
// applied, that entry holds the asset-free copy and a separate pointer names
// the .osk, so the art has to be rebuilt before a preview can draw it. This
// keeps both halves in step and re-reads whenever another surface changes the
// settings.

import { useEffect, useState } from "react";
import { useAuth } from "./auth-context";
import { canUseReplaySkinImport, loadAppliedReplaySkinSettings } from "./replay-owner-skin";
import {
  REPLAY_SKIN_SETTINGS_CHANGE_EVENT,
  readReplaySkinSettings,
  type ReplaySkinSettings,
} from "./replay-skin";

export function useReplaySkinSettings(): ReplaySkinSettings {
  const auth = useAuth();
  const canUseSkinImport = canUseReplaySkinImport(auth);
  const [stored, setStored] = useState(readReplaySkinSettings);
  const [applied, setApplied] = useState<ReplaySkinSettings | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const refresh = () => {
      setStored(readReplaySkinSettings());
      setRevision((current) => current + 1);
    };
    window.addEventListener("storage", refresh);
    window.addEventListener(REPLAY_SKIN_SETTINGS_CHANGE_EVENT, refresh);
    window.addEventListener("focus", refresh);
    return () => {
      window.removeEventListener("storage", refresh);
      window.removeEventListener(REPLAY_SKIN_SETTINGS_CHANGE_EVENT, refresh);
      window.removeEventListener("focus", refresh);
    };
  }, []);

  useEffect(() => {
    if (!canUseSkinImport) {
      setApplied(null);
      return;
    }
    let cancelled = false;
    void loadAppliedReplaySkinSettings().then((settings) => {
      if (!cancelled) setApplied(settings);
    });
    return () => {
      cancelled = true;
    };
  }, [canUseSkinImport, revision]);

  // The rebuilt copy wins only while the pointer is still the one it came
  // from; clearing the skin drops it on the next refresh.
  return applied ?? stored;
}
