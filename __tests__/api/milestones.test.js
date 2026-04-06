// Milestones API - Tests
// Testet GET /api/milestones, POST /api/milestones, POST /api/start-milestone

'use strict';
const http = require('http');
const path = require('path');
const fs = require('fs');

const TEST_PORT = 3215;
const MILESTONES_FILE = path.join(__dirname, '..', '..', 'milestones.json');

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

// Backup und Cleanup fuer milestones.json
let originalContent = null;

describe('Milestones API', () => {
  beforeAll(done => {
    // Backup existierende milestones.json
    try {
      originalContent = fs.readFileSync(MILESTONES_FILE, 'utf8');
    } catch { originalContent = null; }

    process.env.PORT = TEST_PORT;
    Object.keys(require.cache).forEach(key => {
      if (key.includes('server.js')) delete require.cache[key];
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
    // Restore milestones.json
    if (originalContent !== null) {
      fs.writeFileSync(MILESTONES_FILE, originalContent, 'utf8');
    } else {
      try { fs.unlinkSync(MILESTONES_FILE); } catch {}
    }
  });

  test('GET /api/milestones gibt Array zurueck (leer wenn keine Datei)', async () => {
    // Sicherstellen dass keine milestones.json existiert
    try { fs.unlinkSync(MILESTONES_FILE); } catch {}

    const res = await request('GET', '/api/milestones');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('milestones');
    expect(Array.isArray(res.body.milestones)).toBe(true);
    expect(res.body.milestones.length).toBe(0);
  });

  test('POST /api/milestones speichert neuen Meilenstein', async () => {
    const milestones = [
      {
        id: 'test-ms-1',
        title: 'Test Meilenstein',
        description: 'Ein Test-Meilenstein',
        tasks: [
          { title: 'Task A', task: 'Mache A', deliverable: 'Ergebnis A' },
          { title: 'Task B', task: 'Mache B', deliverable: 'Ergebnis B' },
        ]
      }
    ];

    const res = await request('POST', '/api/milestones', { milestones });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.count).toBe(1);
  });

  test('GET /api/milestones gibt gespeicherte Meilensteine zurueck', async () => {
    const res = await request('GET', '/api/milestones');
    expect(res.status).toBe(200);
    expect(res.body.milestones.length).toBe(1);
    expect(res.body.milestones[0].id).toBe('test-ms-1');
    expect(res.body.milestones[0].title).toBe('Test Meilenstein');
  });

  test('POST /api/milestones lehnt ungueltige Daten ab (kein Array)', async () => {
    const res = await request('POST', '/api/milestones', { milestones: 'nicht-array' });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });

  test('POST /api/milestones lehnt Meilenstein ohne Tasks ab', async () => {
    const res = await request('POST', '/api/milestones', {
      milestones: [{ id: 'bad', title: 'Schlecht', tasks: [] }]
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('mindestens eine Task');
  });

  test('POST /api/start-milestone mit gueltiger ID startet Projekt', async () => {
    // Zuerst Meilenstein anlegen
    await request('POST', '/api/milestones', {
      milestones: [{
        id: 'start-test',
        title: 'Startbarer Meilenstein',
        description: 'Wird gestartet',
        tasks: [
          { title: 'T1', task: 'Aufgabe 1', deliverable: 'E1' },
          { title: 'T2', task: 'Aufgabe 2', deliverable: 'E2' },
        ]
      }]
    });

    // Reset um sicher idle zu sein
    await request('POST', '/api/reset');
    await new Promise(r => setTimeout(r, 50));

    const res = await request('POST', '/api/start-milestone', { milestoneId: 'start-test' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.message).toContain('Startbarer Meilenstein');

    // Cleanup: zuruecksetzen
    await request('POST', '/api/reset');
  });

  test('POST /api/start-milestone mit ungueltiger ID gibt 404', async () => {
    const res = await request('POST', '/api/start-milestone', { milestoneId: 'nicht-vorhanden-xyz' });
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('nicht gefunden');
  });

  test('POST /api/start-milestone ohne milestoneId gibt 400', async () => {
    const res = await request('POST', '/api/start-milestone', {});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('milestoneId');
  });
});
