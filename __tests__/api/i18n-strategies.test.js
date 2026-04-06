// i18n + Retry-Strategien API - Tests
// Testet GET /api/i18n, GET /api/i18n/:lang, GET /api/retry-strategies,
// GET /api/retry-strategy, PUT /api/retry-strategy

'use strict';
const http = require('http');

const TEST_PORT = 3239;

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
      this._retryStrategy = {
        strategy: 'exponential',
        maxRetries: 3,
        baseDelay: 2000,
        maxDelay: 30000,
      };
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
    getConfig() { return { language: 'de' }; }
    updateConfig() {}
    approvePlan() {}
    modifyPlan() {}
    retryAgent() { return Promise.resolve(); }
    loadProject() { return this.getState(); }
    resume() { return Promise.resolve(); }
    setIntervention() {}
    getRetryStrategies() {
      return {
        exponential: { name: 'exponential', description: 'Exponential Backoff mit Jitter' },
        fixed: { name: 'fixed', description: 'Feste Wartezeit zwischen Retries' },
        linear: { name: 'linear', description: 'Linear steigende Wartezeit' },
        'circuit-breaker': { name: 'circuit-breaker', description: 'Circuit Breaker' },
        none: { name: 'none', description: 'Kein Retry' },
      };
    }
    getRetryStrategy() {
      return this._retryStrategy;
    }
    setRetryStrategy(config) {
      if (!config || !config.strategy) {
        throw new Error('Retry-Strategie Config muss ein Objekt sein');
      }
      const valid = ['exponential', 'fixed', 'linear', 'circuit-breaker', 'none'];
      if (!valid.includes(config.strategy)) {
        throw new Error(`Unbekannte Retry-Strategie: '${config.strategy}'`);
      }
      this._retryStrategy = { ...this._retryStrategy, ...config };
      return this._retryStrategy;
    }
  }
  return MockOrchestrator;
});

describe('i18n + Retry-Strategien API', () => {
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

  // ── i18n Tests ──────────────────────────────────────────────

  test('GET /api/i18n gibt verfuegbare Sprachen zurueck', async () => {
    const res = await request('GET', '/api/i18n');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('languages');
    expect(res.body).toHaveProperty('current');
    expect(res.body).toHaveProperty('default', 'de');
    expect(res.body.languages).toHaveProperty('de');
    expect(res.body.languages).toHaveProperty('en');
  });

  test('GET /api/i18n/:lang gibt Uebersetzungen fuer gueltige Sprache', async () => {
    const res = await request('GET', '/api/i18n/de');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('language', 'de');
    expect(res.body).toHaveProperty('label', 'Deutsch');
    expect(res.body).toHaveProperty('translations');
    expect(typeof res.body.translations).toBe('object');
  });

  test('GET /api/i18n/:lang gibt 404 fuer unbekannte Sprache', async () => {
    const res = await request('GET', '/api/i18n/xx');
    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty('error');
    expect(res.body.error).toMatch(/nicht gefunden/);
  });

  // ── Retry-Strategien Tests ──────────────────────────────────

  test('GET /api/retry-strategies gibt alle Strategien zurueck', async () => {
    const res = await request('GET', '/api/retry-strategies');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('exponential');
    expect(res.body).toHaveProperty('fixed');
    expect(res.body).toHaveProperty('linear');
    expect(res.body).toHaveProperty('circuit-breaker');
    expect(res.body).toHaveProperty('none');
  });

  test('GET /api/retry-strategy gibt aktuelle Strategie zurueck', async () => {
    const res = await request('GET', '/api/retry-strategy');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('strategy');
    expect(res.body).toHaveProperty('maxRetries');
    expect(res.body.strategy).toBe('exponential');
  });

  test('PUT /api/retry-strategy aendert Strategie erfolgreich', async () => {
    const res = await request('PUT', '/api/retry-strategy', { strategy: 'fixed', maxRetries: 5 });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('ok', true);
    expect(res.body).toHaveProperty('strategy');
    expect(res.body.strategy.strategy).toBe('fixed');
  });

  test('PUT /api/retry-strategy gibt 400 bei ungueltiger Strategie', async () => {
    const res = await request('PUT', '/api/retry-strategy', { strategy: 'invalid' });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });

  test('PUT /api/retry-strategy gibt 400 bei fehlendem Body', async () => {
    const res = await request('PUT', '/api/retry-strategy', {});
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });
});
