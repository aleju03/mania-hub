// React's view of the current export.
//
// Lives apart from the progress panel so a route can watch the job without
// importing the panel's rendering (and its animation dependencies) as well.

import { useSyncExternalStore } from "react";

import { getReplayExportManager, peekReplayExportManager } from "./manager";
import type { ReplayExportJobView } from "./types";

function subscribe(onChange: () => void): () => void {
  return getReplayExportManager().subscribe(() => onChange());
}

function getSnapshot(): ReplayExportJobView | null {
  return peekReplayExportManager()?.view ?? null;
}

function getServerSnapshot(): ReplayExportJobView | null {
  return null;
}

export function useReplayExportJob(): ReplayExportJobView | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
