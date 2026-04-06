// Webhooks CRUD Lifecycle Tests
// Testet den kompletten Webhook-Lifecycle: Registrieren, Auflisten, Toggle, Test-Ping, Loeschen

'use strict';
const http = require('http');
const path = require('path');
const fs = require('fs');

const TEST_PORT = 3243;

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

describe('Webhooks CRUD Lifecycle', () => {
  const webhooksFile = path.join(__dirname, '..', '..', 'webhooks.json');
  let createdWebhookId = null;

  beforeAll(done => {
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
    try { fs.writeFileSync(webhooksFile, '[]', 'utf8'); } catch { /* ignorieren */ }
  });

  test('POST /api/webhooks registriert Webhook erfolgreich', async () => {
    const res = await request('POST', '/api/webhooks', {
      url: 'https://example.com/lifecycle-hook',
      events: ['project-started', 'project-done'],
      secret: 'geheimes-token-123'
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.webhook).toBeDefined();
    expect(res.body.webhook.url).toBe('https://example.com/lifecycle-hook');
    expect(res.body.webhook.events).toEqual(['project-started', 'project-done']);
    expect(res.body.webhook.secret).toBe('***');
    expect(res.body.webhook.active).toBe(true);
    expect(res.body.webhook.id).toBeDefined();
    createdWebhookId = res.body.webhook.id;
  });

  test('POST /api/webhooks ohne URL gibt 400', async () => {
    const res = await request('POST', '/api/webhooks', {
      events: ['project-started'],
      secret: 'testsecret123'
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/URL/i);
  });

  test('POST /api/webhooks mit zu kurzem Secret gibt 400', async () => {
    const res = await request('POST', '/api/webhooks', {
      url: 'https://example.com/short-secret',
      events: ['project-started'],
      secret: 'kurz'
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Secret/i);
  });

  test('GET /api/webhooks listet registrierten Webhook auf', async () => {
    const res = await request('GET', '/api/webhooks');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
    const hook = res.body.find(h => h.id === createdWebhookId);
    expect(hook).toBeDefined();
    expect(hook.url).toBe('https://example.com/lifecycle-hook');
    expect(hook.events).toEqual(['project-started', 'project-done']);
    expect(hook.secret).toBe('***');
    expect(hook.active).toBe(true);
  });

  test('POST /api/webhooks/:id/toggle deaktiviert Webhook', async () => {
    const res = await request('POST', `/api/webhooks/${createdWebhookId}/toggle`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.active).toBe(false);

    // Erneut togglen aktiviert wieder
    const res2 = await request('POST', `/api/webhooks/${createdWebhookId}/toggle`);
    expect(res2.status).toBe(200);
    expect(res2.body.ok).toBe(true);
    expect(res2.body.active).toBe(true);
  });

  test('POST /api/webhooks/:id/test sendet Test-Ping', async () => {
    const res = await request('POST', `/api/webhooks/${createdWebhookId}/test`);
    // example.com antwortet evtl. nicht -> 502, oder Erfolg -> 200
    expect([200, 502]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body.ok).toBe(true);
      expect(res.body.statusCode).toBeDefined();
    }
  });

  test('DELETE /api/webhooks/:id loescht Webhook', async () => {
    const res = await request('DELETE', `/api/webhooks/${createdWebhookId}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.deleted).toBe(createdWebhookId);

    // Pruefen dass er wirklich weg ist
    const list = await request('GET', '/api/webhooks');
    expect(list.status).toBe(200);
    const hook = list.body.find(h => h.id === createdWebhookId);
    expect(hook).toBeUndefined();
  });

  test('Max Webhooks Limit (10) wird eingehalten', async () => {
    // 10 Webhooks registrieren
    const ids = [];
    for (let i = 0; i < 10; i++) {
      const res = await request('POST', '/api/webhooks', {
        url: `https://example.com/limit-hook-${i}`,
        events: ['project-started'],
        secret: 'geheimes-token-123'
      });
      expect(res.status).toBe(200);
      ids.push(res.body.webhook.id);
    }

    // 11. Webhook muss fehlschlagen
    const res = await request('POST', '/api/webhooks', {
      url: 'https://example.com/limit-hook-overflow',
      events: ['project-started'],
      secret: 'geheimes-token-123'
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/[Mm]aximale/);

    // Aufraeumen: alle angelegten Webhooks loeschen
    for (const id of ids) {
      await request('DELETE', `/api/webhooks/${id}`);
    }
  });

  test('DELETE /api/webhooks/:id mit unbekannter ID gibt 404', async () => {
    const res = await request('DELETE', '/api/webhooks/wh-nonexistent-999');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/nicht gefunden/);
  });
});
