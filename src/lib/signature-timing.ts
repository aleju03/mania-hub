// Public duration labels only; never include tokens, URLs or player data.
export class SignatureTiming {
  private readonly started = performance.now();
  private readonly durations = new Map<string, number>();

  add(name: string, duration: number): void {
    this.durations.set(name, (this.durations.get(name) ?? 0) + duration);
  }

  async measure<T>(name: string, task: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try {
      return await task();
    } finally {
      this.add(name, performance.now() - start);
    }
  }

  header(cache: string): string {
    return [
      `cache;desc="${cache}"`,
      ...[...this.durations].map(([name, duration]) => `${name};dur=${duration.toFixed(1)}`),
      `total;dur=${(performance.now() - this.started).toFixed(1)}`,
    ].join(", ");
  }
}
