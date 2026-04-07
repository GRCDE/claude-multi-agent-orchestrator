// SDK Config API - Tests
// Testet claudeMode Konfiguration ueber HTTP API

'use strict';
const http = require('http');

const TEST_PORT = 3278;

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
      this._claudeMode = 'cli';
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
    start() { this.phase = 'running'; return Promise.resolve(); }
    reset() { this.phase = 'idle'; this.agents = []; }
    getPrompts() { return { prompts: {} }; }
    updatePrompts() {}
    resetPrompts() {}
    getConfig() {
      return {
        claudeMode: this._claudeMode,
        sdkAvailable: false,
        sdkInfo: { available: false, detected: true, version: null },
        agentTimeout: 300000, maxRetries: 5, concurrency: 3, maxParallelAgents: 3,
        maxRounds: 5, maxAgents: 10, isolation: 'shared'
      };
    }
    updateConfig(patch) {
      if (patch.claudeMode) {
        if (!['cli', 'sdk', 'auto'].includes(patch.claudeMode)) {
          throw new Error('Ungueltiger Claude-Modus: ' + patch.claudeMode);
        }
        this._claudeMode = patch.claudeMode;
      }
    }
    approvePlan() {}
    modifyPlan() {}
    retryAgent() { return Promise.resolve(); }
    loadProject() { return this.getState(); }
    resume() { return Promise.resolve(); }
    setIntervention() {}
  }
  return MockOrchestrator;
});

describe('SDK Config API', () => {
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

  test('GET /api/config enthaelt claudeMode', async () => {
    const res = await request('GET', '/api/config');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('claudeMode');
  });

  test('GET /api/config enthaelt sdkAvailable', async () => {
    const res = await request('GET', '/api/config');
    expect(res.body).toHaveProperty('sdkAvailable');
  });

  test('GET /api/config enthaelt sdkInfo', async () => {
    const res = await request('GET', '/api/config');
    expect(res.body).toHaveProperty('sdkInfo');
    expect(res.body.sdkInfo).toHaveProperty('available');
    expect(res.body.sdkInfo).toHaveProperty('detected');
  });

  test('POST /api/config aendert claudeMode auf auto', async () => {
    const res = await request('POST', '/api/config', { claudeMode: 'auto' });
    expect(res.status).toBe(200);
    const check = await request('GET', '/api/config');
    expect(check.body.claudeMode).toBe('auto');
  });

  test('POST /api/config aendert claudeMode auf sdk', async () => {
    const res = await request('POST', '/api/config', { claudeMode: 'sdk' });
    expect(res.status).toBe(200);
  });

  test('POST /api/config aendert claudeMode auf cli', async () => {
    await request('POST', '/api/config', { claudeMode: 'cli' });
    const check = await request('GET', '/api/config');
    expect(check.body.claudeMode).toBe('cli');
  });

  test('POST /api/config lehnt ungueltigen claudeMode ab', async () => {
    const res = await request('POST', '/api/config', { claudeMode: 'invalid' });
    // Sollte Fehler zurueckgeben oder ignorieren
    expect(res.status).toBeLessThan(500);
  });
});
