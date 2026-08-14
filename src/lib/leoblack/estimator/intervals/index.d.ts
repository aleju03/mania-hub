export type DanIntervalTable = ReadonlyArray<readonly [number, number, string]>;

export const DAN_INDEX: Record<
  number,
  {
    RC: Record<string, DanIntervalTable>;
    LN?: Record<string, DanIntervalTable>;
  }
>;
