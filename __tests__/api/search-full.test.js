'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');

const TEST_PORT = 3230;

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

describe('Search Full API', () => {
  const projectsDir = path.join(__dirname, '..', '..', 'projects');
  const testProjId = 'proj_9999998001';
  const testProjDir = path.join(projectsDir, testProjId);
  const agentDir = path.join(testProjDir, 'agent-1');

  beforeAll(done => {
    // Test-Projekt anlegen
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(testProjDir, 'state.json'), JSON.stringify({
      projectTitle: 'Fulltext Suchtest Projekt',
      projectSummary: 'Ein Testprojekt fuer erweiterte Suchfunktion',
      agents: [
        { title: 'Backend Agent', task: 'Erstelle eine REST API' }
      ]
    }));
    fs.writeFileSync(path.join(agentDir, 'conversation.jsonl'),
      JSON.stringify({ role: 'assistant', content: 'Die REST API wurde erfolgreich implementiert. FERTIG' }) + '\n' +
      JSON.stringify({ role: 'user', content: 'Erstelle bitte eine REST API mit Express' }) + '\n'
    );

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

  test('GET /api/search/full mit Query gibt Ergebnis-Struktur zurück', async () => {
    const res = await request('GET', '/api/search/full?q=test');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('results');
    expect(res.body).toHaveProperty('total');
    expect(res.body).toHaveProperty('query');
    expect(Array.isArray(res.body.results)).toBe(true);
  });

  test('GET /api/search/full ohne Query gibt leeres Ergebnis', async () => {
    const res = await request('GET', '/api/search/full?q=');
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([]);
    expect(res.body.total).toBe(0);
  });

  test('GET /api/search/full mit ungültigem type gibt 400', async () => {
    const res = await request('GET', '/api/search/full?q=test&type=invalid');
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });

  test('GET /api/search/stats gibt Statistiken zurück', async () => {
    const res = await request('GET', '/api/search/stats');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('indexedProjects');
    expect(res.body).toHaveProperty('totalEntries');
    expect(res.body).toHaveProperty('lastIndexed');
    expect(typeof res.body.indexedProjects).toBe('number');
  });

  test('POST /api/search/reindex baut Index neu auf', async () => {
    const res = await request('POST', '/api/search/reindex', {});
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('success', true);
    expect(res.body).toHaveProperty('indexed');
    expect(typeof res.body.indexed).toBe('number');
    expect(res.body).toHaveProperty('stats');
  });

  test('GET /api/search/full findet nach Reindex indexierte Projekte', async () => {
    // Erst reindexieren
    await request('POST', '/api/search/reindex', {});

    // Dann suchen
    const res = await request('GET', '/api/search/full?q=rest');
    expect(res.status).toBe(200);
    expect(res.body.results.length).toBeGreaterThan(0);
    // Mindestens ein Ergebnis sollte unser Testprojekt sein
    const match = res.body.results.find(r => r.projectId === testProjId);
    expect(match).toBeDefined();
  });

  test('GET /api/search/suggest gibt Array zurück', async () => {
    // Erst reindexieren damit Daten vorhanden
    await request('POST', '/api/search/reindex', {});

    const res = await request('GET', '/api/search/suggest?q=res');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('GET /api/search/suggest ohne Query gibt leeres Array', async () => {
    const res = await request('GET', '/api/search/suggest?q=');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test('GET /api/search/logs gibt Ergebnis-Struktur zurück', async () => {
    const res = await request('GET', '/api/search/logs?q=server');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('results');
    expect(res.body).toHaveProperty('total');
    expect(res.body).toHaveProperty('query');
  });
});
