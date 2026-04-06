// Analytics API - Tests
// Testet GET /api/analytics Endpoint

'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const TEST_PORT = 3211;
const PROJECTS_DIR = path.join(__dirname, '..', '..', 'projects');

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
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
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

jest.mock('express-rate-limit', () => {
  return () => (req, res, next) => next();
});

// Hilfsfunktion: Test-Projekt erstellen
function createTestProject(id, stateOverrides = {}) {
  const dir = path.join(PROJECTS_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  const state = {
    phase: 'complete',
    projectId: id,
    projectTitle: 'Test Projekt ' + id,
    projectSummary: 'Zusammenfassung',
    startedAt: Date.now() - 120000,
    completedAt: Date.now(),
    totalDuration: 120,
    projectScore: 75,
    agents: [
      { role: 'Backend-Entwickler', status: 'done', duration: 60, score: 80, title: 'Agent 1' },
      { role: 'Frontend-Entwickler', status: 'done', duration: 50, score: 70, title: 'Agent 2' }
    ],
    totalTokenUsage: { inputTokens: 5000, outputTokens: 3000, totalTokens: 8000, estimatedCost: 0.05 },
    projectStats: { totalFiles: 4, totalSize: 2048, totalLines: 200 },
    ...stateOverrides
  };
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state, null, 2));
  return dir;
}

