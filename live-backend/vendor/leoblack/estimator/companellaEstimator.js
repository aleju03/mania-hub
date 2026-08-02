const DAN_LABELS = [
    "1", "2", "3", "4", "5", "6", "7", "8", "9", "10",
    "alpha", "beta", "gamma", "delta", "epsilon",
    "Emik Zeta", "Thaumiel Eta", "CloverWisp Theta", "iota", "kappa",
];

const FEATURE_COUNT = 10;
const MIN_DAN = 1.0;
const MAX_DAN = 20.0;

const VARIANT_TEXT = {
    "--": "low",
    "-": "mid/low",
    "": "mid",
    "+": "mid/high",
    "++": "high",
};

let ortNamespacePromise = null;
let modelSessionPromise = null;

const IS_NODE_RUNTIME = typeof process === "object"
    && typeof process.versions === "object"
    && typeof process.versions.node === "string"
    && typeof window === "undefined";

// Upstream vendors a trimmed onnxruntime-web build under ./companella/ort/ and
// picks the entry by hand (ort.wasm.min.mjs in the browser, ort.node.min.mjs in
// Node). We take the same runtime from npm instead, so the ~13MB wasm never
// enters git: the package's own export map already resolves the Node entry, and
// ./wasm is the wasm-only browser build (no webgpu/jsep), which is what upstream
// slimmed down to. The bare specifier is hidden from Vite behind a variable so
// the Node branch never pulls the runtime into the client graph.
const ORT_NODE_SPECIFIER = "onnxruntime-web";

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function resolveOrtNamespace(moduleValue) {
    if (moduleValue && typeof moduleValue === "object") {
        if (moduleValue.InferenceSession && moduleValue.Tensor) {
            return moduleValue;
        }
        if (moduleValue.default && moduleValue.default.InferenceSession && moduleValue.default.Tensor) {
            return moduleValue.default;
        }
        if (moduleValue.ort && moduleValue.ort.InferenceSession && moduleValue.ort.Tensor) {
            return moduleValue.ort;
        }
    }
    throw new Error("Failed to resolve onnxruntime-web namespace");
}

async function getOrtNamespace() {
    if (!ortNamespacePromise) {
        ortNamespacePromise = (IS_NODE_RUNTIME
            ? import(/* @vite-ignore */ ORT_NODE_SPECIFIER)
            : import("onnxruntime-web/wasm"))
            .then(resolveOrtNamespace);
    }
    return ortNamespacePromise;
}

async function getModelSession() {
    if (!modelSessionPromise) {
        modelSessionPromise = (async () => {
            const ort = await getOrtNamespace();

            if (ort.env && ort.env.wasm) {
                // The site sends no COOP/COEP headers, so SharedArrayBuffer is
                // unavailable and a threaded runtime would fail to start. This
                // model is a 10-feature MLP; one thread is not the bottleneck.
                // wasmPaths is deliberately unset: the npm ".bundle." build
                // locates its own wasm through import.meta.url, which Vite
                // resolves, and the Node entry reads it off disk.
                ort.env.wasm.numThreads = 1;
            }

            // Node cannot fetch() a file:// URL, so hand the session raw bytes
            // there; the browser keeps the URL form, which Vite emits as an
            // asset. Same split as upstream's Node fix, one layer up.
            if (IS_NODE_RUNTIME) {
                const [{ readFile }, { fileURLToPath }] = await Promise.all([
                    import(/* @vite-ignore */ "node:fs/promises"),
                    import(/* @vite-ignore */ "node:url"),
                ]);
                const modelBytes = await readFile(
                    fileURLToPath(new URL("./companella/dan_model.onnx", import.meta.url)),
                );
                return ort.InferenceSession.create(new Uint8Array(modelBytes), {
                    executionProviders: ["wasm"],
                });
            }

            const modelUrl = new URL("./companella/dan_model.onnx", import.meta.url).toString();
            return ort.InferenceSession.create(modelUrl, {
                executionProviders: ["wasm"],
            });
        })();
    }

    return modelSessionPromise;
}

function extractFirstNumericValue(value) {
    if (typeof value === "number") {
        return Number(value);
    }

    if (Array.isArray(value) && value.length > 0) {
        return Number(value[0]);
    }

    if (ArrayBuffer.isView(value) && value.length > 0) {
        return Number(value[0]);
    }

    if (value && typeof value === "object") {
        if (value.data !== undefined) {
            return extractFirstNumericValue(value.data);
        }
        if (value.cpuData !== undefined) {
            return extractFirstNumericValue(value.cpuData);
        }
    }

    return Number.NaN;
}

