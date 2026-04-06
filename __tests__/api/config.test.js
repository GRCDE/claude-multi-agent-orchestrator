// Config API - Tests
// Testet GET /api/config und POST /api/config Endpoints

'use strict';
const http = require('http');

const TEST_PORT = 3203;

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

describe('Config API', () => {
  beforeAll(done => {
    process.env.PORT = TEST_PORT;
    delete require.cache[require.resolve('../../server')];
    delete require.cache[require.resolve('../../orchestrator')];

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

  test('GET /api/config gibt Config-Objekt zurueck', async () => {
    const res = await request('GET', '/api/config');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('agentTimeout');
    expect(res.body).toHaveProperty('maxRetries');
    expect(res.body).toHaveProperty('concurrency');
    expect(res.body).toHaveProperty('maxRounds');
    expect(res.body).toHaveProperty('maxAgents');
  });

  test('POST /api/config aktualisiert Werte', async () => {
    const res = await request('POST', '/api/config', { maxRetries: 7 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.config.maxRetries).toBe(7);

    // Verifiziere dass der Wert persistiert
    const check = await request('GET', '/api/config');
    expect(check.body.maxRetries).toBe(7);
  });

  test('POST /api/config lehnt ungueltige Werte ab', async () => {
    const res = await request('POST', '/api/config', { agentTimeout: -500 });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });

  test('POST /api/config lehnt unbekannte Felder ab', async () => {
    const res = await request('POST', '/api/config', { nichtExistent: 42 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Unbekanntes Feld/);
  });
});
