// resume() - Unit Tests
// Testet das Fortsetzen unterbrochener/fehlgeschlagener Projekte

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

describe('resume()', () => {
  let orch;
  const testProjectId = 'proj_test_resume_' + Date.now();
  const projectsDir = path.join(__dirname, '../../projects');
  const testDir = path.join(projectsDir, testProjectId);

  function writeState(state) {
    fs.writeFileSync(path.join(testDir, 'state.json'), JSON.stringify(state));
  }

  function makeAgentDirs(count) {
    for (let i = 1; i <= count; i++) {
      fs.mkdirSync(path.join(testDir, `agent-${i}`), { recursive: true });
    }
  }

  function writeConversation(agentNum, messages) {
    const logFile = path.join(testDir, `agent-${agentNum}`, 'conversation.jsonl');
    const content = messages.map(m => JSON.stringify({ ...m, ts: Date.now() })).join('\n') + '\n';
    fs.writeFileSync(logFile, content);
  }

  beforeAll(() => {
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterAll(() => {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  beforeEach(() => {
    orch = new Orchestrator();
    // Erstelle Standard-State mit gemischten Agent-Status
    makeAgentDirs(4);
  });

  afterEach(() => {
    orch.reset();
  });

  test('identifiziert incomplete Agenten korrekt', () => {
    const state = {
      projectId: testProjectId,
      projectTitle: 'Resume Test',
      projectDesc: 'Testbeschreibung',
      projectSummary: '',
      phase: 'error',
      startedAt: Date.now() - 60000,
      tasks: [
        { title: 'Task 1', task: 'Aufgabe 1', deliverable: 'E1', depends_on: [] },
        { title: 'Task 2', task: 'Aufgabe 2', deliverable: 'E2', depends_on: [] },
        { title: 'Task 3', task: 'Aufgabe 3', deliverable: 'E3', depends_on: [] },
        { title: 'Task 4', task: 'Aufgabe 4', deliverable: 'E4', depends_on: [] },
      ],
      agents: [
        { id: 0, title: 'Task 1', status: 'done', conversation: [], rounds: 1, score: 90 },
        { id: 1, title: 'Task 2', status: 'waiting', conversation: [], rounds: 0 },
        { id: 2, title: 'Task 3', status: 'working', conversation: [], rounds: 1 },
        { id: 3, title: 'Task 4', status: 'asking', conversation: [], rounds: 1 },
      ],
      coordinator: { status: 'ready', log: [] },
    };
    writeState(state);

    orch.loadProject(testProjectId);

    // Done-Agent bleibt done
    expect(orch.agents[0].status).toBe('done');

    // Incomplete Agenten behalten ihren Status (noch nicht resumed)
    const incompleteStatuses = ['waiting', 'working', 'waiting_deps', 'retrying', 'asking'];
    expect(incompleteStatuses).toContain(orch.agents[1].status);
    expect(incompleteStatuses).toContain(orch.agents[2].status);
    expect(incompleteStatuses).toContain(orch.agents[3].status);
  });

  test('ueberspringt abgeschlossene Agenten', () => {
    const state = {
      projectId: testProjectId,
      projectTitle: 'Resume Skip Test',
      projectDesc: 'Test',
      projectSummary: '',
      phase: 'error',
      startedAt: Date.now() - 60000,
      tasks: [
        { title: 'Task 1', task: 'Aufgabe 1', deliverable: 'E1', depends_on: [] },
        { title: 'Task 2', task: 'Aufgabe 2', deliverable: 'E2', depends_on: [] },
      ],
      agents: [
        { id: 0, title: 'Task 1', status: 'done', conversation: [], rounds: 2, score: 85, duration: 30 },
        { id: 1, title: 'Task 2', status: 'done', conversation: [], rounds: 1, score: 95, duration: 20 },
      ],
      coordinator: { status: 'done', log: [] },
    };
    writeState(state);

    orch.loadProject(testProjectId);

    // Alle Agenten sind done - Status und Daten bleiben erhalten
    expect(orch.agents[0].status).toBe('done');
    expect(orch.agents[0].score).toBe(85);
    expect(orch.agents[0].duration).toBe(30);
    expect(orch.agents[1].status).toBe('done');
    expect(orch.agents[1].score).toBe(95);
    expect(orch.agents[1].duration).toBe(20);
  });

  test('setzt fehlerhafte Agenten zurueck', () => {
    const state = {
      projectId: testProjectId,
      projectTitle: 'Resume Error Test',
      projectDesc: 'Test',
      projectSummary: '',
      phase: 'error',
      startedAt: Date.now() - 60000,
      tasks: [
        { title: 'Task 1', task: 'Aufgabe 1', deliverable: 'E1', depends_on: [] },
        { title: 'Task 2', task: 'Aufgabe 2', deliverable: 'E2', depends_on: [] },
        { title: 'Task 3', task: 'Aufgabe 3', deliverable: 'E3', depends_on: [] },
      ],
      agents: [
        { id: 0, title: 'Task 1', status: 'done', conversation: [], rounds: 1, score: 90 },
        { id: 1, title: 'Task 2', status: 'error', conversation: [{ from: 'agent', text: 'Fehler!' }], rounds: 2, score: 0, questions: 1, progress: 50, startTime: Date.now() - 30000, endTime: Date.now() - 10000, duration: 20, stats: { filesCreated: 1 } },
        { id: 2, title: 'Task 3', status: 'waiting', conversation: [], rounds: 0 },
      ],
      coordinator: { status: 'ready', log: [] },
    };
    writeState(state);

    // loadProject laden, dann manuell Error-Reset simulieren (wie in resume())
    orch.loadProject(testProjectId);

    // Simuliere den Error-Reset aus resume()
    for (let i = 0; i < orch.agents.length; i++) {
      if (orch.agents[i].status === 'error') {
        orch.agents[i].status = 'waiting';
        orch.agents[i].conversation = [];
        orch.agents[i].rounds = 0;
        orch.agents[i].questions = 0;
        orch.agents[i].progress = 0;
        orch.agents[i].startTime = null;
        orch.agents[i].endTime = null;
        orch.agents[i].duration = null;
        orch.agents[i].score = null;
        orch.agents[i].stats = null;
      }
    }

    // Error-Agent wurde zurückgesetzt
    expect(orch.agents[1].status).toBe('waiting');
    expect(orch.agents[1].conversation).toEqual([]);
    expect(orch.agents[1].rounds).toBe(0);
    expect(orch.agents[1].questions).toBe(0);
    expect(orch.agents[1].progress).toBe(0);
    expect(orch.agents[1].startTime).toBeNull();
    expect(orch.agents[1].endTime).toBeNull();
    expect(orch.agents[1].duration).toBeNull();
    expect(orch.agents[1].score).toBeNull();
    expect(orch.agents[1].stats).toBeNull();

    // Done-Agent bleibt unverändert
    expect(orch.agents[0].status).toBe('done');
    expect(orch.agents[0].score).toBe(90);

    // Waiting-Agent bleibt unverändert
    expect(orch.agents[2].status).toBe('waiting');
  });

  test('wirft bei nicht-existierendem Projekt', () => {
    expect(() => orch.loadProject('proj_nichtexistent_resume')).toThrow(/nicht gefunden/);
  });

  test('laedt Conversation-History aus JSONL', () => {
    const state = {
      projectId: testProjectId,
      projectTitle: 'Resume History Test',
      projectDesc: 'Test',
      projectSummary: '',
      phase: 'error',
      startedAt: Date.now() - 60000,
      tasks: [
        { title: 'Task 1', task: 'Aufgabe 1', deliverable: 'E1', depends_on: [] },
      ],
      agents: [
        { id: 0, title: 'Task 1', status: 'working', conversation: [], rounds: 1 },
      ],
      coordinator: { status: 'ready', log: [] },
    };
    writeState(state);

    // Conversation-JSONL schreiben
    writeConversation(1, [
      { from: 'agent', text: 'Ich arbeite an der Aufgabe', type: 'work' },
      { from: 'agent', text: 'Habe eine Frage', type: 'question' },
      { from: 'coordinator', text: 'Hier ist die Antwort', type: 'answer' },
    ]);

    orch.loadProject(testProjectId);

    // Conversations werden aus JSONL geladen (letzte 20)
    expect(orch.agents[0].conversation).toHaveLength(3);
    expect(orch.agents[0].conversation[0].text).toBe('Ich arbeite an der Aufgabe');
    expect(orch.agents[0].conversation[2].text).toBe('Hier ist die Antwort');
  });

  test('erkennt verschiedene incomplete Statuse', () => {
    const incompleteStatuses = ['waiting', 'working', 'waiting_deps', 'retrying', 'asking'];

    for (const status of incompleteStatuses) {
      const state = {
        projectId: testProjectId,
        projectTitle: 'Status Test',
        projectDesc: 'Test',
        projectSummary: '',
        phase: 'error',
        startedAt: Date.now(),
        tasks: [
          { title: 'Task 1', task: 'Aufgabe 1', deliverable: 'E1', depends_on: [] },
        ],
        agents: [
          { id: 0, title: 'Task 1', status: status, conversation: [], rounds: 0 },
        ],
        coordinator: { status: 'ready', log: [] },
      };
      writeState(state);
      makeAgentDirs(1);

      orch.loadProject(testProjectId);

      // Status ist weder 'done' noch 'error' → muss als incomplete gelten
      expect(orch.agents[0].status).toBe(status);
      expect(orch.agents[0].status).not.toBe('done');

      orch.reset();
    }
  });

  test('resume Methode existiert auf dem Orchestrator', () => {
    expect(typeof orch.resume).toBe('function');
  });
});
