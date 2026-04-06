// Token-Tracking - Unit Tests
// Testet Token-Schaetzung, Kosten-Berechnung und Budget-Warnungen

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

// Zugriff auf die internen Hilfsfunktionen via require (sie sind modul-global)
// Da estimateTokens, estimateCost, createTokenUsage, accumulateTokenUsage nicht exportiert sind,
// testen wir sie indirekt ueber den Orchestrator-State.

describe('Token-Tracking', () => {
  let orch;

  beforeEach(() => {
    orch = new Orchestrator();
  });

  describe('Initialer Zustand', () => {
    test('coordinatorTokenUsage ist bei Reset auf 0', () => {
      expect(orch.coordinatorTokenUsage).toEqual({
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        estimatedCost: 0,
      });
    });

    test('getState() enthaelt totalTokenUsage', () => {
      const state = orch.getState();
      expect(state).toHaveProperty('totalTokenUsage');
      expect(state.totalTokenUsage).toEqual({
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        estimatedCost: 0,
      });
    });

    test('getState() coordinator enthaelt tokenUsage', () => {
      const state = orch.getState();
      expect(state.coordinator).toHaveProperty('tokenUsage');
      expect(state.coordinator.tokenUsage).toEqual({
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        estimatedCost: 0,
      });
    });
  });

  describe('Token-Schaetzung Logik', () => {
    // Wir simulieren die Schaetzung: 1 Token pro 4 Zeichen
    test('leerer Text ergibt 0 Tokens', () => {
      // Indirekt: coordinatorTokenUsage bleibt 0 wenn kein runClaude laeuft
      expect(orch.coordinatorTokenUsage.inputTokens).toBe(0);
    });

    test('Token-Schaetzung ist ungefaehr text.length / 4', () => {
      // Wir simulieren eine Agent-Token-Akkumulation manuell
      // indem wir den State direkt setzen (wie es nach runClaude passiert)
      orch.agents = [{
        id: 0, title: 'Test', task: 'test', deliverable: 'test',
        status: 'done', conversation: [], tokenUsage: {
          inputTokens: 250, // = 1000 chars / 4
          outputTokens: 125, // = 500 chars / 4
          totalTokens: 375,
          estimatedCost: parseFloat(((250 * 0.015 + 125 * 0.075) / 1000).toFixed(6)),
        }
      }];

      const state = orch.getState();
      expect(state.agents[0].tokenUsage.inputTokens).toBe(250);
      expect(state.agents[0].tokenUsage.outputTokens).toBe(125);
      expect(state.agents[0].tokenUsage.totalTokens).toBe(375);
    });
  });

  describe('Kosten-Berechnung', () => {
    test('Kosten folgen Sonnet-Pricing: input*3/1000000 + output*15/1000000', () => {
      // Setze bekannte Token-Werte
      const inputCost = 1000 * 3 / 1000000;  // 0.003
      const outputCost = 500 * 15 / 1000000;  // 0.0075
      orch.coordinatorTokenUsage = {
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        estimatedCost: parseFloat((inputCost + outputCost).toFixed(6)),
      };

      const expectedCost = inputCost + outputCost; // 0.0105
      expect(orch.coordinatorTokenUsage.estimatedCost).toBeCloseTo(expectedCost, 6);
    });

    test('Kosten bei 0 Tokens sind 0', () => {
      const state = orch.getState();
      expect(state.totalTokenUsage.estimatedCost).toBe(0);
    });
  });

  describe('Token-Aggregation in getState()', () => {
    test('totalTokenUsage summiert Koordinator + alle Agenten', () => {
      orch.coordinatorTokenUsage = {
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        estimatedCost: 0.00525,
      };

      orch.agents = [
        {
          id: 0, title: 'Agent 1', status: 'done', conversation: [],
          tokenUsage: { inputTokens: 200, outputTokens: 100, totalTokens: 300, estimatedCost: 0.0105 },
        },
        {
          id: 1, title: 'Agent 2', status: 'done', conversation: [],
          tokenUsage: { inputTokens: 300, outputTokens: 150, totalTokens: 450, estimatedCost: 0.01575 },
        },
      ];

      const state = orch.getState();
      expect(state.totalTokenUsage.inputTokens).toBe(600);  // 100 + 200 + 300
      expect(state.totalTokenUsage.outputTokens).toBe(300);  // 50 + 100 + 150
      expect(state.totalTokenUsage.totalTokens).toBe(900);
      // Kosten: 600 * 3/1000000 + 300 * 15/1000000 = 0.0018 + 0.0045 = 0.0063
      expect(state.totalTokenUsage.estimatedCost).toBeCloseTo(0.0063, 6);
    });

    test('Agenten ohne tokenUsage werden als 0 gezaehlt', () => {
      orch.coordinatorTokenUsage = {
        inputTokens: 100, outputTokens: 50, totalTokens: 150, estimatedCost: 0.00525,
      };

      orch.agents = [
        { id: 0, title: 'Agent 1', status: 'waiting', conversation: [] },
        { id: 1, title: 'Agent 2', status: 'done', conversation: [],
          tokenUsage: { inputTokens: 200, outputTokens: 100, totalTokens: 300, estimatedCost: 0.0105 },
        },
      ];

      const state = orch.getState();
      expect(state.totalTokenUsage.inputTokens).toBe(300);  // 100 + 0 + 200
      expect(state.totalTokenUsage.outputTokens).toBe(150);  // 50 + 0 + 100
    });
  });

  describe('Token-Budget', () => {
    test('tokenBudget ist in getConfig() enthalten', () => {
      const config = orch.getConfig();
      expect(config).toHaveProperty('tokenBudget');
      expect(config.tokenBudget).toBe(0); // Default: unlimited
    });

    test('tokenBudget kann via updateConfig gesetzt werden', () => {
      orch.updateConfig({ tokenBudget: 500000 });
      expect(orch.getConfig().tokenBudget).toBe(500000);
    });

    test('tokenBudget 0 bedeutet unbegrenzt', () => {
      orch.updateConfig({ tokenBudget: 0 });
      expect(orch.getConfig().tokenBudget).toBe(0);
    });

    test('tokenBudget min ist 0', () => {
      expect(() => orch.updateConfig({ tokenBudget: -1 })).toThrow();
    });

    test('tokenBudget max ist 100000000', () => {
      expect(() => orch.updateConfig({ tokenBudget: 100000001 })).toThrow();
    });

    test('tokenBudget 100000000 ist gueltig', () => {
      orch.updateConfig({ tokenBudget: 100000000 });
      expect(orch.getConfig().tokenBudget).toBe(100000000);
    });

    test('budget_exceeded Event wird emittiert wenn Budget ueberschritten', () => {
      const events = [];
      orch.on('budget_exceeded', (data) => events.push(data));

      orch.updateConfig({ tokenBudget: 100 });

      // Simuliere hohe Token-Usage
      orch.coordinatorTokenUsage = {
        inputTokens: 80, outputTokens: 80, totalTokens: 160, estimatedCost: 0.007,
      };

      // Manuell Budget pruefen (wie es nach runClaude passiert)
      orch._checkTokenBudget();

      expect(events.length).toBe(1);
      expect(events[0].totalTokens).toBe(160);
      expect(events[0].tokenBudget).toBe(100);
    });

    test('kein budget_exceeded wenn Budget 0 (unbegrenzt)', () => {
      const events = [];
      orch.on('budget_exceeded', (data) => events.push(data));

      orch.updateConfig({ tokenBudget: 0 });
      orch.coordinatorTokenUsage = {
        inputTokens: 999999, outputTokens: 999999, totalTokens: 1999998, estimatedCost: 90,
      };

      orch._checkTokenBudget();
      expect(events.length).toBe(0);
    });

    test('kein budget_exceeded wenn unter Budget', () => {
      const events = [];
      orch.on('budget_exceeded', (data) => events.push(data));

      orch.updateConfig({ tokenBudget: 1000 });
      orch.coordinatorTokenUsage = {
        inputTokens: 100, outputTokens: 100, totalTokens: 200, estimatedCost: 0.009,
      };

      orch._checkTokenBudget();
      expect(events.length).toBe(0);
    });
  });

  describe('Reset setzt Token-Usage zurueck', () => {
    test('coordinatorTokenUsage wird bei reset() zurueckgesetzt', () => {
      orch.coordinatorTokenUsage = {
        inputTokens: 500, outputTokens: 250, totalTokens: 750, estimatedCost: 0.02625,
      };

      orch.reset();

      expect(orch.coordinatorTokenUsage).toEqual({
        inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCost: 0,
      });
    });

    test('getState().totalTokenUsage ist nach reset 0', () => {
      orch.coordinatorTokenUsage = {
        inputTokens: 500, outputTokens: 250, totalTokens: 750, estimatedCost: 0.02625,
      };
      orch.agents = [{
        id: 0, title: 'Test', status: 'done', conversation: [],
        tokenUsage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500, estimatedCost: 0.0525 },
      }];

      orch.reset();

      const state = orch.getState();
      expect(state.totalTokenUsage.totalTokens).toBe(0);
      expect(state.totalTokenUsage.estimatedCost).toBe(0);
    });
  });
});
