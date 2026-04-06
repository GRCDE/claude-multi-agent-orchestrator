// Timing-Tracking - Unit Tests
// Testet startedAt, completedAt, totalDuration im Orchestrator-State

'use strict';

jest.mock('../../src/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock('child_process', () => ({
  spawn: jest.fn(),
  execSync: jest.fn(() => 'claude 1.0.0'),
}));

const Orchestrator = require('../../orchestrator');

describe('Timing-Tracking', () => {
  let orch;

  beforeEach(() => {
    orch = new Orchestrator();
  });

  describe('getState()', () => {
    test('enthaelt startedAt, completedAt, totalDuration', () => {
      const state = orch.getState();
      expect(state).toHaveProperty('startedAt');
      expect(state).toHaveProperty('completedAt');
      expect(state).toHaveProperty('totalDuration');
    });

    test('Timing-Felder sind initial null', () => {
      const state = orch.getState();
      expect(state.startedAt).toBeNull();
      expect(state.completedAt).toBeNull();
      expect(state.totalDuration).toBeNull();
    });
  });

  describe('reset()', () => {
    test('setzt Timing-Felder auf null zurueck', () => {
      // Felder manuell setzen um Reset zu testen
      orch.startedAt = Date.now();
      orch.completedAt = Date.now();
      orch.totalDuration = 120;

      orch.reset();

      const state = orch.getState();
      expect(state.startedAt).toBeNull();
      expect(state.completedAt).toBeNull();
      expect(state.totalDuration).toBeNull();
    });

    test('setzt auch Phase auf idle zurueck', () => {
      orch.phase = 'running';
      orch.startedAt = Date.now();

      orch.reset();

      expect(orch.getState().phase).toBe('idle');
    });
  });

  describe('Timing-Felder spiegeln sich in getState()', () => {
    test('startedAt wird korrekt reflektiert', () => {
      const ts = Date.now();
      orch.startedAt = ts;
      expect(orch.getState().startedAt).toBe(ts);
    });

    test('completedAt und totalDuration werden korrekt reflektiert', () => {
      const start = Date.now() - 5000;
      orch.startedAt = start;
      orch.completedAt = Date.now();
      orch.totalDuration = 5;

      const state = orch.getState();
      expect(state.startedAt).toBe(start);
      expect(state.completedAt).toBe(orch.completedAt);
      expect(state.totalDuration).toBe(5);
    });
  });
});
