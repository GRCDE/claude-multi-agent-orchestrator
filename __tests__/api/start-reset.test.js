// Start/Reset/Status API - Tests
// Testet POST /api/start, POST /api/reset, GET /api/status

'use strict';
const http = require('http');

const TEST_PORT = 3251;

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

describe('Start/Reset/Status API', () => {
  beforeAll(done => {
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
  });

  test('POST /api/start ohne description gibt 400', async () => {
    const res = await request('POST', '/api/start', { agentCount: 3 });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });

  test('POST /api/start mit description und agentCount startet Projekt', async () => {
    const res = await request('POST', '/api/start', {
      description: 'Test-Projekt fuer Unit-Tests',
      agentCount: 3
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.message).toBe('Projekt gestartet');
  });

  test('POST /api/start mit agentCount < 2 gibt 400', async () => {
    // Erst reset damit kein Projekt laeuft
    await request('POST', '/api/reset');
    const res = await request('POST', '/api/start', {
      description: 'Test mit zu wenig Agenten',
      agentCount: 1
    });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });

  test('POST /api/start mit agentCount > 10 gibt 400', async () => {
    await request('POST', '/api/reset');
    const res = await request('POST', '/api/start', {
      description: 'Test mit zu vielen Agenten',
      agentCount: 15
    });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });

  test('GET /api/status gibt aktuellen State zurueck', async () => {
    const res = await request('GET', '/api/status');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('phase');
    expect(res.body).toHaveProperty('agents');
    expect(res.body).toHaveProperty('coordinator');
    expect(res.body).toHaveProperty('totalTokenUsage');
  });

  test('POST /api/reset setzt Orchestrator zurueck', async () => {
    const res = await request('POST', '/api/reset');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // Status pruefen: Phase sollte idle sein
    const status = await request('GET', '/api/status');
    expect(status.body.phase).toBe('idle');
  });

  test('POST /api/start mit laufendem Projekt reiht in Queue ein', async () => {
    // Erst reset
    await request('POST', '/api/reset');

    // Erstes Projekt starten
    const first = await request('POST', '/api/start', {
      description: 'Erstes Projekt',
      agentCount: 2
    });
    expect(first.status).toBe(200);
    expect(first.body.ok).toBe(true);

    // Zweites Projekt waehrend erstes laeuft -> Queue
    const second = await request('POST', '/api/start', {
      description: 'Zweites Projekt in Queue',
      agentCount: 3
    });
    expect(second.status).toBe(200);
    expect(second.body.ok).toBe(true);
    expect(second.body.queued).toBe(true);
    expect(second.body.position).toBeGreaterThanOrEqual(1);

    // Queue leeren fuer sauberen Zustand
    await request('POST', '/api/queue/clear');
  });
});
