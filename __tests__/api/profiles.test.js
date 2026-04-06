// Config-Profile API - Tests
// Testet die /api/profiles Endpoints

'use strict';
const http = require('http');

const TEST_PORT = 3229;

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

describe('Config-Profile API', () => {
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

  test('GET /api/profiles listet alle Profile', async () => {
    const res = await request('GET', '/api/profiles');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const names = res.body.map(p => p.name);
    expect(names).toContain('schnell');
    expect(names).toContain('standard');
    expect(names).toContain('gruendlich');
  });

  test('POST + GET + DELETE Cycle fuer benutzerdefiniertes Profil', async () => {
    // Erstellen
    const createRes = await request('POST', '/api/profiles', {
      name: 'api-test-profil',
      description: 'Erstellt via API Test',
      config: { maxParallelAgents: 4, maxRounds: 7 }
    });
    expect(createRes.status).toBe(201);
    expect(createRes.body.name).toBe('api-test-profil');

    // Lesen
    const getRes = await request('GET', '/api/profiles/api-test-profil');
    expect(getRes.status).toBe(200);
    expect(getRes.body.config.maxParallelAgents).toBe(4);

    // Loeschen
    const delRes = await request('DELETE', '/api/profiles/api-test-profil');
    expect(delRes.status).toBe(200);
    expect(delRes.body.ok).toBe(true);

    // Nicht mehr vorhanden
    const getRes2 = await request('GET', '/api/profiles/api-test-profil');
    expect(getRes2.status).toBe(404);
  });

  test('DELETE Default-Profil wird abgelehnt', async () => {
    const res = await request('DELETE', '/api/profiles/schnell');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Default/);
  });

  test('POST /api/profiles/:name/apply wendet Profil an', async () => {
    const res = await request('POST', '/api/profiles/schnell/apply');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.profile).toBe('schnell');
    expect(res.body.config).toBeTruthy();
  });

  test('GET /api/profiles/:name/export gibt JSON zurueck', async () => {
    const res = await request('GET', '/api/profiles/standard/export');
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('standard');
    expect(res.body.config).toBeTruthy();
  });

  test('POST /api/profiles/import importiert Profil', async () => {
    const profileData = {
      name: 'api-import-test',
      description: 'Importiert via API',
      config: { maxParallelAgents: 3, maxRounds: 10 }
    };
    const res = await request('POST', '/api/profiles/import', profileData);
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('api-import-test');

    // Aufraemen
    await request('DELETE', '/api/profiles/api-import-test');
  });

  test('POST /api/profiles/save-current speichert aktuelle Config', async () => {
    const res = await request('POST', '/api/profiles/save-current', {
      name: 'current-save-test',
      description: 'Aktuelle Config gespeichert'
    });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('current-save-test');
    expect(res.body.config).toBeTruthy();

    // Aufraemen
    await request('DELETE', '/api/profiles/current-save-test');
  });

  test('POST /api/profiles mit fehlendem name gibt 400', async () => {
    const res = await request('POST', '/api/profiles', {
      config: { maxRounds: 5 }
    });
    expect(res.status).toBe(400);
  });
});
