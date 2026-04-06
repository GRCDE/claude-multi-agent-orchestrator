// Benchmark API - Performance Tests
// Testet Response-Zeiten und Memory-Verbrauch

'use strict';
const http = require('http');

const TEST_PORT = 3256;

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

async function timedRequest(method, urlPath) {
  const start = Date.now();
  const res = await request(method, urlPath);
  const duration = Date.now() - start;
  return { ...res, duration };
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
    getConfig() { return { maxAgents: 10, agentTimeout: 300000 }; }
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

describe('Benchmark API', () => {
  beforeAll(async () => {
    process.env.PORT = TEST_PORT;
    const maxRetries = 3;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      Object.keys(require.cache).forEach(key => {
        if (key.includes('server.js')) delete require.cache[key];
      });
      try {
        require('../../server');
        await new Promise(resolve => setTimeout(resolve, 500));
        return;
      } catch (e) {
        if (e.code === 'EADDRINUSE' && attempt < maxRetries - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          continue;
        }
        throw e;
      }
    }
  }, 15000);

  afterAll(async () => {
    const serverMod = require('../../server');
    if (serverMod && serverMod.cleanup) await serverMod.cleanup();
  });

  test('GET /api/status antwortet unter 200ms', async () => {
    // Warmup
    await request('GET', '/api/status');

    const { duration, status } = await timedRequest('GET', '/api/status');
    expect(status).toBe(200);
    expect(duration).toBeLessThan(200);
  });

  test('GET /api/health antwortet unter 200ms', async () => {
    await request('GET', '/api/health');

    const { duration, status } = await timedRequest('GET', '/api/health');
    expect(status).toBe(200);
    expect(duration).toBeLessThan(200);
  });

  test('GET /api/config antwortet unter 200ms', async () => {
    await request('GET', '/api/config');

    const { duration, status } = await timedRequest('GET', '/api/config');
    expect(status).toBe(200);
    expect(duration).toBeLessThan(200);
  });

  test('GET /api/projects antwortet unter 500ms', async () => {
    await request('GET', '/api/projects');

    const { duration, status } = await timedRequest('GET', '/api/projects');
    expect(status).toBe(200);
    expect(duration).toBeLessThan(500);
  });

  test('50 sequentielle Requests an /api/status schaffen alle unter 500ms', async () => {
    // Warmup
    await request('GET', '/api/status');

    const durations = [];
    for (let i = 0; i < 50; i++) {
      const { duration, status } = await timedRequest('GET', '/api/status');
      expect(status).toBe(200);
      durations.push(duration);
    }

    const maxDuration = Math.max(...durations);
    const avgDuration = durations.reduce((a, b) => a + b, 0) / durations.length;

    // Jeder einzelne Request muss unter 500ms sein
    expect(maxDuration).toBeLessThan(500);

    // Durchschnitt sollte unter 200ms liegen
    expect(avgDuration).toBeLessThan(200);
  });

  test('Server Memory bleibt unter 200MB nach 100 Requests', async () => {
    // Memory vor den Requests messen
    const memBefore = process.memoryUsage().heapUsed;

    // 100 Requests ausfuehren
    for (let i = 0; i < 100; i++) {
      await request('GET', '/api/status');
    }

    // Memory nach den Requests messen
    const memAfter = process.memoryUsage().heapUsed;
    const totalMemMB = memAfter / (1024 * 1024);
    const deltaMemMB = (memAfter - memBefore) / (1024 * 1024);

    // Gesamter Heap muss unter 200MB bleiben
    expect(totalMemMB).toBeLessThan(200);

    // Memory-Zuwachs sollte minimal sein (unter 50MB)
    expect(deltaMemMB).toBeLessThan(50);
  });
});
