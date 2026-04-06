// Snapshots CRUD API - Tests
// Testet den kompletten Snapshot-Lifecycle: Create, List, Get, Delete, Restore, Compare, Size

'use strict';
const http = require('http');

const TEST_PORT = 3245;

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

const mockSnapshots = [
  { id: 'snap_abc123', name: 'Test Snapshot', description: 'Desc', createdAt: '2026-04-06T10:00:00.000Z', projectId: 'proj-1' },
  { id: 'snap_def456', name: 'Snapshot 2', description: 'Desc 2', createdAt: '2026-04-06T11:00:00.000Z', projectId: 'proj-1' },
];

jest.mock('../../orchestrator', () => {
  const EventEmitter = require('events').EventEmitter;
  class MockOrchestrator extends EventEmitter {
    constructor() {
      super();
      this.phase = 'idle';
      this.agents = [];
      this.startedAt = null;
      this.snapshotManager = {
        restoreSnapshot: jest.fn(async (id) => {
          const snap = mockSnapshots.find(s => s.id === id);
          if (!snap) throw new Error(`Snapshot ${id} nicht gefunden`);
          return { phase: 'complete', agents: [], coordinator: {} };
        }),
        listAllSnapshots: jest.fn(async () => mockSnapshots),
        deleteSnapshot: jest.fn(async (id) => {
          const snap = mockSnapshots.find(s => s.id === id);
          if (!snap) throw new Error(`Snapshot ${id} nicht gefunden`);
          return { deleted: id };
        }),
        getSnapshotSize: jest.fn(async (id) => {
          const snap = mockSnapshots.find(s => s.id === id);
          if (!snap) throw new Error(`Snapshot ${id} nicht gefunden`);
          return { id, sizeBytes: 4096, sizeFormatted: '4 KB' };
        }),
      };
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
    async getSnapshots(projectId) {
      if (projectId) return mockSnapshots.filter(s => s.projectId === projectId);
      return mockSnapshots;
    }
    async createSnapshot(name, description) {
      if (this.phase === 'idle') throw new Error('Kein aktives Projekt');
      return { id: 'snap_new789', name: name || 'Unnamed', description: description || '' };
    }
    async restoreSnapshot(id) {
      const snap = mockSnapshots.find(s => s.id === id);
      if (!snap) throw new Error(`Snapshot ${id} nicht gefunden`);
      this.phase = 'complete';
      return { phase: 'complete' };
    }
    async compareSnapshots(id1, id2) {
      const s1 = mockSnapshots.find(s => s.id === id1);
      const s2 = mockSnapshots.find(s => s.id === id2);
      if (!s1) throw new Error(`Snapshot ${id1} nicht gefunden`);
      if (!s2) throw new Error(`Snapshot ${id2} nicht gefunden`);
      return { id1, id2, agentsAdded: [], agentsRemoved: [], phaseDiff: false };
    }
  }
  return MockOrchestrator;
});

describe('Snapshots CRUD API', () => {
  beforeAll(done => {
    process.env.PORT = TEST_PORT;
    Object.keys(require.cache).forEach(key => {
      if (key.includes('server.js')) delete require.cache[key];
    });
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

  test('GET /api/snapshots listet alle Snapshots auf', async () => {
    const res = await request('GET', '/api/snapshots');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('snapshots');
    expect(Array.isArray(res.body.snapshots)).toBe(true);
    expect(res.body.snapshots.length).toBe(2);
    expect(res.body.snapshots[0].id).toBe('snap_abc123');
  });

  test('POST /api/snapshots erstellt Snapshot (Fehler bei idle)', async () => {
    const res = await request('POST', '/api/snapshots', { name: 'My Snap', description: 'Test' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Kein aktives Projekt/);
  });

  test('GET /api/snapshots/:id laedt einzelnen Snapshot', async () => {
    const res = await request('GET', '/api/snapshots/snap_abc123');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('id', 'snap_abc123');
    expect(res.body).toHaveProperty('state');
    expect(res.body).toHaveProperty('metadata');
    expect(res.body.state).toHaveProperty('phase', 'complete');
  });

  test('GET /api/snapshots/:id gibt 404 bei unbekanntem Snapshot', async () => {
    const res = await request('GET', '/api/snapshots/snap_unknown999');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/nicht gefunden/);
  });

  test('DELETE /api/snapshots/:id loescht Snapshot', async () => {
    const res = await request('DELETE', '/api/snapshots/snap_abc123');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.deleted).toBe('snap_abc123');
  });

  test('POST /api/snapshots/:id/restore stellt Snapshot wieder her', async () => {
    const res = await request('POST', '/api/snapshots/snap_abc123/restore');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.snapshotId).toBe('snap_abc123');
    expect(res.body).toHaveProperty('restoredPhase');
  });

  test('GET /api/snapshots/:id1/compare/:id2 vergleicht zwei Snapshots', async () => {
    const res = await request('GET', '/api/snapshots/snap_abc123/compare/snap_def456');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('id1', 'snap_abc123');
    expect(res.body).toHaveProperty('id2', 'snap_def456');
    expect(res.body).toHaveProperty('agentsAdded');
    expect(res.body).toHaveProperty('agentsRemoved');
  });

  test('GET /api/snapshots/:id/size gibt Snapshot-Groesse zurueck', async () => {
    const res = await request('GET', '/api/snapshots/snap_abc123/size');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('id', 'snap_abc123');
    expect(res.body).toHaveProperty('sizeBytes', 4096);
    expect(res.body).toHaveProperty('sizeFormatted', '4 KB');
  });
});
