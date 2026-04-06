// Projects API - Tests
// Testet GET /api/projects, GET /api/projects/:id, DELETE /api/projects/:id,
// GET /api/projects/:id/changelog, GET /api/projects/:id1/diff/:id2

'use strict';
const http = require('http');
const path = require('path');
const fs = require('fs');

const TEST_PORT = 3235;

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

const projectsDir = path.join(__dirname, '../../projects');
const proj1Id = 'proj_9990001';
const proj2Id = 'proj_9990002';
const proj3Id = 'proj_9990003'; // zum Loeschen
const proj1Dir = path.join(projectsDir, proj1Id);
const proj2Dir = path.join(projectsDir, proj2Id);
const proj3Dir = path.join(projectsDir, proj3Id);

const state1 = {
  phase: 'complete',
  projectTitle: 'Testprojekt Alpha',
  startedAt: 1000000,
  completedAt: 2000000,
  totalDuration: 1000000,
  projectScore: 85,
  totalTokenUsage: { input: 5000, output: 3000 },
  agents: [
    { title: 'Frontend Agent', task: 'UI bauen', status: 'done', score: 90, rounds: 3 },
    { title: 'Backend Agent', task: 'API bauen', status: 'done', score: 80, rounds: 2 }
  ]
};

const state2 = {
  phase: 'complete',
  projectTitle: 'Testprojekt Beta',
  startedAt: 3000000,
  completedAt: 4000000,
  totalDuration: 1000000,
  projectScore: 72,
  totalTokenUsage: { input: 4000, output: 2000 },
  agents: [
    { title: 'Frontend Agent', task: 'UI bauen v2', status: 'done', score: 95, rounds: 2 },
    { title: 'Datenbank Agent', task: 'Schema erstellen', status: 'error', score: 50, rounds: 1 }
  ]
};

const state3 = {
  phase: 'error',
  projectTitle: 'Zum Loeschen',
  agents: []
};

