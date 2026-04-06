// Recovery API - Tests
// Testet GET /api/recovery und POST /api/recovery/discard

'use strict';
const http = require('http');
const path = require('path');
const fs = require('fs');

const TEST_PORT = 3224;

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

describe('Recovery API', () => {
  beforeAll(done => {
    // Alle Checkpoint-Dateien im projects-Verzeichnis entfernen, damit kein Crash erkannt wird
    const projectsDir = path.join(__dirname, '..', '..', 'projects');
    try {
      if (fs.existsSync(projectsDir)) {
        const entries = fs.readdirSync(projectsDir);
        for (const entry of entries) {
          if (entry.startsWith('proj_')) {
            const projPath = path.join(projectsDir, entry);
            // Alle state.checkpoint.*.json Dateien entfernen
            try {
              const files = fs.readdirSync(projPath);
              for (const f of files) {
                if (f.startsWith('state.checkpoint.') && f.endsWith('.json')) {
                  fs.unlinkSync(path.join(projPath, f));
                }
              }
            } catch { /* ignorieren */ }
          }
        }
      }
    } catch { /* ignorieren */ }

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

  test('GET /api/recovery prueft Crash-Status', async () => {
    const res = await request('GET', '/api/recovery');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('hasCrash');
    expect(typeof res.body.hasCrash).toBe('boolean');
  });

  test('GET /api/recovery ohne Checkpoint gibt hasCrash=false', async () => {
    const res = await request('GET', '/api/recovery');
    expect(res.status).toBe(200);
    expect(res.body.hasCrash).toBe(false);
  });

  test('POST /api/recovery/discard ohne Checkpoint gibt 404', async () => {
    const res = await request('POST', '/api/recovery/discard');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Kein Checkpoint/);
  });

  test('POST /api/recovery/restore ohne Checkpoint gibt 404', async () => {
    const res = await request('POST', '/api/recovery/restore');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Kein Checkpoint/);
  });

  test('GET /api/recovery Antwort hat erwartete Felder', async () => {
    const res = await request('GET', '/api/recovery');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('hasCrash');
    if (res.body.hasCrash) {
      expect(res.body).toHaveProperty('projectId');
      expect(res.body).toHaveProperty('projectTitle');
    }
  });
});
