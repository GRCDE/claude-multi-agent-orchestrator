// Queue API - Tests
// Testet GET /api/queue, DELETE /api/queue/:index, POST /api/queue/clear

'use strict';
const http = require('http');

const TEST_PORT = 3207;

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

// Disable rate limiting for tests
jest.mock('express-rate-limit', () => {
  return () => (req, res, next) => next();
});

// Mock orchestrator so start() doesn't actually spawn processes
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
    start() {
      this.phase = 'running';
      return Promise.resolve();
    }
    reset() {
      this.phase = 'idle';
      this.agents = [];
    }
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

describe('Queue API', () => {
  beforeAll(done => {
    process.env.PORT = TEST_PORT;
    // Clear server cache to pick up fresh mocks
    Object.keys(require.cache).forEach(key => {
      if (key.includes('server.js')) {
        delete require.cache[key];
      }
    });

    try {
      require('../../server');
      setTimeout(done, 500);
    } catch (e) {
      done(e);
    }
  });

  // Helper to set orchestrator to running state
  async function makeRunning() {
    await request('POST', '/api/start', { description: 'Laufendes Projekt', agentCount: 2 });
    await new Promise(r => setTimeout(r, 50));
  }

  // Helper to reset to idle
  async function resetState() {
    await request('POST', '/api/queue/clear');
    await request('POST', '/api/reset');
    await new Promise(r => setTimeout(r, 50));
  }

  test('GET /api/queue gibt leeres Array zurueck (initial)', async () => {
    await resetState();
    const res = await request('GET', '/api/queue');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(0);
  });

  test('POST /api/start mit laufendem Projekt reiht in Queue ein', async () => {
    await resetState();
    await makeRunning();

    const res = await request('POST', '/api/start', {
      description: 'Queued Projekt Test',
      agentCount: 3
    });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.queued).toBe(true);
    expect(res.body.position).toBe(1);

    await resetState();
  });

  test('GET /api/queue zeigt eingereihte Projekte mit Position', async () => {
    await resetState();
    await makeRunning();

    await request('POST', '/api/start', { description: 'Erstes Queued', agentCount: 2 });
    await request('POST', '/api/start', { description: 'Zweites Queued', agentCount: 4 });

    const res = await request('GET', '/api/queue');
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(2);
    expect(res.body[0]).toHaveProperty('description', 'Erstes Queued');
    expect(res.body[0]).toHaveProperty('agentCount', 2);
    expect(res.body[0]).toHaveProperty('queuedAt');
    expect(res.body[0]).toHaveProperty('position', 1);
    expect(res.body[1]).toHaveProperty('description', 'Zweites Queued');
    expect(res.body[1]).toHaveProperty('position', 2);

    await resetState();
  });

  test('DELETE /api/queue/:index entfernt korrektes Element', async () => {
    await resetState();
    await makeRunning();

    await request('POST', '/api/start', { description: 'Erstes Projekt', agentCount: 2 });
    await request('POST', '/api/start', { description: 'Zweites Projekt', agentCount: 3 });

    const delRes = await request('DELETE', '/api/queue/0');
    expect(delRes.status).toBe(200);
    expect(delRes.body.ok).toBe(true);
    expect(delRes.body.removed).toHaveProperty('description', 'Erstes Projekt');

    const queueRes = await request('GET', '/api/queue');
    expect(queueRes.body.length).toBe(1);
    expect(queueRes.body[0].description).toBe('Zweites Projekt');

    await resetState();
  });

  test('DELETE /api/queue/:index mit ungueltigem Index gibt 400', async () => {
    const res = await request('DELETE', '/api/queue/999');
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });

  test('POST /api/queue/clear leert die gesamte Queue', async () => {
    await resetState();
    await makeRunning();

    await request('POST', '/api/start', { description: 'Zum Loeschen 1', agentCount: 2 });
    await request('POST', '/api/start', { description: 'Zum Loeschen 2', agentCount: 2 });

    const clearRes = await request('POST', '/api/queue/clear');
    expect(clearRes.status).toBe(200);
    expect(clearRes.body.ok).toBe(true);
    expect(clearRes.body.cleared).toBe(2);

    const queueRes = await request('GET', '/api/queue');
    expect(queueRes.body.length).toBe(0);

    await resetState();
  });

  test('POST /api/start Validierung greift vor Queue-Einreihung', async () => {
    await resetState();
    await makeRunning();

    const res = await request('POST', '/api/start', { agentCount: 2 });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');

    const queueRes = await request('GET', '/api/queue');
    expect(queueRes.body.length).toBe(0);

    await resetState();
  });

  afterAll(async () => {
    const serverMod = require('../../server');
    if (serverMod && serverMod.cleanup) await serverMod.cleanup();
  });
});
