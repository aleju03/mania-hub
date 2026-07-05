import { OsuFileParser } from "../parser/osuFileParser.js";
import {
    DEFAULT_ETTERNA_VERSION,
    resolveEtternaVersionLoaderForKeycount,
} from "./versions/index.js";

const DEFAULT_SCORE_GOAL = 0.93;
const SUPPORTED_KEYS = new Set([4, 6, 7]);
const OFFICIAL_OUTPUT_ORDER = [
    "Overall",
    "Stream",
    "Jumpstream",
    "Handstream",
    "Stamina",
    "JackSpeed",
    "Chordjack",
    "Technical",
];

const DISPLAY_SKILLSET_ORDER = [
    "Stream",
    "Jumpstream",
    "Handstream",
    "Stamina",
    "JackSpeed",
    "Chordjack",
    "Technical",
    "Overall",
];

const wasmModulePromiseByVersion = new Map();
const fallbackWarningShownByRequestedVersion = new Set();

function resolveKeycount(parsedCount, override) {
    if (Number.isFinite(override) && SUPPORTED_KEYS.has(override)) {
        return override;
    }

    if (SUPPORTED_KEYS.has(parsedCount)) {
        return parsedCount;
    }

    throw new Error(`Unsupported keycount: ${parsedCount}`);
}

function applyMod(chart, cvtFlag) {
    const normalized = String(cvtFlag || "").toUpperCase();
    if (!normalized) {
        return;
    }

    if (normalized.includes("IN")) {
        chart.modIN();
    }
    if (normalized.includes("HO")) {
        chart.modHO();
    }
}

function buildRows(chart) {
    const byTime = new Map();
    const columns = Array.isArray(chart.columns) ? chart.columns : [];
    const starts = Array.isArray(chart.noteStarts) ? chart.noteStarts : [];
    const len = Math.min(columns.length, starts.length);

    for (let i = 0; i < len; i += 1) {
        const col = Number(columns[i]);
        const start = Math.trunc(Number(starts[i]));
        if (!Number.isFinite(col) || !Number.isFinite(start) || col < 0 || col > 31) {
            continue;
        }

        const prev = byTime.get(start) || 0;
        byTime.set(start, prev | (1 << col));
    }

    const times = [...byTime.keys()].sort((a, b) => a - b);
    const masks = new Uint32Array(times.length);
    const seconds = new Float32Array(times.length);

    for (let i = 0; i < times.length; i += 1) {
        const t = times[i];
        masks[i] = byTime.get(t) >>> 0;
        seconds[i] = t / 1000;
    }

    return { masks, seconds };
}

function makeZeroValues() {
    const out = {};
    for (const name of DISPLAY_SKILLSET_ORDER) {
        out[name] = 0;
    }
    return out;
}

const IS_NODE_RUNTIME = typeof process === "object"
    && typeof process.versions === "object"
    && typeof process.versions.node === "string"
    && typeof window === "undefined";

async function loadWasmModule(loader, wasmFileName) {
    const overrides = {
        // The `.wasm` suffix must stay outside the interpolation: Vite globs
        // the template into build assets, and a bare `${path}` matches
        // ./versions/* and copies the raw glue .js files (and this folder's
        // index.js, dangling imports included) into the bundle output.
        // Emscripten only ever asks locateFile for the wasm binary.
        locateFile: (path) => new URL(`./versions/${path.replace(/\.wasm$/, "")}.wasm`, import.meta.url).toString(),
    };

    if (IS_NODE_RUNTIME) {
        // The emscripten glue is browser-targeted. In Node it would fetch() the
        // wasm URL (fetch cannot open file:// URLs), and its environment
        // sniffing dereferences the CommonJS globals __dirname/require at
        // factory time even from ESM. Hand it the binary directly and define
        // the globals it insists on reading. The @vite-ignore'd node: imports
        // are unreachable in the browser bundle.
        const [fsModule, urlModule, moduleModule] = await Promise.all([
            import(/* @vite-ignore */ "node:fs/promises"),
            import(/* @vite-ignore */ "node:url"),
            import(/* @vite-ignore */ "node:module"),
        ]);
        const globalScope = globalThis;
        if (typeof globalScope.__dirname === "undefined") {
            globalScope.__dirname = urlModule.fileURLToPath(new URL("./versions/", import.meta.url));
        }
        if (typeof globalScope.require === "undefined") {
            globalScope.require = moduleModule.createRequire(import.meta.url);
        }
        overrides.wasmBinary = await fsModule.readFile(
            urlModule.fileURLToPath(new URL(`./versions/${wasmFileName.replace(/\.wasm$/, "")}.wasm`, import.meta.url)),
        );
    }

    return loader(overrides);
}

