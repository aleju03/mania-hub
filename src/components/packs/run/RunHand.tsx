import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AnimatePresence } from "framer-motion";
import { RunCard, type RunCardSlot, type RunHandCard } from "./RunCard";
import { RUN_FEEL } from "./runFeel";

/* The fan: where each of `count` cards sits, how wide they are and how much
   they overlap. Cards spread with a small gap while there is room and close
   up into an overlap when the hand outgrows the row; the outer ones tip
   outward and dip a little, like a hand held in two fingers. */
export function handLayout(count: number, width: number, height: number): { cardWidth: number; slots: RunCardSlot[] } {
  const fan = RUN_FEEL.fan;
  // Leave headroom above for the hover lift and below for the arc.
  let cardHeight = Math.max(60, Math.min(height - 34, 300));
  let cardWidth = (cardHeight * 5) / 7;
  const fits = (w: number) => count <= 1 || w + (count - 1) * w * fan.minVisibleFraction <= width - 12;
  while (!fits(cardWidth) && cardWidth > 40) {
    cardWidth -= 2;
    cardHeight = (cardWidth * 7) / 5;
  }
  const roomy = cardWidth * (1 + fan.gapFraction);
  const step = count <= 1 ? 0 : Math.max(cardWidth * fan.minVisibleFraction, Math.min(roomy, (width - 12 - cardWidth) / (count - 1)));
  const mid = (count - 1) / 2;
  const spread = Math.min(fan.degPerCard * (count - 1), fan.maxSpreadDeg);
  const top = Math.max(0, (height - cardHeight) / 2 - 6);
  const slots = Array.from({ length: count }, (_, index) => {
    const offset = index - mid;
    return {
      x: offset * step,
      // The ends sit arcFraction of a card lower than the middle.
      y: top + (mid > 0 ? (offset / mid) ** 2 : 0) * fan.arcFraction * cardHeight,
      rotate: mid > 0 ? (offset / mid) * (spread / 2) : 0,
    };
  });
  return { cardWidth: Math.round(cardWidth), slots };
}

interface RunHandProps {
  /* The dealt cards; a new `dealId` replaces the hand (the old one drops
     off the table first). */
  cards: RunHandCard[];
  dealId: number;
  /* The pack's mouth in viewport px, read once when a deal mounts. */
  dealOrigin: (() => { x: number; y: number } | null) | null;
  backUrl: string | null;
  reducedMotion: boolean;
  /* Every card's element, by hand index, for the scoring sequence. */
  onCardElements?: (elements: Array<HTMLDivElement | null>) => void;
}

export function RunHand({ cards, dealId, dealOrigin, backUrl, reducedMotion, onCardElements }: RunHandProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [hovered, setHovered] = useState<number | null>(null);
  const [lifted, setLifted] = useState<number | null>(null);
  const elementsRef = useRef<Array<HTMLDivElement | null>>([]);
  /* The deal's start offsets, fixed for the deal they belong to so a resize
     mid-flight does not restart the flight. */
  const originRef = useRef<{ dealId: number; offset: { x: number; y: number } | null }>({ dealId: -1, offset: null });

  useLayoutEffect(() => {
    const element = boxRef.current;
    if (!element) return;
    const measure = () => setBox({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  if (originRef.current.dealId !== dealId) {
    let offset: { x: number; y: number } | null = null;
    const mouth = dealOrigin?.();
    const rect = boxRef.current?.getBoundingClientRect();
    if (mouth && rect) offset = { x: mouth.x - (rect.left + rect.width / 2), y: mouth.y - rect.top };
    originRef.current = { dealId, offset };
  }

  useEffect(() => {
    setHovered(null);
    setLifted(null);
  }, [dealId]);

  const setElement = useCallback(
    (index: number, element: HTMLDivElement | null) => {
      elementsRef.current[index] = element;
    },
    [],
  );
  useEffect(() => {
    elementsRef.current.length = cards.length;
    onCardElements?.(elementsRef.current.slice());
  }, [cards.length, dealId, onCardElements]);

  const onHover = useCallback((index: number, hovering: boolean) => {
    setHovered((current) => (hovering ? index : current === index ? null : current));
  }, []);
  const onTap = useCallback((index: number) => {
    setLifted((current) => (current === index ? null : index));
  }, []);

  const layout = box.width > 0 ? handLayout(cards.length, box.width, box.height) : null;
  const offset = originRef.current.offset;
  return (
    <div
      ref={boxRef}
      className="relative h-full w-full"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) setLifted(null);
      }}
    >
      <AnimatePresence>
        {layout &&
          cards.map((card, index) => {
            const slot = layout.slots[index];
            const cardHeight = (layout.cardWidth * 7) / 5;
            return (
              <RunCard
                key={`${dealId}:${card.key}:${index}`}
                card={card}
                index={index}
                width={layout.cardWidth}
                slot={slot}
                dealFrom={offset ? { x: offset.x, y: offset.y - cardHeight / 2 } : null}
                dealDelayMs={index * RUN_FEEL.deal.staggerMs}
                zIndex={hovered === index || lifted === index ? 50 : 10 + index}
                backUrl={backUrl}
                reducedMotion={reducedMotion}
                lifted={lifted === index}
                onHover={onHover}
                onTap={onTap}
                elementRef={setElement}
              />
            );
          })}
      </AnimatePresence>
    </div>
  );
}
