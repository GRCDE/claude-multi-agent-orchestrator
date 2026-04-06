// Export Formats API - Tests
// Testet GET /api/export-json/:id, /api/export-markdown/:id, /api/merged/:id, /api/token-usage

'use strict';
const http = require('http');
const path = require('path');
const fs = require('fs');

const TEST_PORT = 3236;

function request(method, urlPath) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: TEST_PORT,
      path: urlPath,
      method,
      headers: { 'Content-Type': 'application/json' }
    };
    const req = http.request(options, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        let body;
        try { body = JSON.parse(raw.toString('utf8')); }
        catch { body = raw.toString('utf8'); }
        resolve({ status: res.statusCode, body, headers: res.headers, raw });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

jest.mock('child_process', () => ({
  spawn: jest.fn(),
  execSync: jest.fn(() => 'claude 1.0.0'),
}));

jest.mock('express-rate-limit', () => {
  return () => (req, res, next) => next();
});

const testProjectId = 'test-export-proj';
const projectsDir = path.join(__dirname, '../../projects');
const testDir = path.join(projectsDir, testProjectId);

describe('Export Formats API', () => {
  beforeAll(done => {
    // Testprojekt-Verzeichnisse erstellen (1-basiert: agent-1, agent-2)
    fs.mkdirSync(path.join(testDir, 'agent-1'), { recursive: true });
    fs.mkdirSync(path.join(testDir, 'agent-2'), { recursive: true });
    fs.mkdirSync(path.join(testDir, 'merged'), { recursive: true });

    // State-Datei
    const state = {
      projectId: testProjectId,
      projectTitle: 'Export Formats Test',
      projectDesc: 'Testbeschreibung fuer Export',
      projectSummary: 'Zusammenfassung des Tests',
      phase: 'complete',
      startedAt: Date.now() - 60000,
      completedAt: Date.now(),
      totalDuration: 60,
      tasks: [
        { title: 'Backend Task', task: 'API erstellen', deliverable: 'API Code', depends_on: [] },
        { title: 'Frontend Task', task: 'UI bauen', deliverable: 'UI Code', depends_on: [0] },
      ],
      agents: [
        { id: 0, title: 'Backend Task', task: 'API erstellen', role: 'Backend', status: 'done', conversation: [], rounds: 2, duration: 30, tokenUsage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500, estimatedCost: 0.01 } },
        { id: 1, title: 'Frontend Task', task: 'UI bauen', role: 'Frontend', status: 'done', conversation: [], rounds: 1, duration: 25, tokenUsage: { inputTokens: 800, outputTokens: 400, totalTokens: 1200, estimatedCost: 0.008 } },
      ],
      coordinator: { status: 'done', summary: 'Alles erledigt', log: [], tokenUsage: { inputTokens: 500, outputTokens: 200, totalTokens: 700, estimatedCost: 0.005 } },
      totalTokenUsage: { inputTokens: 2300, outputTokens: 1100, totalTokens: 3400, estimatedCost: 0.023 },
      budget: { maxTokenBudget: 100000, warnTokenBudget: 80000, inputCostPerMTok: 3, outputCostPerMTok: 15, exceeded: false, warned: false },
    };
    fs.writeFileSync(path.join(testDir, 'state.json'), JSON.stringify(state));

    // Agent-Dateien
    fs.writeFileSync(path.join(testDir, 'agent-1', 'task.md'), '# Backend Task\nAPI erstellen');
    fs.writeFileSync(path.join(testDir, 'agent-1', 'server.js'), 'console.log("server");');
    fs.writeFileSync(path.join(testDir, 'agent-1', 'conversation.jsonl'),
      JSON.stringify({ from: 'agent', text: 'Arbeite an der API', type: 'work', ts: Date.now() }) + '\n'
    );
    fs.writeFileSync(path.join(testDir, 'agent-2', 'task.md'), '# Frontend Task\nUI bauen');
    fs.writeFileSync(path.join(testDir, 'agent-2', 'app.jsx'), '<App />');

    // Merged-Dateien
    fs.writeFileSync(path.join(testDir, 'merged', 'server.js'), 'console.log("merged");');
    fs.writeFileSync(path.join(testDir, 'merged', 'app.jsx'), '<App />');
    fs.writeFileSync(path.join(testDir, 'merged', 'MERGE_REPORT.md'), '# Merge Report\n2 Dateien zusammengefuehrt');

    // Server starten
    process.env.PORT = String(TEST_PORT);
    delete require.cache[require.resolve('../../server')];
    delete require.cache[require.resolve('../../orchestrator')];

    try {
      require('../../server');
      setTimeout(done, 500);
    } catch (e) {
      done(e);
    }
  });

  afterAll(async () => {
    const serverMod = require('../../server');
    if (serverMod && serverMod.cleanup) await serverMod.cleanup();
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  // ── GET /api/export-json/:id ───────────────────────────────

  describe('GET /api/export-json/:id', () => {
    test('gibt JSON-Export mit korrekten Headern und Projektdaten', async () => {
      const res = await request('GET', `/api/export-json/${testProjectId}`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.headers['content-disposition']).toMatch(/attachment/);
      expect(res.headers['content-disposition']).toContain(testProjectId + '.json');
      expect(res.body).toHaveProperty('projectTitle', 'Export Formats Test');
      expect(res.body).toHaveProperty('projectSummary', 'Zusammenfassung des Tests');
      expect(res.body).toHaveProperty('agents');
      expect(res.body.agents).toHaveLength(2);
      expect(res.body).toHaveProperty('totalDuration', 60);
    });

    test('gibt 404 fuer nicht-existierendes Projekt', async () => {
      const res = await request('GET', '/api/export-json/proj_nicht_vorhanden');
      expect(res.status).toBe(404);
      expect(res.body).toHaveProperty('error');
    });
  });

  // ── GET /api/export-markdown/:id ───────────────────────────

  describe('GET /api/export-markdown/:id', () => {
    test('gibt Markdown-Export mit Titel, Agenten und Rollen', async () => {
      const res = await request('GET', `/api/export-markdown/${testProjectId}`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/markdown/);
      expect(res.headers['content-disposition']).toMatch(/attachment/);
      expect(typeof res.body).toBe('string');
      expect(res.body).toContain('Export Formats Test');
      expect(res.body).toContain('Backend');
      expect(res.body).toContain('Frontend');
      expect(res.body).toContain('Fertig');
    });

    test('gibt 404 fuer nicht-existierendes Projekt', async () => {
      const res = await request('GET', '/api/export-markdown/proj_nicht_vorhanden_md');
      expect(res.status).toBe(404);
      expect(res.body).toHaveProperty('error');
    });
  });

  // ── GET /api/merged/:id ────────────────────────────────────

  describe('GET /api/merged/:id', () => {
    test('gibt Dateiliste und Merge-Report fuer Projekt mit merged/', async () => {
      const res = await request('GET', `/api/merged/${testProjectId}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('files');
      expect(Array.isArray(res.body.files)).toBe(true);
      const fileNames = res.body.files.map(f => f.name);
      expect(fileNames).toContain('server.js');
      expect(fileNames).toContain('app.jsx');
      // Jede Datei hat name, size, modified
      const file = res.body.files.find(f => f.name === 'server.js');
      expect(file).toHaveProperty('size');
      expect(file).toHaveProperty('modified');
      // Merge-Report vorhanden
      expect(res.body.mergeReport).toContain('Merge Report');
    });

    test('gibt 404 fuer Projekt ohne merged-Verzeichnis', async () => {
      const res = await request('GET', '/api/merged/proj_kein_merged_dir');
      expect(res.status).toBe(404);
      expect(res.body).toHaveProperty('error');
    });
  });

  // ── GET /api/token-usage ───────────────────────────────────

  describe('GET /api/token-usage', () => {
    test('gibt Token-Verbrauch mit total, coordinator, agents und budget', async () => {
      const res = await request('GET', '/api/token-usage');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('total');
      expect(res.body).toHaveProperty('coordinator');
      expect(res.body).toHaveProperty('agents');
      expect(res.body).toHaveProperty('budget');
      expect(Array.isArray(res.body.agents)).toBe(true);
      // Budget-Felder pruefen
      expect(res.body.budget).toHaveProperty('maxTokenBudget');
      expect(res.body.budget).toHaveProperty('warnTokenBudget');
      expect(res.body.budget).toHaveProperty('inputCostPerMTok');
      expect(res.body.budget).toHaveProperty('outputCostPerMTok');
      expect(res.body.budget).toHaveProperty('exceeded');
      expect(res.body.budget).toHaveProperty('warned');
    });

    test('coordinator hat Token-Felder', async () => {
      const res = await request('GET', '/api/token-usage');
      expect(res.status).toBe(200);
      const coord = res.body.coordinator;
      expect(coord).toHaveProperty('inputTokens');
      expect(coord).toHaveProperty('outputTokens');
      expect(coord).toHaveProperty('totalTokens');
      expect(coord).toHaveProperty('estimatedCost');
    });
  });
});
