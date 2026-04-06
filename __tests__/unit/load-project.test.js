// loadProject - Unit Tests
// Testet das Laden gespeicherter Projekte

'use strict';
const path = require('path');
const fs = require('fs');

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

describe('loadProject()', () => {
  let orch;
  const testProjectId = 'proj_test_load_' + Date.now();
  const projectsDir = path.join(__dirname, '../../projects');
  const testDir = path.join(projectsDir, testProjectId);

  beforeAll(() => {
    // Test-Projektverzeichnis erstellen
    fs.mkdirSync(path.join(testDir, 'agent-1'), { recursive: true });
    fs.mkdirSync(path.join(testDir, 'agent-2'), { recursive: true });

    // State schreiben
    const state = {
      projectId: testProjectId,
      projectTitle: 'Test Laden',
      projectDesc: 'Testbeschreibung',
      projectSummary: 'Zusammenfassung',
      phase: 'complete',
      startedAt: Date.now() - 60000,
      completedAt: Date.now(),
      totalDuration: 60,
      projectScore: 85,
      tasks: [
        { title: 'Task 1', task: 'Aufgabe 1', deliverable: 'Ergebnis 1', depends_on: [] },
        { title: 'Task 2', task: 'Aufgabe 2', deliverable: 'Ergebnis 2', depends_on: [0] },
      ],
      agents: [
        { id: 0, title: 'Task 1', status: 'done', conversation: [], rounds: 1, score: 90 },
        { id: 1, title: 'Task 2', status: 'done', conversation: [], rounds: 2, score: 80 },
      ],
      coordinator: { status: 'done', log: [{ agentIndex: 0, question: 'Test?', answer: 'Ja' }] },
    };
    fs.writeFileSync(path.join(testDir, 'state.json'), JSON.stringify(state));

    // Conversation JSONL fuer Agent 1
    fs.writeFileSync(path.join(testDir, 'agent-1', 'conversation.jsonl'),
      JSON.stringify({ from: 'agent', text: 'Hallo', type: 'work', ts: Date.now() }) + '\n');
  });

  afterAll(() => {
    // Aufräumen
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  beforeEach(() => {
    orch = new Orchestrator();
  });

  test('laedt Projekt-State korrekt', () => {
    const state = orch.loadProject(testProjectId);
    expect(state.projectId).toBe(testProjectId);
    expect(state.projectTitle).toBe('Test Laden');
    expect(state.phase).toBe('complete');
    expect(state.agents).toHaveLength(2);
    expect(state.totalDuration).toBe(60);
    expect(state.projectScore).toBe(85);
  });

  test('laedt Koordinator-Log', () => {
    orch.loadProject(testProjectId);
    expect(orch.coordLog).toHaveLength(1);
    expect(orch.coordLog[0].question).toBe('Test?');
  });

  test('laedt Conversations von Disk', () => {
    orch.loadProject(testProjectId);
    expect(orch.agents[0].conversation).toHaveLength(1);
    expect(orch.agents[0].conversation[0].text).toBe('Hallo');
  });

  test('wirft bei nicht-existierendem Projekt', () => {
    expect(() => orch.loadProject('proj_nichtexistent')).toThrow(/nicht gefunden/);
  });
});
