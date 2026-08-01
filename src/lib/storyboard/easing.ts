// osu! storyboard easing curves, matching osu-framework's Easing enum by
// numeric id (0..34). Input progress is clamped to [0, 1]; outputs may
// overshoot outside [0, 1] for elastic/back/bounce curves, which is expected.

const ELASTIC_CONST = (2 * Math.PI) / 0.3;
const ELASTIC_OFFSET = 0.3 / 4;
const BACK_CONST = 1.70158;
const BACK_CONST2 = BACK_CONST * 1.525;
const BOUNCE_CONST = 7.5625;

function inQuad(p: number): number {
  return p * p;
}

function outQuad(p: number): number {
  return p * (2 - p);
}

function inCubic(p: number): number {
  return p * p * p;
}

function inQuart(p: number): number {
  return p * p * p * p;
}

function inQuint(p: number): number {
  return p * p * p * p * p;
}

function inExpo(p: number): number {
  return p <= 0 ? 0 : Math.pow(2, 10 * (p - 1));
}

function inCirc(p: number): number {
  return 1 - Math.sqrt(1 - p * p);
}

function outElastic(p: number): number {
  return Math.pow(2, -10 * p) * Math.sin((p - ELASTIC_OFFSET) * ELASTIC_CONST) + 1;
}

function inBack(p: number): number {
  return p * p * ((BACK_CONST + 1) * p - BACK_CONST);
}

function outBounce(p: number): number {
  if (p < 1 / 2.75) return BOUNCE_CONST * p * p;
  if (p < 2 / 2.75) {
    const q = p - 1.5 / 2.75;
    return BOUNCE_CONST * q * q + 0.75;
  }
  if (p < 2.5 / 2.75) {
    const q = p - 2.25 / 2.75;
    return BOUNCE_CONST * q * q + 0.9375;
  }
  const q = p - 2.625 / 2.75;
  return BOUNCE_CONST * q * q + 0.984375;
}

function inOut(inFn: (p: number) => number, p: number): number {
  return p < 0.5 ? inFn(p * 2) / 2 : 1 - inFn((1 - p) * 2) / 2;
}

export function applyStoryboardEasing(id: number, progress: number): number {
  const p = progress <= 0 ? 0 : progress >= 1 ? 1 : progress;

  switch (id) {
    case 0:
      return p;
    case 1: // Out (quad)
    case 4:
      return outQuad(p);
    case 2: // In (quad)
    case 3:
      return inQuad(p);
    case 5:
      return inOut(inQuad, p);
    case 6:
      return inCubic(p);
    case 7:
      return 1 - inCubic(1 - p);
    case 8:
      return inOut(inCubic, p);
    case 9:
      return inQuart(p);
    case 10:
      return 1 - inQuart(1 - p);
    case 11:
      return inOut(inQuart, p);
    case 12:
      return inQuint(p);
    case 13:
      return 1 - inQuint(1 - p);
    case 14:
      return inOut(inQuint, p);
    case 15:
      return 1 - Math.cos((p * Math.PI) / 2);
    case 16:
      return Math.sin((p * Math.PI) / 2);
    case 17:
      return -(Math.cos(Math.PI * p) - 1) / 2;
    case 18:
      return inExpo(p);
    case 19:
      return p >= 1 ? 1 : 1 - Math.pow(2, -10 * p);
    case 20:
      return inOut(inExpo, p);
    case 21:
      return inCirc(p);
    case 22:
      return Math.sqrt(1 - (p - 1) * (p - 1));
    case 23:
      return inOut(inCirc, p);
    case 24:
      return 1 - outElastic(1 - p);
    case 25:
      return outElastic(p);
    case 26: // OutElasticHalf
      return Math.pow(2, -10 * p) * Math.sin((0.5 * p - ELASTIC_OFFSET) * ELASTIC_CONST) + 1;
    case 27: // OutElasticQuarter
      return Math.pow(2, -10 * p) * Math.sin((0.25 * p - ELASTIC_OFFSET) * ELASTIC_CONST) + 1;
    case 28: // InOutElastic
      if (p < 0.5) {
        return -0.5 * Math.pow(2, -10 + 20 * p) * Math.sin(((1 - ELASTIC_OFFSET * 1.5) - p * 2) * (ELASTIC_CONST / 1.5));
      }
      return Math.pow(2, -10 * (p * 2 - 1)) * Math.sin(((p * 2 - 1) - ELASTIC_OFFSET * 1.5) * (ELASTIC_CONST / 1.5)) * 0.5 + 1;
    case 29:
      return inBack(p);
    case 30: {
      const q = p - 1;
      return q * q * ((BACK_CONST + 1) * q + BACK_CONST) + 1;
    }
    case 31: {
      const q = p * 2;
      if (q < 1) return (q * q * ((BACK_CONST2 + 1) * q - BACK_CONST2)) / 2;
      const r = q - 2;
      return (r * r * ((BACK_CONST2 + 1) * r + BACK_CONST2) + 2) / 2;
    }
    case 32:
      return 1 - outBounce(1 - p);
    case 33:
      return outBounce(p);
    case 34:
      return p < 0.5 ? (1 - outBounce(1 - p * 2)) / 2 : outBounce(p * 2 - 1) / 2 + 0.5;
    default:
      return p;
  }
}
