// SDK Token-Tracking - Unit Tests
// Testet Token-Tracking und Budget-Integration im SDK-Modus

'use strict';

jest.mock('child_process', () => ({
  spawn: jest.fn(),
  execSync: jest.fn(() => 'claude 1.0.0'),
}));

jest.mock('../../src/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const Orchestrator = require('../../orchestrator');

describe('SDK Token-Tracking', () => {
  let orch;

  beforeEach(() => {
    orch = new Orchestrator();
  });

  test('getConfig enthaelt sdkInfo mit Token-relevanten Feldern', () => {
    const config = orch.getConfig();
    expect(config).toHaveProperty('sdkInfo');
    expect(config.sdkInfo).toHaveProperty('available');
  });

  test('Budget-Einstellungen funktionieren unabhaengig vom Claude-Modus', () => {
    orch.updateConfig({ claudeMode: 'sdk' });
    orch.updateConfig({ tokenBudget: 50000 });
    const config = orch.getConfig();
    expect(config.tokenBudget).toBe(50000);
    expect(config.claudeMode).toBe('sdk');
  });

  test('Warn-Budget funktioniert im SDK-Modus', () => {
    orch.updateConfig({ claudeMode: 'sdk' });
    orch.updateConfig({ warnTokenBudget: 10000 });
    expect(orch.getConfig().warnTokenBudget).toBe(10000);
  });

  test('Pricing-Einstellungen bleiben im SDK-Modus erhalten', () => {
    orch.updateConfig({ claudeMode: 'auto' });
    orch.updateConfig({ inputCostPerMTok: 15, outputCostPerMTok: 75 });
    const config = orch.getConfig();
    expect(config.inputCostPerMTok).toBe(15);
    expect(config.outputCostPerMTok).toBe(75);
  });

  test('Claude-Modus und Budget-Config sind unabhaengig', () => {
    // Setze Budget
    orch.updateConfig({ tokenBudget: 100000, warnTokenBudget: 80000 });
    // Wechsle Modus
    orch.updateConfig({ claudeMode: 'sdk' });
    // Budget sollte unveraendert sein
    const config = orch.getConfig();
    expect(config.tokenBudget).toBe(100000);
    expect(config.warnTokenBudget).toBe(80000);
    expect(config.claudeMode).toBe('sdk');
  });

  test('sdkAvailable wird in Config zurueckgegeben', () => {
    const config = orch.getConfig();
    // In Test-Umgebung ist SDK nicht installiert
    expect(config.sdkAvailable === true || config.sdkAvailable === false || config.sdkAvailable === null).toBe(true);
  });

  test('getState enthaelt Token-Usage unabhaengig vom Modus', () => {
    orch.updateConfig({ claudeMode: 'auto' });
    const state = orch.getState();
    expect(state).toHaveProperty('totalTokenUsage');
    expect(state.totalTokenUsage).toHaveProperty('inputTokens');
    expect(state.totalTokenUsage).toHaveProperty('outputTokens');
  });
});
