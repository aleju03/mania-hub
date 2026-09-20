import type { ChartClassification } from "./chart-classifier.js";
import type { LeoBlackPatternCluster, LeoBlackPatternReport } from "../../vendor/leoblack/patterns/service.js";

type ClusterData = Omit<LeoBlackPatternCluster, "format"> & { label: string };
export type ChartClassificationData = Omit<ChartClassification, "clusters"> & {
  clusters: {
    report: Omit<LeoBlackPatternReport, "Clusters" | "ImportantClusters"> & {
      Clusters: ClusterData[];
      ImportantClusters: ClusterData[];
    };
    topFiveClusters: ClusterData[];
  } | null;
};

/** Materialize LeoBlack's getters and display method inside the CPU isolate.
 * Methods cannot cross postMessage; serving consumers only need the label
 * at 1x, which is what leanClassification has always persisted. */
export function chartClassificationData(classification: ChartClassification): ChartClassificationData {
  const clusters = classification.clusters;
  if (!clusters) return { ...classification, clusters: null };
  const data = new Map<LeoBlackPatternCluster, ClusterData>();
  const clusterData = (cluster: LeoBlackPatternCluster): ClusterData => {
    let entry = data.get(cluster);
    if (!entry) {
      const { format, ...fields } = cluster;
      entry = { ...fields, Importance: cluster.Importance, label: format.call(cluster, 1) };
      data.set(cluster, entry);
    }
    return entry;
  };
  return { ...classification, clusters: {
    report: { ...clusters.report,
      Clusters: clusters.report.Clusters.map(clusterData),
      ImportantClusters: clusters.report.ImportantClusters.map(clusterData),
    },
    topFiveClusters: clusters.topFiveClusters.map(clusterData),
  } };
}
