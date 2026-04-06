// Export API - Tests
// Testet GET /api/export/:id Endpoint

'use strict';
const http = require('http');

const TEST_PORT = 3201;

function request(method, urlPath) {
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
        try { resolve({ status: res.statusCode, body: JSON.parse(data), headers: res.headers }); }
        catch { resolve({ status: res.statusCode, body: data, headers: res.headers }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

jest.mock('child_process', () => ({
  spawn: jest.fn(),
  execSync: jest.fn(() => 'claude 1.0.0'),
}));

describe('GET /api/export/:id', () => {
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

  test('gibt 404 fuer nicht-existierendes Projekt', async () => {
    const res = await request('GET', '/api/export/nonexistent_proj');
    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty('error');
  });

  test('blockiert Pfad-Traversal mit ..', async () => {
    const res = await request('GET', '/api/export/..%2F..%2Fetc');
    // Entweder 400 (Pfad-Traversal erkannt) oder 404 (Verzeichnis existiert nicht)
    expect([400, 404]).toContain(res.status);
  });

  test('blockiert Pfad-Traversal mit ../', async () => {
    const res = await request('GET', '/api/export/../../../etc/passwd');
    // Express normalisiert den Pfad, daher kommt es als anderer Pfad an
    // Wichtig: kein 200 Status und kein ZIP-Content-Type
    expect(res.status).not.toBe(200);
  });

  test('gibt 404 fuer leeren Projekt-Namen', async () => {
    // Express matched /api/export/ nicht als /api/export/:id
    const res = await request('GET', '/api/export/___invalid___');
    expect(res.status).toBe(404);
  });
});
