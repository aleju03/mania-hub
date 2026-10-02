import { useEffect, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { Loader2, X } from "lucide-react";

type PanelModule = typeof import("./SettingsPanel");
let panelRequest: Promise<PanelModule> | null = null;
let LoadedPanel: PanelModule["SettingsPanel"] | null = null;

export function loadSettingsPanel(): Promise<PanelModule> {
  if (!panelRequest) {
    panelRequest = import("./SettingsPanel").then((module) => {
      LoadedPanel = module.SettingsPanel;
      return module;
    }).catch((error) => {
      panelRequest = null;
      throw error;
    });
  }
  return panelRequest;
}

export function preloadSettingsPanel(): void {
  void loadSettingsPanel().catch(() => {});
}

/** A warmed panel opens synchronously; a cold or failed import stays closeable. */
export function LazySettingsPanel({ onClose }: { onClose: () => void }) {
  const { t } = useLingui();
  const [state, setState] = useState(() => ({ Panel: LoadedPanel, failed: false }));
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (state.Panel) return;
    let cancelled = false;
    void loadSettingsPanel().then((module) => {
      if (!cancelled) setState({ Panel: module.SettingsPanel, failed: false });
    }).catch(() => {
      if (!cancelled) setState({ Panel: null, failed: true });
    });
    return () => { cancelled = true; };
  }, [attempt, state.Panel]);

  if (state.Panel) return <state.Panel variant="drawer" onClose={onClose} />;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-osu-b3/40 bg-osu-d5 px-4 py-3">
        <img src="/images/icons/settings.svg" alt="" width={22} height={22} className="opacity-60 shrink-0" />
        <h2 className="flex-1 text-[13px] font-semibold text-osu-c2"><Trans>settings</Trans></h2>
        <button
          type="button"
          onClick={onClose}
          className="grid h-8 w-8 cursor-pointer place-items-center rounded-lg text-osu-pink-light transition-colors hover:bg-osu-b3/50 hover:text-white"
          aria-label={t`Close settings`}
        >
          <X className="h-4 w-4" strokeWidth={2.2} />
        </button>
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-4 px-5 text-center text-sm text-osu-f1">
        {state.failed ? (
          <>
            <p role="alert"><Trans>Unable to load settings.</Trans></p>
            <button
              type="button"
              onClick={() => {
                setState({ Panel: null, failed: false });
                setAttempt((value) => value + 1);
              }}
              className="cursor-pointer rounded-lg border border-osu-b3/60 px-4 py-2 font-semibold text-osu-l1 transition-colors hover:bg-osu-b3/50"
            >
              <Trans>Try again</Trans>
            </button>
          </>
        ) : (
          <div role="status" className="flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin text-osu-pink-light" aria-hidden="true" />
            <Trans>Loading...</Trans>
          </div>
        )}
      </div>
    </div>
  );
}
