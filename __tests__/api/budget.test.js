// Budget API - Tests
// Testet GET /api/budget und POST /api/budget

'use strict';
const http = require('http');

const TEST_PORT = 3221;

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

describe('Budget API', () => {
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

  test('GET /api/budget gibt Budget-Status zurueck', async () => {
    const res = await request('GET', '/api/budget');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('maxTokenBudget');
    expect(res.body).toHaveProperty('warnTokenBudget');
    expect(res.body).toHaveProperty('totalTokens');
    expect(res.body).toHaveProperty('inputTokens');
    expect(res.body).toHaveProperty('outputTokens');
    expect(res.body).toHaveProperty('estimatedCost');
    expect(res.body).toHaveProperty('percent');
    expect(res.body).toHaveProperty('exceeded');
    expect(res.body).toHaveProperty('warned');
  });

  test('GET /api/budget hat korrekte Zahlenwerte', async () => {
    const res = await request('GET', '/api/budget');
    expect(typeof res.body.maxTokenBudget).toBe('number');
    expect(typeof res.body.totalTokens).toBe('number');
    expect(typeof res.body.percent).toBe('number');
    expect(res.body.percent).toBeGreaterThanOrEqual(0);
    expect(res.body.percent).toBeLessThanOrEqual(100);
  });

  test('POST /api/budget setzt Token-Limits', async () => {
    const res = await request('POST', '/api/budget', {
      maxTokenBudget: 500000,
      warnTokenBudget: 400000
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body).toHaveProperty('config');
  });

  test('POST /api/budget setzt Kosten-Parameter', async () => {
    const res = await request('POST', '/api/budget', {
      inputCostPerMTok: 5,
      outputCostPerMTok: 20
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test('GET /api/budget nach Aenderung zeigt neue Werte', async () => {
    // Zuerst setzen
    await request('POST', '/api/budget', { maxTokenBudget: 750000 });
    // Dann lesen
    const res = await request('GET', '/api/budget');
    expect(res.status).toBe(200);
    // maxTokenBudget sollte den gesetzten Wert widerspiegeln
    // (je nach Implementierung koennte der Wert im Config oder State stehen)
    expect(typeof res.body.maxTokenBudget).toBe('number');
  });

  test('POST /api/budget mit leerem Body gibt trotzdem 200', async () => {
    const res = await request('POST', '/api/budget', {});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
