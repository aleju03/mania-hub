export function logInfo(message: string, context: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ level: "info", message, at: new Date().toISOString(), ...context }));
}

export function logWarn(message: string, context: Record<string, unknown> = {}): void {
  console.warn(JSON.stringify({ level: "warn", message, at: new Date().toISOString(), ...context }));
}

export function errorContext(error: unknown): Record<string, unknown> {
  return {
    error: error instanceof Error ? error.message : String(error),
  };
}
