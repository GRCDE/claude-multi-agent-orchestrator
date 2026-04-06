// Search Advanced API - Tests
// Testet GET /api/search mit verschiedenen Scopes und mehreren Projekten

'use strict';
const http = require('http');
const path = require('path');
const fs = require('fs');

const TEST_PORT = 3254;

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

// Erhoehtes Timeout: Suche muss ggf. viele Projekte auf Disk scannen
jest.setTimeout(60000);

describe('Search Advanced API', () => {
  const projectsDir = path.join(__dirname, '..', '..', 'projects');

  // Projekt 1: Titel enthaelt "Zylindermotor", Datei enthaelt "Kolbendruck"
  // Niedrige IDs damit sie bei readdir frueh gefunden werden (vor dem 5s Search-Timeout)
  const proj1Id = 'proj_0000000001';
  const proj1Dir = path.join(projectsDir, proj1Id);
  const agent1Dir = path.join(proj1Dir, 'agent-1');

  // Projekt 2: Titel enthaelt "Quantenphysik", Conversation enthaelt "Verschraenkung"
  const proj2Id = 'proj_0000000002';
  const proj2Dir = path.join(projectsDir, proj2Id);
  const agent2Dir = path.join(proj2Dir, 'agent-1');

  beforeAll(done => {
    // Projekt 1 anlegen
    fs.mkdirSync(agent1Dir, { recursive: true });
    fs.writeFileSync(path.join(proj1Dir, 'state.json'), JSON.stringify({
      projectTitle: 'Zylindermotor Simulation',
      projectSummary: 'Simulation eines Vierzylindermotors',
      agents: [
        { title: 'Mechanik Agent', task: 'Berechne Kolbenbewegung' }
      ]
    }));
    fs.writeFileSync(path.join(agent1Dir, 'results.txt'), 'Der Kolbendruck betraegt 12 bar im Arbeitstakt.');
    fs.writeFileSync(path.join(agent1Dir, 'conversation.jsonl'),
      JSON.stringify({ role: 'assistant', content: 'Mechanik-Berechnung abgeschlossen.' }) + '\n'
    );

    // Projekt 2 anlegen
    fs.mkdirSync(agent2Dir, { recursive: true });
    fs.writeFileSync(path.join(proj2Dir, 'state.json'), JSON.stringify({
      projectTitle: 'Quantenphysik Forschung',
      projectSummary: 'Analyse von Quantenphaenomenen',
      agents: [
        { title: 'Theorie Agent', task: 'Erklaere Quantenverschraenkung' }
      ]
    }));
    fs.writeFileSync(path.join(agent2Dir, 'notes.txt'), 'Einfache Notizen ohne besondere Begriffe.');
    fs.writeFileSync(path.join(agent2Dir, 'conversation.jsonl'),
      JSON.stringify({ role: 'assistant', content: 'Die Verschraenkung zweier Teilchen wurde nachgewiesen.' }) + '\n'
    );

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
    try { fs.rmSync(proj1Dir, { recursive: true, force: true }); } catch { /* ignorieren */ }
    try { fs.rmSync(proj2Dir, { recursive: true, force: true }); } catch { /* ignorieren */ }
  });

  test('Suche findet Projekt per Titel', async () => {
    const res = await request('GET', '/api/search?q=Zylindermotor');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const match = res.body.find(r => r.projectId === proj1Id);
    expect(match).toBeDefined();
    expect(match.type).toBe('title');
    expect(match.match).toContain('Zylindermotor');
  });

  test('Suche findet Projekt per Dateiinhalt', async () => {
    const res = await request('GET', '/api/search?q=Kolbendruck');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const match = res.body.find(r => r.projectId === proj1Id && r.type === 'file');
    expect(match).toBeDefined();
    expect(match.type).toBe('file');
  });

  test('Scope titles durchsucht nur Titel', async () => {
    // "Quantenphysik" ist im Titel von Projekt 2
    const res = await request('GET', '/api/search?q=Quantenphysik&scope=titles');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    // Alle Ergebnisse muessen Typ "title" haben
    res.body.forEach(r => {
      expect(r.type).toBe('title');
    });
    const match = res.body.find(r => r.projectId === proj2Id);
    expect(match).toBeDefined();
  });

  test('Scope files durchsucht nur Dateien', async () => {
    // "Kolbendruck" ist nur in einer Datei, nicht im Titel
    const res = await request('GET', '/api/search?q=Kolbendruck&scope=files');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    res.body.forEach(r => {
      expect(r.type).toBe('file');
    });
  });

  test('Leerer Query gibt leeres Array zurueck', async () => {
    const res = await request('GET', '/api/search?q=');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(0);
  });

  test('Suche ohne Treffer gibt leeres Array zurueck', async () => {
    const res = await request('GET', '/api/search?q=Xylophonklaviersonate');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(0);
  });
});
