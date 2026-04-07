// SDK Config - Unit Tests
// Testet claudeMode Konfiguration in updateConfig()

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

describe('claudeMode Config', () => {
  let orch;

  beforeEach(() => {
    orch = new Orchestrator();
  });

  test('Standard-Modus ist cli', () => {
    const config = orch.getConfig();
    expect(config.claudeMode).toBe('cli');
  });

  test('akzeptiert cli als Modus', () => {
    orch.updateConfig({ claudeMode: 'cli' });
    expect(orch.getConfig().claudeMode).toBe('cli');
  });

  test('akzeptiert sdk als Modus', () => {
    orch.updateConfig({ claudeMode: 'sdk' });
    expect(orch.getConfig().claudeMode).toBe('sdk');
  });

  test('akzeptiert auto als Modus', () => {
    orch.updateConfig({ claudeMode: 'auto' });
    expect(orch.getConfig().claudeMode).toBe('auto');
  });

  test('lehnt ungueltigen Modus ab', () => {
    expect(() => orch.updateConfig({ claudeMode: 'invalid' })).toThrow(/Modus/i);
  });

  test('lehnt leeren String ab', () => {
    expect(() => orch.updateConfig({ claudeMode: '' })).toThrow();
  });

  test('getConfig enthaelt sdkAvailable', () => {
    const config = orch.getConfig();
    expect('sdkAvailable' in config).toBe(true);
  });

  test('getConfig enthaelt sdkInfo', () => {
    const config = orch.getConfig();
    expect('sdkInfo' in config).toBe(true);
    expect(config.sdkInfo).toHaveProperty('available');
    expect(config.sdkInfo).toHaveProperty('detected');
  });

  test('Modus-Wechsel wird in Config persistiert', () => {
    orch.updateConfig({ claudeMode: 'auto' });
    const config = orch.getConfig();
    expect(config.claudeMode).toBe('auto');
    orch.updateConfig({ claudeMode: 'cli' });
    expect(orch.getConfig().claudeMode).toBe('cli');
  });

  test('andere Config-Felder bleiben bei claudeMode-Aenderung erhalten', () => {
    orch.updateConfig({ maxRounds: 8 });
    orch.updateConfig({ claudeMode: 'sdk' });
    const config = orch.getConfig();
    expect(config.claudeMode).toBe('sdk');
    expect(config.maxRounds).toBe(8);
  });
});
