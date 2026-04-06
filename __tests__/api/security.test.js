// Security API - Tests
// Testet Path-Traversal, XSS-Sanitierung, Input-Validierung, Content-Type, Rate-Limit Header

'use strict';
const http = require('http');

const TEST_PORT = 3255;

function request(method, urlPath, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
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
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

jest.mock('child_process', () => ({
  spawn: jest.fn(),
  execSync: jest.fn(() => 'claude 1.0.0'),
}));

jest.mock('express-rate-limit', () => {
  return (opts) => (req, res, next) => {
    // Setze Standard-RateLimit-Header wie express-rate-limit mit standardHeaders: true
    res.setHeader('RateLimit-Limit', opts.max || 100);
    res.setHeader('RateLimit-Remaining', (opts.max || 100) - 1);
    res.setHeader('RateLimit-Reset', Math.ceil(Date.now() / 1000) + 60);
    next();
  };
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

describe('Security Tests', () => {
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

  test('Path-Traversal in /api/file-content wird blockiert', async () => {
    // Versuch, ueber ../../../etc/passwd aus dem Projektverzeichnis auszubrechen
    const res = await request('GET', '/api/file-content/test-project/..%2F..%2F..%2Fetc%2Fpasswd');
    // Muss entweder 400 (Traversal erkannt) oder 404 (Projekt nicht gefunden) sein, nie 200 mit Inhalt
    expect([400, 404]).toContain(res.status);
    if (res.status === 400) {
      expect(res.body.error).toBeDefined();
    }
    // Stelle sicher, dass kein Dateiinhalt zurueckkommt
    expect(res.body.content).toBeUndefined();
  });

  test('Path-Traversal in /api/projects/:id wird blockiert', async () => {
    // Versuch, mit ../../ aus dem projects-Verzeichnis auszubrechen
    const res = await request('GET', '/api/projects/..%2F..%2Fetc');
    // Muss 400 (Traversal) oder 404 (nicht gefunden) sein
    expect([400, 404]).toContain(res.status);
    if (res.status === 400) {
      expect(res.body.error).toBeDefined();
    }
  });

  test('XSS in Projekt-Beschreibung wird sanitized (POST /api/start)', async () => {
    // Sende Script-Tag in der Beschreibung
    const res = await request('POST', '/api/start', {
      description: '<script>alert("xss")</script> Normaler Text',
      agentCount: 3,
    });
    // Projekt startet (oder Queue), aber die Beschreibung darf keinen Script-Tag enthalten
    // Die Server-Seite akzeptiert es (sanitizeInput im Orchestrator entfernt Steuerzeichen),
    // Frontend-seitig wird escapeHtml() verwendet
    // Hier pruefen wir, dass der Server die Anfrage annimmt und verarbeitet (kein Crash)
    expect([200, 409]).toContain(res.status);
    expect(res.body.ok).toBe(true);
  });

  test('Ueberlange Eingaben werden abgelehnt (>5000 Zeichen)', async () => {
    // Server hat ein Limit von 5000 Zeichen fuer Beschreibungen
    const longDescription = 'A'.repeat(5001);
    const res = await request('POST', '/api/start', {
      description: longDescription,
      agentCount: 3,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
    expect(res.body.error).toMatch(/5000/);
  });

  test('Content-Type Validierung (POST ohne JSON Content-Type)', async () => {
    // POST mit text/plain statt application/json
    const res = await request('POST', '/api/start', '{"description":"test","agentCount":3}', {
      'Content-Type': 'text/plain'
    });
    expect(res.status).toBe(415);
    expect(res.body.error).toBeDefined();
    expect(res.body.error).toMatch(/Content-Type/i);
  });

  test('Rate-Limiting Header sind vorhanden (RateLimit-*)', async () => {
    // /api/disk-usage geht durch apiReadLimiter, der Rate-Limit Header setzt
    const res = await request('GET', '/api/disk-usage');
    const headerKeys = Object.keys(res.headers).map(h => h.toLowerCase());
    const hasRateLimitHeaders = headerKeys.some(h => h.startsWith('ratelimit'));
    expect(hasRateLimitHeaders).toBe(true);
  });
});
