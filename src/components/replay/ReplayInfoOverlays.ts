// The map and player info overlays, drawn after lazer's beatmap info card and
// user panel for stable and lazer plays alike. Retained Pixi objects like the
// lazer leaderboard.
import { Container, FillGradient, Graphics, Sprite, Text, Texture } from "pixi.js";
import {
  formatReplayInfoLength,
  formatReplayMapDan,
  getMapInfoBpm,
  getMapInfoLength,
  type ReplayMapCardInput,
  type ReplayPlayerInfo,
} from "../../lib/replay-info-overlay";
import { LAZER_LEADERBOARD } from "../../lib/replay-leaderboard";
import { getCountryFlagLargeUrl, isSupportedCountryCode } from "../../lib/country";
import { starRatingColor } from "../ui/StarRating";

export interface ReplayInfoTextures {
  /** A loaded image by URL, or Texture.EMPTY while it is still loading. */
  image: (url: string) => Texture;
  /** The beatmap background the stage is drawing, if any. */
  background: () => Texture | null;
}

interface Size { width: number; height: number }

const TORUS = "Torus, sans-serif";
const OSU_YELLOW = 0xffcc22;
const GUEST_AVATAR = LAZER_LEADERBOARD.guestAvatar;

export function getReplayInfoFlagUrl(countryCode: string | undefined): string | null {
  return countryCode && isSupportedCountryCode(countryCode) ? getCountryFlagLargeUrl(countryCode) : null;
}

function makeText(family: string, size: number, weight: "400" | "600" | "700", options: { italic?: boolean; shadow?: number } = {}): Text {
  return new Text({ text: "", style: {
    fontFamily: family, fontSize: size, fontWeight: weight, fontStyle: options.italic ? "italic" : "normal", fill: 0xffffff,
    dropShadow: options.shadow ? { color: 0x000000, alpha: options.shadow, blur: 2, angle: Math.PI / 2, distance: size * 0.06 } : false,
  } });
}

const truncateSignatures = new WeakMap<Text, string>();

function setTruncated(text: Text, value: string, width: number) {
  const signature = `${value}|${width}`;
  if (truncateSignatures.get(text) === signature) return;
  truncateSignatures.set(text, signature);
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
  text.text = low > 0 ? `${chars.slice(0, low).join("")}…` : "";
}

function forgetText(text: Text) {
  truncateSignatures.delete(text);
  text.text = "";
}

function fitCover(sprite: Sprite, texture: Texture, width: number, height: number) {
  sprite.texture = texture;
  const scale = Math.max(width / Math.max(1, texture.width), height / Math.max(1, texture.height));
  sprite.scale.set(scale);
  sprite.position.set((width - texture.width * scale) / 2, (height - texture.height * scale) / 2);
}

function fitContain(sprite: Sprite, texture: Texture, width: number, height: number) {
  sprite.texture = texture;
  const scale = Math.min(width / Math.max(1, texture.width), height / Math.max(1, texture.height));
  sprite.scale.set(scale);
  sprite.position.set((width - texture.width * scale) / 2, (height - texture.height * scale) / 2);
}

function verticalGradient(color: number, top: number, bottom: number): FillGradient {
  const rgb = `${color >> 16},${(color >> 8) & 255},${color & 255}`;
  return new FillGradient({
    type: "linear", start: { x: 0, y: 0 }, end: { x: 0, y: 1 }, textureSpace: "local", textureSize: 64,
    colorStops: [{ offset: 0, color: `rgba(${rgb},${top})` }, { offset: 1, color: `rgba(${rgb},${bottom})` }],
  });
}

function drawStar(graphics: Graphics, cx: number, cy: number, radius: number, color: number | string) {
  const points: number[] = [];
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? radius : radius * 0.45;
    const angle = -Math.PI / 2 + (i * Math.PI) / 5;
    points.push(cx + Math.cos(angle) * r, cy + Math.sin(angle) * r);
  }
  graphics.poly(points).fill(color);
}

