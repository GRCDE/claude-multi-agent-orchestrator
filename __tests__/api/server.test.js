'use strict';
const http = require('http');

// Wir testen gegen den laufenden Server oder starten einen eigenen
// Da server.js sofort startet, nutzen wir einen eigenen Port

const TEST_PORT = 3199;

// Einfacher HTTP-Client helper
function request(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: TEST_PORT,
      path,
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

// Mock child_process bevor server geladen wird
jest.mock('child_process', () => ({
  spawn: jest.fn(),
  execSync: jest.fn(() => 'claude 1.0.0'),
}));

jest.mock('express-rate-limit', () => {
  return () => (req, res, next) => next();
});

describe('REST API', () => {
  let server;

  beforeAll(done => {
    process.env.PORT = TEST_PORT;
    // Server laden (startet automatisch)
    // Wir müssen den Cache löschen damit der neue PORT wirkt
    delete require.cache[require.resolve('../../server')];
    delete require.cache[require.resolve('../../orchestrator')];

    try {
      require('../../server');
      setTimeout(done, 500); // Warten bis Server bereit
    } catch(e) {
      done(e);
    }
  });

  afterAll(async () => {
    const serverMod = require('../../server');
    if (serverMod && serverMod.cleanup) await serverMod.cleanup();
  });

  test('GET /health gibt Status zurück', async () => {
    const res = await request('GET', '/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body).toHaveProperty('uptime');
    expect(res.body).toHaveProperty('memory');
  });

  test('GET /api/status gibt State zurück', async () => {
    const res = await request('GET', '/api/status');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('phase');
    expect(res.body).toHaveProperty('agents');
  });

  // Hinweis: /api/start hat ein Rate-Limit von 3 Requests/Minute.
  // Wir testen nur die ersten 3 Validierungs-Fälle über diesen Endpoint.

  test('POST /api/start ohne Body gibt 400', async () => {
    const res = await request('POST', '/api/start', {});
    expect(res.status).toBe(400);
  });

  test('POST /api/start mit agentCount > 10 gibt 400', async () => {
    const res = await request('POST', '/api/start', { description: 'Test', agentCount: 99 });
    expect(res.status).toBe(400);
  });

  test('POST /api/start mit agentCount < 2 gibt 400', async () => {
    const res = await request('POST', '/api/start', { description: 'Test', agentCount: 1 });
    expect(res.status).toBe(400);
  });

  test('POST /api/start mit description > 5000 Zeichen wird vom Rate-Limiter oder Validierung abgelehnt', async () => {
    const res = await request('POST', '/api/start', { description: 'x'.repeat(5001), agentCount: 2 });
    // Entweder 400 (Validierung) oder 429 (Rate-Limit nach 3 Requests)
    expect([400, 429]).toContain(res.status);
  });

  test('GET /api/projects gibt Array zurück', async () => {
    const res = await request('GET', '/api/projects');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('POST /api/reset gibt ok zurück', async () => {
    const res = await request('POST', '/api/reset');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test('POST /api/retry mit ungültigem Index gibt 400', async () => {
    const res = await request('POST', '/api/retry/abc');
    expect(res.status).toBe(400);
  });

  test('GET /api/projects/nonexistent gibt 404', async () => {
    const res = await request('GET', '/api/projects/nonexistent');
    expect(res.status).toBe(404);
  });
});
