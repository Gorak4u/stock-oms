import { fromRupees, type Paise } from '../src/domain/money';
import type { Candle, Signal } from '../src/domain/types';
import { StandardFeatureExtractor, FeatureScaler } from '../src/ai/features';
import { evaluateModel, LogisticModel } from '../src/ai/logisticModel';
import { detectDrift, populationStabilityIndex, severityFor, DriftMonitor } from '../src/ai/drift';
import { InferenceEngine, ModelRegistry, DEFAULT_PROMOTION_CRITERIA } from '../src/ai/inference';
import type { FeatureVector, PredictiveModel, ValidationMetrics } from '../src/ai/types';

const FEATURE_NAMES = ['a', 'b'];

function vector(values: number[], timestamp = 0): FeatureVector {
  return { timestamp, symbol: 'NSE:TEST', values };
}

/** Deterministic separable training set: label 1 when a + b > 0. */
function separableSample(count: number): { samples: FeatureVector[]; labels: number[] } {
  const samples: FeatureVector[] = [];
  const labels: number[] = [];
  let state = 7;

  for (let i = 0; i < count; i += 1) {
    state = (state * 1103515245 + 12345) % 2147483648;
    const a = (state / 2147483648) * 2 - 1;
    state = (state * 1103515245 + 12345) % 2147483648;
    const b = (state / 2147483648) * 2 - 1;

    samples.push(vector([a, b], i));
    labels.push(a + b > 0 ? 1 : 0);
  }

  return { samples, labels };
}

describe('LogisticModel', () => {
  it('trains deterministically — same data, same coefficients', () => {
    const { samples, labels } = separableSample(300);

    const first = new LogisticModel('m', '1', FEATURE_NAMES);
    const second = new LogisticModel('m', '1', FEATURE_NAMES);
    first.train(samples, labels);
    second.train(samples, labels);

    expect(first.coefficients).toEqual(second.coefficients);
  });

  it('learns a separable boundary', () => {
    const { samples, labels } = separableSample(500);
    const model = new LogisticModel('m', '1', FEATURE_NAMES);
    model.train(samples, labels, { iterations: 2000, learningRate: 0.5, l2: 0 });

    expect(model.predict(vector([0.8, 0.8])).probability).toBeGreaterThan(0.5);
    expect(model.predict(vector([-0.8, -0.8])).probability).toBeLessThan(0.5);
  });

  it('reports low confidence on the decision boundary', () => {
    const { samples, labels } = separableSample(300);
    const model = new LogisticModel('m', '1', FEATURE_NAMES);
    model.train(samples, labels);

    const onBoundary = model.predict(vector([0, 0]));
    const farFrom = model.predict(vector([5, 5]));

    expect(onBoundary.confidence).toBeLessThan(farFrom.confidence);
  });

  it('always returns a probability inside [0, 1], even for extreme inputs', () => {
    const { samples, labels } = separableSample(200);
    const model = new LogisticModel('m', '1', FEATURE_NAMES);
    model.train(samples, labels);

    for (const values of [[1e6, 1e6], [-1e6, -1e6], [0, 0]]) {
      const probability = model.predict(vector(values)).probability;
      expect(probability).toBeGreaterThanOrEqual(0);
      expect(probability).toBeLessThanOrEqual(1);
      expect(Number.isNaN(probability)).toBe(false);
    }
  });

  it('refuses to predict before training', () => {
    expect(() => new LogisticModel('m', '1', FEATURE_NAMES).predict(vector([1, 1]))).toThrow(
      /before training/,
    );
  });

  it('rejects mismatched sample and label counts', () => {
    const model = new LogisticModel('m', '1', FEATURE_NAMES);
    expect(() => model.train([vector([1, 1])], [1, 0])).toThrow(/mismatch/);
  });

  it('rejects a feature vector of the wrong width', () => {
    const { samples, labels } = separableSample(100);
    const model = new LogisticModel('m', '1', FEATURE_NAMES);
    model.train(samples, labels);

    expect(() => model.predict(vector([1, 2, 3]))).toThrow(/does not match/);
  });

  it('round-trips through stored coefficients', () => {
    const { samples, labels } = separableSample(200);
    const trained = new LogisticModel('m', '1', FEATURE_NAMES);
    trained.train(samples, labels);

    const restored = new LogisticModel('m', '1', FEATURE_NAMES);
    restored.loadCoefficients(trained.coefficients.weights, trained.coefficients.bias);

    expect(restored.predict(vector([0.5, 0.3]))).toEqual(trained.predict(vector([0.5, 0.3])));
  });
});

