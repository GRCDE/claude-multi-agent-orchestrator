// Milestones CRUD Lifecycle Tests
// Testet GET /api/milestones, POST /api/milestones, POST /api/start-milestone
// Port 3247

'use strict';
const http = require('http');
const path = require('path');
const fs = require('fs');

const TEST_PORT = 3247;
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

let originalContent = null;

describe('Milestones CRUD Lifecycle', () => {
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

  test('GET /api/milestones laedt initiale Daten aus milestones.json', async () => {
    // Schreibe bekannte milestones.json fuer den Test
    const initial = {
      milestones: [
        {
          id: 'init-1',
          title: 'Initialer Meilenstein',
          description: 'Aus Datei geladen',
          tasks: [
            { title: 'Task 1', task: 'Aufgabe 1', deliverable: 'Ergebnis 1' },
            { title: 'Task 2', task: 'Aufgabe 2', deliverable: 'Ergebnis 2' }
          ]
        }
      ]
    };
    fs.writeFileSync(MILESTONES_FILE, JSON.stringify(initial, null, 2), 'utf8');

    const res = await request('GET', '/api/milestones');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('milestones');
    expect(Array.isArray(res.body.milestones)).toBe(true);
    expect(res.body.milestones.length).toBe(1);
    expect(res.body.milestones[0].id).toBe('init-1');
    expect(res.body.milestones[0].title).toBe('Initialer Meilenstein');
  });

  test('POST /api/milestones speichert neues Milestones-Array', async () => {
    const milestones = [
      {
        id: 'crud-1',
        title: 'CRUD Meilenstein A',
        description: 'Erster Meilenstein',
        tasks: [
          { title: 'Analyse', task: 'Code analysieren', deliverable: 'analyse.md' },
          { title: 'Implementierung', task: 'Feature bauen', deliverable: 'feature.js' }
        ]
      },
      {
        id: 'crud-2',
        title: 'CRUD Meilenstein B',
        description: 'Zweiter Meilenstein',
        tasks: [
          { title: 'Tests', task: 'Tests schreiben', deliverable: 'tests/' },
          { title: 'Docs', task: 'Doku schreiben', deliverable: 'README.md' }
        ]
      }
    ];

    const res = await request('POST', '/api/milestones', { milestones });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.count).toBe(2);

    // Verifiziere durch erneutes Laden
    const getRes = await request('GET', '/api/milestones');
    expect(getRes.status).toBe(200);
    expect(getRes.body.milestones.length).toBe(2);
    expect(getRes.body.milestones[0].id).toBe('crud-1');
    expect(getRes.body.milestones[1].id).toBe('crud-2');
  });

  test('POST /api/milestones ueberschreibt bestehende Milestones komplett', async () => {
    // Zuerst 2 Milestones speichern
    await request('POST', '/api/milestones', {
      milestones: [
        { id: 'old-1', title: 'Alt 1', tasks: [{ title: 'T', task: 'T', deliverable: 'T' }] },
        { id: 'old-2', title: 'Alt 2', tasks: [{ title: 'T', task: 'T', deliverable: 'T' }] }
      ]
    });

    // Dann mit einem neuen ueberschreiben
    const res = await request('POST', '/api/milestones', {
      milestones: [
        { id: 'new-1', title: 'Neu 1', tasks: [{ title: 'N', task: 'N', deliverable: 'N' }] }
      ]
    });
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);

    // Verifiziere: alte sind weg, nur neuer vorhanden
    const getRes = await request('GET', '/api/milestones');
    expect(getRes.body.milestones.length).toBe(1);
    expect(getRes.body.milestones[0].id).toBe('new-1');
  });

  test('POST /api/start-milestone ohne milestoneId gibt 400', async () => {
    const res = await request('POST', '/api/start-milestone', {});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('milestoneId');
  });

  test('POST /api/start-milestone mit ungueltiger ID gibt 404', async () => {
    // Sicherstellen dass milestones.json existiert
    await request('POST', '/api/milestones', {
      milestones: [
        { id: 'exists', title: 'Existiert', tasks: [{ title: 'T', task: 'T', deliverable: 'T' }] }
      ]
    });

    const res = await request('POST', '/api/start-milestone', { milestoneId: 'gibts-nicht-xyz' });
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('nicht gefunden');
  });

  test('POST /api/start-milestone mit gueltiger ID startet Projekt', async () => {
    // Meilenstein anlegen
    await request('POST', '/api/milestones', {
      milestones: [{
        id: 'start-lifecycle',
        title: 'Lifecycle Test',
        description: 'Wird gestartet',
        tasks: [
          { title: 'Backend', task: 'API bauen', deliverable: 'server.js' },
          { title: 'Frontend', task: 'UI bauen', deliverable: 'index.html' }
        ]
      }]
    });

    // Reset um idle sicherzustellen
    await request('POST', '/api/reset');
    await new Promise(r => setTimeout(r, 50));

    const res = await request('POST', '/api/start-milestone', { milestoneId: 'start-lifecycle' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.message).toContain('Lifecycle Test');

    // Cleanup
    await request('POST', '/api/reset');
  });

  test('POST /api/start-milestone mit milestoneId als Nicht-String gibt 400', async () => {
    const res = await request('POST', '/api/start-milestone', { milestoneId: 12345 });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('milestoneId');
  });
});
