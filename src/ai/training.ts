/**
 * Model training pipeline.
 *
 * Turns stored candles into a labelled dataset, trains the logistic baseline,
 * validates it on data it has never seen, and promotes it only if it clears
 * the criteria.
 *
 * Two properties matter more than accuracy:
 *
 * **The split is chronological, never random.** Shuffling financial time
 * series before splitting leaks the future into training — adjacent bars are
 * highly correlated, so a random split puts near-duplicates of test rows in
 * the training set and every metric comes out inflated. It is the single most
 * common way a model looks excellent in research and fails live.
 *
 * **Labels are forward-looking and so must be truncated.** A label asks "did
 * price rise over the next N bars", which is unknowable for the final N bars
 * of the series. Those rows are dropped rather than labelled with whatever
 * data happens to exist.
 */

import type { Candle, Timestamp } from '../domain/types';
import type { Repositories, StoredModel } from '../persistence/ports';
import { StandardFeatureExtractor, FeatureScaler } from './features';
import { evaluateModel, LogisticModel } from './logisticModel';
import { DEFAULT_PROMOTION_CRITERIA, type PromotionCriteria } from './inference';
import type { FeatureVector, ValidationMetrics } from './types';

export interface LabelledDataset {
  readonly samples: readonly FeatureVector[];
  readonly labels: readonly number[];
}

export interface TrainingConfig {
  /** Bars ahead the label looks. */
  readonly horizonBars?: number;
  /**
   * Move required to count as a positive, as a fraction.
   *
   * Non-zero on purpose: labelling any rise as positive teaches the model to
   * predict noise, and a 0.1% "win" does not survive costs anyway.
   */
  readonly thresholdFraction?: number;
  /** Fraction of the series used for training; the rest is held out. */
  readonly trainFraction?: number;
  readonly iterations?: number;
  readonly learningRate?: number;
  readonly l2?: number;
}

/**
 * Builds a labelled dataset from a candle series.
 *
 * Label 1 means the close rose by more than `thresholdFraction` over the next
 * `horizonBars`. The last `horizonBars` rows are dropped — their outcome has
 * not happened yet.
 */
export function buildDataset(
  candles: readonly Candle[],
  config: TrainingConfig = {},
): LabelledDataset {
  const horizon = config.horizonBars ?? 5;
  const threshold = config.thresholdFraction ?? 0.002;
  const extractor = new StandardFeatureExtractor();

  const samples: FeatureVector[] = [];
  const labels: number[] = [];

  // Stop `horizon` bars early: beyond that the outcome is unknown.
  for (let i = 0; i < candles.length - horizon; i += 1) {
    const features = extractor.extract(candles, i);
    if (!features) continue; // still warming up

    const now = candles[i]!.close;
    const future = candles[i + horizon]!.close;
    if (now <= 0) continue;

    labels.push((future - now) / now > threshold ? 1 : 0);
    samples.push(features);
  }

  return { samples, labels };
}

export interface TrainingResult {
  readonly model: LogisticModel;
  readonly metrics: ValidationMetrics;
  readonly trainSize: number;
  readonly validationSize: number;
  readonly positiveRate: number;
  readonly promoted: boolean;
  readonly promotionReason: string;
}

/**
 * Trains and validates on a chronological split.
 *
 * The scaler is fitted on the training window only and applied unchanged to
 * validation — fitting it on everything would leak the validation
 * distribution into training.
 */
export function trainAndValidate(
  dataset: LabelledDataset,
  modelId: string,
  version: string,
  config: TrainingConfig = {},
): Omit<TrainingResult, 'promoted' | 'promotionReason'> {
  const trainFraction = config.trainFraction ?? 0.7;
  const total = dataset.samples.length;

  if (total < 100) {
    throw new Error(`need at least 100 labelled samples to train, got ${total}`);
  }

  const splitAt = Math.floor(total * trainFraction);
  const trainSamples = dataset.samples.slice(0, splitAt);
  const trainLabels = dataset.labels.slice(0, splitAt);
  const validationSamples = dataset.samples.slice(splitAt);
  const validationLabels = dataset.labels.slice(splitAt);

  if (validationSamples.length < 20) {
    throw new Error('validation window too small — lower trainFraction or supply more data');
  }

  const scaler = new FeatureScaler();
  scaler.fit(trainSamples);

  const scaledTrain = trainSamples.map((s) => scaler.transform(s));
  const scaledValidation = validationSamples.map((s) => scaler.transform(s));

  const featureNames = [...new StandardFeatureExtractor().featureNames];
  const model = new LogisticModel(modelId, version, featureNames);

  model.train(scaledTrain, trainLabels, {
    ...(config.iterations !== undefined ? { iterations: config.iterations } : {}),
    ...(config.learningRate !== undefined ? { learningRate: config.learningRate } : {}),
    ...(config.l2 !== undefined ? { l2: config.l2 } : {}),
  });

  const metrics = evaluateModel(model, scaledValidation, validationLabels);
  const positives = dataset.labels.reduce((sum, label) => sum + label, 0);

  return {
    model,
    metrics,
    trainSize: trainSamples.length,
    validationSize: validationSamples.length,
    positiveRate: total === 0 ? 0 : positives / total,
  };
}

/**
 * End-to-end training job: load candles, label, train, validate, store, and
 * promote if the model earns it.
 *
 * Promotion is never automatic on "newest wins" — a model that fails
 * validation is stored for inspection but does not go live.
 */
export async function runTrainingJob(
  repositories: Repositories,
  symbol: string,
  options: {
    readonly modelId?: string;
    readonly version?: string;
    readonly bars?: number;
    readonly criteria?: PromotionCriteria;
    readonly training?: TrainingConfig;
    readonly now?: Timestamp;
  } = {},
): Promise<TrainingResult> {
  const modelId = options.modelId ?? 'signal-filter';
  const version = options.version ?? String(options.now ?? Date.now());
  const now = options.now ?? Date.now();

  const candles = await repositories.candles.latest(symbol, '1d', options.bars ?? 2000);
  if (candles.length < 300) {
    throw new Error(
      `only ${candles.length} bars stored for ${symbol}; need at least 300 to train meaningfully`,
    );
  }

  const dataset = buildDataset(candles, options.training ?? {});
  const trained = trainAndValidate(dataset, modelId, version, options.training ?? {});

  const stored: StoredModel = {
    id: modelId,
    version,
    featureNames: trained.model.featureNames,
    weights: trained.model.coefficients.weights,
    bias: trained.model.coefficients.bias,
    metrics: trained.metrics,
    promoted: false,
    registeredAt: now,
  };
  await repositories.models.save(stored);

  const criteria = options.criteria ?? DEFAULT_PROMOTION_CRITERIA;
  const verdict = assessPromotion(trained.metrics, criteria);

  if (verdict.promoted) {
    await repositories.models.promote(modelId, version);
  }

  return { ...trained, promoted: verdict.promoted, promotionReason: verdict.reason };
}

/** The promotion gate, as a pure function so it can be tested directly. */
export function assessPromotion(
  metrics: ValidationMetrics,
  criteria: PromotionCriteria = DEFAULT_PROMOTION_CRITERIA,
): { promoted: boolean; reason: string } {
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
  return { promoted: true, reason: 'met all promotion criteria' };
}
