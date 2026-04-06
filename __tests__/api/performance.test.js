// Performance API - Tests
// Testet GET /api/performance, /api/performance/history, /api/performance/agents, /api/performance/realtime

'use strict';
const http = require('http');

const TEST_PORT = 3228;

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
        coordinator: { tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCost: 0 } },
        totalTokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCost: 0 },
        budget: {},
        startedAt: this.startedAt
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

describe('Performance API', () => {
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

  test('GET /api/performance gibt korrektes Format zurueck', async () => {
    const res = await request('GET', '/api/performance');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('avgAgentDuration');
    expect(res.body).toHaveProperty('tokenTrend');
    expect(res.body).toHaveProperty('successRate');
    expect(res.body).toHaveProperty('avgQuestionsPerAgent');
    expect(res.body).toHaveProperty('fastestAgent');
    expect(res.body).toHaveProperty('slowestAgent');
    expect(res.body).toHaveProperty('totalRuntime');
    expect(res.body).toHaveProperty('projectCount');
  });

  test('GET /api/performance successRate hat korrekte Felder', async () => {
    const res = await request('GET', '/api/performance');
    expect(res.status).toBe(200);
    const sr = res.body.successRate;
    expect(sr).toHaveProperty('completed');
    expect(sr).toHaveProperty('failed');
    expect(sr).toHaveProperty('partial');
    expect(sr).toHaveProperty('total');
    expect(sr).toHaveProperty('rate');
    expect(typeof sr.rate).toBe('number');
    expect(sr.rate).toBeGreaterThanOrEqual(0);
    expect(sr.rate).toBeLessThanOrEqual(100);
  });

  test('GET /api/performance tokenTrend ist ein Array', async () => {
    const res = await request('GET', '/api/performance');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.tokenTrend)).toBe(true);
  });

  test('GET /api/performance/history gibt Array zurueck', async () => {
    const res = await request('GET', '/api/performance/history');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('GET /api/performance/agents gibt Agent-Daten zurueck', async () => {
    const res = await request('GET', '/api/performance/agents');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('GET /api/performance/realtime gibt Echtzeit-Daten zurueck', async () => {
    const res = await request('GET', '/api/performance/realtime');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('phase');
    expect(res.body).toHaveProperty('activeAgents');
    expect(res.body).toHaveProperty('completedCount');
    expect(res.body).toHaveProperty('failedCount');
    expect(res.body).toHaveProperty('totalAgents');
    expect(res.body).toHaveProperty('tokensPerSecond');
    expect(res.body).toHaveProperty('totalTokens');
    expect(res.body).toHaveProperty('currentCost');
    expect(res.body).toHaveProperty('estimatedRemainingCost');
    expect(res.body).toHaveProperty('progress');
  });

  test('GET /api/performance/realtime activeAgents ist ein Array', async () => {
    const res = await request('GET', '/api/performance/realtime');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.activeAgents)).toBe(true);
    expect(typeof res.body.tokensPerSecond).toBe('number');
    expect(typeof res.body.progress).toBe('number');
  });

  test('GET /api/performance numerische Felder sind korrekt', async () => {
    const res = await request('GET', '/api/performance');
    expect(res.status).toBe(200);
    expect(typeof res.body.avgAgentDuration).toBe('number');
    expect(typeof res.body.avgQuestionsPerAgent).toBe('number');
    expect(typeof res.body.totalRuntime).toBe('number');
    expect(typeof res.body.projectCount).toBe('number');
    expect(res.body.avgAgentDuration).toBeGreaterThanOrEqual(0);
    expect(res.body.totalRuntime).toBeGreaterThanOrEqual(0);
  });
});
