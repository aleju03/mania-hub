import { handLayout } from "../RunHand";

/* Where everything on the chain table's board sits, from the board's size.
   Wide boards lay the row of 6 in one line; narrow ones in two lines of
   three (see the narrow branch). */

export interface SlotRect {
  x: number;
  y: number;
  /* An empty slot on a line with no card yet is drawn short. */
  h?: number;
}

export interface BoardLayout {
  width: number;
  height: number;
  narrow: boolean;
  cardW: number;
  cardH: number;
  slots: SlotRect[];
  /* The row's total sits centred on this line. */
  readoutY: number;
  readoutSize: number;
  rowTop: number;
  rowBottom: number;
  actionsY: number;
  handTop: number;
  handHeight: number;
  handWidth: number;
  deck: { x: number; y: number; w: number; h: number };
  /* Phones: hand cards at this width, up to handCols a row. */
  handCardW?: number;
  handCols?: number;
  /* Phones too short for the hand at its smallest: the first row lies over
     the top of the second by this much, leaving the second row's flags,
     keymodes and numbers in view. */
  handOverlap?: number;
}

export const ROW_SLOTS = 6;

const HAND_MIN = 56;

export function boardLayout(width: number, height: number): BoardLayout {
  const narrow = width < 700;
  if (narrow) {
    /* Two lines of three for the row, both left to right, always sized for
       a full row so nothing resizes while cards are placed or dragged. The
       hand under it keeps big cards (two rows, overlapping a little when it
       holds more than six). Links between the lines run as elbows through
       the gap, each on its own lane, so none cross. */
    const side = 8;
    const gapX = 0.3;
    // Short screens (a phone browser's toolbars take ~150px) close the gaps
    // before any card shrinks.
    const tight = height < 600;
    const gapY = tight ? 30 : 38;
    const readoutSize = tight ? 38 : 44;
    const arcRoom = 14;
    const below = tight ? 14 : 22;
    const actions = 48;
    // Air between the buttons and the hand, so the cards don't crowd them.
    const afterActions = tight ? 10 : 16;
    const handGap = tight ? 4 : 6;
    /* The hand is sized once for its fullest state (9 cards, two rows of up
       to five) and the row always for 6, so neither shrinks or jumps while
       cards move between them. The row's cards get the room the hand
       leaves, and the hand gives some back if the row would get too small. */
    const handCols = 5;
    const handRows = 2;
    let handCardW = Math.min(108, (width - side * 2 - handGap * (handCols - 1)) / handCols);
    let cardW = 0;
    for (;;) {
      const handHeight = handRows * handCardW * 1.4 + (handRows - 1) * handGap;
      const rowRoom = height - readoutSize - arcRoom - below - actions - afterActions - handHeight - 10;
      cardW = Math.min(112, (width - side * 2) / (3 + 2 * gapX), (rowRoom - gapY) / 2 / 1.4);
      // The hand stops at 56px, the smallest face that still shows the
      // flag, keymode and skillset.
      if (cardW >= 74 || handCardW - 2 < HAND_MIN) break;
      handCardW -= 2;
    }
    cardW = Math.max(56, cardW);
    const cardH = cardW * 1.4;
    const gx = cardW * gapX;
    const gapLines = gapY;
    const rowBlock = cardH + gapLines + cardH;
    const fullHand = handRows * handCardW * 1.4 + (handRows - 1) * handGap;
    const over = readoutSize + arcRoom + rowBlock + below + actions + afterActions + fullHand + 4 - height;
    // At most half a card, so the second row's info panel always shows.
    const handOverlap = over > 0 ? Math.min(handCardW * 1.4 * 0.5, over + handGap) : 0;
    const handHeight = fullHand - handOverlap;
    const used = readoutSize + arcRoom + rowBlock + below + actions + afterActions + handHeight;
    const top = Math.max(0, Math.min(30, (height - used - 10) / 2));
    const rowTop = top + readoutSize + arcRoom;
    const left = (width - (cardW * 3 + gx * 2)) / 2;
    const slots: SlotRect[] = [];
    for (let index = 0; index < ROW_SLOTS; index += 1) {
      const line = index < 3 ? 0 : 1;
      const col = index % 3;
      slots.push({ x: left + col * (cardW + gx), y: rowTop + line * (cardH + gapLines) });
    }
    const rowBottom = rowTop + rowBlock;
    const actionsY = rowBottom + below;
    const handTop = actionsY + actions + afterActions;
    const deckW = 30;
    return {
      width,
      height,
      narrow,
      cardW,
      cardH,
      slots,
      readoutY: top + readoutSize / 2,
      readoutSize,
      rowTop,
      rowBottom,
      actionsY,
      handTop,
      handHeight,
      handWidth: width,
      handCardW,
      handCols,
      handOverlap,
      deck: { x: width - deckW - 12, y: actionsY + (actions - deckW * 1.4) / 2 - 2, w: deckW, h: deckW * 1.4 },
    };
  }
  const side = 24;
  const gap = 0.36;
  const readoutSize = 92;
  const arcRoom = 44;
  const labels = 42;
  const actions = 56;
  const cardW = Math.max(80, Math.min(158, (width - side * 2) / (6 + 5 * gap), (height - readoutSize - arcRoom - labels - actions - 150) / 1.4 / 1.85));
  const cardH = cardW * 1.4;
  const handCap = cardW * 0.82 * 1.4 + 44;
  const handHeight = Math.max(140, Math.min(handCap, height - readoutSize - arcRoom - cardH - labels - actions));
  const used = readoutSize + arcRoom + cardH + labels + actions + handHeight;
  const top = Math.max(0, (height - used) / 2);
  const rowTop = top + readoutSize + arcRoom;
  const gx = cardW * gap;
  const left = (width - (cardW * 6 + gx * 5)) / 2;
  const slots = Array.from({ length: ROW_SLOTS }, (_, index) => ({ x: left + index * (cardW + gx), y: rowTop }));
  const rowBottom = rowTop + cardH;
  const actionsY = rowBottom + labels;
  const handTop = actionsY + actions;
  const deckW = Math.round(cardW * 0.5);
  return {
    width,
    height,
    narrow,
    cardW,
    cardH,
    slots,
    // Raised into the empty band under the HUD, clear of the two-back arcs.
    readoutY: Math.max(readoutSize / 2 + 6, top + readoutSize / 2 - 60),
    readoutSize,
    rowTop,
    rowBottom,
    actionsY,
    handTop,
    handHeight,
    handWidth: Math.min(width - deckW * 2 - 90, cardW * 9.4),
    deck: { x: width - deckW - side - 8, y: handTop + (handHeight - deckW * 1.4) / 2, w: deckW, h: deckW * 1.4 },
  };
}

