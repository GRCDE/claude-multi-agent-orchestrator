'use strict';
// Wir müssen runClaude mocken. Da es ein Modul-internes ist,
// testen wir über die öffentliche API der Klasse.

// Strategie: Wir erstellen eine TestOrchestrator Subklasse die runClaude überschreibt
// ODER wir mocken das child_process Modul

const path = require('path');
const fs = require('fs');
const os = require('os');

// Mock child_process.spawn
jest.mock('child_process', () => {
  const original = jest.requireActual('child_process');
  return {
    ...original,
    spawn: jest.fn(),
    execSync: jest.fn(() => 'claude 1.0.0'), // checkClaudeCli() mock
  };
});

const { spawn } = require('child_process');
const Orchestrator = require('../../orchestrator');

// Helper: Mock spawn Prozess der sofort Output liefert
function mockSpawnProcess(output, exitCode = 0) {
  const EventEmitter = require('events');
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = jest.fn();

  // Simulate async output
  setTimeout(() => {
    proc.stdout.emit('data', Buffer.from(output));
    proc.emit('close', exitCode);
  }, 10);

  return proc;
}

describe('Orchestrator Integration', () => {
  let orch;
  let tmpDir;

  beforeEach(() => {
    orch = new Orchestrator();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-test-'));
    // Override PROJECTS_DIR - wir müssen das intern setzen
  });

  afterEach(() => {
    orch.reset();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('getState() gibt korrekten Initialzustand', () => {
    const state = orch.getState();
    expect(state.phase).toBe('idle');
    expect(state.agents).toEqual([]);
    expect(state.projectId).toBeNull();
  });

  test('reset() setzt State zurück', () => {
    orch.phase = 'running';
    orch.projectId = 'test';
    orch.reset();
    expect(orch.phase).toBe('idle');
    expect(orch.projectId).toBeNull();
  });

  test('Koordinator-Plan wird korrekt geparst', async () => {
    const planJSON = JSON.stringify({
      project_title: 'Testprojekt',
      summary: 'Ein Test',
      quality_notes: 'Gut aufgeteilt',
      tasks: [
        { title: 'Task 1', task: 'Mache A', deliverable: 'Datei A' },
        { title: 'Task 2', task: 'Mache B', deliverable: 'Datei B' }
      ]
    });

    let callCount = 0;
    spawn.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return mockSpawnProcess(planJSON); // Coordinator plan
      return mockSpawnProcess('Arbeit erledigt. FERTIG'); // Agent work
    });

    await orch.start('Testbeschreibung', 2);

    expect(orch.projectTitle).toBe('Testprojekt');
    expect(orch.tasks).toHaveLength(2);
    expect(orch.phase).toBe('complete');
  });

  test('Agent-Frage wird an Koordinator weitergeleitet', async () => {
    const planJSON = JSON.stringify({
      project_title: 'Test',
      summary: 'Test',
      quality_notes: 'ok',
      tasks: [{ title: 'T1', task: 'Aufgabe', deliverable: 'Ergebnis' }]
    });

    let callCount = 0;
    spawn.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return mockSpawnProcess(planJSON);
      if (callCount === 2) return mockSpawnProcess('Ich brauche Info. FRAGE: Welches Format?');
      if (callCount === 3) return mockSpawnProcess('Verwende JSON.');
      return mockSpawnProcess('Fertig mit JSON. FERTIG');
    });

    await orch.start('Test', 1);

    expect(orch.agents[0].status).toBe('done');
    expect(orch.coordLog.length).toBeGreaterThan(0);
  });
});
