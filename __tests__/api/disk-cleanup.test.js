// Disk-Usage & Cleanup API - Tests
// Testet GET /api/disk-usage und POST /api/cleanup

'use strict';
const http = require('http');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');

const TEST_PORT = 3253;
const PROJECTS_DIR = path.join(__dirname, '..', '..', 'projects');

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

jest.mock('../../orchestrator', () => {
  const EventEmitter = require('events').EventEmitter;
  class MockOrchestrator extends EventEmitter {
    constructor() {
      super();
      this.phase = 'idle';
      this.agents = [];
      this.startedAt = null;
    }
    emit(event, data) {
      super.emit('update', { event, data, ts: Date.now() });
      super.emit(event, data);
      return true;
    }
    getState() {
      return {
        phase: this.phase,
        agents: this.agents,
        coordinator: {},
        totalTokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCost: 0 }
      };
    }
    start() { this.phase = 'running'; return Promise.resolve(); }
    reset() { this.phase = 'idle'; this.agents = []; }
    getPrompts() { return { prompts: {} }; }
    updatePrompts() {}
    resetPrompts() {}
    getConfig() { return {}; }
    updateConfig() {}
    approvePlan() {}
    modifyPlan() {}
    retryAgent() { return Promise.resolve(); }
    loadProject() { return this.getState(); }
    resume() { return Promise.resolve(); }
    setIntervention() {}
  }
  return MockOrchestrator;
});

// Projekt-IDs fuer Tests
const recentProjectId = `proj_${Date.now()}`;
const oldTimestamp = Date.now() - (8 * 24 * 60 * 60 * 1000); // 8 Tage alt
const oldProjectId = `proj_${oldTimestamp}`;

describe('Disk-Usage & Cleanup API', () => {
  beforeAll(async () => {
    // Testprojekte erstellen
    const recentDir = path.join(PROJECTS_DIR, recentProjectId);
    const oldDir = path.join(PROJECTS_DIR, oldProjectId);

    await fsp.mkdir(recentDir, { recursive: true });
    await fsp.writeFile(path.join(recentDir, 'state.json'), JSON.stringify({ phase: 'complete' }));

    await fsp.mkdir(oldDir, { recursive: true });
    await fsp.writeFile(path.join(oldDir, 'state.json'), JSON.stringify({ phase: 'complete' }));

    process.env.PORT = TEST_PORT;
    Object.keys(require.cache).forEach(key => {
      if (key.includes('server.js')) delete require.cache[key];
    });

    await new Promise((resolve, reject) => {
      try {
        require('../../server');
        setTimeout(resolve, 500);
      } catch (e) {
        reject(e);
      }
    });
  });

  afterAll(async () => {
    // Testprojekte aufraeumen
    for (const id of [recentProjectId, oldProjectId]) {
      const dir = path.join(PROJECTS_DIR, id);
      try { await fsp.rm(dir, { recursive: true, force: true }); } catch {}
    }

    const serverMod = require('../../server');
    if (serverMod && serverMod.cleanup) await serverMod.cleanup();
  });

  test('GET /api/disk-usage gibt Struktur mit totalSize und projectCount zurueck', async () => {
    const res = await request('GET', '/api/disk-usage');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('totalSize');
    expect(res.body).toHaveProperty('projectCount');
    expect(typeof res.body.totalSize).toBe('string');
    expect(res.body.totalSize).toMatch(/MB$/);
    expect(typeof res.body.projectCount).toBe('number');
    expect(res.body.projectCount).toBeGreaterThanOrEqual(2);
  });

  test('GET /api/disk-usage enthaelt oldest und newest Felder', async () => {
    const res = await request('GET', '/api/disk-usage');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('oldestProject');
    expect(res.body).toHaveProperty('newestProject');
    // Das alte Projekt oder ein aelteres sollte als oldest auftauchen
    const oldestTs = parseInt(res.body.oldestProject.replace('proj_', ''));
    const ourOldTs = parseInt(oldProjectId.replace('proj_', ''));
    expect(oldestTs).toBeLessThanOrEqual(ourOldTs);
  });

  test('POST /api/cleanup loescht alte Projekte', async () => {
    // Sicherstellen, dass das alte Projekt noch existiert
    const oldDir = path.join(PROJECTS_DIR, oldProjectId);
    const existsBefore = fs.existsSync(oldDir);
    expect(existsBefore).toBe(true);

    const res = await request('POST', '/api/cleanup');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.count).toBeGreaterThanOrEqual(1);
    expect(res.body.deleted).toContain(oldProjectId);

    // Verzeichnis sollte geloescht sein
    const existsAfter = fs.existsSync(oldDir);
    expect(existsAfter).toBe(false);
  });

  test('POST /api/cleanup mit keinen alten Projekten gibt 0 deleted', async () => {
    // Nochmal ausfuehren - das alte Projekt wurde bereits geloescht
    const res = await request('POST', '/api/cleanup');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.count).toBe(0);
    expect(res.body.deleted).toEqual([]);
  });

  test('GET /api/disk-usage nach cleanup zeigt korrekte Anzahl', async () => {
    const res = await request('GET', '/api/disk-usage');
    expect(res.status).toBe(200);
    // Das alte Projekt wurde geloescht, recent sollte noch da sein
    expect(res.body.projectCount).toBeGreaterThanOrEqual(1);
    // newestProject sollte das kuerzlich erstellte sein
    expect(res.body.newestProject).toBe(recentProjectId);
  });
});
