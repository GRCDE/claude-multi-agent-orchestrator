'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');

const TEST_PORT = 3248;

function request(method, urlPath, body = null) {
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json' };
    const options = {
      hostname: 'localhost',
      port: TEST_PORT,
      path: urlPath,
      method,
      headers,
    };
    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', (d) => { chunks.push(d); });
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        try { resolve({ status: res.statusCode, body: JSON.parse(raw.toString()), raw }); }
        catch { resolve({ status: res.statusCode, body: raw.toString(), raw }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// Mock child_process bevor server geladen wird
jest.mock('child_process', () => ({
  spawn: jest.fn(),
  execSync: jest.fn(() => 'claude 1.0.0'),
}));

jest.mock('express-rate-limit', () => {
  return () => (req, res, next) => next();
});

describe('Batch Operations & Search Suggest', () => {
  beforeAll((done) => {
    process.env.PORT = TEST_PORT;
    delete process.env.API_TOKEN;

    // Cache leeren
    Object.keys(require.cache).forEach((key) => {
      if (key.includes('orchestrator') || key.includes('server.js') || key.includes('src')) {
        delete require.cache[key];
      }
    });

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
  });

  // ── Batch Delete Tests ──────────────────────────────────────

  test('Batch delete mit leerer IDs-Liste gibt 400', async () => {
    const res = await request('POST', '/api/batch', {
      operations: [],
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
    expect(res.body.error).toContain('Validierung');
  });

  test('Batch delete mit IDs loescht korrekt', async () => {
    // Testprojekte erstellen
    const projectsDir = path.join(__dirname, '..', '..', 'projects');
    const testIds = ['proj_batch_del_1', 'proj_batch_del_2'];

    for (const id of testIds) {
      const dir = path.join(projectsDir, id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
        id,
        title: 'Test ' + id,
        phase: 'complete',
        agents: [],
      }));
    }

    // Batch-Delete ueber den generischen Batch-Endpoint
    const res = await request('POST', '/api/batch', {
      operations: testIds.map((id, i) => ({
        id: String(i),
        method: 'DELETE',
        path: `/api/projects/${id}`,
        body: null,
      })),
    });

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(2);
    for (const r of res.body.results) {
      expect(r.status).toBe(200);
    }

    // Pruefen dass Verzeichnisse geloescht sind
    for (const id of testIds) {
      expect(fs.existsSync(path.join(projectsDir, id))).toBe(false);
    }
  });

  // ── Batch Export Test ───────────────────────────────────────

  test('Batch export mit IDs gibt Ergebnisse', async () => {
    // Testprojekt erstellen fuer Export
    const projectsDir = path.join(__dirname, '..', '..', 'projects');
    const testId = 'proj_batch_exp_1';
    const dir = path.join(projectsDir, testId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
      id: testId,
      title: 'Export Test',
      phase: 'complete',
      agents: [],
    }));

    // Export-JSON ueber Batch-Endpoint
    const res = await request('POST', '/api/batch', {
      operations: [
        { id: '1', method: 'GET', path: `/api/export-json/${testId}`, body: null },
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0].status).toBe(200);
    expect(res.body.results[0].body).toHaveProperty('projectTitle');

    // Aufraumen
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ── Search Suggest Tests ────────────────────────────────────

  test('Search suggest gibt Vorschlaege', async () => {
    const res = await request('GET', '/api/search/suggest?q=test');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    // Kann leer sein wenn kein Index, aber Format muss stimmen
    for (const item of res.body) {
      expect(item).toHaveProperty('term');
      expect(item).toHaveProperty('frequency');
    }
  });

  test('Search suggest mit leerem Query gibt leeres Array', async () => {
    const res = await request('GET', '/api/search/suggest?q=');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(0);
  });

  test('Search suggest ohne Query-Parameter gibt leeres Array', async () => {
    const res = await request('GET', '/api/search/suggest');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(0);
  });
});
