// Search API - Tests
// Testet GET /api/search Endpoint

'use strict';
const http = require('http');
const path = require('path');
const fs = require('fs');

const TEST_PORT = 3219;

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

describe('Search API', () => {
  const projectsDir = path.join(__dirname, '..', '..', 'projects');
  const testProjId = 'proj_9999990001';
  const testProjDir = path.join(projectsDir, testProjId);
  const agentDir = path.join(testProjDir, 'agent-1');

  beforeAll(done => {
    // Test-Projekt anlegen fuer Suchergebnisse
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(testProjDir, 'state.json'), JSON.stringify({
      projectTitle: 'Suchtest Projekt Alpha',
      projectSummary: 'Ein Testprojekt fuer die Suchfunktion',
      agents: [
        { title: 'Frontend Agent', task: 'Erstelle eine React-Komponente' }
      ]
    }));
    fs.writeFileSync(path.join(agentDir, 'output.txt'), 'Dies ist eine Testdatei mit Inhalt zum Durchsuchen.');
    fs.writeFileSync(path.join(agentDir, 'conversation.jsonl'), JSON.stringify({
      role: 'assistant',
      content: 'Ich habe die React-Komponente erstellt. FERTIG'
    }) + '\n');

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
    // Test-Projekt aufraeumen
    try {
      fs.rmSync(testProjDir, { recursive: true, force: true });
    } catch { /* ignorieren */ }
  });

  test('GET /api/search?q=Suchtest gibt Ergebnisse zurueck', async () => {
    const res = await request('GET', '/api/search?q=Suchtest');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    // Treffer sollte unser Testprojekt enthalten
    const match = res.body.find(r => r.projectId === testProjId);
    expect(match).toBeDefined();
    expect(match.type).toBe('title');
  });

  test('GET /api/search mit scope=titles filtert auf Titel', async () => {
    const res = await request('GET', '/api/search?q=Alpha&scope=titles');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    // Alle Ergebnisse sollten Typ "title" haben
    res.body.forEach(r => {
      expect(r.type).toBe('title');
    });
  });

  test('GET /api/search mit scope=files filtert auf Dateien', async () => {
    const res = await request('GET', '/api/search?q=Testdatei&scope=files');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    res.body.forEach(r => {
      expect(r.type).toBe('file');
    });
  });

  test('GET /api/search mit scope=conversations filtert auf Konversationen', async () => {
    const res = await request('GET', '/api/search?q=React&scope=conversations');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    res.body.forEach(r => {
      expect(r.type).toBe('conversation');
    });
  });

  test('GET /api/search mit leerem q gibt leeres Array zurueck', async () => {
    const res = await request('GET', '/api/search?q=');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(0);
  });

  test('GET /api/search mit zu kurzem q gibt leeres Array zurueck', async () => {
    const res = await request('GET', '/api/search?q=x');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(0);
  });

  test('GET /api/search mit ungueltigem scope gibt 400', async () => {
    const res = await request('GET', '/api/search?q=test&scope=invalid');
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
    expect(res.body.error).toMatch(/Ung.ltiger Scope/);
  });

  test('GET /api/search liefert maximal 50 Ergebnisse', async () => {
    // Wir pruefen nur, dass das Ergebnis-Array nie mehr als 50 Eintraege hat
    const res = await request('GET', '/api/search?q=test');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeLessThanOrEqual(50);
  });

  test('GET /api/search Ergebnisse haben korrekte Struktur', async () => {
    const res = await request('GET', '/api/search?q=Suchtest');
    expect(res.status).toBe(200);
    if (res.body.length > 0) {
      const item = res.body[0];
      expect(item).toHaveProperty('projectId');
      expect(item).toHaveProperty('projectTitle');
      expect(item).toHaveProperty('type');
      expect(item).toHaveProperty('match');
      expect(item).toHaveProperty('context');
    }
  });
});
