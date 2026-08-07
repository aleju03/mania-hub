export type SharedEventListener = EventListenerOrEventListenerObject | ((event: MessageEvent) => unknown);

export interface SharedEventSource {
  readonly readyState: number;
  onopen: ((event: Event) => unknown) | null;
  onerror: ((event: Event) => unknown) | null;
  onmessage: ((event: MessageEvent) => unknown) | null;
  addEventListener(
    type: string,
    listener: (event: MessageEvent) => unknown,
    options?: boolean | AddEventListenerOptions,
  ): void;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    listener: SharedEventListener,
    options?: boolean | EventListenerOptions,
  ): void;
  close(): void;
}

/** The slice of EventSource the pool needs, so a cross-tab relay (or a test
 *  fake) can stand in for the real thing. */
export interface PoolableEventSource {
  readonly readyState: number;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ): void;
  close(): void;
}

type ListenerRegistration = {
  type: string;
  listener: SharedEventListener;
  capture: boolean;
};

type SharedEntry = {
  source: PoolableEventSource;
  handles: Set<SharedEventSourceHandle>;
};

function captureFromOptions(options?: boolean | EventListenerOptions): boolean {
  return typeof options === "boolean" ? options : options?.capture === true;
}

/**
 * EventSource is expensive under HTTP/1.1: browsers generally allow only six
 * connections to one origin, and every stream occupies one for its lifetime.
 * This pool gives independent consumers their normal EventSource-shaped handle
 * while ref-counting one underlying connection per URL.
 */
export class SharedEventSourcePool {
  private readonly entries = new Map<string, SharedEntry>();

  constructor(private readonly createSource: (url: string) => PoolableEventSource) {}

  open(url: string): SharedEventSource {
    let entry = this.entries.get(url);
    if (!entry || entry.source.readyState === EventSource.CLOSED) {
      entry = { source: this.createSource(url), handles: new Set() };
      this.entries.set(url, entry);
    }
    const handle = new SharedEventSourceHandle(entry, () => this.release(url, entry!, handle));
    entry.handles.add(handle);
    return handle;
  }

  activeConnectionCount(): number {
    return this.entries.size;
  }

  private release(url: string, entry: SharedEntry, handle: SharedEventSourceHandle): void {
    entry.handles.delete(handle);
    if (entry.handles.size > 0) return;
    entry.source.close();
    if (this.entries.get(url) === entry) this.entries.delete(url);
  }
}

class SharedEventSourceHandle implements SharedEventSource {
  private readonly listeners: ListenerRegistration[] = [];
  private closed = false;
  private openListener: ((event: Event) => unknown) | null = null;
  private errorListener: ((event: Event) => unknown) | null = null;
  private messageListener: ((event: MessageEvent) => unknown) | null = null;

  constructor(
    private readonly entry: SharedEntry,
    private readonly release: () => void,
  ) {}

  get readyState(): number {
    return this.closed ? EventSource.CLOSED : this.entry.source.readyState;
  }

  get onopen(): ((event: Event) => unknown) | null {
    return this.openListener;
  }

  set onopen(listener: ((event: Event) => unknown) | null) {
    this.replacePropertyListener("open", this.openListener, listener);
    this.openListener = listener;
  }

  get onerror(): ((event: Event) => unknown) | null {
    return this.errorListener;
  }

  set onerror(listener: ((event: Event) => unknown) | null) {
    this.replacePropertyListener("error", this.errorListener, listener);
    this.errorListener = listener;
  }

  get onmessage(): ((event: MessageEvent) => unknown) | null {
    return this.messageListener;
  }

  set onmessage(listener: ((event: MessageEvent) => unknown) | null) {
    this.replacePropertyListener("message", this.messageListener, listener);
    this.messageListener = listener;
  }

  addEventListener(
    type: string,
    listener: SharedEventListener,
    options?: boolean | AddEventListenerOptions,
  ): void {
    if (this.closed) return;
    const capture = captureFromOptions(options);
    if (this.listeners.some((entry) => entry.type === type && entry.listener === listener && entry.capture === capture)) return;
    this.listeners.push({ type, listener, capture });
    this.entry.source.addEventListener(type, listener as EventListenerOrEventListenerObject, options);
  }

  removeEventListener(
    type: string,
    listener: SharedEventListener,
    options?: boolean | EventListenerOptions,
  ): void {
    const capture = captureFromOptions(options);
    const index = this.listeners.findIndex(
      (entry) => entry.type === type && entry.listener === listener && entry.capture === capture,
    );
    if (index < 0) return;
    this.listeners.splice(index, 1);
    this.entry.source.removeEventListener(type, listener as EventListenerOrEventListenerObject, options);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const { type, listener, capture } of this.listeners.splice(0)) {
      this.entry.source.removeEventListener(type, listener as EventListenerOrEventListenerObject, capture);
    }
    this.openListener = null;
    this.errorListener = null;
    this.messageListener = null;
    this.release();
  }

  private replacePropertyListener(
    type: string,
    current: SharedEventListener | null,
    next: SharedEventListener | null,
  ): void {
    if (current) this.removeEventListener(type, current);
    if (next) this.addEventListener(type, next);
  }
}