describe('Projects API', () => {
  beforeAll(done => {
    // Projektverzeichnisse erstellen
    fs.mkdirSync(path.join(proj1Dir, 'agent-1'), { recursive: true });
    fs.mkdirSync(path.join(proj1Dir, 'agent-2'), { recursive: true });
    fs.mkdirSync(path.join(proj2Dir, 'agent-1'), { recursive: true });
    fs.mkdirSync(proj3Dir, { recursive: true });

    fs.writeFileSync(path.join(proj1Dir, 'state.json'), JSON.stringify(state1));
    fs.writeFileSync(path.join(proj2Dir, 'state.json'), JSON.stringify(state2));
    fs.writeFileSync(path.join(proj3Dir, 'state.json'), JSON.stringify(state3));

    // Conversation fuer Changelog-Test
    const conversation = [
      JSON.stringify({ role: 'assistant', content: 'Habe index.js erstellt und FERTIG', timestamp: 1000100 }),
      JSON.stringify({ role: 'coordinator', content: 'Gut gemacht', timestamp: 1000200 })
    ].join('\n');
    fs.writeFileSync(path.join(proj1Dir, 'agent-1', 'conversation.jsonl'), conversation);
    fs.writeFileSync(path.join(proj1Dir, 'agent-1', 'task.md'), '# Task 1');

    // Server starten
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
    try { fs.rmSync(proj1Dir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(proj2Dir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(proj3Dir, { recursive: true, force: true }); } catch {}
  });

  // ── GET /api/projects ─────────────────────────────────────────

  describe('GET /api/projects', () => {
    test('gibt Array von Projekten zurueck', async () => {
      const res = await request('GET', '/api/projects');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      // Mindestens unsere Testprojekte
      const ids = res.body.map(p => p.id);
      expect(ids).toContain(proj1Id);
      expect(ids).toContain(proj2Id);
    });

    test('Projekte enthalten erwartete Felder', async () => {
      const res = await request('GET', '/api/projects');
      const proj = res.body.find(p => p.id === proj1Id);
      expect(proj).toBeDefined();
      expect(proj.title).toBe('Testprojekt Alpha');
      expect(proj.phase).toBe('complete');
      expect(proj.agentCount).toBe(2);
      expect(proj.projectScore).toBe(85);
      expect(proj.totalTokenUsage).toEqual({ input: 5000, output: 3000 });
    });

    test('Projekte sind nach createdAt absteigend sortiert', async () => {
      const res = await request('GET', '/api/projects');
      const testProjects = res.body.filter(p => [proj1Id, proj2Id].includes(p.id));
      // proj2 (9990002) sollte vor proj1 (9990001) kommen
      const idx1 = res.body.findIndex(p => p.id === proj1Id);
      const idx2 = res.body.findIndex(p => p.id === proj2Id);
      expect(idx2).toBeLessThan(idx1);
    });
  });

  // ── GET /api/projects/:id ─────────────────────────────────────

  describe('GET /api/projects/:id', () => {
    test('gibt state.json des Projekts zurueck', async () => {
      const res = await request('GET', `/api/projects/${proj1Id}`);
      expect(res.status).toBe(200);
      expect(res.body.phase).toBe('complete');
      expect(res.body.projectTitle).toBe('Testprojekt Alpha');
      expect(res.body.agents).toHaveLength(2);
    });

    test('gibt 404 fuer nicht existierendes Projekt', async () => {
      const res = await request('GET', '/api/projects/proj_nonexistent');
      expect(res.status).toBe(404);
      expect(res.body.error).toBeDefined();
    });
  });

  // ── DELETE /api/projects/:id ──────────────────────────────────

  describe('DELETE /api/projects/:id', () => {
    test('loescht ein Projekt erfolgreich', async () => {
      // Sicherstellen dass es existiert
      const before = await request('GET', `/api/projects/${proj3Id}`);
      expect(before.status).toBe(200);

      const res = await request('DELETE', `/api/projects/${proj3Id}`);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.deleted).toBe(proj3Id);

      // Sicherstellen dass es weg ist
      const after = await request('GET', `/api/projects/${proj3Id}`);
      expect(after.status).toBe(404);
    });

    test('gibt 400 fuer ungueltige Projekt-ID', async () => {
      const res = await request('DELETE', '/api/projects/invalid_id');
      expect(res.status).toBe(400);
    });

    test('gibt 404 fuer nicht existierendes Projekt', async () => {
      const res = await request('DELETE', '/api/projects/proj_nonexistent');
      expect(res.status).toBe(404);
    });
  });

  // ── GET /api/projects/:id/changelog ───────────────────────────

  describe('GET /api/projects/:id/changelog', () => {
    test('gibt Changelog-Eintraege zurueck', async () => {
      const res = await request('GET', `/api/projects/${proj1Id}/changelog`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThan(0);

      const entry = res.body[0];
      expect(entry).toHaveProperty('timestamp');
      expect(entry).toHaveProperty('agentIndex');
      expect(entry).toHaveProperty('agentTitle');
      expect(entry).toHaveProperty('action');
      expect(entry).toHaveProperty('summary');
    });

    test('gibt 400 fuer ungueltige Projekt-ID', async () => {
      const res = await request('GET', '/api/projects/invalid/changelog');
      expect(res.status).toBe(400);
    });

    test('gibt 404 fuer nicht existierendes Projekt', async () => {
      const res = await request('GET', '/api/projects/proj_nonexistent/changelog');
      expect(res.status).toBe(404);
    });
  });

  // ── GET /api/projects/:id1/diff/:id2 ──────────────────────────

  describe('GET /api/projects/:id1/diff/:id2', () => {
    test('vergleicht zwei Projekte korrekt', async () => {
      const res = await request('GET', `/api/projects/${proj1Id}/diff/${proj2Id}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('added');
      expect(res.body).toHaveProperty('removed');
      expect(res.body).toHaveProperty('changed');
      expect(res.body).toHaveProperty('scoresDiff');

      // "Datenbank Agent" ist in proj2 aber nicht in proj1 -> added
      const addedTitles = res.body.added.map(a => a.title);
      expect(addedTitles).toContain('Datenbank Agent');

      // "Backend Agent" ist in proj1 aber nicht in proj2 -> removed
      const removedTitles = res.body.removed.map(a => a.title);
      expect(removedTitles).toContain('Backend Agent');

      // "Frontend Agent" ist in beiden mit unterschiedlichen Werten -> changed
      const changedTitles = res.body.changed.map(c => c.title);
      expect(changedTitles).toContain('Frontend Agent');

      // ScoreDiff pruefen
      expect(res.body.scoresDiff.project1.score).toBe(85);
      expect(res.body.scoresDiff.project2.score).toBe(72);
      expect(res.body.scoresDiff.scoreDelta).toBe(72 - 85);
    });

    test('gibt 400 bei ungueltiger Projekt-ID', async () => {
      const res = await request('GET', `/api/projects/invalid/diff/${proj2Id}`);
      expect(res.status).toBe(400);
    });

    test('gibt 404 wenn ein Projekt nicht existiert', async () => {
      const res = await request('GET', `/api/projects/${proj1Id}/diff/proj_nonexistent`);
      expect(res.status).toBe(404);
    });
  });
});
