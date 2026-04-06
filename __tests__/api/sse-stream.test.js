// SSE Stream API - Tests
// Testet GET /api/stream (Server-Sent Events Endpoint)

'use strict';
const http = require('http');

const TEST_PORT = 3240;

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

// SSE-Verbindung oeffnen und Daten sammeln
function connectSSE(path = '/api/stream', headers = {}) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: TEST_PORT,
      path,
      method: 'GET',
      headers: {
        'Accept': 'text/event-stream',
        ...headers
      }
    };
    const req = http.request(options, res => {
      resolve({ res, req, destroy: () => req.destroy() });
    });
    req.on('error', reject);
    req.end();
  });
}

// SSE-Daten parsen
function parseSSEData(raw) {
  const events = [];
  const blocks = raw.split('\n\n').filter(b => b.trim());
  for (const block of blocks) {
    const lines = block.split('\n');
    let event = null;
    let data = null;
    for (const line of lines) {
      if (line.startsWith('event: ')) event = line.slice(7);
      if (line.startsWith('data: ')) data = line.slice(6);
    }
    if (event || data) {
      events.push({ event, data: data ? (() => { try { return JSON.parse(data); } catch { return data; } })() : null });
    }
  }
  return events;
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

describe('SSE Stream API', () => {
  const sseConnections = [];

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

  afterEach(() => {
    // Alle SSE-Verbindungen schliessen nach jedem Test
    for (const conn of sseConnections) {
      try { conn.destroy(); } catch {}
    }
    sseConnections.length = 0;
  });

  afterAll(async () => {
    const serverMod = require('../../server');
    if (serverMod && serverMod.cleanup) await serverMod.cleanup();
  });

  test('GET /api/stream liefert Content-Type text/event-stream', async () => {
    const { res, destroy } = await connectSSE();
    sseConnections.push({ destroy });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.headers['cache-control']).toContain('no-cache');

    destroy();
  });

  test('Initiales state Event wird gesendet', async () => {
    const { res, destroy } = await connectSSE();
    sseConnections.push({ destroy });

    const data = await new Promise((resolve) => {
      let collected = '';
      res.on('data', chunk => {
        collected += chunk.toString();
        // Warten bis mindestens ein vollstaendiges Event da ist
        if (collected.includes('\n\n')) {
          resolve(collected);
        }
      });
      // Timeout falls kein Event kommt
      setTimeout(() => resolve(collected), 2000);
    });

    const events = parseSSEData(data);
    expect(events.length).toBeGreaterThanOrEqual(1);

    const stateEvent = events.find(e => e.event === 'state');
    expect(stateEvent).toBeDefined();
    expect(stateEvent.data).toHaveProperty('phase', 'idle');
    expect(stateEvent.data).toHaveProperty('agents');

    destroy();
  });

  test('Verbindung wird in clients Map registriert', async () => {
    // Zuerst Metrics abfragen fuer Baseline
    const before = await request('GET', '/api/metrics');
    const sseConnsBefore = typeof before.body.connections === 'object'
      ? (before.body.connections.sse || 0)
      : (before.body.connections || 0);

    const { res, destroy } = await connectSSE();
    sseConnections.push({ destroy });

    // Warten bis Connection registriert ist
    await new Promise(resolve => {
      res.once('data', () => resolve());
      setTimeout(resolve, 500);
    });

    // Metrics erneut abfragen - SSE connections sollte hoeher sein
    const after = await request('GET', '/api/metrics');
    const sseConnsAfter = typeof after.body.connections === 'object'
      ? (after.body.connections.sse || 0)
      : (after.body.connections || 0);
    expect(sseConnsAfter).toBeGreaterThan(sseConnsBefore);

    destroy();
  });

  test('Heartbeat/Ping wird gesendet', async () => {
    // Wir koennen den Ping-Intervall nicht direkt testen (30s),
    // aber wir koennen pruefen dass die Verbindung offen bleibt
    // und der SSE-Comment-Ping-Mechanismus funktioniert.
    // Stattdessen testen wir dass Connection-Header korrekt gesetzt ist.
    const { res, destroy } = await connectSSE();
    sseConnections.push({ destroy });

    expect(res.headers['connection']).toBe('keep-alive');

    // Verbindung bleibt offen (kein 'end' Event innerhalb 1s)
    const closed = await new Promise(resolve => {
      res.on('end', () => resolve(true));
      setTimeout(() => resolve(false), 1000);
    });
    expect(closed).toBe(false);

    destroy();
  });

  test('Max SSE-Verbindungen pro IP wird begrenzt (503/429)', async () => {
    // Oeffne MAX_SSE_PER_IP (5) Verbindungen
    const connections = [];
    for (let i = 0; i < 5; i++) {
      const conn = await connectSSE();
      connections.push(conn);
      sseConnections.push({ destroy: conn.destroy });
      // Warten bis Connection registriert ist
      await new Promise(resolve => {
        conn.res.once('data', () => resolve());
        setTimeout(resolve, 300);
      });
    }

    // 6. Verbindung sollte abgelehnt werden (429)
    const extraRes = await request('GET', '/api/stream');
    expect([429, 503]).toContain(extraRes.status);

    // Aufraeumen
    for (const conn of connections) {
      conn.destroy();
    }
  });
});