/* A hand card's place: the fan RunHand uses, mapped onto the board as the
   top-left of a row-sized card scaled down to the hand's size. */
export function handPlaces(count: number, layout: BoardLayout): Array<{ x: number; y: number; scale: number; rotate: number; layer?: number }> {
  if (count === 0) return [];
  if (layout.narrow) {
    /* A phone holds the hand in two even rows across the full width. */
    const gap = 6;
    const w = layout.handCardW ?? layout.cardW;
    const h = w * 1.4;
    const scale = w / layout.cardW;
    const cols = layout.handCols ?? 3;
    const perRow = Math.min(cols, Math.ceil(count / 2));
    return Array.from({ length: count }, (_, index) => {
      const line = Math.floor(index / perRow);
      const inLine = Math.min(perRow, count - line * perRow);
      const col = index - line * perRow;
      const room = layout.width - 16;
      const step = inLine <= 1 ? 0 : Math.min(w + gap, (room - w) / (inLine - 1));
      const lineW = w + (inLine - 1) * step;
      const cx = (layout.width - lineW) / 2 + col * step + w / 2;
      const cy = layout.handTop + line * (h + gap - (layout.handOverlap ?? 0)) + h / 2;
      // The first row lies over the second.
      return { x: cx - layout.cardW / 2, y: cy - layout.cardH / 2, scale, rotate: (index % 2 ? 1 : -1) * 0.8, layer: line === 0 ? 1 : 0 };
    });
  }
  const fan = handLayout(count, layout.handWidth, layout.handHeight);
  const scale = Math.min(1, fan.cardWidth / layout.cardW);
  const handCardH = layout.cardH * scale;
  return fan.slots.map((slot) => {
    const cx = layout.width / 2 + slot.x;
    const cy = layout.handTop + slot.y + handCardH / 2;
    return { x: cx - layout.cardW / 2, y: cy - layout.cardH / 2, scale, rotate: slot.rotate };
  });
}

