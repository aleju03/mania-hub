export const GREEK_BY_INDEX = Object.freeze([
    "Alpha",
    "Beta",
    "Gamma",
    "Delta",
    "Epsilon",
    "Emik Zeta",
    "Thaumiel Eta",
    "CloverWisp Theta",
    "Iota",
    "Kappa",
]);

export const RC_TIER_CANDIDATES = Object.freeze([
    Object.freeze({ suffix: "low", offset: -0.4 }),
    Object.freeze({ suffix: "mid/low", offset: -0.2 }),
    Object.freeze({ suffix: "mid", offset: 0 }),
    Object.freeze({ suffix: "mid/high", offset: 0.2 }),
    Object.freeze({ suffix: "high", offset: 0.4 }),
]);

const GREEK_BASE_MAP = Object.freeze({
    alpha: 11,
    beta: 12,
    gamma: 13,
    delta: 14,
    epsilon: 15,
    zeta: 16,
    eta: 17,
    theta: 18,
    iota: 19,
    kappa: 20,
});

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

export function formatRcBaseLabel(base) {
    if (base <= 0) {
        const introLevel = clamp(base + 3, 1, 3);
        return `Intro ${introLevel}`;
    }

    if (base <= 10) {
        return `Reform ${base}`;
    }

    const greekIndex = clamp(base - 11, 0, GREEK_BY_INDEX.length - 1);
    return GREEK_BY_INDEX[greekIndex];
}

export function numericToRcLabel(numeric) {
    const value = Number(numeric);
    if (!Number.isFinite(value)) return "Invalid";

    const clamped = clamp(value, -2.4, 20.4);
    let bestMatch = null;

    for (let base = -2; base <= 20; base += 1) {
        for (const tier of RC_TIER_CANDIDATES) {
            const centerValue = base + tier.offset;
            const distance = Math.abs(clamped - centerValue);
            if (!bestMatch || distance < bestMatch.distance) {
                bestMatch = { base, suffix: tier.suffix, distance };
            }
        }
    }

    if (!bestMatch) return "Invalid";
    return `${formatRcBaseLabel(bestMatch.base)} ${bestMatch.suffix}`;
}

function parseTierAdjustment(textLower) {
    if (/\bmid\s*[/-]\s*high\b|\bmidhigh\b/i.test(textLower)) return 0.2;
    if (/\bmid\s*[/-]\s*low\b|\bmidlow\b/i.test(textLower)) return -0.2;
    if (/\blow\b/i.test(textLower)) return -0.4;
    if (/\bhigh\b/i.test(textLower)) return 0.4;
    if (/\bmid\b/i.test(textLower)) return 0;
    return 0;
}

export function rcLabelToNumeric(label) {
    const primary = String(label ?? "")
        .split("||")[0]
        .replace(/\s+/g, " ")
        .trim();
    if (!primary || /[<>]/.test(primary)) return null;

    const textLower = primary.toLowerCase();
    let base = null;

    const intro = textLower.match(/\bintro\s*([123])\b/i);
    if (intro) {
        base = Number(intro[1]) - 3;
    }

    if (base == null) {
        const numbered = textLower.match(/\b(?:reform|rework|regular)\s*(-?\d+(?:\.\d+)?)\b/i);
        if (numbered) {
            base = Number(numbered[1]);
        }
    }

    if (base == null && (/\bfinish\b/i.test(textLower) || /\bstellium\b/i.test(textLower))) {
        base = 10;
    }

    if (base == null) {
        for (const [word, value] of Object.entries(GREEK_BASE_MAP)) {
            if (new RegExp(`\\b${word}\\b`, "i").test(textLower)) {
                base = value;
                break;
            }
        }
    }

    if (base == null) {
        const plain = textLower.match(/(^|\s)(-?\d+(?:\.\d+)?)(\s|$)/);
        if (plain) {
            base = Number(plain[2]);
        }
    }

    if (!Number.isFinite(base)) return null;
    return base + parseTierAdjustment(textLower);
}
