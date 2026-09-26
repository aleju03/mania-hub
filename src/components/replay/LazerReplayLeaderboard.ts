// Layout and transitions ported from ppy/osu ebaf7e9910ef3755308dec2c7950d916aabc545b.
// Copyright (c) ppy Pty Ltd. MIT licence: /licenses/osu-lazer-leaderboard.txt.
import { Container, FillGradient, Graphics, Matrix, Sprite, Text, Texture } from "pixi.js";
import { buildLazerLeaderboardRows, formatLazerLeaderboardAccuracy, LAZER_LEADERBOARD as STYLE, lazerOutElastic, lazerOutQuint } from "../../lib/replay-leaderboard";
import type { LazerLeaderboardRow, ReplayLeaderboardEntry, ReplayLeaderboardOptions } from "../../lib/replay-leaderboard";

type Card = {
  root: Container;
  panel: Container;
  backgrounds: Graphics;
  border: Graphics;
  mask: Graphics;
  avatar: Container;
  image: Sprite;
  rank: Text;
  name: Text;
  score: Text;
  accuracy: Text;
  combo: Text;
  fromY: number;
  toY: number;
  moveAt: number;
  extensionFrom: number;
  extensionTo: number;
  extensionAt: number;
  geometry: string;
};

type PanelGradients = { left: FillGradient; right: FillGradient; border: FillGradient };

function label(size: number, weight: "400" | "600", right = false): Text {
  const text = new Text({ text: "", style: {
    fontFamily: "Torus, sans-serif", fontSize: size, fontWeight: weight, fill: 0xffffff,
    dropShadow: { color: 0x000000, alpha: 0.2, blur: 0, angle: Math.PI / 2, distance: size * 0.06 },
  } });
  text.anchor.set(right ? 1 : 0, 0);
  return text;
}

function verticalGradient(color: number, top: number, bottom: number): FillGradient {
  const rgb = `${color >> 16},${(color >> 8) & 255},${color & 255}`;
  return new FillGradient({
    type: "linear", start: { x: 0, y: 0 }, end: { x: 0, y: 1 }, textureSpace: "local", textureSize: 64,
    colorStops: [{ offset: 0, color: `rgba(${rgb},${top})` }, { offset: 1, color: `rgba(${rgb},${bottom})` }],
  });
}

/** Retained Pixi cards keep masking, avatars and text in the same sheared panel. */
export class LazerReplayLeaderboard {
  readonly container = new Container();
  private readonly flow = new Container();
  private readonly fadeMask = new Sprite();
  private readonly maskTextures = new Map<string, Texture>();
  private readonly gradients = new Map<number, PanelGradients>();
  private readonly cards = new Map<string, Card>();
  private readonly textSignatures = new WeakMap<Text, string>();
  private rows: LazerLeaderboardRow[] = [];
  private initialized = false;
  private nextSortAt = 0;
  private previousTime = 0;
  private scroll = 0;
  private visibilityTarget = 1;
  private visibilityFrom = 1;
  private visibilityAt = -Infinity;
  private expandedFrom = 1;
  private expandedTo = 1;
  private expandedAt = -Infinity;
  private detailsFrom = 1;
  private expansion = 1;

  /** Current animated footprint, including the rank/leader extension. */
  get width(): number {
    return STYLE.compactWidth + (STYLE.width - STYLE.compactWidth) * this.expansion;
  }

  constructor(private readonly textureForAvatar: (url: string) => Texture) {
    this.container.addChild(this.flow, this.fadeMask);
    this.flow.mask = this.fadeMask;
    this.container.eventMode = "none";
    this.container.visible = false;
  }

  reset() {
    this.initialized = false;
  }

  hide(now: number) {
    this.setVisibility(false, now);
    this.container.alpha = this.visibilityAlpha(now);
    this.container.visible = this.container.alpha > 0;
    this.reset();
  }

  private visibilityAlpha(now: number): number {
    return this.visibilityFrom + (this.visibilityTarget - this.visibilityFrom) * lazerOutQuint((now - this.visibilityAt) / 100);
  }

