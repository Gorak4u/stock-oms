/**
 * Drift detection.
 *
 * A model is only valid while live data resembles what it was trained on. When
 * the market regime changes the model does not announce it — it keeps
 * returning confident predictions that are now wrong. Drift detection is what
 * turns that silent failure into an alert.
 *
 * Population Stability Index is used because it is interpretable and its
 * thresholds are conventional:
 *
 * - PSI < 0.10 — stable
 * - 0.10–0.25 — moderate shift, investigate
 * - > 0.25 — significant shift, retrain before trusting the model
 */

import type { FeatureVector } from './types';

export type DriftSeverity = 'STABLE' | 'MODERATE' | 'SIGNIFICANT';

export interface FeatureDrift {
  readonly featureName: string;
  readonly psi: number;
  readonly severity: DriftSeverity;
}

export interface DriftReport {
  readonly features: readonly FeatureDrift[];
  readonly maxPsi: number;
  readonly severity: DriftSeverity;
  /** True when the model should stop being trusted for live inference. */
  readonly shouldHalt: boolean;
  readonly sampleCount: number;
}

export function severityFor(psi: number): DriftSeverity {
  if (psi < 0.1) return 'STABLE';
  if (psi < 0.25) return 'MODERATE';
  return 'SIGNIFICANT';
}

/**
 * PSI for one feature between a baseline and a current sample.
 *
 * Bin edges come from the baseline's quantiles so the comparison is
 * distribution-free. Empty bins are floored at a small epsilon — the textbook
 * formula divides by the bin proportion and would otherwise return Infinity
 * for any bin the current sample happens not to populate.
 */
export function populationStabilityIndex(
  baseline: readonly number[],
  current: readonly number[],
  bins = 10,
): number {
  if (baseline.length === 0 || current.length === 0) return 0;

  const sorted = [...baseline].sort((a, b) => a - b);
  const edges: number[] = [];
  for (let i = 1; i < bins; i += 1) {
    const index = Math.floor((i / bins) * sorted.length);
    edges.push(sorted[Math.min(index, sorted.length - 1)]!);
  }

  const bucket = (values: readonly number[]): number[] => {
    const counts = new Array<number>(bins).fill(0);
    for (const value of values) {
      let index = 0;
      while (index < edges.length && value > edges[index]!) index += 1;
      counts[index]! += 1;
    }
    return counts.map((count) => count / values.length);
  };

  const baselineShares = bucket(baseline);
  const currentShares = bucket(current);
  const epsilon = 1e-6;

  let psi = 0;
  for (let i = 0; i < bins; i += 1) {
    const expected = Math.max(baselineShares[i]!, epsilon);
    const actual = Math.max(currentShares[i]!, epsilon);
    psi += (actual - expected) * Math.log(actual / expected);
  }

  return psi;
}

/**
 * Compares a live feature sample against the training baseline.
 *
 * `shouldHalt` is set on significant drift: the inference engine treats that
 * as an instruction to stop gating on the model and let the strategy layer's
 * own rules stand, rather than trusting predictions from a stale distribution.
 */
export function detectDrift(
  baseline: readonly FeatureVector[],
  current: readonly FeatureVector[],
  featureNames: readonly string[],
  bins = 10,
): DriftReport {
  if (baseline.length === 0 || current.length === 0) {
    return {
      features: [],
      maxPsi: 0,
      severity: 'STABLE',
      shouldHalt: false,
      sampleCount: current.length,
    };
  }

  const width = featureNames.length;
  const features: FeatureDrift[] = [];
  let maxPsi = 0;

  for (let i = 0; i < width; i += 1) {
    const baselineColumn = baseline.map((vector) => vector.values[i] ?? 0);
    const currentColumn = current.map((vector) => vector.values[i] ?? 0);
    const psi = populationStabilityIndex(baselineColumn, currentColumn, bins);

    features.push({ featureName: featureNames[i]!, psi, severity: severityFor(psi) });
    if (psi > maxPsi) maxPsi = psi;
  }

  const severity = severityFor(maxPsi);

  return {
    features,
    maxPsi,
    severity,
    shouldHalt: severity === 'SIGNIFICANT',
    sampleCount: current.length,
  };
}

/**
 * Rolling window of recent feature vectors to compare against the baseline.
 *
 * Fixed capacity so memory is bounded in a long-running process.
 */
export class DriftMonitor {
  private readonly window: FeatureVector[] = [];

  constructor(
    private readonly baseline: readonly FeatureVector[],
    private readonly featureNames: readonly string[],
    private readonly windowSize = 500,
    /** Minimum observations before a report is meaningful. */
    private readonly minSamples = 100,
  ) {}

  observe(vector: FeatureVector): void {
    this.window.push(vector);
    if (this.window.length > this.windowSize) this.window.shift();
  }

  /** Returns `null` until enough observations have accumulated. */
  report(): DriftReport | null {
    if (this.window.length < this.minSamples) return null;
    return detectDrift(this.baseline, this.window, this.featureNames);
  }

  get observationCount(): number {
    return this.window.length;
  }
}