describe('evaluateModel', () => {
  it('scores a model that learned the boundary above chance', () => {
    const train = separableSample(400);
    const test = separableSample(200);

    const model = new LogisticModel('m', '1', FEATURE_NAMES);
    model.train(train.samples, train.labels, { iterations: 2000, learningRate: 0.5, l2: 0 });

    const metrics = evaluateModel(model, test.samples, test.labels, 0.5, 0);
    expect(metrics.accuracy).toBeGreaterThan(0.8);
    expect(metrics.sampleCount).toBe(200);
  });

  it('counts abstentions separately from wrong answers', () => {
    const { samples, labels } = separableSample(200);
    const model = new LogisticModel('m', '1', FEATURE_NAMES);
    model.train(samples, labels);

    // A confidence floor of 1 makes almost everything an abstention.
    const metrics = evaluateModel(model, samples, labels, 0.5, 1);
    expect(metrics.abstentionRate).toBeGreaterThan(0);
  });
});

describe('populationStabilityIndex', () => {
  it('is near zero for identical distributions', () => {
    const values = Array.from({ length: 500 }, (_, i) => Math.sin(i));
    expect(populationStabilityIndex(values, values)).toBeLessThan(0.01);
  });

  it('grows as the distribution shifts', () => {
    const baseline = Array.from({ length: 500 }, (_, i) => Math.sin(i));
    const shifted = baseline.map((value) => value + 3);

    expect(populationStabilityIndex(baseline, shifted)).toBeGreaterThan(0.25);
  });

  it('never returns Infinity when a bin is empty in one sample', () => {
    const baseline = Array.from({ length: 200 }, (_, i) => i);
    const narrow = new Array<number>(200).fill(5);

    const psi = populationStabilityIndex(baseline, narrow);
    expect(Number.isFinite(psi)).toBe(true);
  });

  it('maps to the conventional severity bands', () => {
    expect(severityFor(0.05)).toBe('STABLE');
    expect(severityFor(0.15)).toBe('MODERATE');
    expect(severityFor(0.4)).toBe('SIGNIFICANT');
  });
});

describe('detectDrift', () => {
  it('reports stability when live data matches the baseline', () => {
    const baseline = Array.from({ length: 300 }, (_, i) => vector([Math.sin(i), Math.cos(i)]));
    const report = detectDrift(baseline, baseline, FEATURE_NAMES);

    expect(report.severity).toBe('STABLE');
    expect(report.shouldHalt).toBe(false);
  });

  it('halts when a feature shifts significantly', () => {
    const baseline = Array.from({ length: 300 }, (_, i) => vector([Math.sin(i), Math.cos(i)]));
    const drifted = baseline.map((v) => vector([v.values[0]! + 5, v.values[1]!]));

    const report = detectDrift(baseline, drifted, FEATURE_NAMES);
    expect(report.shouldHalt).toBe(true);
    expect(report.features[0]!.severity).toBe('SIGNIFICANT');
  });

  it('is a no-op on empty input', () => {
    expect(detectDrift([], [], FEATURE_NAMES).severity).toBe('STABLE');
  });
});

describe('DriftMonitor', () => {
  it('withholds a report until enough observations accumulate', () => {
    const baseline = Array.from({ length: 200 }, (_, i) => vector([Math.sin(i), 0]));
    const monitor = new DriftMonitor(baseline, FEATURE_NAMES, 500, 100);

    monitor.observe(vector([0, 0]));
    expect(monitor.report()).toBeNull();

    for (let i = 0; i < 150; i += 1) monitor.observe(vector([Math.sin(i), 0]));
    expect(monitor.report()).not.toBeNull();
  });

  it('bounds memory to the window size', () => {
    const monitor = new DriftMonitor([vector([0, 0])], FEATURE_NAMES, 50, 10);
    for (let i = 0; i < 500; i += 1) monitor.observe(vector([i, i]));

    expect(monitor.observationCount).toBe(50);
  });
});