  private setVisibility(visible: boolean, now: number) {
    const target = visible ? 1 : 0;
    if (target === this.visibilityTarget) return;
    this.visibilityFrom = this.visibilityAlpha(now);
    this.visibilityTarget = target;
    this.visibilityAt = now;
  }

  invalidateFonts() {
    for (const card of this.cards.values()) {
      for (const text of [card.rank, card.name, card.score, card.accuracy, card.combo]) {
        this.textSignatures.delete(text);
        text.text = "";
      }
    }
  }

  update(
    entries: readonly ReplayLeaderboardEntry[], player: ReplayLeaderboardEntry, options: ReplayLeaderboardOptions,
    frame: { x: number; y: number; scale: number }, now: number, reset: boolean, expanded = true,
  ) {
    this.setVisibility(true, now);
    const fresh = reset || !this.initialized || now < this.previousTime;
    const target = expanded ? 1 : 0;
    if (fresh || target !== this.expandedTo) {
      this.expandedFrom = fresh ? target : this.expansionAt(now);
      this.detailsFrom = fresh ? target : this.detailsAlpha(now);
      this.expandedTo = target;
      this.expandedAt = now;
    }
    this.expansion = this.expansionAt(now);
    if (fresh || now >= this.nextSortAt) {
      this.rows = buildLazerLeaderboardRows(entries, player, options.isPartial ?? entries.length >= 50);
      this.nextSortAt = now + STYLE.sortIntervalMs;
      const keys = new Set(this.rows.map((row) => row.key));
      for (const [key, card] of this.cards) {
        if (!keys.has(key)) {
          card.root.destroy({ children: true });
          this.cards.delete(key);
        }
      }
      this.rows.forEach((row, index) => {
        const target = index * (STYLE.rowHeight + STYLE.rowGap);
        let card = this.cards.get(row.key);
        if (!card) {
          card = this.createCard(target);
          this.cards.set(row.key, card);
          this.flow.addChild(card.root);
        }
        const current = this.rowY(card, now);
        if (fresh || card.toY !== target) {
          card.fromY = fresh ? target : current;
          card.toY = target;
          card.moveAt = now;
        }
      });
    }
    const tracked = this.rows.find((row) => row.tracked);
    if (tracked) {
      tracked.score = player.score;
      tracked.accuracy = player.accuracy;
      tracked.combo = player.combo;
      tracked.avatarUrl = player.avatarUrl;
    }

    const contentHeight = this.rows.length * (STYLE.rowHeight + STYLE.rowGap) - STYLE.rowGap;
    const maxScroll = Math.max(0, contentHeight - STYLE.height);
    const trackedCard = this.cards.get("player");
    const targetScroll = trackedCard
      ? Math.max(0, Math.min(maxScroll, this.rowY(trackedCard, now) + STYLE.rowHeight / 2 - STYLE.height / 2))
      : 0;
    const dt = fresh ? 0 : Math.max(0, now - this.previousTime);
    this.scroll = fresh ? targetScroll : targetScroll + (this.scroll - targetScroll) * Math.exp(-STYLE.scrollDecay * dt);
    if (Math.abs(this.scroll - targetScroll) < 0.01) this.scroll = targetScroll;
    const fadeTop = this.scroll > 0.01;
    const fadeBottom = this.scroll < maxScroll - 0.01;
    this.fadeMask.texture = this.getFadeMask(fadeTop, fadeBottom);
    this.fadeMask.width = STYLE.width;
    this.fadeMask.height = STYLE.height;

    this.container.position.set(frame.x, frame.y);
    this.container.scale.set(frame.scale);
    this.container.alpha = this.visibilityAlpha(now);
    this.container.visible = this.container.alpha > 0;
    for (const row of this.rows) {
      const card = this.cards.get(row.key)!;
      const y = this.rowY(card, now) - this.scroll;
      card.root.position.set(STYLE.flowX, y);
      card.root.visible = y + STYLE.rowHeight > 0 && y < STYLE.height;
      this.updateCard(card, row, now, fresh);
    }
    this.initialized = true;
    this.previousTime = now;
  }

  private rowY(card: Card, now: number): number {
    return card.fromY + (card.toY - card.fromY) * lazerOutQuint((now - card.moveAt) / STYLE.moveDurationMs);
  }

