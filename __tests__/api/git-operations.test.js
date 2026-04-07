// Git Operations API - Tests
// Testet Git-Operations Endpoints (Commit, Push, Checkout, Init)

'use strict';
const http = require('http');

const TEST_PORT = 3283;

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
  execSync: jest.fn((cmd) => {
    if (cmd.includes('claude')) return 'claude 1.0.0';
    if (cmd.includes('git --version')) return 'git version 2.40.0';
    throw new Error('Command not found');
  }),
}));

jest.mock('express-rate-limit', () => {
  return () => (req, res, next) => next();
});

jest.mock('../../orchestrator', () => {
  const EventEmitter = require('events').EventEmitter;
  const GitIntegration = require('../../src/git-integration');
  class MockOrchestrator extends EventEmitter {
    constructor() {
      super();
      this.phase = 'idle';
      this.agents = [];
      this.gitIntegration = new GitIntegration({ enabled: false });
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
        claudeMode: 'cli', sdkAvailable: false,
        sdkInfo: { available: false, detected: true, version: null },
        git: this.gitIntegration.getConfig(),
        agentTimeout: 300000, maxRetries: 5, concurrency: 3,
        maxParallelAgents: 3, maxRounds: 5, maxAgents: 10,
      };
    }
    updateConfig(patch) {
      if (patch.git) this.gitIntegration.updateConfig(patch.git);
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

describe('Git Operations API', () => {
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

  test('POST /api/git/commit erfordert aktivierte Integration', async () => {
    const res = await request('POST', '/api/git/commit', { message: 'Test' });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  test('POST /api/git/push erfordert aktivierte Integration', async () => {
    const res = await request('POST', '/api/git/push');
    expect(res.status).toBe(400);
  });

  test('POST /api/git/checkout erfordert aktivierte Integration', async () => {
    const res = await request('POST', '/api/git/checkout', { branch: 'main' });
    expect(res.status).toBe(400);
  });

  test('POST /api/git/checkout erfordert Branch-Name', async () => {
    // Aktiviere Git
    await request('POST', '/api/git/config', { enabled: true });
    const res = await request('POST', '/api/git/checkout', {});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Branch/i);
  });

  test('GET /api/git/diff/:hash gibt Ergebnis zurueck', async () => {
    const res = await request('GET', '/api/git/diff/abc1234');
    expect(res.status).toBe(200);
  });

  test('POST /api/git/config akzeptiert alle Felder', async () => {
    const res = await request('POST', '/api/git/config', {
      enabled: true,
      autoCommit: false,
      branchPerProject: false,
      autoPush: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test('GET /api/git/config reflektiert Aenderungen', async () => {
    await request('POST', '/api/git/config', { enabled: true, autoPush: true });
    const res = await request('GET', '/api/git/config');
    expect(res.body.enabled).toBe(true);
    expect(res.body.autoPush).toBe(true);
  });
});
