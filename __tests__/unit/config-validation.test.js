// Config Validation - Unit Tests
// Testet updateConfig() mit verschiedenen Eingaben

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

describe('updateConfig()', () => {
  let orch;

  beforeEach(() => {
    orch = new Orchestrator();
  });

  test('akzeptiert gueltige webhookUrl', () => {
    orch.updateConfig({ webhookUrl: 'http://example.com/hook' });
    const config = orch.getConfig();
    expect(config.webhookUrl).toBe('http://example.com/hook');
  });

  test('akzeptiert HTTPS webhookUrl', () => {
    orch.updateConfig({ webhookUrl: 'https://hooks.slack.com/services/abc' });
    const config = orch.getConfig();
    expect(config.webhookUrl).toMatch(/^https:\/\//);
  });

  test('akzeptiert leere webhookUrl zum Deaktivieren', () => {
    orch.updateConfig({ webhookUrl: 'http://example.com/hook' });
    orch.updateConfig({ webhookUrl: '' });
    expect(orch.getConfig().webhookUrl).toBe('');
  });

  test('lehnt FTP webhookUrl ab', () => {
    expect(() => orch.updateConfig({ webhookUrl: 'ftp://example.com' }))
      .toThrow(/http/i);
  });

  test('lehnt ungueltige webhookUrl ab', () => {
    expect(() => orch.updateConfig({ webhookUrl: 'not-a-url' }))
      .toThrow(/URL/i);
  });

  test('akzeptiert gueltige concurrency', () => {
    orch.updateConfig({ concurrency: 5 });
    expect(orch.getConfig().concurrency).toBe(5);
  });

  test('lehnt zu hohe concurrency ab', () => {
    expect(() => orch.updateConfig({ concurrency: 100 })).toThrow();
  });

  test('akzeptiert mehrere Felder gleichzeitig', () => {
    orch.updateConfig({ maxRetries: 3, maxRounds: 8 });
    const config = orch.getConfig();
    expect(config.maxRetries).toBe(3);
    expect(config.maxRounds).toBe(8);
  });

  test('isolation akzeptiert shared und strict', () => {
    orch.updateConfig({ isolation: 'strict' });
    expect(orch.getConfig().isolation).toBe('strict');
    orch.updateConfig({ isolation: 'shared' });
    expect(orch.getConfig().isolation).toBe('shared');
  });

  test('isolation lehnt ungueltige Werte ab', () => {
    expect(() => orch.updateConfig({ isolation: 'invalid' })).toThrow();
  });
});
