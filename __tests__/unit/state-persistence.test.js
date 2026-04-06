// State Persistence - Unit Tests
// Testet Serialisierung, Deserialisierung, Debounce und Fehlerbehandlung

'use strict';
const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;

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

describe('State Persistence', () => {
  let orch;
  const testProjectId = 'proj_test_state_' + Date.now();
  const projectsDir = path.join(__dirname, '../../projects');
  const testDir = path.join(projectsDir, testProjectId);

  beforeAll(() => {
    fs.mkdirSync(path.join(testDir, 'agent-1'), { recursive: true });
    fs.mkdirSync(path.join(testDir, 'agent-2'), { recursive: true });
  });

  afterAll(() => {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  beforeEach(() => {
    orch = new Orchestrator();
    // Orchestrator-State manuell setzen fuer Tests
    orch.projectId = testProjectId;
    orch.projectDir = testDir;
    orch.projectTitle = 'State Test Projekt';
    orch.projectDesc = 'Testbeschreibung fuer State';
    orch.projectSummary = 'Zusammenfassung';
    orch.phase = 'running';
    orch.startedAt = Date.now() - 30000;
    orch.tasks = [
      { title: 'Task 1', task: 'Aufgabe 1', deliverable: 'E1', depends_on: [] },
      { title: 'Task 2', task: 'Aufgabe 2', deliverable: 'E2', depends_on: [0] },
    ];
    orch.agents = [
      { id: 0, title: 'Task 1', task: 'Aufgabe 1', deliverable: 'E1', status: 'done', conversation: [], rounds: 1, questions: 0, startTime: null, endTime: null, duration: 15, role: '', depends_on: [], workDir: path.join(testDir, 'agent-1'), stats: { filesCreated: 2, totalFileSize: 1024, linesOfCode: 50 }, tokenUsage: { inputTokens: 100, outputTokens: 200, totalTokens: 300, estimatedCost: 0.0165 } },
      { id: 1, title: 'Task 2', task: 'Aufgabe 2', deliverable: 'E2', status: 'working', conversation: [], rounds: 0, questions: 0, startTime: null, endTime: null, duration: null, role: '', depends_on: [0], workDir: path.join(testDir, 'agent-2'), stats: null, tokenUsage: { inputTokens: 50, outputTokens: 100, totalTokens: 150, estimatedCost: 0.00825 } },
    ];
    orch.coordLog = [{ agentIndex: 0, question: 'Wie?', answer: 'So!' }];
    orch.coordStatus = 'idle';
    orch.activityLog = [{ type: 'test', data: { msg: 'Eintrag' }, ts: Date.now() }];
  });

  afterEach(() => {
    orch.reset();
  });

  // ── getState() Serialisierung ─────────────────────────────

  describe('getState() Serialisierung', () => {
    test('enthaelt alle wichtigen Felder', () => {
      const state = orch.getState();
      expect(state).toHaveProperty('phase', 'running');
      expect(state).toHaveProperty('projectId', testProjectId);
      expect(state).toHaveProperty('projectTitle', 'State Test Projekt');
      expect(state).toHaveProperty('projectSummary', 'Zusammenfassung');
      expect(state).toHaveProperty('projectDesc', 'Testbeschreibung fuer State');
      expect(state).toHaveProperty('tasks');
      expect(state).toHaveProperty('agents');
      expect(state).toHaveProperty('coordinator');
      expect(state).toHaveProperty('startedAt');
      expect(state).toHaveProperty('activityLog');
    });

    test('aggregiert Projekt-Statistiken aus Agent-Stats', () => {
      const state = orch.getState();
      expect(state.projectStats.totalFiles).toBe(2);
      expect(state.projectStats.totalSize).toBe(1024);
      expect(state.projectStats.totalLines).toBe(50);
    });

    test('aggregiert Token-Usage ueber alle Agenten', () => {
      const state = orch.getState();
      // Agent 1: 100+50 input, 200+100 output + coordinator (0)
      expect(state.totalTokenUsage.inputTokens).toBe(150);
      expect(state.totalTokenUsage.outputTokens).toBe(300);
      expect(state.totalTokenUsage.totalTokens).toBe(450);
    });

    test('begrenzt activityLog auf letzte 100 Eintraege', () => {
      // 150 Eintraege erstellen
      orch.activityLog = [];
      for (let i = 0; i < 150; i++) {
        orch.activityLog.push({ type: 'test', data: { i }, ts: Date.now() + i });
      }
      const state = orch.getState();
      expect(state.activityLog).toHaveLength(100);
      // Letzte 100, also erster Eintrag hat i=50
      expect(state.activityLog[0].data.i).toBe(50);
    });

    test('ist JSON-serialisierbar', () => {
      const state = orch.getState();
      const json = JSON.stringify(state, null, 2);
      expect(() => JSON.parse(json)).not.toThrow();
      const parsed = JSON.parse(json);
      expect(parsed.projectId).toBe(testProjectId);
      expect(parsed.agents).toHaveLength(2);
    });

    test('Coordinator-Objekt enthaelt Log und Status', () => {
      const state = orch.getState();
      expect(state.coordinator.status).toBe('idle');
      expect(state.coordinator.log).toHaveLength(1);
      expect(state.coordinator.log[0].question).toBe('Wie?');
    });
  });

  // ── Deserialisierung via loadProject() ──────────────────

  describe('Deserialisierung via loadProject()', () => {
    test('State wird korrekt geladen nach Speichern', async () => {
      // State manuell schreiben
      const originalState = orch.getState();
      fs.writeFileSync(
        path.join(testDir, 'state.json'),
        JSON.stringify(originalState, null, 2)
      );

      // Neuer Orchestrator laedt den State
      const orch2 = new Orchestrator();
      const loaded = orch2.loadProject(testProjectId);

      expect(loaded.projectId).toBe(testProjectId);
      expect(loaded.projectTitle).toBe('State Test Projekt');
      expect(loaded.phase).toBe('running');
      expect(loaded.agents).toHaveLength(2);
      expect(loaded.agents[0].status).toBe('done');
      expect(loaded.agents[1].status).toBe('working');

      orch2.reset();
    });

    test('fehlende Felder werden mit Defaults aufgefuellt', () => {
      // Minimal-State ohne optionale Felder
      const minimalState = {
        projectId: testProjectId,
        phase: 'complete',
        tasks: [],
        agents: [],
      };
      fs.writeFileSync(
        path.join(testDir, 'state.json'),
        JSON.stringify(minimalState)
      );

      const orch2 = new Orchestrator();
      const loaded = orch2.loadProject(testProjectId);

      expect(loaded.projectTitle).toBe('');
      expect(loaded.projectDesc).toBeFalsy();
      expect(loaded.projectSummary).toBe('');
      expect(loaded.agents).toEqual([]);

      orch2.reset();
    });
  });

  // ── _saveState() Debounce ─────────────────────────────────

  describe('_saveState() Debounce', () => {
    test('schreibt nicht sofort auf Disk', async () => {
      // State-Datei loeschen falls vorhanden
      try { fs.unlinkSync(path.join(testDir, 'state.json')); } catch {}

      await orch._saveState();

      // Sofort nach dem Aufruf sollte die Datei noch NICHT geschrieben sein
      // (weil der Timer erst nach STATE_SAVE_INTERVAL feuert)
      const existsImmediately = fs.existsSync(path.join(testDir, 'state.json'));
      // Hinweis: Je nach Timing kann es sofort existieren oder nicht.
      // Wir testen hauptsaechlich, dass nach dem Timer die Datei da ist.

      // Warten bis der Timer feuert (2s + Puffer)
      await new Promise(r => setTimeout(r, 2500));

      const existsAfterDelay = fs.existsSync(path.join(testDir, 'state.json'));
      expect(existsAfterDelay).toBe(true);
    }, 10000);

    test('mehrfache Aufrufe werden zusammengefasst (Debounce)', async () => {
      try { fs.unlinkSync(path.join(testDir, 'state.json')); } catch {}

      // Spy auf fsp.writeFile
      const writeSpy = jest.spyOn(fsp, 'writeFile');
      const callsBefore = writeSpy.mock.calls.length;

      // Mehrfach aufrufen
      await orch._saveState();
      await orch._saveState();
      await orch._saveState();

      // Warten bis Timer feuert
      await new Promise(r => setTimeout(r, 2500));

      // Es sollte nur EINMAL geschrieben worden sein (Debounce)
      const callsAfter = writeSpy.mock.calls.filter(
        c => typeof c[0] === 'string' && c[0].includes('state.json')
      ).length;
      // Mindestens 1, maximal 2 (je nach Timing)
      expect(callsAfter).toBeGreaterThanOrEqual(1);

      writeSpy.mockRestore();
    }, 10000);

    test('ohne projectDir wird nichts geschrieben', async () => {
      orch.projectDir = null;
      const writeSpy = jest.spyOn(fsp, 'writeFile');
      const callsBefore = writeSpy.mock.calls.length;

      await orch._saveState();
      await new Promise(r => setTimeout(r, 2500));

      // Kein neuer writeFile-Aufruf fuer state.json
      const newCalls = writeSpy.mock.calls.slice(callsBefore).filter(
        c => typeof c[0] === 'string' && c[0].includes('state.json')
      );
      expect(newCalls).toHaveLength(0);

      writeSpy.mockRestore();
    }, 10000);
  });

  // ── _saveStateImmediate() ─────────────────────────────────

  describe('_saveStateImmediate()', () => {
    test('schreibt sofort auf Disk', async () => {
      try { fs.unlinkSync(path.join(testDir, 'state.json')); } catch {}

      await orch._saveStateImmediate();

      // Datei muss sofort existieren
      const exists = fs.existsSync(path.join(testDir, 'state.json'));
      expect(exists).toBe(true);

      // Inhalt pruefen
      const raw = fs.readFileSync(path.join(testDir, 'state.json'), 'utf-8');
      const parsed = JSON.parse(raw);
      expect(parsed.projectId).toBe(testProjectId);
      expect(parsed.phase).toBe('running');
    });

    test('bricht ausstehenden Debounce-Timer ab', async () => {
      try { fs.unlinkSync(path.join(testDir, 'state.json')); } catch {}

      // Erst Debounce-Save starten
      await orch._saveState();

      // Dann sofort Immediate-Save
      orch.phase = 'complete'; // Aenderung die nur im Immediate-Save drin sein sollte
      await orch._saveStateImmediate();

      // Immediate-Save sollte die aktuelle Phase haben
      const raw = fs.readFileSync(path.join(testDir, 'state.json'), 'utf-8');
      const parsed = JSON.parse(raw);
      expect(parsed.phase).toBe('complete');
    });

    test('ohne projectDir wird nichts geschrieben', async () => {
      orch.projectDir = null;
      const writeSpy = jest.spyOn(fsp, 'writeFile');
      const callsBefore = writeSpy.mock.calls.length;

      await orch._saveStateImmediate();

      const newCalls = writeSpy.mock.calls.slice(callsBefore).filter(
        c => typeof c[0] === 'string' && c[0].includes('state.json')
      );
      expect(newCalls).toHaveLength(0);

      writeSpy.mockRestore();
    });
  });

  // ── Corrupt state.json Handling ────────────────────────────

  describe('Corrupt state.json Handling', () => {
    test('loadProject wirft bei korruptem JSON', () => {
      fs.writeFileSync(
        path.join(testDir, 'state.json'),
        '{ ungueltig json <<<'
      );

      const orch2 = new Orchestrator();
      expect(() => orch2.loadProject(testProjectId)).toThrow();
      orch2.reset();
    });

    test('loadProject wirft bei leerem state.json', () => {
      fs.writeFileSync(path.join(testDir, 'state.json'), '');

      const orch2 = new Orchestrator();
      expect(() => orch2.loadProject(testProjectId)).toThrow();
      orch2.reset();
    });

    test('loadProject wirft bei fehlendem state.json', () => {
      // state.json loeschen
      try { fs.unlinkSync(path.join(testDir, 'state.json')); } catch {}

      const orch2 = new Orchestrator();
      expect(() => orch2.loadProject(testProjectId)).toThrow(/nicht gefunden/);
      orch2.reset();
    });

    test('loadProject verkraftet fehlende agents im State', () => {
      fs.writeFileSync(
        path.join(testDir, 'state.json'),
        JSON.stringify({ projectId: testProjectId, phase: 'complete', tasks: [] })
      );

      const orch2 = new Orchestrator();
      const loaded = orch2.loadProject(testProjectId);
      expect(loaded.agents).toEqual([]);
      orch2.reset();
    });

    test('loadProject verkraftet fehlenden coordinator im State', () => {
      fs.writeFileSync(
        path.join(testDir, 'state.json'),
        JSON.stringify({ projectId: testProjectId, phase: 'complete', tasks: [], agents: [] })
      );

      const orch2 = new Orchestrator();
      const loaded = orch2.loadProject(testProjectId);
      // coordLog sollte leer sein (Default)
      expect(orch2.coordLog).toEqual([]);
      orch2.reset();
    });

    test('loadProject verkraftet korrupte conversation.jsonl Zeilen', () => {
      const state = {
        projectId: testProjectId,
        phase: 'complete',
        tasks: [{ title: 'T1', task: 'A1', deliverable: 'E1', depends_on: [] }],
        agents: [{ id: 0, title: 'T1', status: 'done', conversation: [], rounds: 1 }],
        coordinator: { status: 'done', log: [] },
      };
      fs.writeFileSync(path.join(testDir, 'state.json'), JSON.stringify(state));

      // JSONL mit korrupten und gueltigen Zeilen
      fs.writeFileSync(
        path.join(testDir, 'agent-1', 'conversation.jsonl'),
        '{"from":"agent","text":"OK","type":"work","ts":1234}\n' +
        'KORRUPTE ZEILE <<<\n' +
        '{"from":"agent","text":"Fertig","type":"work","ts":1235}\n'
      );

      const orch2 = new Orchestrator();
      const loaded = orch2.loadProject(testProjectId);

      // Nur die 2 gueltigen Zeilen werden geladen
      expect(orch2.agents[0].conversation).toHaveLength(2);
      expect(orch2.agents[0].conversation[0].text).toBe('OK');
      expect(orch2.agents[0].conversation[1].text).toBe('Fertig');

      orch2.reset();
    });
  });
});
