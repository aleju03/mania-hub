// Web Audio plumbing for map preview <audio> elements so UI can react to the
// actual signal (the maps random-card wave bar). One shared AudioContext for
// the whole app (browsers cap live contexts), and one MediaElementSource per
// element - the API allows exactly one, ever, so the graph is cached per
// element and only disconnected while unused, never torn down.
//
// Only route elements whose src is CORS-clean (same origin, or
// crossOrigin="anonymous" against a server that allows it) through this: a
// tainted element connected to the graph plays silence.

type PreviewAnalyserGraph = {
  source: MediaElementAudioSourceNode;
  analyser: AnalyserNode;
  connected: boolean;
};

let sharedContext: AudioContext | null = null;
const graphs = new WeakMap<HTMLMediaElement, PreviewAnalyserGraph>();

function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (sharedContext) return sharedContext;
  const Ctor = window.AudioContext
    ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    sharedContext = new Ctor();
  } catch {
    return null;
  }
  return sharedContext;
}

export function getPreviewAnalyser(element: HTMLMediaElement): AnalyserNode | null {
  const context = getAudioContext();
  if (!context) return null;
  let graph = graphs.get(element);
  if (!graph) {
    try {
      const source = context.createMediaElementSource(element);
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      // Snappier than the 0.8 default so kicks read as kicks.
      analyser.smoothingTimeConstant = 0.35;
      graph = { source, analyser, connected: false };
      graphs.set(element, graph);
    } catch {
      return null;
    }
  }
  if (!graph.connected) {
    graph.source.connect(graph.analyser);
    graph.analyser.connect(context.destination);
    graph.connected = true;
  }
  // Contexts start suspended until a user gesture; callers reach here off a
  // play() that already satisfied the gesture requirement.
  if (context.state === "suspended") void context.resume().catch(() => undefined);
  return graph.analyser;
}

// Detach an element's graph (card unmount) so discarded elements don't keep
// nodes wired to the destination. A later getPreviewAnalyser reconnects.
export function releasePreviewAnalyser(element: HTMLMediaElement | null): void {
  if (!element) return;
  const graph = graphs.get(element);
  if (!graph || !graph.connected) return;
  try {
    graph.source.disconnect();
    graph.analyser.disconnect();
  } catch {
    // Already-detached nodes throw on disconnect in some browsers.
  }
  graph.connected = false;
}
