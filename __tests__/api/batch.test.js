'use strict';

const http = require('http');

const TEST_PORT = 3232;

function request(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json' };
    const options = {
      hostname: 'localhost',
      port: TEST_PORT,
      path,
      method,
      headers,
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
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

describe('Batch API Tests', () => {
  beforeAll((done) => {
    process.env.PORT = TEST_PORT;
    delete process.env.API_TOKEN; // Keine Auth für Tests

    // Cache leeren
    Object.keys(require.cache).forEach((key) => {
      if (key.includes('orchestrator') || key.includes('server.js') || key.includes('src')) {
        delete require.cache[key];
      }
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

  test('POST /api/batch mit mehreren GET Requests', async () => {
    const res = await request('POST', '/api/batch', {
      operations: [
        { id: '1', method: 'GET', path: '/api/status', body: null },
        { id: '2', method: 'GET', path: '/api/health', body: null },
        { id: '3', method: 'GET', path: '/api/batch/stats', body: null },
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(3);
    expect(res.body.results[0].id).toBe('1');
    expect(res.body.results[0].status).toBe(200);
    expect(res.body.successCount).toBe(3);
    expect(res.body.errorCount).toBe(0);
    expect(res.body.totalDuration).toBeGreaterThanOrEqual(0);
  });

  test('POST /api/batch mit gemischten Methoden', async () => {
    const res = await request('POST', '/api/batch', {
      operations: [
        { id: '1', method: 'GET', path: '/api/status', body: null },
        { id: '2', method: 'GET', path: '/api/config', body: null },
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(2);
    for (const r of res.body.results) {
      expect(r).toHaveProperty('id');
      expect(r).toHaveProperty('status');
      expect(r).toHaveProperty('body');
      expect(r).toHaveProperty('duration');
    }
  });

  test('POST /api/batch mit blockiertem Endpoint gibt 400', async () => {
    const res = await request('POST', '/api/batch', {
      operations: [
        { id: '1', method: 'POST', path: '/api/start', body: { description: 'test' } },
      ],
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Validierung');
    expect(res.body.details[0]).toContain('blockiert');
  });

  test('POST /api/batch mit leerem Array gibt 400', async () => {
    const res = await request('POST', '/api/batch', {
      operations: [],
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Validierung');
  });

  test('POST /api/batch mit >20 Operationen gibt 400', async () => {
    const ops = Array.from({ length: 21 }, (_, i) => ({
      id: String(i), method: 'GET', path: '/api/status', body: null,
    }));

    const res = await request('POST', '/api/batch', { operations: ops });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Validierung');
    expect(res.body.details[0]).toContain('Maximal 20');
  });

  test('GET /api/batch/stats gibt Statistiken zurück', async () => {
    const res = await request('GET', '/api/batch/stats');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('totalBatches');
    expect(res.body).toHaveProperty('avgOpsPerBatch');
    expect(res.body).toHaveProperty('avgDurationMs');
    expect(typeof res.body.totalBatches).toBe('number');
  });

  test('GET /api/batch/blocked gibt blockierte Endpoints zurück', async () => {
    const res = await request('GET', '/api/batch/blocked');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('blocked');
    expect(Array.isArray(res.body.blocked)).toBe(true);
    expect(res.body.blocked.length).toBeGreaterThanOrEqual(3);

    // Prüfe dass die gefährlichen Endpoints enthalten sind
    const paths = res.body.blocked.map((b) => b.method + ' ' + b.path);
    expect(paths).toContain('POST /api/start');
    expect(paths).toContain('POST /api/abort');
    expect(paths).toContain('POST /api/reset');
  });

  test('POST /api/batch ohne operations gibt 400', async () => {
    const res = await request('POST', '/api/batch', {});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('operations');
  });
});
