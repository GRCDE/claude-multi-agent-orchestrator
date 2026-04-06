// Merge API - Tests
// Testet POST /api/merge/:id und GET /api/merged/:id

'use strict';
const http = require('http');
const path = require('path');
const fs = require('fs');

const TEST_PORT = 3223;

function request(method, urlPath, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: TEST_PORT,
      path: urlPath,
      method,
      headers: { 'Content-Type': 'application/json' }
    };
    const req = http.request(options, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
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

describe('Merge API', () => {
  const projectsDir = path.join(__dirname, '..', '..', 'projects');
  const testProjId = 'proj_9999990003';
  const testProjDir = path.join(projectsDir, testProjId);
  const mergedDir = path.join(testProjDir, 'merged');

  beforeAll(done => {
    // Test-Projekt mit merged-Verzeichnis anlegen
    fs.mkdirSync(mergedDir, { recursive: true });
    fs.writeFileSync(path.join(testProjDir, 'state.json'), JSON.stringify({
      projectTitle: 'Merge Testprojekt',
      agents: [{ title: 'Agent 1', task: 'Test' }]
    }));
    fs.writeFileSync(path.join(mergedDir, 'app.js'), '// merged app.js');
    fs.writeFileSync(path.join(mergedDir, 'utils.js'), '// merged utils.js');

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
      fs.rmSync(testProjDir, { recursive: true, force: true });
    } catch { /* ignorieren */ }
  });

  test('GET /api/merged/:id gibt Dateiliste zurueck', async () => {
    const res = await request('GET', `/api/merged/${testProjId}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('files');
    expect(Array.isArray(res.body.files)).toBe(true);
    expect(res.body.files.length).toBeGreaterThan(0);
  });

  test('GET /api/merged/:id Dateien haben korrekte Struktur', async () => {
    const res = await request('GET', `/api/merged/${testProjId}`);
    expect(res.status).toBe(200);
    const file = res.body.files[0];
    expect(file).toHaveProperty('name');
    expect(file).toHaveProperty('size');
    expect(file).toHaveProperty('modified');
  });

  test('GET /api/merged/:id gibt 404 bei fehlendem merged-Verzeichnis', async () => {
    const res = await request('GET', '/api/merged/proj_0000000000');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/nicht gefunden/);
  });

  test('POST /api/merge/:id mit ungueltiger Strategie gibt 400', async () => {
    const res = await request('POST', `/api/merge/${testProjId}`, {
      strategy: 'ungueltig'
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Ung.ltige Strategie/);
  });

  test('POST /api/merge/:id mit ungueltiger Projekt-ID gibt 400', async () => {
    const res = await request('POST', '/api/merge/invalid-id', {
      strategy: 'latest'
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Ung.ltige Projekt-ID/);
  });

  test('POST /api/merge/:id mit falschem Projekt gibt 400 (nicht aktuelles Projekt)', async () => {
    const res = await request('POST', `/api/merge/${testProjId}`, {
      strategy: 'latest'
    });
    expect(res.status).toBe(400);
    // Orchestrator hat kein aktives Projekt → Fehler
    expect(res.body).toHaveProperty('error');
  });

  test('POST /api/merge/:id akzeptiert gueltige Strategien', async () => {
    // Alle gueltigen Strategien testen - sollten 400 geben wegen fehlendem aktiven Projekt
    // aber NICHT wegen ungueltiger Strategie
    for (const strategy of ['latest', 'largest', 'manual']) {
      const res = await request('POST', `/api/merge/${testProjId}`, { strategy });
      // Darf nicht "Ungueltige Strategie" sein
      if (res.status === 400 && res.body.error) {
        expect(res.body.error).not.toMatch(/Ung.ltige Strategie/);
      }
    }
  });

  test('GET /api/merged/:id enthaelt optionale Felder', async () => {
    const res = await request('GET', `/api/merged/${testProjId}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('dir');
    // mergeReport und conflictsInfo koennen null sein
    expect(res.body).toHaveProperty('mergeReport');
    expect(res.body).toHaveProperty('conflictsInfo');
  });
});
