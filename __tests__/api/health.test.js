// Health API - Tests
// Testet GET /health und GET /api/health

'use strict';
const http = require('http');

const TEST_PORT = 3217;

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

describe('Health API', () => {
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

  test('GET /api/health gibt Status zurueck', async () => {
    const res = await request('GET', '/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  test('GET /health gibt gleiches Ergebnis', async () => {
    const res = await request('GET', '/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  test('Response enthaelt uptime als Zahl', async () => {
    const res = await request('GET', '/api/health');
    expect(res.body).toHaveProperty('uptime');
    expect(typeof res.body.uptime).toBe('number');
    expect(res.body.uptime).toBeGreaterThanOrEqual(0);
  });

  test('Response enthaelt status-Feld', async () => {
    const res = await request('GET', '/health');
    expect(res.body).toHaveProperty('status');
    expect(res.body.status).toBe('ok');
  });

  test('Response enthaelt phase des Orchestrators', async () => {
    const res = await request('GET', '/api/health');
    expect(res.body).toHaveProperty('phase');
    expect(res.body.phase).toBe('idle');
  });

  test('Response enthaelt memory-Info', async () => {
    const res = await request('GET', '/api/health');
    expect(res.body).toHaveProperty('memory');
    expect(typeof res.body.memory).toBe('string');
    expect(res.body.memory).toMatch(/MB$/);
  });

  test('Beide Endpoints liefern gleiche Struktur', async () => {
    const res1 = await request('GET', '/health');
    const res2 = await request('GET', '/api/health');

    expect(Object.keys(res1.body).sort()).toEqual(Object.keys(res2.body).sort());
    expect(res1.body.status).toBe(res2.body.status);
    expect(res1.body.phase).toBe(res2.body.phase);
  });
});
