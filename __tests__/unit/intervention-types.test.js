// Intervention Types - Unit Tests
// Testet setIntervention mit verschiedenen Typen: redirect, skip, complete, restart, inject

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
const os = require('os');
const path = require('path');
const fs = require('fs');

describe('Intervention Types', () => {
  let orch;
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'intervention-types-test-'));
    // Erstelle Agent-Verzeichnisse
    for (let i = 0; i < 3; i++) {
      fs.mkdirSync(path.join(tmpDir, 'agent-' + i), { recursive: true });
    }

    orch = new Orchestrator();
    orch.projectDir = tmpDir;
    orch.agents = [
      { id: 0, status: 'working', pendingIntervention: null, pendingInterventionType: null, conversation: [], rounds: 2, startTime: Date.now() - 5000, interventionHistory: [], workDir: path.join(tmpDir, 'agent-0') },
      { id: 1, status: 'waiting', pendingIntervention: null, pendingInterventionType: null, conversation: [], rounds: 0, startTime: null, interventionHistory: [], workDir: path.join(tmpDir, 'agent-1') },
      { id: 2, status: 'done', pendingIntervention: null, pendingInterventionType: null, conversation: [], rounds: 3, startTime: Date.now() - 10000, endTime: Date.now(), interventionHistory: [], workDir: path.join(tmpDir, 'agent-2') },
    ];
    orch.tasks = [
      { title: 'Task 1', task: 'Mache etwas', deliverable: 'Ergebnis 1' },
      { title: 'Task 2', task: 'Mache mehr', deliverable: 'Ergebnis 2' },
      { title: 'Task 3', task: 'Mache fertig', deliverable: 'Ergebnis 3' },
    ];
    orch.activityLog = [];
  });

  afterEach(() => {
    // Temp-Verzeichnis aufraeumen
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  describe('type="redirect"', () => {
    test('setzt pendingIntervention Nachricht auf arbeitendem Agent', () => {
      orch.setIntervention(0, 'Bitte aendere den Ansatz', 'redirect');
      expect(orch.agents[0].pendingIntervention).toBe('Bitte aendere den Ansatz');
      expect(orch.agents[0].pendingInterventionType).toBe('redirect');
    });

    test('emittiert agent_intervention_queued Event', () => {
      const events = [];
      orch.on('update', (ev) => events.push(ev));

      orch.setIntervention(0, 'Redirect-Nachricht', 'redirect');

      const queued = events.find(e => e.event === 'agent_intervention_queued');
      expect(queued).toBeDefined();
      expect(queued.data.type).toBe('redirect');
    });

    test('lehnt redirect ab wenn Agent nicht arbeitet', () => {
      expect(() => orch.setIntervention(1, 'Test', 'redirect'))
        .toThrow('Agent ist nicht im Arbeitsstatus');
    });
  });

  describe('type="skip"', () => {
    test('markiert Agent sofort als skipped', () => {
      orch.setIntervention(0, 'Wird uebersprungen', 'skip');
      expect(orch.agents[0].status).toBe('skipped');
      expect(orch.agents[0].endTime).toBeDefined();
      expect(orch.agents[0].duration).toBeDefined();
    });

    test('emittiert agent_intervention_applied Event', () => {
      const events = [];
      orch.on('update', (ev) => events.push(ev));

      orch.setIntervention(0, 'Skip-Nachricht', 'skip');

      const applied = events.find(e => e.event === 'agent_intervention_applied');
      expect(applied).toBeDefined();
      expect(applied.data.type).toBe('skip');
    });

    test('kann auch wartende Agenten ueberspringen', () => {
      orch.setIntervention(1, 'Wartenden ueberspringen', 'skip');
      expect(orch.agents[1].status).toBe('skipped');
    });

    test('lehnt skip ab wenn Agent bereits done ist', () => {
      expect(() => orch.setIntervention(2, 'Test', 'skip'))
        .toThrow('bereits fertig oder übersprungen');
    });

    test('lehnt skip ab wenn Agent bereits skipped ist', () => {
      orch.agents[0].status = 'skipped';
      expect(() => orch.setIntervention(0, 'Nochmal', 'skip'))
        .toThrow('bereits fertig oder übersprungen');
    });
  });

  describe('type="complete"', () => {
    test('markiert Agent sofort als done mit progress 100', () => {
      orch.setIntervention(0, 'Manuell fertig', 'complete');
      expect(orch.agents[0].status).toBe('done');
      expect(orch.agents[0].progress).toBe(100);
      expect(orch.agents[0].endTime).toBeDefined();
    });

    test('emittiert agent_intervention_applied Event', () => {
      const events = [];
      orch.on('update', (ev) => events.push(ev));

      orch.setIntervention(0, 'Complete-Test', 'complete');

      const applied = events.find(e => e.event === 'agent_intervention_applied');
      expect(applied).toBeDefined();
      expect(applied.data.type).toBe('complete');
    });

    test('lehnt complete ab wenn Agent bereits done ist', () => {
      expect(() => orch.setIntervention(2, 'Test', 'complete'))
        .toThrow('bereits fertig');
    });

    test('kann wartende Agenten als fertig markieren', () => {
      orch.setIntervention(1, 'Direkt fertig', 'complete');
      expect(orch.agents[1].status).toBe('done');
      expect(orch.agents[1].progress).toBe(100);
    });
  });

  describe('type="restart"', () => {
    test('setzt pendingIntervention mit type restart', () => {
      orch.setIntervention(0, 'Bitte neu starten', 'restart');
      expect(orch.agents[0].pendingIntervention).toBe('Bitte neu starten');
      expect(orch.agents[0].pendingInterventionType).toBe('restart');
    });

    test('emittiert agent_intervention_queued Event', () => {
      const events = [];
      orch.on('update', (ev) => events.push(ev));

      orch.setIntervention(0, 'Restart-Nachricht', 'restart');

      const queued = events.find(e => e.event === 'agent_intervention_queued');
      expect(queued).toBeDefined();
      expect(queued.data.type).toBe('restart');
    });

    test('lehnt restart ab wenn Agent bereits done ist', () => {
      expect(() => orch.setIntervention(2, 'Test', 'restart'))
        .toThrow('bereits fertig');
    });

    test('erlaubt restart fuer wartende Agenten', () => {
      // restart ist in allowedForNonWorking
      orch.setIntervention(1, 'Restart wartender Agent', 'restart');
      expect(orch.agents[1].pendingIntervention).toBe('Restart wartender Agent');
      expect(orch.agents[1].pendingInterventionType).toBe('restart');
    });
  });

  describe('Ungueltiger Typ', () => {
    test('lehnt unbekannten Typ ab', () => {
      expect(() => orch.setIntervention(0, 'Test', 'ungueltig'))
        .toThrow('Ungültiger Intervention-Typ');
    });

    test('lehnt leeren Typ ab', () => {
      expect(() => orch.setIntervention(0, 'Test', ''))
        .toThrow('Ungültiger Intervention-Typ');
    });
  });

  describe('interventionHistory', () => {
    test('wird korrekt gespeichert bei redirect', () => {
      orch.setIntervention(0, 'History-Test', 'redirect');
      expect(orch.agents[0].interventionHistory.length).toBe(1);
      expect(orch.agents[0].interventionHistory[0].type).toBe('redirect');
      expect(orch.agents[0].interventionHistory[0].message).toBe('History-Test');
      expect(orch.agents[0].interventionHistory[0]).toHaveProperty('timestamp');
      expect(orch.agents[0].interventionHistory[0].round).toBe(2);
    });

    test('wird korrekt gespeichert bei skip', () => {
      orch.setIntervention(0, 'Skip-History', 'skip');
      expect(orch.agents[0].interventionHistory.length).toBe(1);
      expect(orch.agents[0].interventionHistory[0].type).toBe('skip');
    });

    test('wird korrekt gespeichert bei complete', () => {
      orch.setIntervention(0, 'Complete-History', 'complete');
      expect(orch.agents[0].interventionHistory.length).toBe(1);
      expect(orch.agents[0].interventionHistory[0].type).toBe('complete');
    });

    test('sammelt mehrere Eintraege', () => {
      orch.setIntervention(0, 'Erste Intervention', 'redirect');
      // Agent ist noch working, zweite Intervention
      orch.setIntervention(0, 'Zweite Intervention', 'redirect');
      expect(orch.agents[0].interventionHistory.length).toBe(2);
      expect(orch.agents[0].interventionHistory[0].message).toBe('Erste Intervention');
      expect(orch.agents[0].interventionHistory[1].message).toBe('Zweite Intervention');
    });

    test('initialisiert History-Array falls nicht vorhanden', () => {
      delete orch.agents[0].interventionHistory;
      orch.setIntervention(0, 'Init-Test', 'redirect');
      expect(Array.isArray(orch.agents[0].interventionHistory)).toBe(true);
      expect(orch.agents[0].interventionHistory.length).toBe(1);
    });
  });
});
