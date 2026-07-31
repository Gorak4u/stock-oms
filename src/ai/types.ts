/**
 * AI layer contracts.
 *
 * The model's job here is deliberately narrow: it **filters** signals the
 * strategy layer already produced. It cannot invent a trade, cannot pick a
 * direction, and cannot enlarge a position beyond what risk allows.
 *
 * That constraint is a safety decision, not a modelling one. A model that can
 * only veto has a bounded worst case — it stops the system trading. A model
 * that can originate trades has an unbounded one, and its failures arrive
 * exactly when the market regime has shifted out from under its training set.
 */

import type { Candle, Signal, Timestamp } from '../domain/types';

/** A named, ordered feature vector. Order is fixed by the model's `featureNames`. */
export interface FeatureVector {
  readonly timestamp: Timestamp;
  readonly symbol: string;
  readonly values: readonly number[];
}

export interface Prediction {
  /** Probability the signal is profitable, in [0, 1]. */
  readonly probability: number;
  /** Model's own confidence, in [0, 1]. Low confidence is treated as abstention. */
  readonly confidence: number;
  readonly modelId: string;
  readonly modelVersion: string;
}

export interface PredictiveModel {
  readonly id: string;
  readonly version: string;
  /** Feature order this model expects. Used to detect a mismatched vector. */
  readonly featureNames: readonly string[];
  predict(features: FeatureVector): Prediction;
}

/** Result of scoring a training/validation set. */
export interface ValidationMetrics {
  readonly accuracy: number;
  readonly precision: number;
  readonly recall: number;
  readonly sampleCount: number;
  /** Fraction of predictions where confidence fell below the abstention floor. */
  readonly abstentionRate: number;
}

export interface ModelRecord {
  readonly model: PredictiveModel;
  readonly registeredAt: Timestamp;
  readonly metrics?: ValidationMetrics;
  /** Only a promoted model is used for live inference. */
  readonly promoted: boolean;
  /** Feature distribution at training time — the drift baseline. */
  readonly trainingBaseline?: readonly FeatureVector[];
}

/** Extracts a model's features from a candle series at one index. */
export interface FeatureExtractor {
  readonly featureNames: readonly string[];
  extract(candles: readonly Candle[], index: number): FeatureVector | null;
}

export interface GatedSignal {
  readonly signal: Signal;
  readonly prediction: Prediction | null;
  readonly allowed: boolean;
  readonly reason: string;
}
