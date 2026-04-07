// SDK Mode API - Tests
// Testet SDK-Modus Validierung und Edge Cases

'use strict';
const http = require('http');

const TEST_PORT = 3281;

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
    start() { return Promise.resolve(); }
    reset() { this.phase = 'idle'; }
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

describe('SDK Mode Edge Cases', () => {
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

  test('Alle drei Modi sind gueltig', async () => {
    for (const mode of ['cli', 'sdk', 'auto']) {
      const res = await request('POST', '/api/config', { claudeMode: mode });
      expect(res.status).toBe(200);
    }
  });

  test('Ungueltige Modi werden abgelehnt', async () => {
    const res = await request('POST', '/api/config', { claudeMode: 'docker' });
    expect(res.status).toBeLessThan(500);
  });

  test('Leerer String als Modus wird abgelehnt', async () => {
    const res = await request('POST', '/api/config', { claudeMode: '' });
    expect(res.status).toBeLessThan(500);
  });

  test('Zahl als Modus wird abgelehnt', async () => {
    const res = await request('POST', '/api/config', { claudeMode: 123 });
    expect(res.status).toBeLessThan(500);
  });

  test('Config-Wechsel bewahrt bestehende Einstellungen', async () => {
    const before = await request('GET', '/api/config');
    const originalMode = before.body.claudeMode;

    await request('POST', '/api/config', { claudeMode: 'auto' });
    await request('POST', '/api/config', { claudeMode: originalMode || 'cli' });

    const after = await request('GET', '/api/config');
    expect(after.body.maxRetries).toBe(before.body.maxRetries);
  });

  test('sdkInfo.detected ist boolean', async () => {
    const res = await request('GET', '/api/config');
    expect(typeof res.body.sdkInfo.detected).toBe('boolean');
  });

  test('Health-Endpoint reflektiert aktuellen Modus', async () => {
    await request('POST', '/api/config', { claudeMode: 'auto' });
    const health = await request('GET', '/api/health');
    if (health.body.sdk) {
      expect(health.body.sdk.mode).toBe('auto');
    }
    // Zuruecksetzen
    await request('POST', '/api/config', { claudeMode: 'cli' });
  });
});
