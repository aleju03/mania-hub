function pickNumber(obj, keys) {
    if (!obj || typeof obj !== "object") {
        return null;
    }

    for (const key of keys) {
        const value = Number(obj[key]);
        if (Number.isFinite(value)) {
            return value;
        }
    }

    return null;
}

export function detectVibro(values, threshold) {
    const overall = pickNumber(values, ["Overall", "overall"]);
    const jackSpeed = pickNumber(values, ["JackSpeed", "Jackspeed", "jackSpeed", "jackspeed"]);

    if (!Number.isFinite(overall) || overall <= 0 || !Number.isFinite(jackSpeed)) {
        return false;
    }

    return (jackSpeed / overall) >= threshold;
}

export function detectVibroFromLongjackPattern(patternReport, threshold, minBpm) {
    if (!patternReport || !Array.isArray(patternReport.Clusters)) {
        return false;
    }

    const bpmLimit = Number.isFinite(minBpm) && minBpm > 0 ? minBpm : 0;

    for (const cluster of patternReport.Clusters) {
        if (!Array.isArray(cluster.SpecificTypes)) {
            continue;
        }
        const clusterBpm = Number(cluster.BPM);
        if (!Number.isFinite(clusterBpm) || clusterBpm < bpmLimit) {
            continue;
        }
        for (const [name, ratio] of cluster.SpecificTypes) {
            if (name === "Longjacks" && Number.isFinite(ratio) && ratio >= threshold) {
                return true;
            }
        }
    }

    return false;
}
