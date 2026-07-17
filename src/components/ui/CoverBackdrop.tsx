import { useEffect, useState } from "react";

// Faint beatmap cover behind score-card details. The image usually finishes
// loading after the card is already visible, so without a transition it pops
// in at full backdrop opacity; fade it in once decoded instead.
export function CoverBackdrop({ url, opacityClass = "opacity-[0.07]" }: { url: string; opacityClass?: string }) {
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setLoaded(false);
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (!cancelled) setLoaded(true);
    };
    img.src = url;
    return () => {
      cancelled = true;
    };
  }, [url]);

  return (
    <div
      className={`absolute inset-0 bg-cover bg-center pointer-events-none transition-opacity duration-200 ${loaded ? opacityClass : "opacity-0"}`}
      style={{ backgroundImage: `url(${url})` }}
    />
  );
}
