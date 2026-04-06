'use strict';
const http = require('http');

const TEST_PORT = 3233;

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
  const HealthMonitor = require('../../src/health-monitor');
  class MockOrchestrator extends EventEmitter {
    constructor() {
      super();
      this.phase = 'idle';
      this.agents = [];
      this.startedAt = null;
      this.healthMonitor = new HealthMonitor({
        checkInterval: 100000,
        getConnections: () => ({ sse: 0, websocket: 0 }),
        getOrchestratorInfo: () => ({ phase: this.phase, agentCount: 0, activeAgents: 0 }),
      });
      this.healthMonitor.start();
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

describe('Health Detailed API', () => {
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

  test('GET /api/health gibt weiterhin einfachen Status zurueck', async () => {
    const res = await request('GET', '/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body).toHaveProperty('uptime');
  });

  test('GET /api/health/detailed gibt erweiterte Daten zurueck', async () => {
    const res = await request('GET', '/api/health/detailed');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('status');
    expect(['healthy', 'degraded', 'unhealthy']).toContain(res.body.status);
    expect(res.body).toHaveProperty('memory');
    expect(res.body.memory).toHaveProperty('used');
    expect(res.body.memory).toHaveProperty('total');
    expect(res.body.memory).toHaveProperty('percentage');
    expect(res.body.memory).toHaveProperty('heapUsed');
    expect(res.body.memory).toHaveProperty('rss');
    expect(res.body).toHaveProperty('cpu');
    expect(res.body).toHaveProperty('disk');
    expect(res.body).toHaveProperty('connections');
    expect(res.body).toHaveProperty('orchestrator');
    expect(res.body).toHaveProperty('timestamp');
  });

  test('GET /api/health/history gibt Array zurueck', async () => {
    const res = await request('GET', '/api/health/history?minutes=30');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('GET /api/health/diagnostics hat nodeVersion', async () => {
    const res = await request('GET', '/api/health/diagnostics');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('nodeVersion');
    expect(res.body.nodeVersion).toBe(process.version);
    expect(res.body).toHaveProperty('platform');
    expect(res.body).toHaveProperty('arch');
    expect(res.body).toHaveProperty('loadedModules');
  });

  test('GET /api/health/alerts gibt Array zurueck', async () => {
    const res = await request('GET', '/api/health/alerts');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('GET /api/health/thresholds gibt Schwellwerte zurueck', async () => {
    const res = await request('GET', '/api/health/thresholds');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('memoryPercent');
    expect(res.body).toHaveProperty('heapPercent');
    expect(res.body).toHaveProperty('eventLoopLag');
    expect(res.body).toHaveProperty('diskSize');
  });

  test('PUT /api/health/thresholds akzeptiert gueltige Werte', async () => {
    const res = await request('PUT', '/api/health/thresholds', { memoryPercent: 70 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.thresholds.memoryPercent).toBe(70);
  });

  test('PUT /api/health/thresholds lehnt ungueltige Metrik ab', async () => {
    const res = await request('PUT', '/api/health/thresholds', { invalidMetric: 50 });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });
});
