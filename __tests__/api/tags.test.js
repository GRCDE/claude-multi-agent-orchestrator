// Tags API - Tests
// Testet GET /api/tags und Tag-Funktionalitaet in Templates

'use strict';
const http = require('http');

const TEST_PORT = 3275;

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

describe('Tags API', () => {
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

  test('GET /api/tags gibt Tag-Liste zurueck', async () => {
    const res = await request('GET', '/api/tags');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('tags');
    expect(Array.isArray(res.body.tags)).toBe(true);
  });

  test('Template mit Tags erstellen und in /api/tags wiederfinden', async () => {
    // Template mit Tags erstellen
    const createRes = await request('POST', '/api/templates', {
      title: 'Tag-Test Template',
      description: 'Template fuer Tag-Tests',
      agentCount: 2,
      tags: ['test-tag-alpha', 'test-tag-beta']
    });
    expect(createRes.status).toBe(200);
    expect(createRes.body).toHaveProperty('template');
    expect(createRes.body.template).toHaveProperty('id');

    // Tags-Endpoint pruefen
    const tagsRes = await request('GET', '/api/tags');
    expect(tagsRes.status).toBe(200);
    expect(tagsRes.body.tags).toContain('test-tag-alpha');
    expect(tagsRes.body.tags).toContain('test-tag-beta');

    // Aufraeumen: Template wieder loeschen
    await request('DELETE', '/api/templates/' + createRes.body.template.id);
  });

  test('Tags sind in Template-Liste enthalten', async () => {
    // Template mit Tags erstellen
    const createRes = await request('POST', '/api/templates', {
      title: 'Tag-Liste Template',
      description: 'Template fuer Tag-Listen-Test',
      agentCount: 3,
      tags: ['liste-tag']
    });
    expect(createRes.status).toBe(200);
    const templateId = createRes.body.template.id;

    // Templates laden und Tags pruefen
    const templatesRes = await request('GET', '/api/templates');
    expect(templatesRes.status).toBe(200);
    const created = templatesRes.body.templates.find(t => t.id === templateId);
    expect(created).toBeDefined();
    expect(created.tags).toContain('liste-tag');

    // Aufraeumen
    await request('DELETE', '/api/templates/' + templateId);
  });

  test('Tags-Liste enthaelt keine Duplikate', async () => {
    // Zwei Templates mit gleichem Tag erstellen
    const res1 = await request('POST', '/api/templates', {
      title: 'Duplikat-Test 1',
      description: 'Erster Duplikat-Test',
      agentCount: 2,
      tags: ['duplikat-tag', 'einzigartig-eins']
    });
    const res2 = await request('POST', '/api/templates', {
      title: 'Duplikat-Test 2',
      description: 'Zweiter Duplikat-Test',
      agentCount: 2,
      tags: ['duplikat-tag', 'einzigartig-zwei']
    });

    const tagsRes = await request('GET', '/api/tags');
    expect(tagsRes.status).toBe(200);

    // duplikat-tag darf nur einmal vorkommen
    const count = tagsRes.body.tags.filter(t => t === 'duplikat-tag').length;
    expect(count).toBe(1);

    // Beide einzigartigen Tags muessen vorhanden sein
    expect(tagsRes.body.tags).toContain('einzigartig-eins');
    expect(tagsRes.body.tags).toContain('einzigartig-zwei');

    // Aufraeumen
    if (res1.body.template) await request('DELETE', '/api/templates/' + res1.body.template.id);
    if (res2.body.template) await request('DELETE', '/api/templates/' + res2.body.template.id);
  });
});
