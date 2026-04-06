// Intervention API - Tests
// Testet POST /api/intervene/:agentIndex, POST /api/retry/:agentIndex,
// POST /api/approve, POST /api/modify-plan Endpoints

'use strict';
const http = require('http');

const TEST_PORT = 3237;

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

// Mock orchestrator mit allen benoetigten Methoden
let mockSetIntervention;
let mockRetryAgent;
let mockApprovePlan;
let mockModifyPlan;

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
    approvePlan(...args) {
      if (mockApprovePlan) return mockApprovePlan(...args);
      throw new Error('Kein Plan wartet auf Genehmigung');
    }
    modifyPlan(...args) {
      if (mockModifyPlan) return mockModifyPlan(...args);
      throw new Error('Kein Plan wartet auf Genehmigung');
    }
    retryAgent(...args) {
      if (mockRetryAgent) return mockRetryAgent(...args);
      return Promise.resolve();
    }
    setIntervention(...args) {
      if (mockSetIntervention) return mockSetIntervention(...args);
    }
    loadProject() { return this.getState(); }
    resume() { return Promise.resolve(); }
  }
  return MockOrchestrator;
});

describe('Intervention API', () => {
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

  afterAll(async () => {
    const serverMod = require('../../server');
    if (serverMod && serverMod.cleanup) await serverMod.cleanup();
  });

  beforeEach(() => {
    mockSetIntervention = null;
    mockRetryAgent = null;
    mockApprovePlan = null;
    mockModifyPlan = null;
  });

  // ── POST /api/intervene/:agentIndex ──────────────────────────

  test('POST /api/intervene mit gueltigem redirect-Typ gibt ok zurueck', async () => {
    mockSetIntervention = jest.fn();
    const res = await request('POST', '/api/intervene/0', {
      message: 'Bitte aendere den Ansatz',
      type: 'redirect'
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.type).toBe('redirect');
    expect(mockSetIntervention).toHaveBeenCalledWith(0, 'Bitte aendere den Ansatz', 'redirect');
  });

  test('POST /api/intervene ohne Typ nutzt redirect als Default', async () => {
    mockSetIntervention = jest.fn();
    const res = await request('POST', '/api/intervene/1', {
      message: 'Neue Anweisung'
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.type).toBe('redirect');
    expect(mockSetIntervention).toHaveBeenCalledWith(1, 'Neue Anweisung', 'redirect');
  });

  test('POST /api/intervene mit ungueltigem Index gibt 400', async () => {
    const res = await request('POST', '/api/intervene/abc', {
      message: 'Test', type: 'redirect'
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Ungültiger Index/);
  });

  test('POST /api/intervene mit ungueltigem Typ gibt 400', async () => {
    const res = await request('POST', '/api/intervene/0', {
      message: 'Test', type: 'invalid_type'
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Ungültiger Intervention-Typ/);
  });

  test('POST /api/intervene redirect ohne Nachricht gibt 400', async () => {
    const res = await request('POST', '/api/intervene/0', {
      type: 'redirect'
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Nachricht ist erforderlich/);
  });

  test('POST /api/intervene skip ohne Nachricht funktioniert', async () => {
    mockSetIntervention = jest.fn();
    const res = await request('POST', '/api/intervene/2', {
      type: 'skip'
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.type).toBe('skip');
    expect(mockSetIntervention).toHaveBeenCalledWith(2, '', 'skip');
  });

  test('POST /api/intervene mit zu langer Nachricht gibt 400', async () => {
    const longMessage = 'x'.repeat(2001);
    const res = await request('POST', '/api/intervene/0', {
      message: longMessage, type: 'redirect'
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/maximal 2000 Zeichen/);
  });

  // ── POST /api/retry/:agentIndex ──────────────────────────────

  test('POST /api/retry mit gueltigem Index gibt ok zurueck', async () => {
    mockRetryAgent = jest.fn().mockResolvedValue();
    const res = await request('POST', '/api/retry/0');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  // ── POST /api/approve ────────────────────────────────────────

  test('POST /api/approve gibt 400 wenn kein Plan auf Genehmigung wartet', async () => {
    const res = await request('POST', '/api/approve');
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });

  // ── POST /api/modify-plan ────────────────────────────────────

  test('POST /api/modify-plan ohne Tasks gibt 400', async () => {
    const res = await request('POST', '/api/modify-plan', { tasks: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/nicht-leeres Array/);
  });
});