  private expansionAt(now: number): number {
    return this.expandedFrom + (this.expandedTo - this.expandedFrom)
      * lazerOutQuint((now - this.expandedAt) / STYLE.panelDurationMs);
  }

  private detailsAlpha(now: number): number {
    const duration = this.expandedTo ? STYLE.panelDurationMs : STYLE.textDurationMs;
    return this.detailsFrom + (this.expandedTo - this.detailsFrom) * lazerOutQuint((now - this.expandedAt) / duration);
  }

  private createCard(y: number): Card {
    const root = new Container();
    const panel = new Container();
    const clipped = new Container();
    const backgrounds = new Graphics();
    const border = new Graphics();
    const mask = new Graphics();
    const textLayer = new Container();
    textLayer.setFromMatrix(new Matrix(1, 0, STYLE.shear, 1, 0, 0));
    const rank = label(14, "600");
    rank.anchor.set(0.5);
    const name = label(14, "600");
    const score = label(16, "400");
    const accuracy = label(12, "600", true);
    const combo = label(12, "600", true);
    textLayer.addChild(rank, name, score, accuracy, combo);

    const avatar = new Container();
    const avatarMask = new Graphics().roundRect(0, 0, 35.4, 35.4, 10).fill(0xffffff);
    const placeholder = new Graphics().rect(0, 0, 35.4, 35.4).fill(0x1a1a1a);
    const avatarUpright = new Container();
    avatarUpright.setFromMatrix(new Matrix(1, 0, STYLE.shear, 1, 17.7, 17.7));
    const image = new Sprite();
    image.anchor.set(0.5);
    avatarUpright.addChild(image);
    avatar.addChild(placeholder, avatarUpright, avatarMask);
    avatar.mask = avatarMask;
    clipped.addChild(backgrounds, textLayer, avatar);
    clipped.mask = mask;
    panel.addChild(clipped, mask, border);
    root.addChild(panel);
    return {
      root, panel, backgrounds, border, mask, avatar, image, rank, name, score, accuracy, combo,
      fromY: y, toY: y, moveAt: 0, extensionFrom: 0, extensionTo: 0, extensionAt: 0, geometry: "",
    };
  }

  private updateCard(card: Card, row: LazerLeaderboardRow, now: number, fresh: boolean) {
    const extended = row.position === 1 || row.tracked;
    const targetExtension = extended ? 20 : 0;
    const previousExtension = card.extensionFrom + (card.extensionTo - card.extensionFrom)
      * lazerOutElastic((now - card.extensionAt) / STYLE.panelDurationMs);
    if (fresh || targetExtension !== card.extensionTo) {
      card.extensionFrom = fresh ? targetExtension : previousExtension;
      card.extensionTo = targetExtension;
      card.extensionAt = now;
    }
    const extension = card.extensionFrom + (card.extensionTo - card.extensionFrom)
      * lazerOutElastic((now - card.extensionAt) / STYLE.panelDurationMs);
    const leftWidth = 57 + extension;
    const rightWidth = 19 + (STYLE.width - 77 - 38) * this.expansion;
    const panelWidth = leftWidth + rightWidth;
    const color = row.position === 1 ? STYLE.colors.leader : row.tracked ? STYLE.colors.player
      : row.isFriend ? STYLE.colors.friend : STYLE.colors.other;
    const geometry = `${leftWidth}|${rightWidth}|${color}`;
    if (card.geometry !== geometry) {
      const gradients = this.panelGradients(color);
      card.backgrounds.clear()
        .rect(0, 0, leftWidth, 38).fill(gradients.left)
        .rect(leftWidth, 0, rightWidth, 38).fill(gradients.right);
      card.mask.clear().roundRect(0, 0, panelWidth, 38, 10).fill(0xffffff);
      card.border.clear().roundRect(1, 1, panelWidth - 2, 36, 9).stroke({ fill: gradients.border, width: 2 });
      card.geometry = geometry;
    }
    card.panel.setFromMatrix(new Matrix(1, 0, -STYLE.shear, 1, 20 - extension, 0));
    card.avatar.position.set(leftWidth - 17.7, 1.3);
    const alpha = this.detailsAlpha(now);
    for (const text of [card.name, card.score, card.accuracy, card.combo]) text.alpha = alpha;
    card.name.visible = card.score.visible = rightWidth >= 50;
    card.accuracy.visible = card.combo.visible = rightWidth >= 150;
    if (!card.root.visible) return;

    const texture = this.textureForAvatar(row.avatarUrl ?? STYLE.guestAvatar);
    card.image.visible = texture !== Texture.EMPTY;
    if (texture !== Texture.EMPTY) {
      card.image.texture = texture;
      const cover = 35.4 * 1.1 / Math.min(texture.width, texture.height);
      card.image.scale.set(cover);
    }
    card.rank.text = row.position == null ? "-" : `#${row.position}`;
    card.rank.position.set(leftWidth - 39.9, 19);
    card.accuracy.text = formatLazerLeaderboardAccuracy(row.accuracy);
    card.combo.text = `${Math.max(0, Math.floor(row.combo))}x`;
    const textLeft = leftWidth + 23;
    const textRight = panelWidth - 20;
    card.accuracy.position.set(textRight, 7);
    card.combo.position.set(textRight, 21);
    card.name.position.set(textLeft, 5);
    card.score.position.set(textLeft, 17);
    card.name.tint = row.isFriend && !row.tracked && row.position !== 1 ? STYLE.colors.friend : 0xffffff;
    this.truncate(card.name, row.name, Math.max(0, textRight - textLeft - (card.accuracy.visible ? card.accuracy.width : 0)));
    this.truncate(card.score, Math.round(row.score).toLocaleString("en-US"), Math.max(0, textRight - textLeft - (card.combo.visible ? card.combo.width : 0)));
  }

