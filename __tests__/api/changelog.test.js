// Changelog API - Tests
// Testet GET /api/projects/:id/changelog

'use strict';
const http = require('http');
const path = require('path');
const fs = require('fs');

const TEST_PORT = 3222;

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

describe('Changelog API', () => {
  const projectsDir = path.join(__dirname, '..', '..', 'projects');
  const testProjId = 'proj_9999990002';
  const testProjDir = path.join(projectsDir, testProjId);
  const agentDir = path.join(testProjDir, 'agent-1');

  beforeAll(done => {
    // Test-Projekt anlegen
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(testProjDir, 'state.json'), JSON.stringify({
      projectTitle: 'Changelog Testprojekt',
      startedAt: Date.now() - 60000,
      agents: [
        { title: 'Backend Agent', task: 'API erstellen', startedAt: Date.now() - 50000 }
      ]
    }));
    fs.writeFileSync(path.join(agentDir, 'conversation.jsonl'),
      JSON.stringify({ role: 'assistant', content: 'Ich erstelle die API-Routen. erstellt: server.js' }) + '\n' +
      JSON.stringify({ role: 'assistant', content: 'FERTIG - Alle Routen sind implementiert.' }) + '\n'
    );
    fs.writeFileSync(path.join(agentDir, 'server.js'), '// Platzhalter');

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

  test('GET /api/projects/:id/changelog gibt Timeline zurueck', async () => {
    const res = await request('GET', `/api/projects/${testProjId}/changelog`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
  });

  test('Changelog-Eintraege haben korrekte Struktur', async () => {
    const res = await request('GET', `/api/projects/${testProjId}/changelog`);
    expect(res.status).toBe(200);
    if (res.body.length > 0) {
      const entry = res.body[0];
      expect(entry).toHaveProperty('timestamp');
      expect(entry).toHaveProperty('agentIndex');
      expect(entry).toHaveProperty('agentTitle');
      expect(entry).toHaveProperty('action');
      expect(entry).toHaveProperty('summary');
    }
  });

  test('Changelog erkennt FERTIG-Aktion', async () => {
    const res = await request('GET', `/api/projects/${testProjId}/changelog`);
    expect(res.status).toBe(200);
    const fertigEntry = res.body.find(e => e.action === 'abgeschlossen');
    expect(fertigEntry).toBeDefined();
  });

  test('GET /api/projects/proj_0000000000/changelog gibt 404 bei unbekanntem Projekt', async () => {
    const res = await request('GET', '/api/projects/proj_0000000000/changelog');
    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty('error');
  });

  test('GET /api/projects/invalid/changelog gibt 400 bei ungueltiger ID', async () => {
    const res = await request('GET', '/api/projects/invalid/changelog');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Ung.ltige Projekt-ID/);
  });
});
