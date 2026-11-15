import { useEffect, useState } from "react";

/* For the /supporter stage while the pointer sweeps across a drawer: the
   costly parts of a look (a frame's video, a name's WebGL shader, the card's
   repainted textures) wait until the pick has held still for `ms`, and show
   something cheap or the last settled pick until then. */

/* `value` once its `key` has held for `ms`; until then the last value that did. */
export function useSettled<T>(value: T, ms: number, key: string): T {
  const [settled, setSettled] = useState({ key, value });
  useEffect(() => {
    if (key === settled.key) return;
    const timer = setTimeout(() => setSettled({ key, value }), ms);
    return () => clearTimeout(timer);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return key === settled.key ? value : settled.value;
}

/* Whether `key` has held for `ms`. */
export function useIsSettled(key: string, ms: number): boolean {
  return useSettled(key, ms, key) === key;
}
