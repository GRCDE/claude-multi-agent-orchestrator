// File Content & Agent Prompts API - Tests
// Testet GET /api/file-content/:id/:filePath und GET /api/agent-prompts/:id/:agentIndex

'use strict';
const http = require('http');
const path = require('path');
const fs = require('fs');

const TEST_PORT = 3252;

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
        resolve({ status: res.statusCode, body, headers: res.headers });
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

const testProjectId = 'test-file-content';
const projectsDir = path.join(__dirname, '../../projects');
const testDir = path.join(projectsDir, testProjectId);

describe('File Content & Agent Prompts API', () => {
  beforeAll(done => {
    // Projektstruktur erstellen
    fs.mkdirSync(path.join(testDir, 'agent-1'), { recursive: true });
    fs.mkdirSync(path.join(testDir, 'agent-2'), { recursive: true });

    // Textdateien
    fs.writeFileSync(path.join(testDir, 'state.json'), JSON.stringify({ phase: 'complete' }));
    fs.writeFileSync(path.join(testDir, 'agent-1', 'task.md'), '# Aufgabe 1\nDetails hier');
    fs.writeFileSync(path.join(testDir, 'agent-1', 'output.js'), 'const result = 42;\nmodule.exports = result;');

    // Binaerdatei (PNG)
    const pngHeader = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    fs.writeFileSync(path.join(testDir, 'agent-1', 'image.png'), pngHeader);

    // Zu grosse Datei (>1MB)
    const bigBuffer = Buffer.alloc(1024 * 1024 + 100, 'x');
    fs.writeFileSync(path.join(testDir, 'agent-1', 'big.txt'), bigBuffer);

    // Agent-Prompts JSONL
    const promptEntries = [
      { round: 1, prompt: 'Erstelle eine Funktion', response: 'function foo() { return 1; }', ts: '2026-04-06T10:00:00.000Z' },
      { round: 2, prompt: 'Fuege Tests hinzu', response: 'test("foo", () => expect(foo()).toBe(1));', ts: '2026-04-06T10:01:00.000Z' },
    ];
    const jsonlContent = promptEntries.map(e => JSON.stringify(e)).join('\n');
    fs.writeFileSync(path.join(testDir, 'agent-1', 'prompts.jsonl'), jsonlContent);

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

  // ── 1. Datei lesen gibt Inhalt zurueck ──────────────────────

  test('Datei lesen gibt Inhalt zurueck', async () => {
    const res = await request('GET', `/api/file-content/${testProjectId}/agent-1/output.js`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('content');
    expect(res.body.content).toContain('const result = 42');
    expect(res.body).toHaveProperty('size');
    expect(res.body.size).toBeGreaterThan(0);
    expect(res.body).toHaveProperty('path', 'agent-1/output.js');
  });

  // ── 2. Datei nicht gefunden gibt 404 ────────────────────────

  test('Datei nicht gefunden gibt 404', async () => {
    const res = await request('GET', `/api/file-content/${testProjectId}/agent-1/nichtda.txt`);
    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty('error');
  });

  // ── 3. Path-Traversal wird blockiert (400) ─────────────────

  test('Path-Traversal (../) wird blockiert', async () => {
    const res = await request('GET', `/api/file-content/${testProjectId}/..%2F..%2F..%2Fetc%2Fpasswd`);
    expect([400, 404]).toContain(res.status);
    if (res.body && typeof res.body === 'object') {
      expect(res.body).not.toHaveProperty('content');
    }
  });

  // ── 4. Binaerdatei wird erkannt ─────────────────────────────

  test('Binaerdatei wird erkannt', async () => {
    const res = await request('GET', `/api/file-content/${testProjectId}/agent-1/image.png`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('binary', true);
    expect(res.body).toHaveProperty('size');
    expect(res.body).toHaveProperty('path', 'agent-1/image.png');
    expect(res.body).not.toHaveProperty('content');
  });

  // ── 5. Zu grosse Datei (>1MB) wird abgelehnt ───────────────

  test('Zu grosse Datei wird mit 413 abgelehnt', async () => {
    const res = await request('GET', `/api/file-content/${testProjectId}/agent-1/big.txt`);
    expect(res.status).toBe(413);
    expect(res.body).toHaveProperty('error');
    expect(res.body).toHaveProperty('size');
    expect(res.body.size).toBeGreaterThan(1024 * 1024);
  });

  // ── 6. Agent-Prompts gibt JSONL-Eintraege zurueck ──────────

  test('Agent-Prompts gibt JSONL-Eintraege zurueck', async () => {
    const res = await request('GET', `/api/agent-prompts/${testProjectId}/0`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2);

    const first = res.body[0];
    expect(first).toHaveProperty('round', 1);
    expect(first).toHaveProperty('prompt');
    expect(first).toHaveProperty('response');
    expect(first).toHaveProperty('ts');
    expect(first).toHaveProperty('promptTokens');
    expect(first).toHaveProperty('responseTokens');
    expect(typeof first.promptTokens).toBe('number');
    expect(first.promptTokens).toBeGreaterThan(0);
  });

  // ── 7. Agent-Prompts fuer ungueltigen Index gibt 400 ───────

  test('Agent-Prompts fuer ungueltigen Index gibt 400', async () => {
    const res = await request('GET', `/api/agent-prompts/${testProjectId}/abc`);
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });
});