  private truncate(text: Text, value: string, width: number) {
    const signature = `${value}|${width}`;
    if (this.textSignatures.get(text) === signature) return;
    this.textSignatures.set(text, signature);
    text.text = value;
    if (text.width <= width) return;
    const chars = Array.from(value);
    let low = 0;
    let high = chars.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      text.text = `${chars.slice(0, middle).join("")}…`;
      if (text.width <= width) low = middle;
      else high = middle - 1;
    }
    text.text = `${chars.slice(0, low).join("")}…`;
    if (text.width > width) text.text = "";
  }

  private panelGradients(color: number): PanelGradients {
    let gradients = this.gradients.get(color);
    if (!gradients) {
      gradients = {
        left: verticalGradient(color, 0.2, 0.5), right: verticalGradient(color, 0.1, 0.3), border: verticalGradient(color, 0.2, 1),
      };
      this.gradients.set(color, gradients);
    }
    return gradients;
  }

  private getFadeMask(top: boolean, bottom: boolean): Texture {
    const key = `${top}|${bottom}`;
    let texture = this.maskTextures.get(key);
    if (texture) return texture;
    const canvas = document.createElement("canvas");
    canvas.width = 2;
    canvas.height = STYLE.height * 2;
    const context = canvas.getContext("2d")!;
    const gradient = context.createLinearGradient(0, 0, 0, canvas.height);
    gradient.addColorStop(0, `rgba(255,255,255,${top ? 0 : 1})`);
    gradient.addColorStop(STYLE.rowHeight / STYLE.height, "white");
    gradient.addColorStop(1 - STYLE.rowHeight / STYLE.height, "white");
    gradient.addColorStop(1, `rgba(255,255,255,${bottom ? 0 : 1})`);
    context.fillStyle = gradient;
    context.fillRect(0, 0, canvas.width, canvas.height);
    texture = Texture.from(canvas);
    this.maskTextures.set(key, texture);
    return texture;
  }

  destroy() {
    this.container.destroy({ children: true });
    for (const gradients of this.gradients.values()) {
      gradients.left.destroy(); gradients.right.destroy(); gradients.border.destroy();
    }
    // Pixi's global alpha-mask pool still holds the last source until its
    // next draw. Destroying that source invalidates the pooled filter's bind
    // group and breaks subsequent viewers/exports. Release the texture here;
    // renderer teardown frees its GPU allocation, and the pool drops the
    // source reference when it binds the next mask.
    for (const texture of this.maskTextures.values()) texture.destroy(false);
    this.cards.clear(); this.gradients.clear(); this.maskTextures.clear();
  }
}
