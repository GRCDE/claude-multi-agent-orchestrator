// Roles API - Tests
// Testet GET/POST/PUT/DELETE /api/roles Endpoints

'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const TEST_PORT = 3250;
const ROLES_FILE = path.join(__dirname, '..', '..', 'roles.json');

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

// Backup und Restore der roles.json
let rolesBackup = null;

describe('Roles API', () => {
  beforeAll(done => {
    // Backup roles.json
    try {
      rolesBackup = fs.readFileSync(ROLES_FILE, 'utf-8');
    } catch { rolesBackup = null; }

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
    // Restore roles.json
    if (rolesBackup !== null) {
      fs.writeFileSync(ROLES_FILE, rolesBackup, 'utf-8');
    }
  });

  test('GET /api/roles gibt Rollen zurueck', async () => {
    const res = await request('GET', '/api/roles');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('roles');
    expect(res.body).toHaveProperty('defaultRoles');
    expect(res.body).toHaveProperty('customRoles');
    expect(Array.isArray(res.body.roles)).toBe(true);
    expect(Array.isArray(res.body.defaultRoles)).toBe(true);
  });

  test('Default-Rollen enthalten erwartete IDs', async () => {
    const res = await request('GET', '/api/roles');
    expect(res.status).toBe(200);
    const ids = res.body.defaultRoles.map(r => r.id);
    expect(ids).toContain('developer');
    expect(ids).toContain('tester');
    expect(ids).toContain('architect');
    expect(ids).toContain('reviewer');
    expect(ids).toContain('designer');
    expect(ids).toContain('devops');
    expect(ids).toContain('analyst');
  });

  test('Jede Default-Rolle hat erforderliche Felder', async () => {
    const res = await request('GET', '/api/roles');
    for (const role of res.body.defaultRoles) {
      expect(role).toHaveProperty('id');
      expect(role).toHaveProperty('name');
      expect(role).toHaveProperty('systemPrompt');
      expect(role).toHaveProperty('color');
      expect(role.builtin).toBe(true);
      expect(typeof role.systemPrompt).toBe('string');
      expect(role.systemPrompt.length).toBeGreaterThan(10);
    }
  });

  test('POST /api/roles erstellt neue Rolle', async () => {
    const newRole = {
      name: 'Test-Rolle',
      description: 'Eine Test-Rolle',
      systemPrompt: 'Du bist ein Test-Agent. Teste alles gruendlich.',
      color: '#ff0000'
    };
    const res = await request('POST', '/api/roles', newRole);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.role).toHaveProperty('id');
    expect(res.body.role.name).toBe('Test-Rolle');
    expect(res.body.role.builtin).toBe(false);
  });

  test('POST /api/roles ohne Name schlaegt fehl', async () => {
    const res = await request('POST', '/api/roles', {
      systemPrompt: 'Du bist ein Test.'
    });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });

  test('POST /api/roles ohne System-Prompt schlaegt fehl', async () => {
    const res = await request('POST', '/api/roles', {
      name: 'Incomplete Role'
    });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });

  test('DELETE /api/roles/:id loescht custom Rolle', async () => {
    // Erst erstellen
    const createRes = await request('POST', '/api/roles', {
      name: 'Zu Loeschen',
      description: 'Wird geloescht',
      systemPrompt: 'Temporaerer Agent.',
      color: '#00ff00'
    });
    expect(createRes.status).toBe(200);
    const roleId = createRes.body.role.id;

    // Dann loeschen
    const delRes = await request('DELETE', '/api/roles/' + roleId);
    expect(delRes.status).toBe(200);
    expect(delRes.body.ok).toBe(true);

    // Pruefen dass sie weg ist
    const listRes = await request('GET', '/api/roles');
    const ids = listRes.body.customRoles.map(r => r.id);
    expect(ids).not.toContain(roleId);
  });

  test('DELETE /api/roles/:id builtin Rolle schlaegt fehl', async () => {
    const res = await request('DELETE', '/api/roles/developer');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/vordefiniert/i);
  });

  test('PUT /api/roles/:id aktualisiert custom Rolle', async () => {
    // Erst erstellen
    const createRes = await request('POST', '/api/roles', {
      name: 'Update Test',
      description: 'Wird aktualisiert',
      systemPrompt: 'Originaler Prompt.',
      color: '#0000ff'
    });
    expect(createRes.status).toBe(200);
    const roleId = createRes.body.role.id;

    // Dann aktualisieren
    const updateRes = await request('PUT', '/api/roles/' + roleId, {
      name: 'Updated Name',
      systemPrompt: 'Aktualisierter Prompt.'
    });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.role.name).toBe('Updated Name');
    expect(updateRes.body.role.systemPrompt).toBe('Aktualisierter Prompt.');

    // Aufraeumen
    await request('DELETE', '/api/roles/' + roleId);
  });

  test('PUT /api/roles/:id builtin Rolle schlaegt fehl', async () => {
    const res = await request('PUT', '/api/roles/developer', {
      name: 'Geaendert',
      systemPrompt: 'Neuer Prompt.'
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/vordefiniert/i);
  });
});
