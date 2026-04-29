export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

export function gateWhen(condition: boolean, value: number): number {
  return condition ? value : 0;
}

export function minGate(...values: number[]): number {
  return clamp01(Math.min(...values));
}

export function quantile(values: number[], q: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * q)));
  return sorted[index];
}

export function countInWindow(times: number[], windowMs: number): number {
  let best = 0;
  let start = 0;
  for (let end = 0; end < times.length; end++) {
    while (times[end] - times[start] > windowMs) start++;
    best = Math.max(best, end - start + 1);
  }
  return best;
}

export function average(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function bucketEntropy(values: number[], bucketSize: number): number {
  if (!values.length || bucketSize <= 0) return 0;
  const buckets = new Map<number, number>();
  for (const value of values) {
    const bucket = Math.round(value / bucketSize) * bucketSize;
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
  }

  let entropy = 0;
  for (const count of buckets.values()) {
    const probability = count / values.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

export function bucketValues(values: number[], bucketSize: number): number[] {
  if (bucketSize <= 0) return values;
  return values.map((value) => Math.round(value / bucketSize) * bucketSize);
}

export function raoQuadraticEntropyLog(values: number[], logIterations: number): number {
  if (values.length < 2) return 0;
  const counts = new Map<number, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  const entries = [...counts.entries()];
  const total = values.length;
  let entropy = 0;
  for (const [left, leftCount] of entries) {
    for (const [right, rightCount] of entries) {
      let distance = Math.abs(left - right);
      for (let i = 0; i < logIterations; i++) {
        distance = Math.log1p(distance);
      }
      entropy += (leftCount / total) * (rightCount / total) * distance;
    }
  }
  return entropy;
}

export function powerMean(values: number[], weights: number[], exponent: number): number {
  if (!values.length) return 0;
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
  if (weightSum <= 0) return 0;
  return (values.reduce((sum, value, index) => sum + (value ** exponent) * weights[index], 0) / weightSum) ** (1 / exponent);
}

export function strainSpikiness(values: number[], weights: number[]): number {
  if (values.length < 3) return 0;
  const mean = powerMean(values, weights, 5);
  if (mean <= 0) return 0;
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
  if (weightSum <= 0) return 0;
  const variance = values.reduce((sum, value, index) => {
    const diff = (value ** 8) - (mean ** 8);
    return sum + diff * diff * weights[index];
  }, 0) / weightSum;
  return Math.sqrt(variance ** (1 / 8)) / mean;
}