// The audio wave as one filled curve rising from `bottom`, low notes left.
function drawWave(graphics: Graphics, levels: Float32Array, x: number, bottom: number, width: number, height: number, alpha: number) {
  const count = levels.length;
  if (count < 2) return;
  const point = (index: number) => ({ x: x + width * index / (count - 1), y: bottom - Math.min(1, levels[index]) * height });
  let previous = point(0);
  graphics.moveTo(x, bottom).lineTo(previous.x, previous.y);
  for (let index = 1; index < count; index++) {
    const next = point(index);
    graphics.quadraticCurveTo(previous.x, previous.y, (previous.x + next.x) / 2, (previous.y + next.y) / 2);
    previous = next;
  }
  graphics.lineTo(previous.x, previous.y).lineTo(x + width, bottom).closePath().fill({ color: 0xffffff, alpha });
}

interface InfoCard<T> {
  readonly container: Container;
  layout(data: T): Size;
  update(data: T): void;
  invalidateFonts(): void;
  destroy(): void;
}

// --- lazer: beatmap info card -----------------------------------------------

const MAP_CARD = { width: 316, radius: 10, pad: 16, progress: 3 } as const;
const MAP_TEXT_RIGHT = MAP_CARD.width - 12;

// Rows top to bottom; parts that are switched off give their height back.
function lazerMapRows({ map, options }: ReplayMapCardInput) {
  // The dan badge stands taller than the star pill, so its row does too.
  let y = options.dan && map.dan ? 40 : options.stars && map.stars != null ? 30 : 14;
  const title = y;
  y += 24;
  const artist = y;
  y += 19;
  const line = y;
  y += 19;
  const stats = options.stats ? y : null;
  if (stats != null) y += 19;
  return { title, artist, line, stats, height: y + 1 };
}

class LazerMapCard implements InfoCard<ReplayMapCardInput> {
  readonly container = new Container();
  private readonly background = new Sprite();
  private readonly dim = new Graphics();
  private readonly progress = new Graphics();
  private readonly wave = new Graphics();
  private readonly mask = new Graphics();
  private readonly pill = new Graphics();
  private readonly icons = new Graphics();
  private readonly stars = makeText(TORUS, 12, "700");
  private readonly danBadge = new Sprite();
  private readonly danText = makeText(TORUS, 12, "700", { shadow: 0.4 });
  private readonly title = makeText(TORUS, 20, "600", { italic: true, shadow: 0.3 });
  private readonly artist = makeText(TORUS, 14, "400", { italic: true, shadow: 0.3 });
  private readonly version = makeText(TORUS, 12, "600", { shadow: 0.3 });
  private readonly mappedBy = makeText(TORUS, 12, "400", { shadow: 0.3 });
  private readonly creator = makeText(TORUS, 12, "600", { shadow: 0.3 });
  private readonly stats = [0, 1, 2, 3].map(() => makeText(TORUS, 12, "600", { shadow: 0.3 }));
  private readonly dimGradient = verticalGradient(0x000000, 0.3, 0.8);
  private geometry = "";
  private pillSignature = "";
  private pillLeft: number = MAP_TEXT_RIGHT;

  constructor(private readonly textures: ReplayInfoTextures) {
    const clipped = new Container();
    clipped.addChild(this.background, this.dim, this.wave, this.progress);
    clipped.mask = this.mask;
    this.version.alpha = 0.95;
    this.mappedBy.alpha = 0.8;
    this.container.addChild(
      clipped, this.mask, this.pill, this.stars, this.danBadge, this.danText, this.title, this.artist,
      this.version, this.mappedBy, this.creator, this.icons, ...this.stats,
    );
  }

  layout(input: ReplayMapCardInput): Size {
    return { width: MAP_CARD.width, height: lazerMapRows(input).height };
  }

