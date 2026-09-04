import { lazy, type ComponentProps } from "react";

type EditorModule = typeof import("./ReplaySkinSettingsModal");
let editorRequest: Promise<EditorModule> | null = null;
let LoadedEditor: EditorModule["ReplaySkinSettingsModal"] | null = null;

export function loadReplaySkinSettingsModal(): Promise<EditorModule> {
  if (!editorRequest) {
    editorRequest = import("./ReplaySkinSettingsModal").then((module) => {
      LoadedEditor = module.ReplaySkinSettingsModal;
      return module;
    }).catch((error) => {
      editorRequest = null;
      throw error;
    });
  }
  return editorRequest;
}

const DeferredEditor = lazy(() => loadReplaySkinSettingsModal().then((module) => ({ default: module.ReplaySkinSettingsModal })));

// Opening waits for loadReplaySkinSettingsModal, so an already-warmed editor
// paints directly instead of briefly suspending on React.lazy's first render.
export function ReplaySkinSettingsModal(props: ComponentProps<EditorModule["ReplaySkinSettingsModal"]>) {
  return LoadedEditor ? <LoadedEditor {...props} /> : <DeferredEditor {...props} />;
}

export function preloadReplaySkinSettingsModal(): void {
  void loadReplaySkinSettingsModal().catch(() => {});
}

// Called only after a replay is ready, never from the shared application shell.
export function scheduleReplaySkinSettingsPreload(): () => void {
  if (typeof window.requestIdleCallback === "function") {
    const idle = window.requestIdleCallback(preloadReplaySkinSettingsModal, { timeout: 3000 });
    return () => window.cancelIdleCallback(idle);
  }
  const timer = window.setTimeout(preloadReplaySkinSettingsModal, 1000);
  return () => window.clearTimeout(timer);
}
