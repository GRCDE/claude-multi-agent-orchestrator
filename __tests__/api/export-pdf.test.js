// Export-PDF API - Tests
// Testet GET /api/export-pdf/:id (HTML fuer Druck)

'use strict';
const http = require('http');
const path = require('path');
const fs = require('fs');

const TEST_PORT = 3276;

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
const testProjectId = 'proj_export_pdf_test_' + Date.now();
const projectsDir = path.join(__dirname, '../../projects');
const testDir = path.join(projectsDir, testProjectId);

describe('Export-PDF API Endpoints', () => {
  beforeAll(done => {
    // Test-Projektverzeichnis und Dateien erstellen
    fs.mkdirSync(path.join(testDir, 'agent-1'), { recursive: true });
    fs.mkdirSync(path.join(testDir, 'agent-2'), { recursive: true });

    // State-Datei schreiben
    const state = {
      projectId: testProjectId,
      projectTitle: 'PDF Export Test Projekt',
      projectDesc: 'Testbeschreibung fuer PDF',
      projectSummary: 'Zusammenfassung des PDF-Export-Tests',
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

  // ── GET /api/export-pdf/:id ───────────────────────────────

  test('gibt HTML zurueck fuer gueltiges Projekt', async () => {
    const res = await request('GET', `/api/export-pdf/${testProjectId}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(typeof res.body).toBe('string');
    expect(res.body).toContain('<!DOCTYPE html>');
  });

  test('Response enthaelt Projekt-Titel', async () => {
    const res = await request('GET', `/api/export-pdf/${testProjectId}`);
    expect(res.status).toBe(200);
    expect(res.body).toContain('PDF Export Test Projekt');
    // Titel sollte sowohl im <title> als auch im <h1> stehen
    expect(res.body).toContain('<title>PDF Export Test Projekt</title>');
    expect(res.body).toContain('<h1>PDF Export Test Projekt</h1>');
  });

  test('Response enthaelt print-friendly Styles', async () => {
    const res = await request('GET', `/api/export-pdf/${testProjectId}`);
    expect(res.status).toBe(200);
    expect(res.body).toContain('@media print');
    expect(res.body).toContain('@page');
    expect(res.body).toContain('page-break-inside');
  });

  test('gibt 404 fuer nicht-existierendes Projekt', async () => {
    const res = await request('GET', '/api/export-pdf/proj_nichtexistent_pdf');
    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty('error');
  });
});