  update(input: ReplayMapCardInput) {
    const { map, options, live } = input;
    const rows = lazerMapRows(input);
    const { width, radius, pad } = MAP_CARD;
    const height = rows.height;
    const geometry = `${height}|${options.background}`;
    if (geometry !== this.geometry) {
      this.geometry = geometry;
      this.mask.clear().roundRect(0, 0, width, height, radius).fill(0xffffff);
      // Without its art the card is just its text on the stage.
      this.dim.clear();
      if (options.background) this.dim.rect(0, 0, width, height).fill(this.dimGradient);
    }

    const loaded = options.background && map.backgroundUrl ? this.textures.image(map.backgroundUrl) : Texture.EMPTY;
    const background = !options.background ? null : loaded !== Texture.EMPTY ? loaded : this.textures.background();
    this.background.visible = !!background;
    if (background) fitCover(this.background, background, width, height);

    this.wave.clear();
    if (live.wave) drawWave(this.wave, live.wave, 0, height, width, Math.min(52, height * 0.5), 0.28);

    this.progress.clear();
    if (options.progress) {
      const y = height - MAP_CARD.progress;
      this.progress.rect(0, y, width, MAP_CARD.progress).fill({ color: 0xffffff, alpha: 0.15 });
      if (live.progress > 0) this.progress.rect(0, y, width * Math.min(1, live.progress), MAP_CARD.progress).fill({ color: 0xffffff, alpha: 0.9 });
    }

    const showStars = options.stars && map.stars != null;
    const pillSignature = showStars ? `${map.stars}` : "";
    if (pillSignature !== this.pillSignature) {
      this.pillSignature = pillSignature;
      this.pill.clear();
      if (showStars) {
        const starColor = starRatingColor(map.stars!);
        const ink = map.stars! >= 6.5 ? 0xffd966 : 0x16191b;
        this.stars.text = map.stars!.toFixed(2);
        this.stars.style.fill = ink;
        const pillHeight = 18;
        const pillWidth = this.stars.width + 30;
        const pillY = 10;
        const pillX = MAP_TEXT_RIGHT - pillWidth;
        this.pillLeft = pillX;
        this.pill.roundRect(pillX, pillY, pillWidth, pillHeight, pillHeight / 2).fill(starColor);
        drawStar(this.pill, pillX + 12, pillY + pillHeight / 2, 5.5, ink);
        this.stars.anchor.set(0, 0.5);
        this.stars.position.set(pillX + 21, pillY + pillHeight / 2 + 0.5);
      }
    }
    this.pill.visible = this.stars.visible = showStars;

    // The dan badge sits left of the star pill, the way the site's map cards
    // pair them; the verdict prints as text until its art has loaded.
    const dan = options.dan ? map.dan ?? null : null;
    const danTexture = dan?.imageUrl ? this.textures.image(dan.imageUrl) : Texture.EMPTY;
    const danRight = showStars ? this.pillLeft - 9 : MAP_TEXT_RIGHT;
    this.danBadge.visible = !!dan && danTexture !== Texture.EMPTY;
    this.danText.visible = !!dan && !this.danBadge.visible;
    if (this.danBadge.visible) {
      // The art keeps a margin of empty space around the glyph, so the box
      // is drawn larger than the glyph should look and pulled back over the
      // margin toward the pill.
      const size = 38;
      fitContain(this.danBadge, danTexture, size, size);
      this.danBadge.position.set(danRight - size * 0.86 + this.danBadge.position.x, 21 - size / 2 + this.danBadge.position.y);
    } else if (dan) {
      this.danText.text = formatReplayMapDan(dan);
      this.danText.anchor.set(1, 0.5);
      this.danText.position.set(danRight - 2, 19.5);
    }

    this.title.position.set(pad, rows.title);
    setTruncated(this.title, map.title, MAP_TEXT_RIGHT - pad);
    this.artist.position.set(pad, rows.artist);
    setTruncated(this.artist, map.artist, MAP_TEXT_RIGHT - pad);

    // "<difficulty> mapped by <creator>", the creator keeping its weight.
    let x: number = pad;
    this.version.position.set(x, rows.line);
    setTruncated(this.version, map.version, Math.max(0, (MAP_TEXT_RIGHT - x) * (options.mapper ? 0.6 : 1)));
    x += this.version.width;
    this.mappedBy.visible = this.creator.visible = options.mapper && !!map.creator;
    if (this.creator.visible) {
      const mappedBy = map.mappedByLabel || "mapped by";
      this.mappedBy.text = map.version ? ` ${mappedBy} ` : `${mappedBy} `;
      this.mappedBy.position.set(x, rows.line);
      x += this.mappedBy.width;
      this.creator.position.set(x, rows.line);
      setTruncated(this.creator, map.creator, Math.max(0, MAP_TEXT_RIGHT - x));
    }

    this.icons.clear();
    const length = getMapInfoLength(input);
    const bpm = getMapInfoBpm(input);
    const values = rows.stats == null ? [] : [
      length == null ? null : { icon: "clock", text: `${length.remaining ? "-" : ""}${formatReplayInfoLength(length.ms)}` },
      bpm == null ? null : { icon: "note", text: String(Math.round(bpm)) },
      { icon: null, text: `${map.keyCount}K` },
      map.od == null ? null : { icon: null, text: `OD ${Math.round(map.od * 10) / 10}` },
    ].filter((value): value is { icon: string | null; text: string } => value != null);
    x = pad;
    this.stats.forEach((label, index) => {
      const value = values[index];
      label.visible = !!value;
      if (!value || rows.stats == null) return;
      if (value.icon) {
        this.drawIcon(value.icon, x + 5, rows.stats + 7.5);
        x += 14;
      }
      label.text = value.text;
      label.position.set(x, rows.stats);
      x += label.width + 12;
    });
  }