function parsePrediction(rawValue) {
    if (rawValue < MIN_DAN) {
        return { danIndex: 0, variant: "--" };
    }

    if (rawValue >= MAX_DAN) {
        return { danIndex: 19, variant: "++" };
    }

    const danLevel = clamp(Math.round(rawValue), 1, 20);
    const danIndex = danLevel - 1;
    const offset = rawValue - danLevel;

    let variant;
    if (offset <= -0.3) {
        variant = "--";
    } else if (offset <= -0.1) {
        variant = "-";
    } else if (offset < 0.1) {
        variant = "";
    } else if (offset < 0.3) {
        variant = "+";
    } else {
        variant = "++";
    }

    return {
        danIndex,
        variant,
    };
}

function capitalizeLabel(label) {
    const text = String(label || "?").trim();
    if (!text) {
        return "?";
    }

    if (/^\d+$/.test(text)) {
        return text;
    }

    return text
        .split(/\s+/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
        .join(" ");
}

function normalizeMsdInput(msdValues) {
    const input = msdValues && typeof msdValues === "object" ? msdValues : {};
    return {
        overall: Number(input.Overall),
        stream: Number(input.Stream),
        jumpstream: Number(input.Jumpstream),
        handstream: Number(input.Handstream),
        stamina: Number(input.Stamina),
        jackspeed: Number(input.JackSpeed),
        chordjack: Number(input.Chordjack),
        technical: Number(input.Technical),
    };
}

function buildDisplayDifficulty(label, variant) {
    const variantText = VARIANT_TEXT[variant] || VARIANT_TEXT[""];
    const cappedLabel = capitalizeLabel(label);

    if (/^\d+$/.test(cappedLabel)) {
        return `Reform ${cappedLabel} ${variantText}`;
    }

    return `${cappedLabel} ${variantText}`;
}

export async function classifyCompanellaDifficulty({
    msdValues,
    interludeStar,
    sunnyStar,
} = {}) {
    const normalized = normalizeMsdInput(msdValues);
    const interlude = Number(interludeStar);
    const sunny = Number(sunnyStar);

    const features = [
        normalized.overall,
        normalized.stream,
        normalized.jumpstream,
        normalized.handstream,
        normalized.stamina,
        normalized.jackspeed,
        normalized.chordjack,
        normalized.technical,
        interlude,
        sunny,
    ];

    const hasInvalidFeature = features.some((value) => !Number.isFinite(value));
    if (hasInvalidFeature || features.length !== FEATURE_COUNT) {
        throw new Error("Companella requires valid MSD, InterludeSR, and Sunny SR values");
    }

    const [ort, session] = await Promise.all([
        getOrtNamespace(),
        getModelSession(),
    ]);

    const inputName = session.inputNames?.[0]
        || Object.keys(session.inputMetadata || {})[0];
    if (!inputName) {
        throw new Error("Companella model input metadata is missing");
    }

    const inputTensor = new ort.Tensor("float32", Float32Array.from(features), [1, FEATURE_COUNT]);
    const outputs = await session.run({
        [inputName]: inputTensor,
    });

    const outputName = session.outputNames?.[0] || Object.keys(outputs || {})[0];
    const outputValue = outputName ? outputs[outputName] : null;
    const rawModelValue = extractFirstNumericValue(outputValue);

    if (!Number.isFinite(rawModelValue)) {
        throw new Error("Companella model output is invalid");
    }

    // Keep parity with Companella C# pipeline:
    // clamp -> +1 shift -> parse tier/variant.
    const shiftedRawValue = clamp(rawModelValue, MIN_DAN, MAX_DAN) + 1;
    const { danIndex, variant } = parsePrediction(shiftedRawValue);
    const label = DAN_LABELS[danIndex] || "?";

    const roundedRaw = Number(shiftedRawValue.toFixed(2));
    const roundedCenter = Math.round(shiftedRawValue);
    const confidence = Math.max(0, 1.0 - Math.abs(shiftedRawValue - roundedCenter) * 2.0);

    return {
        estDiff: buildDisplayDifficulty(label, variant),
        numericDifficulty: roundedRaw,
        numericDifficultyHint: null,
        danLabel: label,
        variant,
        confidence,
        rawModelOutput: roundedRaw,
    };
}