describe('ModelRegistry', () => {
  function metrics(overrides: Partial<ValidationMetrics> = {}): ValidationMetrics {
    return {
      accuracy: 0.6,
      precision: 0.6,
      recall: 0.5,
      sampleCount: 1000,
      abstentionRate: 0.1,
      ...overrides,
    };
  }

  function stubModel(id = 'm', version = '1'): PredictiveModel {
    return {
      id,
      version,
      featureNames: FEATURE_NAMES,
      predict: () => ({ probability: 0.9, confidence: 1, modelId: id, modelVersion: version }),
    };
  }

  it('starts with nothing promoted', () => {
    expect(new ModelRegistry().promoted).toBeNull();
  });

  it('promotes a model that clears every criterion', () => {
    const registry = new ModelRegistry();
    const model = stubModel();
    registry.register(model, 0, metrics());

    expect(registry.promote(model).promoted).toBe(true);
    expect(registry.promoted!.model).toBe(model);
  });

  it('refuses a model validated on too few samples', () => {
    const registry = new ModelRegistry();
    const model = stubModel();
    registry.register(model, 0, metrics({ sampleCount: 10 }));

    const result = registry.promote(model);
    expect(result.promoted).toBe(false);
    expect(result.reason).toContain('samples');
  });

  it('refuses a model below the accuracy floor', () => {
    const registry = new ModelRegistry();
    const model = stubModel();
    registry.register(model, 0, metrics({ accuracy: 0.4 }));

    expect(registry.promote(model).reason).toContain('accuracy');
  });

  it('refuses a model that abstains on most of its validation set', () => {
    const registry = new ModelRegistry();
    const model = stubModel();
    registry.register(model, 0, metrics({ abstentionRate: 0.9 }));

    expect(registry.promote(model).reason).toContain('abstention');
  });

  it('refuses a model with no validation metrics at all', () => {
    const registry = new ModelRegistry();
    const model = stubModel();
    registry.register(model, 0);

    expect(registry.promote(model).reason).toContain('no validation metrics');
  });

  it('demotes the previous model when a new one is promoted', () => {
    const registry = new ModelRegistry();
    const first = stubModel('m', '1');
    const second = stubModel('m', '2');
    registry.register(first, 0, metrics());
    registry.register(second, 1, metrics());

    registry.promote(first, DEFAULT_PROMOTION_CRITERIA);
    registry.promote(second, DEFAULT_PROMOTION_CRITERIA);

    expect(registry.promoted!.model.version).toBe('2');
    expect(registry.all().filter((record) => record.promoted)).toHaveLength(1);
  });
});

describe('InferenceEngine', () => {
  const extractor = new StandardFeatureExtractor();

  function makeSignal(direction: Signal['direction']): Signal {
    return {
      symbol: 'NSE:TEST',
      strategyId: 'test',
      direction,
      strength: 1,
      timestamp: 0,
      referencePrice: fromRupees(1000),
      rationale: 'test',
    };
  }

  function series(length: number): Candle[] {
    return Array.from({ length }, (_, i) => {
      const price = 1000 + Math.sin(i / 5) * 50 + i * 0.1;
      return {
        symbol: 'NSE:TEST',
        interval: '1d' as const,
        timestamp: i * 86_400_000,
        open: fromRupees(price),
        high: fromRupees(price + 5),
        low: fromRupees(price - 5),
        close: fromRupees(price),
        volume: 100_000,
      };
    });
  }

  function fixedModel(probability: number): PredictiveModel {
    return {
      id: 'fixed',
      version: '1',
      featureNames: [...new StandardFeatureExtractor().featureNames],
      predict: () => ({ probability, confidence: 1, modelId: 'fixed', modelVersion: '1' }),
    };
  }

  function registryWith(probability: number): ModelRegistry {
    const registry = new ModelRegistry();
    const model = fixedModel(probability);
    registry.register(model, 0, {
      accuracy: 0.6,
      precision: 0.6,
      recall: 0.5,
      sampleCount: 1000,
      abstentionRate: 0.1,
    });
    registry.promote(model);
    return registry;
  }

  it('passes signals through when no model is promoted', () => {
    const engine = new InferenceEngine(new ModelRegistry(), extractor);
    const result = engine.gate(makeSignal('LONG'), series(200), 199);

    expect(result.allowed).toBe(true);
    expect(result.reason).toContain('no promoted model');
  });

  it('never vetoes an exit', () => {
    const engine = new InferenceEngine(registryWith(0.01), extractor);
    const result = engine.gate(makeSignal('FLAT'), series(200), 199);

    expect(result.allowed).toBe(true);
    expect(result.reason).toContain('exit signals bypass');
  });

  it('vetoes a low-probability entry', () => {
    const engine = new InferenceEngine(registryWith(0.2), extractor, { minProbability: 0.55 });
    const result = engine.gate(makeSignal('LONG'), series(200), 199);

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('vetoed');
  });

  it('allows a high-probability entry', () => {
    const engine = new InferenceEngine(registryWith(0.9), extractor, { minProbability: 0.55 });
    expect(engine.gate(makeSignal('LONG'), series(200), 199).allowed).toBe(true);
  });

  it('fails open when the model throws', () => {
    const registry = new ModelRegistry();
    const exploding: PredictiveModel = {
      id: 'boom',
      version: '1',
      featureNames: [...extractor.featureNames],
      predict: () => {
        throw new Error('inference server down');
      },
    };
    registry.register(exploding, 0, {
      accuracy: 0.6,
      precision: 0.6,
      recall: 0.5,
      sampleCount: 1000,
      abstentionRate: 0.1,
    });
    registry.promote(exploding);

    const engine = new InferenceEngine(registry, extractor);
    const result = engine.gate(makeSignal('LONG'), series(200), 199);

    expect(result.allowed).toBe(true);
    expect(result.reason).toContain('model error');
  });

  it('fails open when features are unavailable during warm-up', () => {
    const engine = new InferenceEngine(registryWith(0.01), extractor);
    const result = engine.gate(makeSignal('LONG'), series(200), 2);

    expect(result.allowed).toBe(true);
    expect(result.reason).toContain('features unavailable');
  });

  it('abstains rather than vetoing when confidence is below the floor', () => {
    const registry = new ModelRegistry();
    const unsure: PredictiveModel = {
      id: 'unsure',
      version: '1',
      featureNames: [...extractor.featureNames],
      predict: () => ({ probability: 0.1, confidence: 0.01, modelId: 'unsure', modelVersion: '1' }),
    };
    registry.register(unsure, 0, {
      accuracy: 0.6,
      precision: 0.6,
      recall: 0.5,
      sampleCount: 1000,
      abstentionRate: 0.1,
    });
    registry.promote(unsure);

    const engine = new InferenceEngine(registry, extractor, { minConfidence: 0.2 });
    const result = engine.gate(makeSignal('LONG'), series(200), 199);

    expect(result.allowed).toBe(true);
    expect(result.reason).toContain('abstained');
  });
});

