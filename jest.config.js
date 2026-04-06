module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.js'],
  collectCoverageFrom: ['orchestrator.js', 'server.js'],
  testTimeout: 30000,
  verbose: true,
  // API-Tests starten Server – seriell ausführen um Port-Konflikte zu vermeiden
  maxWorkers: 1
};
