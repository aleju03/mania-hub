import { useEffect, useState } from "react";

/* Typing a name should not cost a request per keystroke: every search box on
   this page is a server read, and the list underneath re-renders on every one
   of them. Shared by the collector directory, a collector's card grid and the
   showcase picker, which all search the same way. */
export function useDebounced(value: string, delayMs: number): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value.trim()), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}