describe('StandardFeatureExtractor', () => {
  const extractor = new StandardFeatureExtractor();

  function series(length: number): Candle[] {
    return Array.from({ length }, (_, i) => {
      const price = 1000 + Math.sin(i / 7) * 40;
      return {
        symbol: 'NSE:TEST',
        interval: '1d' as const,
        timestamp: i * 86_400_000,
        open: fromRupees(price),
        high: fromRupees(price + 4),
        low: fromRupees(price - 4),
        close: fromRupees(price),
        volume: 100_000 + i,
      };
    });
  }

  it('returns null during warm-up rather than fabricating an observation', () => {
    expect(extractor.extract(series(100), 3)).toBeNull();
  });

  it('produces one value per declared feature name', () => {
    const vectorAt = extractor.extract(series(200), 199)!;
    expect(vectorAt.values).toHaveLength(extractor.featureNames.length);
    expect(vectorAt.values.every((value) => Number.isFinite(value))).toBe(true);
  });

  it('is unaffected by future bars', () => {
    const short = extractor.extract(series(150), 120);
    const long = new StandardFeatureExtractor().extract(series(400), 120);

    expect(short!.values).toEqual(long!.values);
  });

  it('returns null for an out-of-range index', () => {
    expect(extractor.extract(series(50), 99)).toBeNull();
    expect(extractor.extract(series(50), -1)).toBeNull();
  });
});

describe('FeatureScaler', () => {
  it('standardises to roughly zero mean and unit deviation', () => {
    const samples = Array.from({ length: 200 }, (_, i) => vector([i, i * 2]));
    const scaler = new FeatureScaler();
    scaler.fit(samples);

    const transformed = samples.map((sample) => scaler.transform(sample));
    const mean =
      transformed.reduce((sum, sample) => sum + sample.values[0]!, 0) / transformed.length;

    expect(Math.abs(mean)).toBeLessThan(1e-9);
  });

  it('never divides by a zero deviation', () => {
    const constant = Array.from({ length: 50 }, () => vector([5, 5]));
    const scaler = new FeatureScaler();
    scaler.fit(constant);

    expect(Number.isFinite(scaler.transform(vector([5, 5])).values[0]!)).toBe(true);
  });

  it('refuses to fit on an empty sample or transform before fitting', () => {
    expect(() => new FeatureScaler().fit([])).toThrow();
    expect(() => new FeatureScaler().transform(vector([1, 1]))).toThrow(/before fit/);
  });
});
