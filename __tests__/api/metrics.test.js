// Metrics API - Tests
// Testet GET /api/metrics, DELETE /api/metrics

'use strict';
const http = require('http');

const TEST_PORT = 3216;

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

describe('Metrics API', () => {
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

  test('GET /api/metrics gibt Metriken zurueck', async () => {
    const res = await request('GET', '/api/metrics');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('uptime');
    expect(res.body).toHaveProperty('memory');
    expect(res.body).toHaveProperty('endpoints');
  });

  test('Metriken enthalten uptime als Zahl', async () => {
    const res = await request('GET', '/api/metrics');
    expect(typeof res.body.uptime).toBe('number');
    expect(res.body.uptime).toBeGreaterThanOrEqual(0);
  });

  test('Metriken enthalten memory-Objekt mit heapUsed', async () => {
    const res = await request('GET', '/api/metrics');
    expect(res.body.memory).toHaveProperty('heapUsed');
    expect(res.body.memory).toHaveProperty('heapTotal');
    expect(res.body.memory).toHaveProperty('rss');
    expect(typeof res.body.memory.heapUsed).toBe('number');
  });

  test('Metriken enthalten endpoints als Array', async () => {
    const res = await request('GET', '/api/metrics');
    expect(Array.isArray(res.body.endpoints)).toBe(true);
  });

  test('Metriken enthalten cpu und connections', async () => {
    const res = await request('GET', '/api/metrics');
    expect(res.body).toHaveProperty('cpu');
    expect(res.body).toHaveProperty('connections');
    expect(typeof res.body.cpu).toBe('number');
  });

  test('Metriken enthalten serverStart-Timestamp', async () => {
    const res = await request('GET', '/api/metrics');
    expect(res.body).toHaveProperty('serverStart');
    expect(typeof res.body.serverStart).toBe('number');
  });

  test('DELETE /api/metrics setzt Metriken zurueck', async () => {
    // Zuerst ein paar Requests ausfuehren damit es Metriken gibt
    await request('GET', '/api/metrics');
    await request('GET', '/api/metrics');

    const delRes = await request('DELETE', '/api/metrics');
    expect(delRes.status).toBe(200);
    expect(delRes.body.ok).toBe(true);
    expect(delRes.body.message).toContain('zurueckgesetzt');

    // Nach Reset sollten endpoints leer sein
    const res = await request('GET', '/api/metrics');
    // endpoints enthaelt jetzt nur den gerade gemachten GET /api/metrics Request
    expect(res.body.endpoints.length).toBeLessThanOrEqual(1);
  });
});