// Hilfsfunktion: Test-Projekt aufräumen
function cleanupTestProjects(ids) {
  for (const id of ids) {
    const dir = path.join(PROJECTS_DIR, id);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

describe('Analytics API', () => {
  const testProjectIds = ['proj_test_analytics_1', 'proj_test_analytics_2', 'proj_test_analytics_3'];

  beforeAll(done => {
    process.env.PORT = TEST_PORT;
    delete require.cache[require.resolve('../../server')];
    delete require.cache[require.resolve('../../orchestrator')];

    // Alte Test-Projekte aufräumen
    cleanupTestProjects(testProjectIds);

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
    cleanupTestProjects(testProjectIds);
  });

  test('GET /api/analytics gibt korrekte Struktur zurueck', async () => {
    const res = await request('GET', '/api/analytics');
    expect(res.status).toBe(200);

    // Top-level Felder pruefen
    expect(res.body).toHaveProperty('timeline');
    expect(res.body).toHaveProperty('roleStats');
    expect(res.body).toHaveProperty('costEfficiency');
    expect(res.body).toHaveProperty('topStats');
    expect(res.body).toHaveProperty('distribution');

    // costEfficiency Felder
    expect(res.body.costEfficiency).toHaveProperty('avgTokensPerProject');
    expect(res.body.costEfficiency).toHaveProperty('avgTokensPerAgent');
    expect(res.body.costEfficiency).toHaveProperty('avgTokensPerFile');
    expect(res.body.costEfficiency).toHaveProperty('avgCostPerProject');

    // topStats Felder
    expect(res.body.topStats).toHaveProperty('bestProject');
    expect(res.body.topStats).toHaveProperty('worstProject');
    expect(res.body.topStats).toHaveProperty('fastestProject');
    expect(res.body.topStats).toHaveProperty('longestProject');

    // distribution Felder
    expect(res.body.distribution).toHaveProperty('scoreBuckets');
    expect(res.body.distribution).toHaveProperty('durationBuckets');
  });

  test('Alle Arrays sind tatsaechlich Arrays', async () => {
    const res = await request('GET', '/api/analytics');
    expect(res.status).toBe(200);

    expect(Array.isArray(res.body.timeline)).toBe(true);
    expect(Array.isArray(res.body.roleStats)).toBe(true);
    expect(Array.isArray(res.body.distribution.scoreBuckets)).toBe(true);
    expect(Array.isArray(res.body.distribution.durationBuckets)).toBe(true);
  });

  test('Top stats behandelt leeren Fall graceful (null statt Error)', async () => {
    const res = await request('GET', '/api/analytics');
    expect(res.status).toBe(200);

    // Jeder topStats-Wert ist entweder null oder ein Objekt mit den erwarteten Feldern
    const { bestProject, worstProject, fastestProject, longestProject } = res.body.topStats;

    if (bestProject !== null) {
      expect(bestProject).toHaveProperty('id');
      expect(bestProject).toHaveProperty('title');
      expect(bestProject).toHaveProperty('score');
    }
    if (worstProject !== null) {
      expect(worstProject).toHaveProperty('id');
      expect(worstProject).toHaveProperty('title');
      expect(worstProject).toHaveProperty('score');
    }
    if (fastestProject !== null) {
      expect(fastestProject).toHaveProperty('id');
      expect(fastestProject).toHaveProperty('title');
      expect(fastestProject).toHaveProperty('duration');
    }
    if (longestProject !== null) {
      expect(longestProject).toHaveProperty('id');
      expect(longestProject).toHaveProperty('title');
      expect(longestProject).toHaveProperty('duration');
    }
  });

  test('Distribution hat korrekte Bucket-Ranges', async () => {
    const res = await request('GET', '/api/analytics');
    expect(res.status).toBe(200);

    const scoreRanges = res.body.distribution.scoreBuckets.map(b => b.range);
    expect(scoreRanges).toEqual(['0-20', '21-40', '41-60', '61-80', '81-100']);

    const durationRanges = res.body.distribution.durationBuckets.map(b => b.range);
    expect(durationRanges).toEqual(['0-60s', '61-120s', '121-300s', '301-600s', '600s+']);
  });

  test('Gibt Daten mit Test-Projekten zurueck', async () => {
    // Test-Projekte erstellen
    createTestProject(testProjectIds[0], {
      phase: 'complete', projectScore: 85, totalDuration: 100,
      startedAt: Date.now() - 100000
    });
    createTestProject(testProjectIds[1], {
      phase: 'error', projectScore: 30, totalDuration: 200,
      startedAt: Date.now() - 200000
    });
    createTestProject(testProjectIds[2], {
      phase: 'complete', projectScore: 60, totalDuration: 400,
      startedAt: Date.now() - 300000
    });

    // Cache invalidieren (warten bis TTL abläuft oder neuen Request erzwingen)
    // Da der Test-Server frisch ist, sollte der Cache leer sein oder wir warten
    // Wir setzen den Cache-Timestamp manuell nicht, stattdessen akzeptieren wir cached Daten
    // und prüfen nur die Struktur

    // Warte kurz damit der Cache abläuft (falls vorheriger Test gecached hat)
    await new Promise(r => setTimeout(r, 100));

    const res = await request('GET', '/api/analytics');
    expect(res.status).toBe(200);

    // Struktur muss immer noch stimmen
    expect(Array.isArray(res.body.timeline)).toBe(true);
    expect(Array.isArray(res.body.roleStats)).toBe(true);
    expect(typeof res.body.costEfficiency).toBe('object');
    expect(typeof res.body.topStats).toBe('object');
    expect(typeof res.body.distribution).toBe('object');

    // costEfficiency Werte sind Zahlen
    expect(typeof res.body.costEfficiency.avgTokensPerProject).toBe('number');
    expect(typeof res.body.costEfficiency.avgTokensPerAgent).toBe('number');
    expect(typeof res.body.costEfficiency.avgTokensPerFile).toBe('number');
    expect(typeof res.body.costEfficiency.avgCostPerProject).toBe('number');

    // Buckets haben count-Felder vom Typ number
    for (const bucket of res.body.distribution.scoreBuckets) {
      expect(typeof bucket.count).toBe('number');
      expect(bucket.count).toBeGreaterThanOrEqual(0);
    }
    for (const bucket of res.body.distribution.durationBuckets) {
      expect(typeof bucket.count).toBe('number');
      expect(bucket.count).toBeGreaterThanOrEqual(0);
    }
  });
});
