import { parentPort } from "node:worker_threads";
import { analyzeLnSkill, analyzeLnSkillFromText } from "./ln-skill.js";
import { analyzeLnSsr } from "./ln-ssr.js";
import { classifyChart, sunnyLowEndReroute } from "./chart-classifier.js";
import { chartClassificationData } from "./chart-classification-data.js";
import { runLeoBlackMixed } from "./leoblack-estimator.js";
import { resolveChartLnIdentity } from "./ln-identity.js";
import type { AnalysisRequest, AnalysisResponse, AnalysisResults } from "./analysis-thread.js";

const port = parentPort;
if (!port) throw new Error("analysis-thread-worker must run as a worker thread");

// All operations are synchronous pure calculations. Message dispatch therefore
// serializes them without importing any feature, database or job-queue module.
port.on("message", ({ id, request }: { id: number; request: AnalysisRequest }) => {
  try {
    let result: AnalysisResults[keyof AnalysisResults];
    switch (request.kind) {
      case "ln": result = analyzeLnSkillFromText(request.osuText, request.options); break;
      case "lnMap": result = analyzeLnSkill(request.map, request.options); break;
      case "lnSsr": result = analyzeLnSsr(request.osuText, request.options); break;
      case "classify": result = chartClassificationData(classifyChart(request.map, request.osuText, request.input)); break;
      case "lnIdentity": result = resolveChartLnIdentity(request.map, request.options); break;
      case "sunnyFloorPin": result = sunnyLowEndReroute(runLeoBlackMixed(request.osuText), request.osuText, 1) != null; break;
    }
    port.postMessage({ id, result } satisfies AnalysisResponse);
  } catch (error) {
    port.postMessage({ id, error: error instanceof Error ? error.message : String(error) } satisfies AnalysisResponse);
  }
});
