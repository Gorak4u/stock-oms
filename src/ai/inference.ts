/**
 * Model registry and inference engine.
 *
 * The registry is the record of which model is live and why. Promotion is
 * explicit and gated on validation metrics — a model cannot become the live
 * one simply by being the newest.
 *
 * The inference engine applies the model as a veto over strategy signals, and
 * fails open: if there is no promoted model, if features are unavailable, if
 * the model throws, or if drift has gone significant, the signal passes
 * through unchanged.
 *
 * Failing open is the right default for a *filter*. The strategy and risk
 * layers are already sound on their own; a broken model should reduce the
 * system to those, not silently stop it trading. The inverse — failing closed —
 * turns any model bug into a total outage.
 */

import type { Candle, Signal, Timestamp } from '../domain/types';
import type {
  FeatureExtractor,
  FeatureVector,
  GatedSignal,
  ModelRecord,
  PredictiveModel,
  ValidationMetrics,
} from './types';
import { DriftMonitor, type DriftReport } from './drift';

export interface PromotionCriteria {
  readonly minAccuracy: number;
  readonly minPrecision: number;
  readonly minSamples: number;
  /** Reject a model that abstains on most of its validation set. */
  readonly maxAbstentionRate: number;
}

export const DEFAULT_PROMOTION_CRITERIA: PromotionCriteria = {
  minAccuracy: 0.53,
  minPrecision: 0.53,
  minSamples: 250,
  maxAbstentionRate: 0.5,
};

export class ModelRegistry {
  private readonly records = new Map<string, ModelRecord>();
  private promotedKey: string | null = null;

  private static key(model: PredictiveModel): string {
    return `${model.id}@${model.version}`;
  }

  register(
    model: PredictiveModel,
    at: Timestamp,
    metrics?: ValidationMetrics,
    trainingBaseline?: readonly FeatureVector[],
  ): ModelRecord {
    const record: ModelRecord = {
      model,
      registeredAt: at,
      promoted: false,
      ...(metrics ? { metrics } : {}),
      ...(trainingBaseline ? { trainingBaseline } : {}),
    };
    this.records.set(ModelRegistry.key(model), record);
    return record;
  }

  /**
   * Promotes a model to live, if it clears the criteria.
   *
   * Returns the reason on refusal rather than throwing — a model failing
   * validation is a normal outcome of a training run.
   */
  promote(
    model: PredictiveModel,
    criteria: PromotionCriteria = DEFAULT_PROMOTION_CRITERIA,
  ): { promoted: boolean; reason: string } {
    const key = ModelRegistry.key(model);
    const record = this.records.get(key);
    if (!record) return { promoted: false, reason: `${key} is not registered` };

    const metrics = record.metrics;
    if (!metrics) return { promoted: false, reason: `${key} has no validation metrics` };

    if (metrics.sampleCount < criteria.minSamples) {
      return {
        promoted: false,
        reason: `validated on ${metrics.sampleCount} samples, need ${criteria.minSamples}`,
      };
    }
    if (metrics.accuracy < criteria.minAccuracy) {
      return {
        promoted: false,
        reason: `accuracy ${metrics.accuracy.toFixed(3)} below ${criteria.minAccuracy}`,
      };
    }
    if (metrics.precision < criteria.minPrecision) {
      return {
        promoted: false,
        reason: `precision ${metrics.precision.toFixed(3)} below ${criteria.minPrecision}`,
      };
    }
    if (metrics.abstentionRate > criteria.maxAbstentionRate) {
      return {
        promoted: false,
        reason: `abstention ${metrics.abstentionRate.toFixed(3)} above ${criteria.maxAbstentionRate}`,
      };
    }

    if (this.promotedKey) {
      const previous = this.records.get(this.promotedKey);
      if (previous) this.records.set(this.promotedKey, { ...previous, promoted: false });
    }

    this.records.set(key, { ...record, promoted: true });
    this.promotedKey = key;
    return { promoted: true, reason: 'met all promotion criteria' };
  }

