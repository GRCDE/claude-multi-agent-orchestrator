// Logs API - Tests
// Testet GET /api/logs, GET /api/logs/files, GET /api/logs/export

'use strict';
const http = require('http');

const TEST_PORT = 3241;

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
        try { resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, headers: res.headers, body: data }); }
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

describe('Logs API', () => {
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

  test('GET /api/logs gibt paginierte Ergebnisse zurueck', async () => {
    const res = await request('GET', '/api/logs');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('entries');
    expect(res.body).toHaveProperty('total');
    expect(res.body).toHaveProperty('offset');
    expect(res.body).toHaveProperty('limit');
    expect(Array.isArray(res.body.entries)).toBe(true);
    expect(typeof res.body.total).toBe('number');
  });

  test('GET /api/logs?level=error filtert nach Level', async () => {
    const res = await request('GET', '/api/logs?level=error');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.entries)).toBe(true);
    // Alle zurueckgegebenen Eintraege muessen Level "error" haben
    for (const entry of res.body.entries) {
      expect(entry.level).toBe('error');
    }
  });

  test('GET /api/logs?search=test sucht in Nachrichten', async () => {
    const res = await request('GET', '/api/logs?search=test');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.entries)).toBe(true);
    // Alle Ergebnisse muessen "test" in message, category oder metadata enthalten
    for (const entry of res.body.entries) {
      const combined = [
        (entry.message || ''),
        (entry.category || ''),
        entry.metadata ? JSON.stringify(entry.metadata) : ''
      ].join(' ').toLowerCase();
      expect(combined).toContain('test');
    }
  });

  test('GET /api/logs respektiert offset und limit', async () => {
    const res = await request('GET', '/api/logs?offset=0&limit=5');
    expect(res.status).toBe(200);
    expect(res.body.offset).toBe(0);
    expect(res.body.limit).toBe(5);
    expect(res.body.entries.length).toBeLessThanOrEqual(5);
  });

  test('GET /api/logs/files gibt Array von Dateien zurueck', async () => {
    const res = await request('GET', '/api/logs/files');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    // Jede Datei sollte name, size, created haben (falls vorhanden)
    for (const file of res.body) {
      expect(file).toHaveProperty('name');
      expect(file).toHaveProperty('size');
    }
  });

  test('GET /api/logs/export gibt JSONL Content-Type', async () => {
    const res = await request('GET', '/api/logs/export');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/jsonl/);
    expect(res.headers['content-disposition']).toMatch(/attachment/);
    expect(res.headers['content-disposition']).toMatch(/\.jsonl/);
  });
});
