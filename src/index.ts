/** Public surface of the platform core. */

// Domain
export * from './domain/money';
export * from './domain/types';

// Market data
export * from './marketdata/calendar';
export * from './marketdata/ohlc';
export * from './marketdata/validation';
export * from './marketdata/corporateActions';

// Features
export * from './features/indicators';

// AI
export * from './ai/types';
export * from './ai/features';
export * from './ai/logisticModel';
export * from './ai/drift';
export * from './ai/inference';

// Strategy
export * from './strategy/types';
export { TrendFollowingStrategy } from './strategy/trendFollowing';
export { MeanReversionStrategy } from './strategy/meanReversion';
export { MomentumStrategy } from './strategy/momentum';
export { VolatilityBreakoutStrategy } from './strategy/volatility';

// Risk
export * from './risk/types';
export * from './risk/engine';
export * from './risk/positionSizing';

// Execution
export * from './execution/costs';
export * from './execution/broker';
export * from './execution/paperBroker';
export * from './execution/portfolio';
export * from './execution/oms';

// Backtest
export * from './backtest/metrics';
export * from './backtest/engine';
export * from './backtest/walkForward';

// Pipeline & audit
export * from './pipeline/tradingPipeline';
export * from './audit/log';