export interface Connector {
  d: string;
  /* Where its number sits. */
  x: number;
  y: number;
}

/* The line from card `from` to card `to`: a neighbour link (straight
   between the card edges, or on a phone an elbow through the gap when it
   joins the two lines) or a Forgotten Tree arc two slots on (over the row,
   under the second line on a phone, or an elbow on its own lane). */
export function connector(layout: BoardLayout, from: number, to: number, skip: boolean): Connector {
  const { cardW, cardH } = layout;
  const a = layout.slots[from];
  const b = layout.slots[to];
  const sameLine = Math.abs(a.y - b.y) < 1;
  if (!skip && sameLine) {
    const forward = b.x > a.x ? 1 : -1;
    const y = a.y + cardH / 2;
    const x1 = forward > 0 ? a.x + cardW : a.x;
    const x2 = forward > 0 ? b.x : b.x + cardW;
    return { d: `M${x1} ${y} L${x2} ${y}`, x: (x1 + x2) / 2, y };
  }
  if (!sameLine) {
    // An elbow down out of the upper card, across the gap on its lane,
    // and down into the lower one.
    const lane = !skip ? 0 : from === 1 ? 1 : 2;
    const gapTop = a.y + cardH;
    const laneY = gapTop + (layout.narrow ? 20 : 24) + lane * (layout.narrow ? 6 : 9);
    // Clear of the combo number under each card's middle.
    const ax = a.x + cardW * (!skip ? 0.86 : from === 1 ? 0.25 : 0.72);
    const bx = b.x + cardW * (!skip ? 0.14 : from === 1 ? 0.75 : 0.28);
    const r = 6;
    const dir = bx < ax ? -1 : 1;
    const d = `M${ax} ${gapTop} L${ax} ${laneY - r} Q${ax} ${laneY} ${ax + dir * r} ${laneY} L${bx - dir * r} ${laneY} Q${bx} ${laneY} ${bx} ${laneY + r} L${bx} ${b.y}`;
    return { d, x: (ax + bx) / 2, y: laneY };
  }
  // A skip arc on one line: over it, or under the second line on a phone.
  const under = layout.narrow && from >= 3;
  const forward = b.x > a.x ? 1 : -1;
  const x1 = a.x + cardW * (layout.narrow ? 0.72 : 0.5) + 10 * forward * (layout.narrow ? 0 : 1);
  const x2 = b.x + cardW * (layout.narrow ? 0.28 : 0.5) - 10 * forward * (layout.narrow ? 0 : 1);
  const lift = layout.narrow ? 14 : to % 2 === 0 ? 34 : 22;
  if (under) {
    const y = a.y + cardH + 2;
    return { d: `M${x1} ${y} C${x1} ${y + lift * 1.3}, ${x2} ${y + lift * 1.3}, ${x2} ${y}`, x: (x1 + x2) / 2, y: y + lift };
  }
  const y = a.y - 2;
  return { d: `M${x1} ${y} C${x1} ${y - lift * 1.3}, ${x2} ${y - lift * 1.3}, ${x2} ${y}`, x: (x1 + x2) / 2, y: y - lift };
}