  private drawIcon(icon: string, cx: number, cy: number) {
    if (icon === "clock") {
      this.icons.circle(cx, cy, 5).stroke({ color: OSU_YELLOW, width: 1.6 })
        .moveTo(cx, cy).lineTo(cx, cy - 3).stroke({ color: OSU_YELLOW, width: 1.4 })
        .moveTo(cx, cy).lineTo(cx + 2.4, cy + 1.2).stroke({ color: OSU_YELLOW, width: 1.4 });
      return;
    }
    this.icons.ellipse(cx - 1.5, cy + 3, 3, 2.3).fill(OSU_YELLOW)
      .rect(cx + 0.6, cy - 5.5, 1.5, 8.6).fill(OSU_YELLOW)
      .poly([cx + 0.6, cy - 5.5, cx + 5, cy - 3.5, cx + 5, cy - 1.6, cx + 0.6, cy - 3.6]).fill(OSU_YELLOW);
  }

  invalidateFonts() {
    for (const text of [this.stars, this.danText, this.title, this.artist, this.version, this.mappedBy, this.creator, ...this.stats]) forgetText(text);
    this.pillSignature = "";
  }

  destroy() {
    this.container.destroy({ children: true });
    this.dimGradient.destroy();
  }
}

// --- lazer: player card ------------------------------------------------------------

// Avatar, name and flag on one row over the player's dimmed profile cover.
// The card is as wide as the name needs.
const USER_CARD = { height: 48, radius: 10, avatar: 34, minWidth: 140, maxWidth: 280 } as const;
const USER_NAME_X = 8 + USER_CARD.avatar + 10;

class LazerPlayerCard implements InfoCard<ReplayPlayerInfo> {
  readonly container = new Container();
  private readonly panel = new Graphics();
  private readonly cover = new Sprite();
  private readonly dim = new Graphics();
  private readonly mask = new Graphics();
  private readonly avatar = new Sprite();
  private readonly flag = new Sprite();
  private readonly flagFrame = new Container();
  private readonly name = makeText(TORUS, 17, "600", { shadow: 0.4 });
  private readonly dimGradient = new FillGradient({
    type: "linear", start: { x: 0, y: 0 }, end: { x: 1, y: 0 }, textureSpace: "local", textureSize: 64,
    colorStops: [{ offset: 0, color: "rgba(0,0,0,0.7)" }, { offset: 1, color: "rgba(0,0,0,0.35)" }],
  });
  private geometry = "";

  constructor(private readonly textures: ReplayInfoTextures) {
    const { height, avatar } = USER_CARD;
    const clipped = new Container();
    clipped.addChild(this.panel, this.cover, this.dim);
    clipped.mask = this.mask;

    const avatarFrame = new Container();
    avatarFrame.position.set(8, (height - avatar) / 2);
    const avatarMask = new Graphics().roundRect(0, 0, avatar, avatar, 8).fill(0xffffff);
    const placeholder = new Graphics().roundRect(0, 0, avatar, avatar, 8).fill(0x101317);
    avatarFrame.addChild(placeholder, this.avatar, avatarMask);
    avatarFrame.mask = avatarMask;

    const flagMask = new Graphics().roundRect(0, 0, 22, 15, 3).fill(0xffffff);
    this.flagFrame.addChild(this.flag, flagMask);
    this.flagFrame.mask = flagMask;
    this.container.addChild(clipped, this.mask, avatarFrame, this.name, this.flagFrame);
  }

  private hasFlag(player: ReplayPlayerInfo): boolean {
    const url = getReplayInfoFlagUrl(player.countryCode);
    return !!url && this.textures.image(url) !== Texture.EMPTY;
  }

