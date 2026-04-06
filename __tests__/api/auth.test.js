'use strict';
const http = require('http');

const TEST_PORT = 3196;
const TEST_TOKEN = 'test-geheim-token-12345';

// HTTP-Client helper (gleicher Stil wie server.test.js)
function request(method, path, body = null, token = null) {
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;

    const options = {
      hostname: 'localhost',
      port: TEST_PORT,
      path,
      method,
      headers
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

describe('API-Authentifizierung', () => {
  beforeAll(done => {
    process.env.PORT = TEST_PORT;
    process.env.API_TOKEN = TEST_TOKEN;

    // Cache leeren
    Object.keys(require.cache).forEach(key => {
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

  describe('Mit API_TOKEN gesetzt', () => {
    beforeAll(() => {
      process.env.API_TOKEN = TEST_TOKEN;
    });

    test('POST /api/reset ohne Token gibt 401', async () => {
      const res = await request('POST', '/api/reset');
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Authentifizierung erforderlich');
    });

    test('POST /api/reset mit falschem Token gibt 401', async () => {
      const res = await request('POST', '/api/reset', null, 'falscher-token');
      expect(res.status).toBe(401);
    });

    test('POST /api/reset mit korrektem Token gibt 200', async () => {
      const res = await request('POST', '/api/reset', null, TEST_TOKEN);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    test('GET /api/status funktioniert ohne Token', async () => {
      const res = await request('GET', '/api/status');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('phase');
    });

    test('GET /health funktioniert ohne Token', async () => {
      const res = await request('GET', '/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    });

    test('GET /api/projects funktioniert ohne Token', async () => {
      const res = await request('GET', '/api/projects');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    test('POST /api/cleanup ohne Token gibt 401', async () => {
      const res = await request('POST', '/api/cleanup');
      expect(res.status).toBe(401);
    });
  });

  describe('Ohne API_TOKEN (abwaertskompatibel)', () => {
    beforeAll(() => {
      delete process.env.API_TOKEN;
    });

    afterAll(() => {
      // Token wiederherstellen fuer andere Tests
      process.env.API_TOKEN = TEST_TOKEN;
    });

    test('POST /api/reset funktioniert ohne Token', async () => {
      const res = await request('POST', '/api/reset');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    test('GET /api/status funktioniert ohne Token', async () => {
      const res = await request('GET', '/api/status');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('phase');
    });
  });
});
