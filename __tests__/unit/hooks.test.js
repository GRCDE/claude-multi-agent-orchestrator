// Hook-System - Unit Tests
// Testet loadHooks() und _runHook() Verhalten

'use strict';

// Mock logger bevor orchestrator geladen wird
jest.mock('../../src/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

// Mock child_process (orchestrator braucht es)
jest.mock('child_process', () => ({
  spawn: jest.fn(),
  execSync: jest.fn(() => 'claude 1.0.0'),
}));

describe('Hook-System', () => {
  let Orchestrator;

  beforeEach(() => {
    // Module-Cache leeren damit jeder Test frisch startet
    jest.resetModules();

    jest.mock('../../src/logger', () => ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    }));
    jest.mock('child_process', () => ({
      spawn: jest.fn(),
      execSync: jest.fn(() => 'claude 1.0.0'),
    }));
  });

  describe('loadHooks()', () => {
    test('gibt leeres Objekt zurueck wenn keine hooks.js existiert', () => {
      // Kein Mock fuer ./hooks => require wirft MODULE_NOT_FOUND
      Orchestrator = require('../../orchestrator');
      const orch = new Orchestrator();
      expect(orch.hooks).toEqual({});
    });

    test('laedt hooks.js wenn vorhanden', () => {
      // Mock hooks.js mit einer Funktion
      jest.mock('../../hooks', () => ({
        beforePlan: jest.fn(),
        afterPlan: jest.fn(),
      }), { virtual: true });

      Orchestrator = require('../../orchestrator');
      const orch = new Orchestrator();
      expect(typeof orch.hooks.beforePlan).toBe('function');
      expect(typeof orch.hooks.afterPlan).toBe('function');
    });
  });

  describe('_runHook()', () => {
    let orch;

    beforeEach(() => {
      Orchestrator = require('../../orchestrator');
      orch = new Orchestrator();
    });

    test('crasht nicht wenn Hook einen Fehler wirft', async () => {
      orch.hooks = {
        beforePlan: jest.fn(() => { throw new Error('Hook kaputt'); }),
      };

      // Soll NICHT werfen
      await expect(orch._runHook('beforePlan', { test: true })).resolves.toBeUndefined();
    });

    test('ruft Hook-Funktion mit korrekten Daten auf', async () => {
      const mockHook = jest.fn();
      orch.hooks = { onComplete: mockHook };

      const data = { projectId: 'proj_123', totalDuration: 42 };
      await orch._runHook('onComplete', data);

      expect(mockHook).toHaveBeenCalledTimes(1);
      expect(mockHook).toHaveBeenCalledWith(data);
    });

    test('ignoriert stillschweigend nicht-Funktions-Hooks', async () => {
      orch.hooks = {
        beforePlan: 'not a function',
        afterPlan: 42,
        onComplete: null,
      };

      // Keiner soll werfen
      await expect(orch._runHook('beforePlan', {})).resolves.toBeUndefined();
      await expect(orch._runHook('afterPlan', {})).resolves.toBeUndefined();
      await expect(orch._runHook('onComplete', {})).resolves.toBeUndefined();
    });

    test('ignoriert nicht-existierende Hooks', async () => {
      orch.hooks = {};
      await expect(orch._runHook('nichtVorhanden', {})).resolves.toBeUndefined();
    });

    test('crasht nicht wenn async Hook rejected', async () => {
      orch.hooks = {
        beforePlan: jest.fn(() => Promise.reject(new Error('Async Fehler'))),
      };

      await expect(orch._runHook('beforePlan', {})).resolves.toBeUndefined();
    });
  });
});
