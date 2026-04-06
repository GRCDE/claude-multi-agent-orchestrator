// Archive API - Tests
// Testet POST /api/projects/:id/archive, /unarchive und Filterung in GET /api/projects

'use strict';
const http = require('http');
const path = require('path');
const fs = require('fs');

const TEST_PORT = 3277;
const PROJECTS_DIR = path.join(__dirname, '..', '..', 'projects');

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

// Testprojekt-ID
const TEST_PROJECT_ID = 'proj_9999990001';
const TEST_PROJECT_ID2 = 'proj_9999990002';

function createTestProject(id, extra = {}) {
  const dir = path.join(PROJECTS_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  const state = {
    projectTitle: 'Testprojekt ' + id,
    phase: 'complete',
    agents: [],
    totalTokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCost: 0 },
    ...extra
  };
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state, null, 2));
}

function removeTestProject(id) {
  const dir = path.join(PROJECTS_DIR, id);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

jest.mock('child_process', () => ({
  spawn: jest.fn(),
  execSync: jest.fn(() => 'claude 1.0.0'),
}));

jest.mock('express-rate-limit', () => {
  return () => (req, res, next) => next();
});

jest.mock('../../orchestrator', () => {
  const EventEmitter = require('events').EventEmitter;
  class MockOrchestrator extends EventEmitter {
    constructor() {
      super();
      this.phase = 'idle';
      this.agents = [];
      this.startedAt = null;
    }
    emit(event, data) {
      super.emit('update', { event, data, ts: Date.now() });
      super.emit(event, data);
      return true;
    }
    getState() {
      return {
        phase: this.phase,
        agents: this.agents,
        coordinator: {},
        totalTokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCost: 0 }
      };
    }
    start() { this.phase = 'running'; return Promise.resolve(); }
    reset() { this.phase = 'idle'; this.agents = []; }
    getPrompts() { return { prompts: {} }; }
    updatePrompts() {}
    resetPrompts() {}
    getConfig() { return {}; }
    updateConfig() {}
    approvePlan() {}
    modifyPlan() {}
    retryAgent() { return Promise.resolve(); }
    loadProject() { return this.getState(); }
    resume() { return Promise.resolve(); }
    setIntervention() {}
  }
  return MockOrchestrator;
});

describe('Archive API', () => {
  beforeAll(done => {
    process.env.PORT = TEST_PORT;
    Object.keys(require.cache).forEach(key => {
      if (key.includes('server.js')) delete require.cache[key];
    });

    // Testprojekte anlegen
    createTestProject(TEST_PROJECT_ID);
    createTestProject(TEST_PROJECT_ID2);

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
    removeTestProject(TEST_PROJECT_ID);
    removeTestProject(TEST_PROJECT_ID2);
  });

  test('POST /api/projects/:id/archive markiert Projekt als archiviert', async () => {
    const res = await request('POST', `/api/projects/${TEST_PROJECT_ID}/archive`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.archived).toBe(true);
    expect(res.body.id).toBe(TEST_PROJECT_ID);

    // state.json pruefen
    const state = JSON.parse(fs.readFileSync(path.join(PROJECTS_DIR, TEST_PROJECT_ID, 'state.json'), 'utf8'));
    expect(state.archived).toBe(true);
  });

  test('GET /api/projects schliesst archivierte standardmaessig aus', async () => {
    const res = await request('GET', '/api/projects');
    expect(res.status).toBe(200);
    const ids = res.body.map(p => p.id);
    expect(ids).not.toContain(TEST_PROJECT_ID);
    expect(ids).toContain(TEST_PROJECT_ID2);
  });

  test('GET /api/projects?includeArchived=true zeigt alle Projekte', async () => {
    const res = await request('GET', '/api/projects?includeArchived=true');
    expect(res.status).toBe(200);
    const ids = res.body.map(p => p.id);
    expect(ids).toContain(TEST_PROJECT_ID);
    expect(ids).toContain(TEST_PROJECT_ID2);

    const archived = res.body.find(p => p.id === TEST_PROJECT_ID);
    expect(archived.archived).toBe(true);
  });

  test('POST /api/projects/:id/unarchive hebt Archivierung auf', async () => {
    const res = await request('POST', `/api/projects/${TEST_PROJECT_ID}/unarchive`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.archived).toBe(false);

    // Projekt taucht jetzt wieder in normaler Liste auf
    const listRes = await request('GET', '/api/projects');
    const ids = listRes.body.map(p => p.id);
    expect(ids).toContain(TEST_PROJECT_ID);
  });

  test('Archive/Unarchive bei ungueltigem Projekt gibt 404', async () => {
    const res1 = await request('POST', '/api/projects/proj_0000000000/archive');
    expect(res1.status).toBe(404);

    const res2 = await request('POST', '/api/projects/proj_0000000000/unarchive');
    expect(res2.status).toBe(404);
  });
});
