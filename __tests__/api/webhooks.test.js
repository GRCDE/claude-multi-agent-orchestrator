// Webhooks API - Tests
// Testet POST/GET/DELETE /api/webhooks und /api/webhooks/:id/test

'use strict';
const http = require('http');
const path = require('path');
const fs = require('fs');

const TEST_PORT = 3220;

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

describe('Webhooks API', () => {
  const webhooksFile = path.join(__dirname, '..', '..', 'webhooks.json');
  let createdWebhookId = null;

  beforeAll(done => {
    // Saubere webhooks.json sicherstellen
    try { fs.writeFileSync(webhooksFile, '[]', 'utf8'); } catch { /* ignorieren */ }

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
    // webhooks.json aufraeumen
    try { fs.writeFileSync(webhooksFile, '[]', 'utf8'); } catch { /* ignorieren */ }
  });

  test('POST /api/webhooks ohne URL gibt 400', async () => {
    const res = await request('POST', '/api/webhooks', {
      events: ['project-started'],
      secret: 'testsecret123'
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/URL/i);
  });

  test('POST /api/webhooks mit ungueltiger URL gibt 400', async () => {
    const res = await request('POST', '/api/webhooks', {
      url: 'not-a-valid-url',
      events: ['project-started'],
      secret: 'testsecret123'
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/URL/i);
  });

  test('POST /api/webhooks mit zu kurzem Secret gibt 400', async () => {
    const res = await request('POST', '/api/webhooks', {
      url: 'https://example.com/hook',
      events: ['project-started'],
      secret: 'kurz'
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Secret/i);
  });

  test('POST /api/webhooks ohne Events gibt 400', async () => {
    const res = await request('POST', '/api/webhooks', {
      url: 'https://example.com/hook',
      secret: 'testsecret123'
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Event/i);
  });

  test('POST /api/webhooks mit ungueltigem Event gibt 400', async () => {
    const res = await request('POST', '/api/webhooks', {
      url: 'https://example.com/hook',
      events: ['invalid-event'],
      secret: 'testsecret123'
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Ung(?:ue|ü)ltige Events/);
  });

  test('POST /api/webhooks registriert erfolgreich', async () => {
    const res = await request('POST', '/api/webhooks', {
      url: 'https://example.com/webhook-test',
      events: ['project-started', 'project-done'],
      secret: 'mein-geheimes-token'
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.webhook).toBeDefined();
    expect(res.body.webhook.url).toBe('https://example.com/webhook-test');
    expect(res.body.webhook.secret).toBe('***'); // Secret darf nicht zurueckgegeben werden
    expect(res.body.webhook.id).toBeDefined();
    createdWebhookId = res.body.webhook.id;
  });

  test('POST /api/webhooks lehnt doppelte URL ab', async () => {
    const res = await request('POST', '/api/webhooks', {
      url: 'https://example.com/webhook-test',
      events: ['project-started'],
      secret: 'anderes-secret1'
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/existiert bereits/);
  });

  test('GET /api/webhooks listet registrierte Webhooks', async () => {
    const res = await request('GET', '/api/webhooks');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    // Secret sollte maskiert sein
    const hook = res.body.find(h => h.id === createdWebhookId);
    expect(hook).toBeDefined();
    expect(hook.secret).toBe('***');
  });

  test('POST /api/webhooks/:id/test sendet Test-Ping', async () => {
    // Test-Ping wird versucht, aber example.com antwortet evtl. nicht → 502 oder 200
    const res = await request('POST', `/api/webhooks/${createdWebhookId}/test`);
    // Entweder Erfolg (200) oder externer Fehler (502)
    expect([200, 502]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body.ok).toBe(true);
    }
  });

  test('POST /api/webhooks/:id/test mit unbekannter ID gibt 404', async () => {
    const res = await request('POST', '/api/webhooks/wh-nonexistent/test');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/nicht gefunden/);
  });

  test('DELETE /api/webhooks/:id loescht Webhook', async () => {
    const res = await request('DELETE', `/api/webhooks/${createdWebhookId}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.deleted).toBe(createdWebhookId);
  });

  test('DELETE /api/webhooks/:id mit unbekannter ID gibt 404', async () => {
    const res = await request('DELETE', '/api/webhooks/wh-nonexistent');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/nicht gefunden/);
  });

  test('GET /api/webhooks nach Loeschen ist leer', async () => {
    const res = await request('GET', '/api/webhooks');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(0);
  });
});