  layout(player: ReplayPlayerInfo): Size {
    const flagSpace = this.hasFlag(player) ? 29 : 0;
    setTruncated(this.name, player.name, USER_CARD.maxWidth - USER_NAME_X - 14 - flagSpace);
    const width = Math.min(USER_CARD.maxWidth, Math.max(USER_CARD.minWidth, Math.ceil(USER_NAME_X + this.name.width + flagSpace + 14)));
    return { width, height: USER_CARD.height };
  }

  update(player: ReplayPlayerInfo) {
    const { width } = this.layout(player);
    const { height, radius, avatar } = USER_CARD;
    const geometry = String(width);
    if (geometry !== this.geometry) {
      this.geometry = geometry;
      this.panel.clear().rect(0, 0, width, height).fill({ color: 0x1c2128, alpha: 0.94 });
      this.dim.clear().rect(0, 0, width, height).fill(this.dimGradient);
      this.mask.clear().roundRect(0, 0, width, height, radius).fill(0xffffff);
    }

    this.panel.visible = this.dim.visible = !player.bare;
    const cover = player.coverUrl && !player.bare ? this.textures.image(player.coverUrl) : Texture.EMPTY;
    this.cover.visible = cover !== Texture.EMPTY;
    if (this.cover.visible) fitCover(this.cover, cover, width, height);

    const avatarTexture = this.textures.image(player.avatarUrl ?? GUEST_AVATAR);
    this.avatar.visible = avatarTexture !== Texture.EMPTY;
    if (this.avatar.visible) fitCover(this.avatar, avatarTexture, avatar, avatar);

    const nameY = (height - 21) / 2;
    this.name.position.set(USER_NAME_X, nameY);
    this.flagFrame.visible = this.hasFlag(player);
    if (this.flagFrame.visible) {
      fitCover(this.flag, this.textures.image(getReplayInfoFlagUrl(player.countryCode)!), 22, 15);
      this.flagFrame.position.set(USER_NAME_X + this.name.width + 7, nameY + 3.5);
    }
  }

  invalidateFonts() {
    forgetText(this.name);
  }

  destroy() {
    this.container.destroy({ children: true });
    this.dimGradient.destroy();
  }
}

// --- the pair ------------------------------------------------------------------------

export class ReplayInfoOverlays {
  private map: LazerMapCard | null = null;
  private player: LazerPlayerCard | null = null;

  constructor(private readonly textures: ReplayInfoTextures) {}

  private mapCard(): LazerMapCard {
    return this.map ??= this.prepare(new LazerMapCard(this.textures));
  }

  private playerCard(): LazerPlayerCard {
    return this.player ??= this.prepare(new LazerPlayerCard(this.textures));
  }

  private prepare<T extends InfoCard<never>>(card: T): T {
    card.container.visible = false;
    card.container.eventMode = "none";
    return card;
  }

  private get cards(): InfoCard<never>[] {
    return [this.map, this.player].filter((card): card is LazerMapCard | LazerPlayerCard => card != null);
  }

  hide() {
    for (const card of this.cards) card.container.visible = false;
  }

  /** Unscaled size of a card for this data, measured before it is placed. */
  measureMap(input: ReplayMapCardInput): Size {
    return this.mapCard().layout(input);
  }

  measurePlayer(player: ReplayPlayerInfo): Size {
    return this.playerCard().layout(player);
  }

  /** Draws into `parent`, the overlay's own stage layer. */
  drawMap(input: ReplayMapCardInput, frame: { x: number; y: number; scale: number }, parent: Container) {
    this.place(this.mapCard(), input, frame, parent);
  }

  drawPlayer(player: ReplayPlayerInfo, frame: { x: number; y: number; scale: number }, parent: Container) {
    this.place(this.playerCard(), player, frame, parent);
  }

  private place<T>(card: InfoCard<T>, data: T, frame: { x: number; y: number; scale: number }, parent: Container) {
    if (card.container.parent !== parent) parent.addChild(card.container);
    card.update(data);
    card.container.position.set(frame.x, frame.y);
    card.container.scale.set(frame.scale);
    card.container.visible = true;
  }

  invalidateFonts() {
    for (const card of this.cards) card.invalidateFonts();
  }

  destroy() {
    for (const card of this.cards) card.destroy();
    this.map = null;
    this.player = null;
  }
}
