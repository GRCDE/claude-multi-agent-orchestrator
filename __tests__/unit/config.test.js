// Konfiguration - Unit Tests
// Testet getConfig() und updateConfig() des Orchestrators

'use strict';

jest.mock('child_process', () => ({
  spawn: jest.fn(),
  execSync: jest.fn(() => 'claude 1.0.0'),
}));

// Logger mocken damit keine Dateien geschrieben werden
jest.mock('../../src/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const Orchestrator = require('../../orchestrator');

describe('getConfig()', () => {
  let orch;

  beforeEach(() => {
    orch = new Orchestrator();
  });

  test('gibt erwartete Schluessel zurueck', () => {
    const config = orch.getConfig();
    expect(config).toHaveProperty('agentTimeout');
    expect(config).toHaveProperty('maxRetries');
    expect(config).toHaveProperty('retryBaseDelay');
    expect(config).toHaveProperty('maxAgents');
    expect(config).toHaveProperty('concurrency');
    expect(config).toHaveProperty('maxRounds');
    expect(config).toHaveProperty('webhookUrl');
  });

  test('alle numerischen Werte sind positive Zahlen', () => {
    const config = orch.getConfig();
    expect(config.agentTimeout).toBeGreaterThan(0);
    expect(config.maxRetries).toBeGreaterThanOrEqual(0);
    expect(config.retryBaseDelay).toBeGreaterThan(0);
    expect(config.maxAgents).toBeGreaterThan(0);
    expect(config.concurrency).toBeGreaterThan(0);
    expect(config.maxRounds).toBeGreaterThan(0);
  });
});

describe('updateConfig()', () => {
  let orch;

  beforeEach(() => {
    orch = new Orchestrator();
  });

  test('aktualisiert gueltige Werte', () => {
    orch.updateConfig({ agentTimeout: 60000, maxRetries: 3 });
    const config = orch.getConfig();
    expect(config.agentTimeout).toBe(60000);
    expect(config.maxRetries).toBe(3);
  });

  test('lehnt ungueltige Werte ab (negatives Timeout)', () => {
    expect(() => {
      orch.updateConfig({ agentTimeout: -1 });
    }).toThrow();
  });

  test('lehnt Werte ueber Maximum ab', () => {
    expect(() => {
      orch.updateConfig({ agentTimeout: 99999999 });
    }).toThrow();
  });

  test('ignoriert unbekannte Schluessel mit Fehler', () => {
    expect(() => {
      orch.updateConfig({ unknownField: 42 });
    }).toThrow(/Unbekanntes Feld/);
  });

  test('lehnt nicht-numerische Werte ab', () => {
    expect(() => {
      orch.updateConfig({ agentTimeout: 'abc' });
    }).toThrow();
  });
});
