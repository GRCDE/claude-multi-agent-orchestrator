// Agent Progress - Unit Tests
// Testet Fortschrittsanzeige im Agent-Lebenszyklus

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

describe('Agent Progress', () => {
  let orch;

  beforeEach(() => {
    orch = new Orchestrator();
  });

  test('initialer Agenten-Progress ist 0', () => {
    // Simuliere wie modifyPlan Agents erstellt
    orch.projectDir = '/tmp/test-proj';
    orch.phase = 'awaiting_approval';
    orch._approvalResolver = () => {};
    orch.modifyPlan([
      { title: 'Task 1', task: 'Aufgabe 1', deliverable: 'Ergebnis 1' },
      { title: 'Task 2', task: 'Aufgabe 2', deliverable: 'Ergebnis 2' },
    ]);

    expect(orch.agents[0].progress).toBe(0);
    expect(orch.agents[1].progress).toBe(0);
    expect(orch.agents[0].status).toBe('waiting');
    expect(orch.agents[1].status).toBe('waiting');
  });

  test('Progress wird durch _patchAgent aktualisiert', () => {
    // Setup Agents direkt
    orch.agents = [
      { id: 0, title: 'A', status: 'waiting', progress: 0, conversation: [] },
      { id: 1, title: 'B', status: 'waiting', progress: 0, conversation: [] },
    ];
    orch.tasks = [{ title: 'A' }, { title: 'B' }];

    // Simuliere Arbeitsstart
    orch._patchAgent(0, { status: 'working', progress: 10 });
    expect(orch.agents[0].progress).toBe(10);
    expect(orch.agents[0].status).toBe('working');

    // Simuliere Fortschritt waehrend Runden
    orch._patchAgent(0, { progress: 50 });
    expect(orch.agents[0].progress).toBe(50);

    // Zweiter Agent bleibt unveraendert
    expect(orch.agents[1].progress).toBe(0);
  });

  test('Progress ist 100 wenn Agent fertig', () => {
    orch.agents = [
      { id: 0, title: 'A', status: 'working', progress: 50, conversation: [] },
    ];
    orch.tasks = [{ title: 'A' }];

    orch._patchAgent(0, { status: 'done', progress: 100 });
    expect(orch.agents[0].progress).toBe(100);
    expect(orch.agents[0].status).toBe('done');
  });
});