async function getWasmModule(requestedVersion = DEFAULT_ETTERNA_VERSION, keycount = null) {
    const {
        requestedVersion: normalizedRequestedVersion,
        version,
        loader,
        wasmFileName,
        fallbackReason,
    } = resolveEtternaVersionLoaderForKeycount(requestedVersion, keycount);

    if (normalizedRequestedVersion !== version
        && fallbackReason
        && !fallbackWarningShownByRequestedVersion.has(normalizedRequestedVersion)) {
        fallbackWarningShownByRequestedVersion.add(normalizedRequestedVersion);
        console.warn(`Etterna version ${normalizedRequestedVersion} is unavailable; falling back to ${version}. Reason: ${fallbackReason}`);
    }

    if (!wasmModulePromiseByVersion.has(version)) {
        wasmModulePromiseByVersion.set(version, loadWasmModule(loader, wasmFileName));
    }
    return {
        requestedVersion: normalizedRequestedVersion,
        version,
        fallbackReason,
        module: await wasmModulePromiseByVersion.get(version),
    };
}

function mapOutputValues(rawEight) {
    const out = {};
    for (let i = 0; i < OFFICIAL_OUTPUT_ORDER.length; i += 1) {
        out[OFFICIAL_OUTPUT_ORDER[i]] = Number(rawEight[i]) || 0;
    }
    return out;
}

function runOfficialWasm(module, {
    keycount,
    musicRate,
    scoreGoal,
    rowMasks,
    rowTimes,
}) {
    const masksBytes = rowMasks.length * Uint32Array.BYTES_PER_ELEMENT;
    const timesBytes = rowTimes.length * Float32Array.BYTES_PER_ELEMENT;
    const outCount = OFFICIAL_OUTPUT_ORDER.length;
    const outBytes = outCount * Float32Array.BYTES_PER_ELEMENT;

    const ptrMasks = module._malloc(masksBytes);
    const ptrTimes = module._malloc(timesBytes);
    const ptrOut = module._malloc(outBytes);

    try {
        module.HEAPU32.set(rowMasks, ptrMasks >>> 2);
        module.HEAPF32.set(rowTimes, ptrTimes >>> 2);

        const ok = module._minacalc_compute(
            keycount,
            Number(musicRate),
            Number(scoreGoal),
            ptrMasks,
            ptrTimes,
            rowMasks.length,
            ptrOut,
        );

        if (!ok) {
            throw new Error("minacalc_compute returned failure");
        }

        const rawOut = module.HEAPF32.slice((ptrOut >>> 2), (ptrOut >>> 2) + outCount);
        return mapOutputValues(rawOut);
    } finally {
        module._free(ptrMasks);
        module._free(ptrTimes);
        module._free(ptrOut);
    }
}

export async function analyzeEtternaFromText(osuText, {
    musicRate = 1.0,
    scoreGoal = DEFAULT_SCORE_GOAL,
    keyOverride = null,
    cvtFlag = null,
    etternaVersion = DEFAULT_ETTERNA_VERSION,
} = {}) {
    const chart = new OsuFileParser(osuText);
    chart.process();

    if (chart.status !== "OK") {
        throw new Error(`Beatmap parse status: ${chart.status}`);
    }

    const keycount = resolveKeycount(chart.columnCount, keyOverride);
    applyMod(chart, cvtFlag);

    const { masks, seconds } = buildRows(chart);
    if (masks.length <= 1) {
        return {
            keycount,
            lnRatio: chart.lnRatio,
            metadata: chart.metaData,
            values: makeZeroValues(),
        };
    }

    const moduleInfo = await getWasmModule(etternaVersion, keycount);
    const values = runOfficialWasm(moduleInfo.module, {
        keycount,
        musicRate,
        scoreGoal,
        rowMasks: masks,
        rowTimes: seconds,
    });

    return {
        keycount,
        lnRatio: chart.lnRatio,
        metadata: chart.metaData,
        requestedEtternaVersion: moduleInfo.requestedVersion,
        etternaVersion: moduleInfo.version,
        etternaVersionFallbackReason: moduleInfo.fallbackReason,
        values,
    };
}

export {
    DEFAULT_SCORE_GOAL,
    DISPLAY_SKILLSET_ORDER,
};
