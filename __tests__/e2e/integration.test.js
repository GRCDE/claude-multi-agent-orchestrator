// E2E Integration Test - API -> SSE -> Roundtrip
// Testet den vollen Roundtrip: API-Call -> SSE-Event -> Validierung
// Nutzt nur Node.js http, kein Playwright

'use strict';
const http = require('http');

const TEST_PORT = 3269;

// ── Hilfsfunktionen ─────────────────────────────────────────

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

/**
 * SSE-Verbindung aufbauen und Events sammeln.
 * Gibt ein Objekt zurueck mit:
 *   - events: Array der empfangenen Events { event, data }
 *   - waitForEvent(name, timeout): Promise das auf ein bestimmtes Event wartet
 *   - close(): Verbindung schliessen
 */
function connectSSE() {
  return new Promise((resolve, reject) => {
    const events = [];
    const listeners = [];

    const req = http.get({
      hostname: 'localhost',
      port: TEST_PORT,
      path: '/api/stream',
      headers: { 'Accept': 'text/event-stream' }
    }, res => {
      if (res.statusCode !== 200) {
        reject(new Error('SSE connect failed with status ' + res.statusCode));
        return;
      }

      let buffer = '';

      res.on('data', chunk => {
        buffer += chunk.toString();
        // SSE-Events parsen (getrennt durch \n\n)
        const parts = buffer.split('\n\n');
        buffer = parts.pop(); // letztes (unvollstaendiges) Stueck behalten

        for (const part of parts) {
          if (!part.trim()) continue;
          // Kommentare (: ping) ignorieren
          if (part.trim().startsWith(':')) continue;

          let eventName = 'message';
          let eventData = '';

          for (const line of part.split('\n')) {
            if (line.startsWith('event: ')) {
              eventName = line.slice(7).trim();
            } else if (line.startsWith('data: ')) {
              eventData = line.slice(6);
            }
          }

          let parsed;
          try { parsed = JSON.parse(eventData); }
          catch { parsed = eventData; }

          const evt = { event: eventName, data: parsed };
          events.push(evt);

          // Wartende Listener benachrichtigen
          for (let i = listeners.length - 1; i >= 0; i--) {
            if (listeners[i].name === eventName) {
              listeners[i].resolve(evt);
              listeners.splice(i, 1);
            }
          }
        }
      });

      res.on('error', () => { /* SSE-Verbindung geschlossen */ });

      const handle = {
        events,
        waitForEvent(name, timeout = 3000) {
          // Pruefen ob Event bereits empfangen wurde
          const existing = events.find(e => e.event === name);
          if (existing) return Promise.resolve(existing);

          return new Promise((res, rej) => {
            const timer = setTimeout(() => {
              rej(new Error('Timeout: Event "' + name + '" nicht empfangen nach ' + timeout + 'ms'));
            }, timeout);

            listeners.push({
              name,
              resolve: (evt) => {
                clearTimeout(timer);
                res(evt);
              }
            });
          });
        },
        close() {
          try { req.destroy(); } catch { /* best-effort */ }
        }
      };

      resolve(handle);
    });

    req.on('error', reject);
  });
}

// ── Mocks ────────────────────────────────────────────────────

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
      this._config = { maxAgents: 10, agentConcurrency: 3 };
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
    getConfig() { return this._config; }
    updateConfig(patch) {
      Object.assign(this._config, patch);
    }
    approvePlan() {}
    modifyPlan() {}
    retryAgent() { return Promise.resolve(); }
    loadProject() { return this.getState(); }
    resume() { return Promise.resolve(); }
    setIntervention() {}
    abort() { this.phase = 'idle'; return Promise.resolve(); }
    getLastMergeResult() { return null; }
    remerge() { return Promise.resolve(); }
    _installSignalHandlers() {}
  }
  return MockOrchestrator;
});

// ── Test Suite ───────────────────────────────────────────────

let serverMod;

beforeAll(done => {
  process.env.PORT = String(TEST_PORT);
  Object.keys(require.cache).forEach(key => {
    if (key.includes('server.js')) delete require.cache[key];
  });

  try {
    serverMod = require('../../server');
    setTimeout(done, 800);
  } catch (e) {
    done(e);
  }
});

afterAll(async () => {
  if (serverMod && serverMod.cleanup) await serverMod.cleanup();
});

describe('E2E Integration: API -> SSE Roundtrip', () => {

  test('SSE-Verbindung empfaengt State-Event beim Connect', async () => {
    const sse = await connectSSE();
    try {
      const stateEvt = await sse.waitForEvent('state', 3000);

      expect(stateEvt).toBeDefined();
      expect(stateEvt.event).toBe('state');
      expect(stateEvt.data).toHaveProperty('phase', 'idle');
      expect(stateEvt.data).toHaveProperty('agents');
      expect(Array.isArray(stateEvt.data.agents)).toBe(true);
      expect(stateEvt.data).toHaveProperty('coordinator');
      expect(stateEvt.data).toHaveProperty('totalTokenUsage');
    } finally {
      sse.close();
    }
  });

  test('POST /api/config aendert Konfiguration und GET /api/config spiegelt Aenderung', async () => {
    // Config aendern
    const postRes = await request('POST', '/api/config', { maxAgents: 7 });
    expect(postRes.status).toBe(200);
    expect(postRes.body.ok).toBe(true);
    expect(postRes.body.config).toBeDefined();

    // Config lesen und pruefen
    const getRes = await request('GET', '/api/config');
    expect(getRes.status).toBe(200);
    expect(getRes.body.maxAgents).toBe(7);
  });

  test('GET /api/projects gibt Projektliste zurueck', async () => {
    const res = await request('GET', '/api/projects');
    expect(res.status).toBe(200);
    // Antwort ist ein Array (leer oder mit Projekten)
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('POST /api/templates erstellt Template und GET /api/templates enthaelt es', async () => {
    // Neues Template erstellen
    const createRes = await request('POST', '/api/templates', {
      title: 'E2E-Test-Template',
      description: 'Erstellt im E2E-Integrationstest',
      agentCount: 3,
      tags: ['test', 'e2e']
    });
    expect(createRes.status).toBe(200);
    expect(createRes.body.ok).toBe(true);
    expect(createRes.body.template).toBeDefined();
    expect(createRes.body.template.name).toBe('E2E-Test-Template');
    expect(createRes.body.template.suggestedAgents).toBe(3);

    const createdId = createRes.body.template.id;
    expect(createdId).toBeDefined();
    expect(createdId).toMatch(/^tpl-/);

    // Templates auflisten und pruefen
    const listRes = await request('GET', '/api/templates');
    expect(listRes.status).toBe(200);
    expect(listRes.body).toHaveProperty('templates');
    expect(Array.isArray(listRes.body.templates)).toBe(true);

    const found = listRes.body.templates.find(t => t.id === createdId);
    expect(found).toBeDefined();
    expect(found.name).toBe('E2E-Test-Template');
    expect(found.description).toBe('Erstellt im E2E-Integrationstest');
    expect(found.suggestedAgents).toBe(3);
    expect(found.tags).toEqual(expect.arrayContaining(['test', 'e2e']));

    // Aufraeumen: Template wieder loeschen
    const delRes = await request('DELETE', '/api/templates/' + createdId);
    expect(delRes.status).toBe(200);
    expect(delRes.body.ok).toBe(true);
  });

});