  /** Immediately demotes the live model. Used when drift trips. */
  demote(): void {
    if (!this.promotedKey) return;
    const record = this.records.get(this.promotedKey);
    if (record) this.records.set(this.promotedKey, { ...record, promoted: false });
    this.promotedKey = null;
  }

  get promoted(): ModelRecord | null {
    return this.promotedKey ? (this.records.get(this.promotedKey) ?? null) : null;
  }

  all(): readonly ModelRecord[] {
    return [...this.records.values()];
  }
}

export interface InferenceConfig {
  /** Below this probability an entry signal is vetoed. */
  readonly minProbability?: number;
  /** Below this confidence the model abstains and the signal passes. */
  readonly minConfidence?: number;
  /** Demote the live model when drift turns significant. */
  readonly demoteOnDrift?: boolean;
}

export class InferenceEngine {
  private readonly minProbability: number;
  private readonly minConfidence: number;
  private readonly demoteOnDrift: boolean;
  private driftMonitor: DriftMonitor | null = null;
  private lastDrift: DriftReport | null = null;

  constructor(
    private readonly registry: ModelRegistry,
    private readonly extractor: FeatureExtractor,
    config: InferenceConfig = {},
  ) {
    this.minProbability = config.minProbability ?? 0.55;
    this.minConfidence = config.minConfidence ?? 0.2;
    this.demoteOnDrift = config.demoteOnDrift ?? true;
  }

  /** Starts drift monitoring against the promoted model's training baseline. */
  startDriftMonitoring(windowSize = 500, minSamples = 100): void {
    const record = this.registry.promoted;
    if (!record?.trainingBaseline) return;
    this.driftMonitor = new DriftMonitor(
      record.trainingBaseline,
      record.model.featureNames,
      windowSize,
      minSamples,
    );
  }

  /**
   * Applies the model to a signal.
   *
   * Exit signals (`FLAT`) are never vetoed — the model's opinion on whether a
   * *new* trade is worth taking says nothing about whether an existing
   * position should stay open, and blocking an exit is how a filter turns into
   * a loss.
   */
  gate(signal: Signal, candles: readonly Candle[], index: number): GatedSignal {
    if (signal.direction === 'FLAT') {
      return { signal, prediction: null, allowed: true, reason: 'exit signals bypass the model' };
    }

    const record = this.registry.promoted;
    if (!record) {
      return { signal, prediction: null, allowed: true, reason: 'no promoted model — passing through' };
    }

    const features = this.extractor.extract(candles, index);
    if (!features) {
      return { signal, prediction: null, allowed: true, reason: 'features unavailable — passing through' };
    }

    if (this.driftMonitor) {
      this.driftMonitor.observe(features);
      const report = this.driftMonitor.report();
      if (report) {
        this.lastDrift = report;
        if (report.shouldHalt) {
          if (this.demoteOnDrift) this.registry.demote();
          return {
            signal,
            prediction: null,
            allowed: true,
            reason: `drift PSI ${report.maxPsi.toFixed(3)} — model demoted, passing through`,
          };
        }
      }
    }

    let prediction;
    try {
      prediction = record.model.predict(features);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { signal, prediction: null, allowed: true, reason: `model error (${detail}) — passing through` };
    }

    if (prediction.confidence < this.minConfidence) {
      return {
        signal,
        prediction,
        allowed: true,
        reason: `confidence ${prediction.confidence.toFixed(3)} below floor — abstained`,
      };
    }

    const allowed = prediction.probability >= this.minProbability;
    return {
      signal,
      prediction,
      allowed,
      reason: allowed
        ? `model probability ${prediction.probability.toFixed(3)} cleared ${this.minProbability}`
        : `model probability ${prediction.probability.toFixed(3)} below ${this.minProbability} — vetoed`,
    };
  }

  get driftReport(): DriftReport | null {
    return this.lastDrift;
  }
}
