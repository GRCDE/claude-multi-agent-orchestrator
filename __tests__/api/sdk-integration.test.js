// SDK Integration API - Tests
// Testet SDK-Modus Umschaltung und Integration ueber API

'use strict';
const http = require('http');

const TEST_PORT = 3280;

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
        agentTimeout: 300000, maxRetries: 5, concurrency: 3,
        maxParallelAgents: 3, maxRounds: 5, maxAgents: 10,
        tokenBudget: 0, warnTokenBudget: 0,
        inputCostPerMTok: 3, outputCostPerMTok: 15,
      };
    }
    updateConfig(patch) {
      if (patch.claudeMode !== undefined) {
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

describe('SDK Integration', () => {
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

  test('Config und Health zeigen gleichen claudeMode', async () => {
    const config = await request('GET', '/api/config');
    const health = await request('GET', '/api/health');
    expect(config.body.claudeMode).toBeDefined();
    if (health.body.sdk) {
      expect(health.body.sdk.mode).toBe(config.body.claudeMode);
    }
  });

  test('claudeMode Wechsel von cli zu auto und zurueck', async () => {
    await request('POST', '/api/config', { claudeMode: 'auto' });
    let config = await request('GET', '/api/config');
    expect(config.body.claudeMode).toBe('auto');

    await request('POST', '/api/config', { claudeMode: 'cli' });
    config = await request('GET', '/api/config');
    expect(config.body.claudeMode).toBe('cli');
  });

  test('claudeMode aendert nicht andere Config-Werte', async () => {
    const before = await request('GET', '/api/config');
    await request('POST', '/api/config', { claudeMode: 'sdk' });
    const after = await request('GET', '/api/config');
    expect(after.body.maxRounds).toBe(before.body.maxRounds);
    expect(after.body.maxAgents).toBe(before.body.maxAgents);
  });

  test('sdkInfo ist in Config vorhanden', async () => {
    const res = await request('GET', '/api/config');
    expect(res.body.sdkInfo).toBeDefined();
    expect(typeof res.body.sdkInfo.available).toBe('boolean');
    expect(typeof res.body.sdkInfo.detected).toBe('boolean');
  });

  test('Status-Endpoint funktioniert im SDK-Modus', async () => {
    await request('POST', '/api/config', { claudeMode: 'sdk' });
    const status = await request('GET', '/api/status');
    expect(status.status).toBe(200);
    // Zuruecksetzen
    await request('POST', '/api/config', { claudeMode: 'cli' });
  });
});
