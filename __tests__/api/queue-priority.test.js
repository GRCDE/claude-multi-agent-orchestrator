// Queue-Priorität und Reorder - API Tests
// Testet Sortierung nach Priorität, Reorder-Endpoint und geschätzte Wartezeit

'use strict';
const http = require('http');

const TEST_PORT = 3214;

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

describe('Queue Priority & Reorder API', () => {
  beforeAll(done => {
    process.env.PORT = TEST_PORT;
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

  async function makeRunning() {
    await request('POST', '/api/start', { description: 'Laufendes Projekt', agentCount: 2 });
    await new Promise(r => setTimeout(r, 50));
  }

  async function resetState() {
    await request('POST', '/api/queue/clear');
    await request('POST', '/api/reset');
    await new Promise(r => setTimeout(r, 50));
  }

  test('Queue sortiert nach Prioritaet (1=hoch zuerst)', async () => {
    await resetState();
    await makeRunning();

    // Drei Projekte mit verschiedenen Prioritäten einreihen
    await request('POST', '/api/start', {
      description: 'Niedrige Prio', agentCount: 2, priority: 3
    });
    await request('POST', '/api/start', {
      description: 'Hohe Prio', agentCount: 2, priority: 1
    });
    await request('POST', '/api/start', {
      description: 'Mittlere Prio', agentCount: 2, priority: 2
    });

    const res = await request('GET', '/api/queue');
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(3);

    // Hohe Prio (1) muss zuerst sein
    expect(res.body[0].description).toBe('Hohe Prio');
    expect(res.body[0].priority).toBe(1);

    // Dann mittlere (2)
    expect(res.body[1].description).toBe('Mittlere Prio');
    expect(res.body[1].priority).toBe(2);

    // Dann niedrige (3)
    expect(res.body[2].description).toBe('Niedrige Prio');
    expect(res.body[2].priority).toBe(3);

    await resetState();
  });

  afterAll(async () => {
    const serverMod = require('../../server');
    if (serverMod && serverMod.cleanup) await serverMod.cleanup();
  });

  test('POST /api/queue/reorder verschiebt Element korrekt', async () => {
    await resetState();
    await makeRunning();

    await request('POST', '/api/start', {
      description: 'Erstes', agentCount: 2, priority: 2
    });
    await request('POST', '/api/start', {
      description: 'Zweites', agentCount: 2, priority: 2
    });
    await request('POST', '/api/start', {
      description: 'Drittes', agentCount: 2, priority: 2
    });

    // Drittes (Index 2) an erste Stelle (Index 0) schieben
    const reorderRes = await request('POST', '/api/queue/reorder', { from: 2, to: 0 });
    expect(reorderRes.status).toBe(200);
    expect(reorderRes.body.ok).toBe(true);

    // Queue prüfen
    expect(reorderRes.body.queue[0].description).toBe('Drittes');
    expect(reorderRes.body.queue[0].position).toBe(1);
    expect(reorderRes.body.queue[1].description).toBe('Erstes');
    expect(reorderRes.body.queue[2].description).toBe('Zweites');

    await resetState();
  });

  test('POST /api/queue/reorder mit ungueltigen Indizes gibt 400', async () => {
    await resetState();
    await makeRunning();

    await request('POST', '/api/start', {
      description: 'Einziges', agentCount: 2
    });

    // Gleicher Index
    const sameRes = await request('POST', '/api/queue/reorder', { from: 0, to: 0 });
    expect(sameRes.status).toBe(400);

    // Index ausserhalb der Queue
    const outRes = await request('POST', '/api/queue/reorder', { from: 0, to: 99 });
    expect(outRes.status).toBe(400);

    // Negative Indizes
    const negRes = await request('POST', '/api/queue/reorder', { from: -1, to: 0 });
    expect(negRes.status).toBe(400);

    await resetState();
  });

  test('Geschaetzte Wartezeit wird berechnet', async () => {
    await resetState();
    await makeRunning();

    await request('POST', '/api/start', {
      description: 'Warte-Projekt 1', agentCount: 2
    });
    await request('POST', '/api/start', {
      description: 'Warte-Projekt 2', agentCount: 2
    });

    const res = await request('GET', '/api/queue');
    expect(res.status).toBe(200);

    // Jedes Element muss eine estimatedWaitTime haben
    expect(res.body[0]).toHaveProperty('estimatedWaitTime');
    expect(res.body[1]).toHaveProperty('estimatedWaitTime');

    // Zweites Projekt wartet laenger als erstes
    expect(res.body[1].estimatedWaitTime).toBeGreaterThan(res.body[0].estimatedWaitTime);

    // Wartezeit muss positiv sein
    expect(res.body[0].estimatedWaitTime).toBeGreaterThan(0);

    await resetState();
  });

  test('Position ist 1-basiert', async () => {
    await resetState();
    await makeRunning();

    await request('POST', '/api/start', {
      description: 'Position-Test 1', agentCount: 2
    });
    await request('POST', '/api/start', {
      description: 'Position-Test 2', agentCount: 2
    });

    const res = await request('GET', '/api/queue');
    expect(res.body[0].position).toBe(1);
    expect(res.body[1].position).toBe(2);

    // Auch beim Einreihen ist Position 1-basiert
    const addRes = await request('POST', '/api/start', {
      description: 'Position-Test 3', agentCount: 2
    });
    expect(addRes.body.position).toBeGreaterThanOrEqual(1);

    await resetState();
  });

  test('Default-Prioritaet ist 2 (mittel)', async () => {
    await resetState();
    await makeRunning();

    // Ohne priority-Parameter
    await request('POST', '/api/start', {
      description: 'Ohne Prio', agentCount: 2
    });

    const res = await request('GET', '/api/queue');
    expect(res.body[0].priority).toBe(2);

    await resetState();
  });

  test('Ungueltige Prioritaet wird auf 2 gesetzt', async () => {
    await resetState();
    await makeRunning();

    await request('POST', '/api/start', {
      description: 'Ungueltige Prio', agentCount: 2, priority: 99
    });

    const res = await request('GET', '/api/queue');
    expect(res.body[0].priority).toBe(2);

    await resetState();
  });
});
