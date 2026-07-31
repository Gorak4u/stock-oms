/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/__tests__'],
  testMatch: ['**/*.test.ts'],
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts'],
  coverageDirectory: 'coverage',
  clearMocks: true,
  verbose: false,
  // Serial by design. The persistence and API suites both run against the same
  // Postgres database and TRUNCATE between cases; in parallel workers one
  // suite wipes the other's rows mid-test, which surfaces as spurious
  // foreign-key failures. Isolating them would mean a database per worker,
  // which is more machinery than the few seconds this costs.
  maxWorkers: 1,
};
