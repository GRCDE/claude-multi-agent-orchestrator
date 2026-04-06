// Rate-Limiting API - Tests
// Testet echtes Rate-Limiting ohne express-rate-limit Mock
// Port 3257

'use strict';
const http = require('http');

const TEST_PORT = 3257;

function request(method, urlPath, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: urlPath,
      method,
      headers: { 'Content-Type': 'application/json', ...headers }
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
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// Orchestrator mocken, aber express-rate-limit NICHT mocken
jest.mock('child_process', () => ({
  spawn: jest.fn(),
  execSync: jest.fn(() => 'claude 1.0.0'),
}));

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

describe('Rate-Limiting API (echtes Rate-Limiting)', () => {
  let serverMod;

  beforeAll(done => {
    process.env.PORT = TEST_PORT;
    delete process.env.API_TOKEN; // Kein Auth-Token, damit authMiddleware durchlaesst

    Object.keys(require.cache).forEach(key => {
      if (key.includes('server.js')) delete require.cache[key];
    });

    try {
      serverMod = require('../../server');
      setTimeout(done, 600);
    } catch (e) {
      done(e);
    }
  });

  afterAll(async () => {
    if (serverMod && serverMod.cleanup) await serverMod.cleanup();
  });

  test('Start-Limiter: 3 Requests erlaubt, 4. wird mit 429 abgelehnt', async () => {
    const startBody = { description: 'Test-Projekt', agentCount: 2 };
    const results = [];

    // 4 Requests schnell hintereinander senden
    for (let i = 0; i < 4; i++) {
      const res = await request('POST', '/api/start', startBody);
      results.push(res);
    }

    // Die ersten 3 sollten NICHT 429 sein (sie koennten 200 oder andere Status haben,
    // aber nicht rate-limited)
    for (let i = 0; i < 3; i++) {
      expect(results[i].status).not.toBe(429);
    }

    // Der 4. Request sollte 429 sein
    expect(results[3].status).toBe(429);
    expect(results[3].body.error).toContain('Zu viele');
  });

  test('Rate-Limit Response enthaelt Retry-After Header', async () => {
    // Start-Limiter ist nach dem vorherigen Test bereits erschoepft
    const res = await request('POST', '/api/start', { description: 'Test', agentCount: 1 });

    expect(res.status).toBe(429);
    // standardHeaders: true setzt RateLimit-* Headers (RFC Draft)
    // Retry-After wird von express-rate-limit als 'retry-after' gesendet
    const retryAfter = res.headers['retry-after'];
    expect(retryAfter).toBeDefined();
    expect(parseInt(retryAfter)).toBeGreaterThan(0);
  });

  test('Rate-Limit Response enthaelt RateLimit-Remaining Header', async () => {
    // Ein Request an einen Read-Endpoint (apiReadLimiter, 120/min)
    const res = await request('GET', '/api/roles');

    expect(res.status).not.toBe(429);
    // standardHeaders: true setzt RateLimit-Policy und RateLimit Header
    const remaining = res.headers['ratelimit-remaining'];
    expect(remaining).toBeDefined();
    expect(parseInt(remaining)).toBeGreaterThanOrEqual(0);
  });

  test('Read-Limiter erlaubt viele Requests (120/min)', async () => {
    // 20 Requests schnell hintereinander an Read-Endpoint senden
    // Alle sollten durchkommen (Limit ist 120/min)
    const promises = [];
    for (let i = 0; i < 20; i++) {
      promises.push(request('GET', '/api/roles'));
    }
    const results = await Promise.all(promises);

    const successCount = results.filter(r => r.status !== 429).length;
    expect(successCount).toBe(20);

    // Pruefen dass kein einziger Request rate-limited wurde
    results.forEach(r => {
      expect(r.status).not.toBe(429);
    });
  });
});
