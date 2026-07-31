/**
 * Logistic regression baseline.
 *
 * Deliberately the simplest model that can do the job. A linear model is
 * inspectable — every coefficient is a number you can read and argue with —
 * and it is cheap to retrain, which matters more than raw accuracy when the
 * data-generating process shifts every few months.
 *
 * More importantly it establishes the baseline that any heavier model has to
 * beat on walk-forward validation. Most do not.
 *
 * Training is full-batch gradient descent with a fixed iteration count and no
 * randomness, so the same data always produces the same coefficients — a model
 * that trains differently each run cannot be audited.
 */

import type { FeatureVector, PredictiveModel, Prediction, ValidationMetrics } from './types';

export interface TrainingConfig {
  readonly learningRate?: number;
  readonly iterations?: number;
  /** L2 penalty. Non-zero by default — financial features are highly collinear. */
  readonly l2?: number;
}

function sigmoid(z: number): number {
  // Split by sign to avoid overflow in exp for large |z|.
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const exp = Math.exp(z);
  return exp / (1 + exp);
}

export class LogisticModel implements PredictiveModel {
  private weights: number[] = [];
  private bias = 0;
  private trained = false;

  constructor(
    readonly id: string,
    readonly version: string,
    readonly featureNames: readonly string[],
    /** Predictions closer to 0.5 than this margin are reported as low confidence. */
    private readonly confidenceMargin = 0.1,
  ) {}

  /**
   * Fits the model.
   *
   * `labels[i]` is 1 when the signal at `samples[i]` turned out profitable.
   */
  train(
    samples: readonly FeatureVector[],
    labels: readonly number[],
    config: TrainingConfig = {},
  ): void {
    if (samples.length !== labels.length) {
      throw new Error(`sample/label length mismatch: ${samples.length} vs ${labels.length}`);
    }
    if (samples.length === 0) throw new Error('cannot train on an empty sample');

    const width = samples[0]!.values.length;
    if (width !== this.featureNames.length) {
      throw new Error(
        `feature width ${width} does not match declared names (${this.featureNames.length})`,
      );
    }

    const learningRate = config.learningRate ?? 0.1;
    const iterations = config.iterations ?? 500;
    const l2 = config.l2 ?? 0.01;

    this.weights = new Array<number>(width).fill(0);
    this.bias = 0;

    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const gradients = new Array<number>(width).fill(0);
      let biasGradient = 0;

      for (let s = 0; s < samples.length; s += 1) {
        const values = samples[s]!.values;
        let z = this.bias;
        for (let i = 0; i < width; i += 1) z += this.weights[i]! * values[i]!;

        const error = sigmoid(z) - labels[s]!;
        for (let i = 0; i < width; i += 1) gradients[i]! += error * values[i]!;
        biasGradient += error;
      }

      const scale = learningRate / samples.length;
      for (let i = 0; i < width; i += 1) {
        // The L2 term shrinks weights toward zero; the bias is left unpenalised.
        this.weights[i]! -= scale * gradients[i]! + learningRate * l2 * this.weights[i]!;
      }
      this.bias -= scale * biasGradient;
    }

    this.trained = true;
  }

  predict(features: FeatureVector): Prediction {
    if (!this.trained) {
      throw new Error(`model ${this.id}@${this.version} used before training`);
    }
    if (features.values.length !== this.weights.length) {
      throw new Error(
        `feature width ${features.values.length} does not match model (${this.weights.length})`,
      );
    }

    let z = this.bias;
    for (let i = 0; i < this.weights.length; i += 1) z += this.weights[i]! * features.values[i]!;

    const probability = sigmoid(z);
    // Distance from the decision boundary, rescaled so `confidenceMargin`
    // maps to 1. A prediction sitting on 0.5 tells you nothing.
    const confidence = Math.min(1, Math.abs(probability - 0.5) / this.confidenceMargin);

    return { probability, confidence, modelId: this.id, modelVersion: this.version };
  }

  /** Coefficients, for inspection and for writing into the model registry. */
  get coefficients(): { weights: readonly number[]; bias: number } {
    return { weights: [...this.weights], bias: this.bias };
  }

  /** Restores a previously trained model from stored coefficients. */
  loadCoefficients(weights: readonly number[], bias: number): void {
    if (weights.length !== this.featureNames.length) {
      throw new Error(`coefficient width ${weights.length} does not match model`);
    }
    this.weights = [...weights];
    this.bias = bias;
    this.trained = true;
  }

  get isTrained(): boolean {
    return this.trained;
  }
}

/** Scores a model against a held-out set. */
export function evaluateModel(
  model: PredictiveModel,
  samples: readonly FeatureVector[],
  labels: readonly number[],
  threshold = 0.5,
  minConfidence = 0.2,
): ValidationMetrics {
  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;
  let correct = 0;
  let abstained = 0;
  let scored = 0;

  for (let i = 0; i < samples.length; i += 1) {
    const prediction = model.predict(samples[i]!);
    if (prediction.confidence < minConfidence) {
      abstained += 1;
      continue;
    }

    scored += 1;
    const predicted = prediction.probability >= threshold ? 1 : 0;
    const actual = labels[i]!;

    if (predicted === actual) correct += 1;
    if (predicted === 1 && actual === 1) truePositives += 1;
    if (predicted === 1 && actual === 0) falsePositives += 1;
    if (predicted === 0 && actual === 1) falseNegatives += 1;
  }

  return {
    accuracy: scored === 0 ? 0 : correct / scored,
    precision: truePositives + falsePositives === 0 ? 0 : truePositives / (truePositives + falsePositives),
    recall: truePositives + falseNegatives === 0 ? 0 : truePositives / (truePositives + falseNegatives),
    sampleCount: samples.length,
    abstentionRate: samples.length === 0 ? 0 : abstained / samples.length,
  };
}
