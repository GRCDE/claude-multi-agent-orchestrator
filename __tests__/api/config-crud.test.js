// Config CRUD API - Tests
// Testet GET /api/config, POST /api/config, POST /api/config/undo, POST /api/config/redo, GET /api/undo-redo

'use strict';
const http = require('http');

const TEST_PORT = 3242;

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

// Stateful mock mit Undo/Redo
const configState = {
  current: {
    agentTimeout: 300000,
    maxRetries: 5,
    retryBaseDelay: 5000,
    maxAgents: 10,
    concurrency: 3,
    maxParallelAgents: 3,
    maxRounds: 5,
    isolation: 'shared',
    webhookUrl: '',
    tokenBudget: 0,
    warnTokenBudget: 0,
    inputCostPerMTok: 3,
    outputCostPerMTok: 15,
    verifyAgents: false,
    autoInterventionEnabled: false,
    autoInterventionRounds: 10,
    interimReportInterval: 3,
    language: 'de',
  },
  undoStack: [],
  redoStack: [],
};

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
    getConfig() {
      return { ...configState.current };
    }
    updateConfig(patch) {
      // Snapshot fuer Undo
      configState.undoStack.push({ ...configState.current });
      configState.redoStack = [];
      // Patch anwenden
      for (const [key, val] of Object.entries(patch)) {
        if (key in configState.current) {
          configState.current[key] = val;
        }
      }
    }
    undoConfig() {
      if (configState.undoStack.length === 0) {
        throw new Error('Kein Config-Undo verfuegbar');
      }
      configState.redoStack.push({ ...configState.current });
      configState.current = configState.undoStack.pop();
      return this.getConfig();
    }
    redoConfig() {
      if (configState.redoStack.length === 0) {
        throw new Error('Kein Config-Redo verfuegbar');
      }
      configState.undoStack.push({ ...configState.current });
      configState.current = configState.redoStack.pop();
      return this.getConfig();
    }
    getUndoRedoStatus() {
      return {
        config: {
          canUndo: configState.undoStack.length > 0,
          canRedo: configState.redoStack.length > 0,
          undoCount: configState.undoStack.length,
          redoCount: configState.redoStack.length,
        },
        plan: {
          canUndo: false,
          canRedo: false,
          undoCount: 0,
          redoCount: 0,
        },
      };
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

describe('Config CRUD API', () => {
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

  // Reset state vor jedem Test
  beforeEach(() => {
    configState.current = {
      agentTimeout: 300000,
      maxRetries: 5,
      retryBaseDelay: 5000,
      maxAgents: 10,
      concurrency: 3,
      maxParallelAgents: 3,
      maxRounds: 5,
      isolation: 'shared',
      webhookUrl: '',
      tokenBudget: 0,
      warnTokenBudget: 0,
      inputCostPerMTok: 3,
      outputCostPerMTok: 15,
      verifyAgents: false,
      autoInterventionEnabled: false,
      autoInterventionRounds: 10,
      interimReportInterval: 3,
      language: 'de',
    };
    configState.undoStack = [];
    configState.redoStack = [];
  });

  test('GET /api/config gibt aktuelle Konfiguration zurueck', async () => {
    const res = await request('GET', '/api/config');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('maxAgents', 10);
    expect(res.body).toHaveProperty('maxRounds', 5);
    expect(res.body).toHaveProperty('concurrency', 3);
  });

  test('POST /api/config aendert Konfiguration', async () => {
    const res = await request('POST', '/api/config', { maxAgents: 5 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.config.maxAgents).toBe(5);

    // Pruefen dass der Wert persistiert
    const check = await request('GET', '/api/config');
    expect(check.body.maxAgents).toBe(5);
  });

  test('POST /api/config aendert mehrere Felder gleichzeitig', async () => {
    const res = await request('POST', '/api/config', { maxAgents: 7, maxRounds: 8 });
    expect(res.status).toBe(200);
    expect(res.body.config.maxAgents).toBe(7);
    expect(res.body.config.maxRounds).toBe(8);
  });

  test('POST /api/config/undo macht letzte Aenderung rueckgaengig', async () => {
    // Ausgangszustand: maxAgents=10
    await request('POST', '/api/config', { maxAgents: 5 });
    // Jetzt maxAgents=5

    const res = await request('POST', '/api/config/undo');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.config.maxAgents).toBe(10);
  });

  test('POST /api/config/redo stellt rueckgaengig gemachte Aenderung wieder her', async () => {
    await request('POST', '/api/config', { maxAgents: 5 });
    await request('POST', '/api/config/undo');
    // maxAgents wieder 10

    const res = await request('POST', '/api/config/redo');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.config.maxAgents).toBe(5);
  });

  test('POST /api/config/undo ohne History gibt Fehler', async () => {
    const res = await request('POST', '/api/config/undo');
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });

  test('POST /api/config/redo ohne History gibt Fehler', async () => {
    const res = await request('POST', '/api/config/redo');
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });

  test('Kompletter Workflow: Config lesen, aendern, undo, redo, Status', async () => {
    // 1. Config lesen (Ausgangszustand)
    const initial = await request('GET', '/api/config');
    expect(initial.body.maxAgents).toBe(10);
    expect(initial.body.maxRounds).toBe(5);

    // 2. Config aendern (maxAgents auf 5)
    const change1 = await request('POST', '/api/config', { maxAgents: 5 });
    expect(change1.body.config.maxAgents).toBe(5);

    // 3. Config erneut aendern (maxRounds auf 3)
    const change2 = await request('POST', '/api/config', { maxRounds: 3 });
    expect(change2.body.config.maxRounds).toBe(3);
    expect(change2.body.config.maxAgents).toBe(5); // bleibt

    // 4. Undo (maxRounds zurueck auf 5)
    const undo1 = await request('POST', '/api/config/undo');
    expect(undo1.body.config.maxRounds).toBe(5);
    expect(undo1.body.config.maxAgents).toBe(5); // bleibt bei 5

    // 5. Redo (maxRounds wieder auf 3)
    const redo1 = await request('POST', '/api/config/redo');
    expect(redo1.body.config.maxRounds).toBe(3);

    // 6. Undo-Redo Status pruefen
    const status = await request('GET', '/api/undo-redo');
    expect(status.status).toBe(200);
    expect(status.body.config).toHaveProperty('canUndo');
    expect(status.body.config).toHaveProperty('canRedo');
    expect(status.body.config.canUndo).toBe(true);  // 1 Undo noch (maxAgents)
    expect(status.body.config.canRedo).toBe(false);  // Redo verbraucht
    expect(status.body.config.undoCount).toBe(2);
    expect(status.body.config.redoCount).toBe(0);
  });
});
