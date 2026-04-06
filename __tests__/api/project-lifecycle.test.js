// Project Lifecycle API - Tests
// Testet POST /api/load/:id, POST /api/resume/:id, POST /api/clone/:id,
// POST /api/cleanup, GET /api/disk-usage

'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const TEST_PORT = 3238;

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

describe('Project Lifecycle API', () => {
  const projectsDir = path.join(__dirname, '../../projects');

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

  // ── POST /api/load/:id ──────────────────────────────────────

  test('POST /api/load mit ungueltiger ID gibt 400', async () => {
    const res = await request('POST', '/api/load/invalid_id');
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
    expect(res.body.error).toMatch(/Ungültige Projekt-ID/);
  });

  test('POST /api/load mit nicht-existierendem Projekt gibt 404', async () => {
    const res = await request('POST', '/api/load/proj_nonexistent_999');
    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty('error');
  });

  // ── POST /api/resume/:id ────────────────────────────────────

  test('POST /api/resume ohne proj_ Prefix gibt 400', async () => {
    const res = await request('POST', '/api/resume/invalid_id');
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
    expect(res.body.error).toMatch(/proj_/);
  });

  test('POST /api/resume mit gueltigem Projekt gibt 200 (async)', async () => {
    const testId = 'proj_test_lifecycle_' + Date.now();
    const projectDir = path.join(projectsDir, testId);
    fs.mkdirSync(path.join(projectDir, 'agent-1'), { recursive: true });

    const stateData = {
      projectId: testId,
      projectTitle: 'Lifecycle Resume Test',
      projectDesc: 'Test',
      phase: 'partial',
      startedAt: Date.now() - 60000,
      tasks: [{ title: 'Task 1', task: 'Aufgabe 1', deliverable: 'Ergebnis', depends_on: [] }],
      agents: [{ id: 0, title: 'Task 1', status: 'error', conversation: [], rounds: 0 }],
      coordinator: { status: 'done', log: [] },
    };
    fs.writeFileSync(path.join(projectDir, 'state.json'), JSON.stringify(stateData));

    const res = await request('POST', '/api/resume/' + testId);
    // 200 (accepted async) oder 409 (falls anderes Projekt laeuft)
    expect([200, 409]).toContain(res.status);

    // Aufraeumen
    await new Promise(r => setTimeout(r, 300));
    try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch {}
  });

  // ── POST /api/clone/:id ─────────────────────────────────────

  test('POST /api/clone mit existierendem Projekt gibt Einstellungen zurueck', async () => {
    const testId = 'proj_test_clone_' + Date.now();
    const projectDir = path.join(projectsDir, testId);
    fs.mkdirSync(projectDir, { recursive: true });

    const stateData = {
      projectId: testId,
      projectDesc: 'Clone-Beschreibung',
      agents: [{ id: 0 }, { id: 1 }],
      tasks: [
        { title: 'T1', task: 'Aufgabe 1', deliverable: 'Ergebnis 1' },
        { title: 'T2', task: 'Aufgabe 2', deliverable: 'Ergebnis 2' }
      ]
    };
    fs.writeFileSync(path.join(projectDir, 'state.json'), JSON.stringify(stateData));

    const res = await request('POST', '/api/clone/' + testId);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.description).toBe('Clone-Beschreibung');
    expect(res.body.agentCount).toBe(2);
    expect(res.body.tasks).toHaveLength(2);
    expect(res.body.tasks[0].title).toBe('T1');

    // Aufraeumen
    try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch {}
  });

  test('POST /api/clone mit nicht-existierendem Projekt gibt 404', async () => {
    const res = await request('POST', '/api/clone/proj_nonexistent_999');
    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty('error');
  });

  // ── POST /api/cleanup ───────────────────────────────────────

  test('POST /api/cleanup loescht alte Projekte', async () => {
    // Projekt mit altem Timestamp erstellen (>7 Tage)
    const oldTs = Date.now() - (8 * 24 * 60 * 60 * 1000);
    const oldId = 'proj_' + oldTs;
    const oldDir = path.join(projectsDir, oldId);
    fs.mkdirSync(oldDir, { recursive: true });
    fs.writeFileSync(path.join(oldDir, 'state.json'), '{}');

    const res = await request('POST', '/api/cleanup');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.deleted).toContain(oldId);
    expect(res.body.count).toBeGreaterThanOrEqual(1);

    // Verzeichnis sollte geloescht sein
    expect(fs.existsSync(oldDir)).toBe(false);
  });

  // ── GET /api/disk-usage ─────────────────────────────────────

  test('GET /api/disk-usage gibt Speicherplatz-Info zurueck', async () => {
    const res = await request('GET', '/api/disk-usage');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('totalSize');
    expect(res.body).toHaveProperty('projectCount');
    expect(res.body).toHaveProperty('oldestProject');
    expect(res.body).toHaveProperty('newestProject');
    expect(res.body.totalSize).toMatch(/MB$/);
    expect(typeof res.body.projectCount).toBe('number');
  });
});
