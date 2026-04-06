// Snapshot API - Tests
// Testet GET/POST/DELETE /api/snapshots und Restore/Compare

'use strict';
const http = require('http');
const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;

const TEST_PORT = 3231;

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

// Test-Snapshots Verzeichnis saeubern
const SNAPSHOTS_DIR = path.join(__dirname, '..', '..', 'snapshots');

describe('Snapshot API', () => {
  let createdSnapshots = [];

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
    // Aufraumen: erstellte Test-Snapshots loeschen
    for (const id of createdSnapshots) {
      try {
        const filePath = path.join(SNAPSHOTS_DIR, `${id}.json`);
        await fsp.unlink(filePath);
      } catch { /* ignorieren */ }
    }
  });

  test('GET /api/snapshots gibt Snapshot-Liste zurueck', async () => {
    const res = await request('GET', '/api/snapshots');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('snapshots');
    expect(Array.isArray(res.body.snapshots)).toBe(true);
  });

  test('POST /api/snapshots ohne aktives Projekt gibt Fehler', async () => {
    const res = await request('POST', '/api/snapshots', { name: 'Test', description: 'Test-Snap' });
    // Ohne aktives Projekt sollte 400 kommen
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });

  test('DELETE /api/snapshots/:id mit ungueltiger ID gibt 400', async () => {
    const res = await request('DELETE', '/api/snapshots/invalid_id');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Ungueltige/);
  });

  test('DELETE /api/snapshots/:id mit nicht-existenter ID gibt 404', async () => {
    const res = await request('DELETE', '/api/snapshots/snap_999999999_xyz');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/nicht gefunden/);
  });

  test('POST /api/snapshots/:id/restore mit nicht-existenter ID gibt 404', async () => {
    const res = await request('POST', '/api/snapshots/snap_999999999_xyz/restore');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/nicht gefunden/);
  });

  test('GET /api/snapshots/:id1/compare/:id2 mit ungueltigen IDs gibt 400', async () => {
    const res = await request('GET', '/api/snapshots/bad/compare/also_bad');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Ungueltige/);
  });

  test('GET /api/snapshots/:id/size mit nicht-existenter ID gibt 404', async () => {
    const res = await request('GET', '/api/snapshots/snap_999999999_xyz/size');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/nicht gefunden/);
  });

  test('GET /api/snapshots mit projectId Filter', async () => {
    const res = await request('GET', '/api/snapshots?projectId=proj_nonexistent');
    expect(res.status).toBe(200);
    expect(res.body.snapshots).toEqual([]);
  });
});
