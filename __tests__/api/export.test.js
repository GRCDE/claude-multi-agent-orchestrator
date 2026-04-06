// Export API - Tests
// Testet GET /api/export/:id, /api/export-json/:id, /api/export-markdown/:id

'use strict';
const http = require('http');
const path = require('path');
const fs = require('fs');

const TEST_PORT = 3213;

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

// Test-Projekt erstellen
const testProjectId = 'proj_export_test_' + Date.now();
const projectsDir = path.join(__dirname, '../../projects');
const testDir = path.join(projectsDir, testProjectId);

describe('Export API Endpoints', () => {
  beforeAll(done => {
    // Test-Projektverzeichnis und Dateien erstellen
    fs.mkdirSync(path.join(testDir, 'agent-1'), { recursive: true });
    fs.mkdirSync(path.join(testDir, 'agent-2'), { recursive: true });

    // State-Datei schreiben
    const state = {
      projectId: testProjectId,
      projectTitle: 'Export Test Projekt',
      projectDesc: 'Testbeschreibung',
      projectSummary: 'Zusammenfassung des Export-Tests',
      phase: 'complete',
      startedAt: Date.now() - 120000,
      completedAt: Date.now(),
      totalDuration: 120,
      tasks: [
        { title: 'Task 1', task: 'Aufgabe 1', deliverable: 'Ergebnis 1', depends_on: [] },
        { title: 'Task 2', task: 'Aufgabe 2', deliverable: 'Ergebnis 2', depends_on: [0] },
      ],
      agents: [
        { id: 0, title: 'Task 1', task: 'Aufgabe 1', role: 'Backend', status: 'done', conversation: [], rounds: 1, duration: 60 },
        { id: 1, title: 'Task 2', task: 'Aufgabe 2', role: 'Frontend', status: 'done', conversation: [], rounds: 2, duration: 50 },
      ],
      coordinator: { status: 'done', summary: 'Alles fertig', log: [] },
    };
    fs.writeFileSync(path.join(testDir, 'state.json'), JSON.stringify(state));

    // Agent-Dateien erstellen
    fs.writeFileSync(path.join(testDir, 'agent-1', 'task.md'), '# Task 1\nAufgabe 1');
    fs.writeFileSync(path.join(testDir, 'agent-1', 'output.js'), 'console.log("Agent 1");');
    fs.writeFileSync(path.join(testDir, 'agent-1', 'conversation.jsonl'),
      JSON.stringify({ from: 'agent', text: 'Arbeite an Task 1', type: 'work', ts: Date.now() }) + '\n' +
      JSON.stringify({ from: 'agent', text: 'FERTIG', type: 'work', ts: Date.now() }) + '\n'
    );
    fs.writeFileSync(path.join(testDir, 'agent-2', 'task.md'), '# Task 2\nAufgabe 2');
    fs.writeFileSync(path.join(testDir, 'agent-2', 'result.html'), '<h1>Agent 2</h1>');

    // Server starten
    process.env.PORT = TEST_PORT;
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
    test('gibt JSON-Export fuer gueltiges Projekt', async () => {
      const res = await request('GET', `/api/export-json/${testProjectId}`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.headers['content-disposition']).toMatch(/attachment/);
      expect(res.headers['content-disposition']).toContain(testProjectId + '.json');

      // Body ist ein Objekt mit Projektdaten
      expect(res.body).toHaveProperty('projectTitle', 'Export Test Projekt');
      expect(res.body).toHaveProperty('projectSummary');
      expect(res.body).toHaveProperty('agents');
      expect(res.body.agents).toHaveLength(2);
    });

    test('enthaelt Agent-Details im JSON-Export', async () => {
      const res = await request('GET', `/api/export-json/${testProjectId}`);
      expect(res.status).toBe(200);

      const agent1 = res.body.agents[0];
      expect(agent1.title).toBe('Task 1');
      expect(agent1.role).toBe('Backend');
      expect(agent1.status).toBe('done');
      expect(agent1.duration).toBe(60);
      // Dateien werden aufgelistet (ohne conversation.jsonl)
      expect(agent1.files).toContain('task.md');
      expect(agent1.files).toContain('output.js');
      expect(agent1.files).not.toContain('conversation.jsonl');
    });

    test('enthaelt Conversation im JSON-Export', async () => {
      const res = await request('GET', `/api/export-json/${testProjectId}`);
      expect(res.status).toBe(200);

      const agent1 = res.body.agents[0];
      expect(agent1.conversation).toBeInstanceOf(Array);
      expect(agent1.conversation.length).toBeGreaterThanOrEqual(1);
      expect(agent1.conversation[0]).toHaveProperty('text');
    });

    test('gibt 404 fuer nicht-existierendes Projekt', async () => {
      const res = await request('GET', '/api/export-json/proj_nichtexistent_9999');
      expect(res.status).toBe(404);
      expect(res.body).toHaveProperty('error');
    });
  });

  // ── GET /api/export-markdown/:id ───────────────────────────

  describe('GET /api/export-markdown/:id', () => {
    test('gibt Markdown-Export fuer gueltiges Projekt', async () => {
      const res = await request('GET', `/api/export-markdown/${testProjectId}`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/markdown/);
      expect(res.headers['content-disposition']).toMatch(/attachment/);
      expect(res.headers['content-disposition']).toContain('.md');

      // Body ist ein Markdown-String
      expect(typeof res.body).toBe('string');
      expect(res.body).toContain('Export Test Projekt');
    });

    test('Markdown enthaelt Agent-Abschnitte', async () => {
      const res = await request('GET', `/api/export-markdown/${testProjectId}`);
      expect(res.body).toContain('Agent 1');
      expect(res.body).toContain('Agent 2');
      expect(res.body).toContain('Task 1');
      expect(res.body).toContain('Task 2');
    });

    test('Markdown enthaelt Status und Rollen', async () => {
      const res = await request('GET', `/api/export-markdown/${testProjectId}`);
      expect(res.body).toContain('Backend');
      expect(res.body).toContain('Frontend');
      // Status-Labels (deutsch)
      expect(res.body).toContain('Fertig');
    });

    test('Markdown enthaelt Dateien-Abschnitt', async () => {
      const res = await request('GET', `/api/export-markdown/${testProjectId}`);
      // Dateien der Agenten sollten aufgelistet sein
      expect(res.body).toContain('output.js');
      expect(res.body).toContain('result.html');
    });

    test('gibt 404 fuer nicht-existierendes Projekt', async () => {
      const res = await request('GET', '/api/export-markdown/proj_nichtexistent_md');
      expect(res.status).toBe(404);
      expect(res.body).toHaveProperty('error');
    });
  });

  // ── GET /api/export/:id (ZIP) ──────────────────────────────

  describe('GET /api/export/:id (ZIP)', () => {
    test('gibt ZIP fuer gueltiges Projekt', async () => {
      const res = await request('GET', `/api/export/${testProjectId}`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('application/zip');
      expect(res.headers['content-disposition']).toContain(testProjectId + '.zip');

      // ZIP-Datei beginnt mit PK-Signatur (Bytes 50 4B)
      expect(res.raw[0]).toBe(0x50); // P
      expect(res.raw[1]).toBe(0x4B); // K
    });

    test('gibt 404 oder 429 fuer nicht-existierendes Projekt', async () => {
      const res = await request('GET', '/api/export/proj_nichtexistent_zip');
      // 404 (nicht gefunden) oder 429 (Rate-Limit durch exportLimiter)
      expect([404, 429]).toContain(res.status);
      expect(res.body).toHaveProperty('error');
    });

    test('blockiert Pfad-Traversal mit ..', async () => {
      const res = await request('GET', '/api/export/..%2F..%2Fetc');
      expect([400, 404, 429]).toContain(res.status);
    });

    test('blockiert Pfad-Traversal mit ../', async () => {
      const res = await request('GET', '/api/export/../../../etc/passwd');
      expect(res.status).not.toBe(200);
    });
  });
});
