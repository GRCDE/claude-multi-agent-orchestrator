// Health-Alerts API - Tests
// Testet GET /api/health/alerts und POST /api/health/alerts/:id/clear

'use strict';
const http = require('http');

const TEST_PORT = 3249;

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
      this.healthMonitor = {
        _alerts: [
          { id: 1, type: 'cpu', message: 'CPU hoch', timestamp: Date.now() },
          { id: 2, type: 'memory', message: 'Memory hoch', timestamp: Date.now() }
        ],
        getAlerts() {
          return this._alerts;
        },
        clearAlert(id) {
          const idx = this._alerts.findIndex(a => a.id === id);
          if (idx === -1) return false;
          this._alerts.splice(idx, 1);
          return true;
        }
      };
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

describe('Health-Alerts API', () => {
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

  test('GET /api/health/alerts gibt Array zurueck', async () => {
    const res = await request('GET', '/api/health/alerts');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
  });

  test('POST /api/health/alerts/:id/clear loescht Alert', async () => {
    const res = await request('POST', '/api/health/alerts/1/clear');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  test('POST /api/health/alerts/:id/clear mit unbekannter ID gibt 404', async () => {
    const res = await request('POST', '/api/health/alerts/9999/clear');
    expect(res.status).toBe(404);
    expect(res.body.error).toBeDefined();
  });

  test('POST /api/health/alerts ohne ID gibt 404', async () => {
    const res = await request('POST', '/api/health/alerts');
    expect(res.status).toBe(404);
  });
});
