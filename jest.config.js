module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.js'],
  collectCoverageFrom: ['orchestrator.js', 'server.js'],
  testTimeout: 30000,
  verbose: true
};
