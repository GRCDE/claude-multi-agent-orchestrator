// Queue Reorder API - Tests
// Testet POST /api/queue/reorder

'use strict';
const http = require('http');

const TEST_PORT = 3218;

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

describe('Queue Reorder API', () => {
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

  async function makeRunning() {
    await request('POST', '/api/start', { description: 'Laufendes Projekt', agentCount: 2 });
    await new Promise(r => setTimeout(r, 50));
  }

  async function resetState() {
    await request('POST', '/api/queue/clear');
    await request('POST', '/api/reset');
    await new Promise(r => setTimeout(r, 50));
  }

  async function fillQueue(count) {
    for (let i = 0; i < count; i++) {
      await request('POST', '/api/start', {
        description: 'Projekt ' + (i + 1),
        agentCount: 2
      });
    }
    await new Promise(r => setTimeout(r, 50));
  }

  test('POST /api/queue/reorder verschiebt Items korrekt (0 nach 2)', async () => {
    await resetState();
    await makeRunning();
    await fillQueue(3);

    // Verifiziere Queue hat 3 Items
    const before = await request('GET', '/api/queue');
    expect(before.body.length).toBe(3);
    expect(before.body[0].description).toBe('Projekt 1');
    expect(before.body[1].description).toBe('Projekt 2');
    expect(before.body[2].description).toBe('Projekt 3');

    // Verschiebe Item 0 nach Position 2
    const res = await request('POST', '/api/queue/reorder', { from: 0, to: 2 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // Pruefe neue Reihenfolge
    const after = await request('GET', '/api/queue');
    expect(after.body[0].description).toBe('Projekt 2');
    expect(after.body[1].description).toBe('Projekt 3');
    expect(after.body[2].description).toBe('Projekt 1');

    await resetState();
  });

  afterAll(async () => {
    const serverMod = require('../../server');
    if (serverMod && serverMod.cleanup) await serverMod.cleanup();
  });

  test('POST /api/queue/reorder verschiebt Items korrekt (2 nach 0)', async () => {
    await resetState();
    await makeRunning();
    await fillQueue(3);

    const res = await request('POST', '/api/queue/reorder', { from: 2, to: 0 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const after = await request('GET', '/api/queue');
    expect(after.body[0].description).toBe('Projekt 3');
    expect(after.body[1].description).toBe('Projekt 1');
    expect(after.body[2].description).toBe('Projekt 2');

    await resetState();
  });

  test('Ungueltige Indizes geben 400 (from zu gross)', async () => {
    await resetState();
    await makeRunning();
    await fillQueue(2);

    const res = await request('POST', '/api/queue/reorder', { from: 99, to: 0 });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Ungültige Indizes');

    await resetState();
  });

  test('Ungueltige Indizes geben 400 (negative Werte)', async () => {
    await resetState();
    await makeRunning();
    await fillQueue(2);

    const res = await request('POST', '/api/queue/reorder', { from: -1, to: 0 });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Ungültige Indizes');

    await resetState();
  });

  test('Ungueltige Indizes geben 400 (from === to)', async () => {
    await resetState();
    await makeRunning();
    await fillQueue(2);

    const res = await request('POST', '/api/queue/reorder', { from: 0, to: 0 });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Ungültige Indizes');

    await resetState();
  });

  test('Leere Queue gibt 400 bei reorder', async () => {
    await resetState();

    const res = await request('POST', '/api/queue/reorder', { from: 0, to: 1 });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Ungültige Indizes');
  });

  test('Reorder gibt aktualisierte Queue mit Positionen zurueck', async () => {
    await resetState();
    await makeRunning();
    await fillQueue(3);

    const res = await request('POST', '/api/queue/reorder', { from: 0, to: 1 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.queue)).toBe(true);
    expect(res.body.queue.length).toBe(3);
    // Positionen pruefen (1-basiert)
    expect(res.body.queue[0].position).toBe(1);
    expect(res.body.queue[1].position).toBe(2);
    expect(res.body.queue[2].position).toBe(3);

    await resetState();
  });
});
