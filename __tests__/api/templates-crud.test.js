// Templates CRUD API - Kompletter Lifecycle Test
// Testet POST, PUT, DELETE /api/templates + Import/Export

'use strict';
const http = require('http');

const TEST_PORT = 3244;

function request(method, urlPath, body) {
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

describe('Templates CRUD API', () => {
  let createdId;

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
    // Aufraumen: erstelltes Template loeschen falls noch vorhanden
    if (createdId) {
      try { await request('DELETE', `/api/templates/${createdId}`); } catch { /* ok */ }
    }
    const serverMod = require('../../server');
    if (serverMod && serverMod.cleanup) await serverMod.cleanup();
  });

  test('POST /api/templates - Template erstellen', async () => {
    const res = await request('POST', '/api/templates', {
      title: 'Test-Template',
      description: 'Ein Test-Template fuer CRUD-Tests',
      agentCount: 4,
      icon: '🧪',
      tags: ['test', 'crud']
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.template).toBeDefined();
    expect(res.body.template.name).toBe('Test-Template');
    expect(res.body.template.description).toBe('Ein Test-Template fuer CRUD-Tests');
    expect(res.body.template.suggestedAgents).toBe(4);
    expect(res.body.template.icon).toBe('🧪');
    expect(res.body.template.tags).toEqual(['test', 'crud']);
    expect(res.body.template.id).toMatch(/^tpl-/);
    expect(res.body.template.createdAt).toBeDefined();
    expect(res.body.template.updatedAt).toBeDefined();
    createdId = res.body.template.id;
  });

  test('PUT /api/templates/:id - Template aktualisieren', async () => {
    expect(createdId).toBeDefined();
    const res = await request('PUT', `/api/templates/${createdId}`, {
      title: 'Aktualisiertes Template',
      description: 'Neue Beschreibung',
      agentCount: 6,
      tags: ['updated']
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.template.name).toBe('Aktualisiertes Template');
    expect(res.body.template.description).toBe('Neue Beschreibung');
    expect(res.body.template.suggestedAgents).toBe(6);
    expect(res.body.template.tags).toEqual(['updated']);
  });

  test('DELETE /api/templates/:id - Template loeschen', async () => {
    expect(createdId).toBeDefined();
    const res = await request('DELETE', `/api/templates/${createdId}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // Verify: PUT auf geloeschtes Template gibt 404
    const res2 = await request('PUT', `/api/templates/${createdId}`, {
      title: 'Sollte fehlschlagen'
    });
    expect(res2.status).toBe(404);
    createdId = null; // schon geloescht
  });

  test('GET /api/templates/export - Templates als JSON exportieren', async () => {
    const res = await request('GET', '/api/templates/export');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('templates');
    expect(Array.isArray(res.body.templates)).toBe(true);
    expect(res.body.templates.length).toBeGreaterThan(0);
    // Jedes Template hat Pflichtfelder
    for (const t of res.body.templates) {
      expect(t).toHaveProperty('id');
      expect(t).toHaveProperty('name');
      expect(t).toHaveProperty('description');
    }
  });

  test('POST /api/templates/import - Templates aus JSON importieren', async () => {
    const importData = {
      templates: [
        {
          name: 'Importiertes Template',
          description: 'Aus Import erstellt',
          suggestedAgents: 2,
          icon: '📦',
          tags: ['import']
        }
      ]
    };
    const res = await request('POST', '/api/templates/import', importData);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.imported).toBe(1);
    expect(res.body.total).toBeGreaterThan(0);

    // Verify: Template existiert im Export
    const exp = await request('GET', '/api/templates/export');
    const found = exp.body.templates.find(t => t.name === 'Importiertes Template');
    expect(found).toBeDefined();
    expect(found.description).toBe('Aus Import erstellt');

    // Aufraumen
    if (found) {
      await request('DELETE', `/api/templates/${found.id}`);
    }
  });

  test('POST /api/templates - Ungueltig ohne Titel gibt 400', async () => {
    const res = await request('POST', '/api/templates', {
      description: 'Kein Titel',
      agentCount: 3
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  test('DELETE /api/templates/:id - Nicht existierendes Template gibt 404', async () => {
    const res = await request('DELETE', '/api/templates/tpl-nicht-vorhanden-99999');
    expect(res.status).toBe(404);
    expect(res.body.error).toBeDefined();
  });
});
