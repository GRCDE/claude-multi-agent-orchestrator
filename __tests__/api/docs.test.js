'use strict';

const http = require('http');

const TEST_PORT = 3226;

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
        try { resolve({ status: res.statusCode, body: JSON.parse(data), raw: data, headers: res.headers }); }
        catch { resolve({ status: res.statusCode, body: data, raw: data, headers: res.headers }); }
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

describe('API Docs Endpoints', () => {
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

  test('GET /api/docs/json gibt 200 und Dokumentations-Objekt zurueck', async () => {
    const res = await request('GET', '/api/docs/json');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('categories');
    expect(res.body).toHaveProperty('title');
    expect(res.body).toHaveProperty('version');
  });

  test('GET /api/docs/openapi hat openapi-Feld und paths', async () => {
    const res = await request('GET', '/api/docs/openapi');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('openapi');
    expect(res.body.openapi).toMatch(/^3\.0/);
    expect(res.body).toHaveProperty('paths');
    expect(res.body).toHaveProperty('info');
  });

  test('GET /api/docs/markdown gibt text zurueck', async () => {
    const res = await request('GET', '/api/docs/markdown');
    expect(res.status).toBe(200);
    expect(typeof res.raw).toBe('string');
    expect(res.raw).toContain('# Claude Multi-Agent Orchestrator API');
    expect(res.headers['content-type']).toContain('text/markdown');
  });

  test('GET /api/docs gibt HTML zurueck', async () => {
    const res = await request('GET', '/api/docs');
    expect(res.status).toBe(200);
    expect(typeof res.raw).toBe('string');
    expect(res.raw).toContain('<!DOCTYPE html>');
    expect(res.headers['content-type']).toContain('text/html');
  });
});
