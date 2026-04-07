// SDK Health API - Tests
// Testet SDK-Status in Health-Endpoints

'use strict';
const http = require('http');

const TEST_PORT = 3279;

function request(method, urlPath) {
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
    }
    emit(event, data) {
      super.emit('update', { event, data, ts: Date.now() });
      super.emit(event, data);
      return true;
    }
    getState() {
      return {
        phase: this.phase, agents: this.agents, coordinator: {},
        totalTokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCost: 0 }
      };
    }
    start() { return Promise.resolve(); }
    reset() { this.phase = 'idle'; }
    getPrompts() { return { prompts: {} }; }
    updatePrompts() {}
    resetPrompts() {}
    getConfig() {
      return {
        claudeMode: 'auto',
        sdkAvailable: false,
        sdkInfo: { available: false, detected: true, version: null },
        agentTimeout: 300000, maxRetries: 5, concurrency: 3, maxParallelAgents: 3,
        maxRounds: 5, maxAgents: 10
      };
    }
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

describe('SDK Health API', () => {
  beforeAll(done => {
    process.env.PORT = TEST_PORT;
    Object.keys(require.cache).forEach(key => {
      if (key.includes('server.js')) delete require.cache[key];
    });
    try {
      require('../../server');
      setTimeout(done, 500);
    } catch (e) { done(e); }
  });

  afterAll(async () => {
    const serverMod = require('../../server');
    if (serverMod && serverMod.cleanup) await serverMod.cleanup();
  });

  test('GET /api/health enthaelt sdk-Info', async () => {
    const res = await request('GET', '/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('sdk');
  });

  test('SDK-Info hat mode-Feld', async () => {
    const res = await request('GET', '/api/health');
    expect(res.body.sdk).toHaveProperty('mode');
    expect(['cli', 'sdk', 'auto']).toContain(res.body.sdk.mode);
  });

  test('SDK-Info hat available-Feld', async () => {
    const res = await request('GET', '/api/health');
    expect(res.body.sdk).toHaveProperty('available');
  });

  test('SDK-Info hat info-Objekt', async () => {
    const res = await request('GET', '/api/health');
    expect(res.body.sdk).toHaveProperty('info');
  });

  test('GET /health enthaelt auch sdk-Info', async () => {
    const res = await request('GET', '/health');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('sdk');
  });
});
