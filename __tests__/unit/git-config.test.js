// Git Config - Unit Tests
// Testet Git-Konfiguration in Orchestrator getConfig/updateConfig

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

describe('Git Config im Orchestrator', () => {
  let orch;

  beforeEach(() => {
    orch = new Orchestrator();
  });

  test('getConfig enthaelt git-Objekt', () => {
    const config = orch.getConfig();
    expect(config).toHaveProperty('git');
    expect(config.git).toBeTruthy();
  });

  test('git ist standardmaessig deaktiviert', () => {
    const config = orch.getConfig();
    expect(config.git.enabled).toBe(false);
  });

  test('git-Config hat alle Felder', () => {
    const config = orch.getConfig();
    expect(config.git).toHaveProperty('enabled');
    expect(config.git).toHaveProperty('workDir');
    expect(config.git).toHaveProperty('autoCommit');
    expect(config.git).toHaveProperty('branchPerProject');
    expect(config.git).toHaveProperty('autoPush');
    expect(config.git).toHaveProperty('commitPrefix');
    expect(config.git).toHaveProperty('gitInstalled');
  });

  test('updateConfig akzeptiert git-Objekt', () => {
    orch.updateConfig({ git: { enabled: true } });
    expect(orch.getConfig().git.enabled).toBe(true);
  });

  test('updateConfig aendert git autoCommit', () => {
    orch.updateConfig({ git: { autoCommit: false } });
    expect(orch.getConfig().git.autoCommit).toBe(false);
  });

  test('updateConfig aendert git branchPerProject', () => {
    orch.updateConfig({ git: { branchPerProject: false } });
    expect(orch.getConfig().git.branchPerProject).toBe(false);
  });

  test('updateConfig aendert git autoPush', () => {
    orch.updateConfig({ git: { autoPush: true } });
    expect(orch.getConfig().git.autoPush).toBe(true);
  });

  test('git-Config aendert nicht andere Config-Felder', () => {
    orch.updateConfig({ maxRounds: 7 });
    orch.updateConfig({ git: { enabled: true } });
    expect(orch.getConfig().maxRounds).toBe(7);
    expect(orch.getConfig().git.enabled).toBe(true);
  });

  test('gitIntegration-Instanz existiert', () => {
    expect(orch.gitIntegration).toBeTruthy();
    expect(typeof orch.gitIntegration.getConfig).toBe('function');
  });

  test('gitIntegration hat commitProjectResults', () => {
    expect(typeof orch.gitIntegration.commitProjectResults).toBe('function');
  });
});
