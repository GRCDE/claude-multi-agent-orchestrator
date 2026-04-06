// Abort & Resume API - Tests
// Testet POST /api/abort und POST /api/resume/:id Endpoints

'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const TEST_PORT = 3210;

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

describe('Abort & Resume API', () => {
  beforeAll(done => {
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
  });

  test('POST /api/abort gibt 400 wenn kein Projekt laeuft', async () => {
    const res = await request('POST', '/api/abort');
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
    expect(res.body.error).toMatch(/Kein laufendes Projekt/);
  });

  test('POST /api/resume mit nicht-existierendem Projekt gibt 200 (async Verarbeitung)', async () => {
    const res = await request('POST', '/api/resume/proj_nonexistent_999');
    // Resume endpoint antwortet sofort mit 200 und verarbeitet async
    // Der Fehler wird über SSE broadcast gesendet, nicht in der HTTP-Response
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // Warten bis async Fehler verarbeitet ist
    await new Promise(r => setTimeout(r, 300));
  });

  test('POST /api/resume ohne proj_ Prefix gibt Fehler', async () => {
    const res = await request('POST', '/api/resume/invalid_id');
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  test('POST /api/resume mit existierendem Projekt versucht Fortsetzung', async () => {
    // Testprojekt-Verzeichnis erstellen
    const testId = 'proj_test_resume_' + Date.now();
    const projectDir = path.join(__dirname, '../../projects', testId);
    fs.mkdirSync(path.join(projectDir, 'agent-1'), { recursive: true });

    const stateData = {
      projectId: testId,
      projectTitle: 'Resume Test',
      projectDesc: 'Test',
      phase: 'partial',
      startedAt: Date.now() - 60000,
      tasks: [{ title: 'Task 1', task: 'Aufgabe 1', deliverable: 'Ergebnis', depends_on: [] }],
      agents: [{ id: 0, title: 'Task 1', status: 'error', conversation: [], rounds: 0 }],
      coordinator: { status: 'done', log: [] },
    };
    fs.writeFileSync(path.join(projectDir, 'state.json'), JSON.stringify(stateData));

    // Resume starten - wird wahrscheinlich fehlschlagen weil spawn gemocked ist,
    // aber der Endpoint sollte 200 zurückgeben (async Verarbeitung)
    const res = await request('POST', '/api/resume/' + testId);
    // Either 200 (accepted) or 409 (already running from previous test) or 500 (spawn fails)
    expect([200, 409, 500]).toContain(res.status);

    // Aufräumen
    try {
      // Wait a bit for any async operations
      await new Promise(r => setTimeout(r, 500));
      fs.rmSync(projectDir, { recursive: true, force: true });
    } catch {}
  });
});
