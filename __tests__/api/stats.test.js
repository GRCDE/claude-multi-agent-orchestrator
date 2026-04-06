// Stats API - Tests
// Testet GET /api/stats und POST /api/test-webhook Endpoints

'use strict';
const http = require('http');

const TEST_PORT = 3204;

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

describe('Stats & Webhook API', () => {
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

  test('GET /api/stats gibt Statistik-Objekt zurueck', async () => {
    const res = await request('GET', '/api/stats');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('totalProjects');
    expect(res.body).toHaveProperty('completedProjects');
    expect(res.body).toHaveProperty('failedProjects');
    expect(res.body).toHaveProperty('totalAgents');
    expect(res.body).toHaveProperty('avgDuration');
    expect(res.body).toHaveProperty('avgScore');
    expect(typeof res.body.totalProjects).toBe('number');
  });

  test('GET /api/stats hat korrekte Zahlenwerte', async () => {
    const res = await request('GET', '/api/stats');
    expect(res.body.totalProjects).toBeGreaterThanOrEqual(0);
    expect(res.body.completedProjects).toBeGreaterThanOrEqual(0);
    expect(res.body.avgDuration).toBeGreaterThanOrEqual(0);
  });

  test('POST /api/test-webhook lehnt fehlende URL ab', async () => {
    const res = await request('POST', '/api/test-webhook', {});
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });

  test('POST /api/test-webhook lehnt ungueltige URL ab', async () => {
    const res = await request('POST', '/api/test-webhook', { url: 'not-a-url' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Ung.ltige URL/);
  });

  test('POST /api/test-webhook lehnt nicht-HTTP Protokolle ab', async () => {
    const res = await request('POST', '/api/test-webhook', { url: 'ftp://example.com' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/http/i);
  });
});
