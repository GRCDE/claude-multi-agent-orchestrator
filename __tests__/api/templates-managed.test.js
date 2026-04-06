// Templates Managed API - Tests
// Testet die erweiterten Template-Manager Endpoints (Port 3227)

'use strict';
const http = require('http');

const TEST_PORT = 3227;

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

describe('Templates Managed API', () => {
  beforeAll(done => {
    process.env.PORT = TEST_PORT;
    delete require.cache[require.resolve('../../server')];
    delete require.cache[require.resolve('../../orchestrator')];
    delete require.cache[require.resolve('../../src/template-manager')];

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

  // 1. GET /api/templates/managed - Alle Templates auflisten
  test('GET /api/templates/managed gibt Templates-Array zurueck', async () => {
    const res = await request('GET', '/api/templates/managed');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('templates');
    expect(Array.isArray(res.body.templates)).toBe(true);
    // Es sollten mindestens die 5 Beispiel-Templates vorhanden sein
    expect(res.body.templates.length).toBeGreaterThanOrEqual(5);
  });

  // 2. POST + GET + DELETE Cycle
  test('POST erstellt, GET laedt, DELETE loescht ein Template', async () => {
    // Erstellen
    const createRes = await request('POST', '/api/templates/managed', {
      name: 'API-Test Template',
      description: 'Fuer API-Tests',
      category: 'Test',
      tags: ['api-test'],
      difficulty: 'beginner',
      agentCount: 2,
      tasks: [{ title: 'Task 1', description: 'Beschreibung' }]
    });
    expect(createRes.status).toBe(200);
    expect(createRes.body.ok).toBe(true);
    expect(createRes.body.template).toHaveProperty('id');

    const templateId = createRes.body.template.id;

    // Laden
    const getRes = await request('GET', '/api/templates/managed/' + templateId);
    expect(getRes.status).toBe(200);
    expect(getRes.body.template.name).toBe('API-Test Template');

    // Loeschen
    const delRes = await request('DELETE', '/api/templates/managed/' + templateId);
    expect(delRes.status).toBe(200);
    expect(delRes.body.ok).toBe(true);

    // Verifizieren dass geloescht
    const getRes2 = await request('GET', '/api/templates/managed/' + templateId);
    expect(getRes2.status).toBe(404);
  });

  // 3. Import - Template aus JSON importieren
  test('POST /api/templates/managed/import importiert ein Template', async () => {
    const templateData = {
      name: 'Importiertes Template',
      description: 'Per Import erstellt',
      tasks: [{ title: 'Importierte Aufgabe', description: 'Test' }],
      category: 'Import'
    };

    const res = await request('POST', '/api/templates/managed/import', templateData);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.template.name).toBe('Importiertes Template');

    // Aufraeumen
    if (res.body.template && res.body.template.id) {
      await request('DELETE', '/api/templates/managed/' + res.body.template.id);
    }
  });

  // 4. Export - Template als JSON exportieren
  test('GET /api/templates/managed/:id/export exportiert als JSON', async () => {
    const res = await request('GET', '/api/templates/managed/web-app/export');
    expect(res.status).toBe(200);
    expect(typeof res.body).toBe('object');
    expect(res.body.name).toBe('Fullstack Web-App');
  });

  // 5. Bewertung
  test('POST /api/templates/managed/:id/rate bewertet ein Template', async () => {
    // Erstelle ein Template zum Bewerten
    const createRes = await request('POST', '/api/templates/managed', {
      name: 'Rating Test',
      tasks: [{ title: 'Task', description: 'Test' }]
    });
    const id = createRes.body.template.id;

    const rateRes = await request('POST', '/api/templates/managed/' + id + '/rate', { rating: 4 });
    expect(rateRes.status).toBe(200);
    expect(rateRes.body.template.rating).toBe(4);
    expect(rateRes.body.template.ratingCount).toBe(1);

    // Zweite Bewertung
    const rateRes2 = await request('POST', '/api/templates/managed/' + id + '/rate', { rating: 2 });
    expect(rateRes2.status).toBe(200);
    expect(rateRes2.body.template.rating).toBe(3); // (4+2)/2
    expect(rateRes2.body.template.ratingCount).toBe(2);

    // Aufraeumen
    await request('DELETE', '/api/templates/managed/' + id);
  });

  // 6. Duplizierung
  test('POST /api/templates/managed/:id/duplicate erstellt eine Kopie', async () => {
    const dupRes = await request('POST', '/api/templates/managed/web-app/duplicate', { name: 'Kopie Web-App' });
    expect(dupRes.status).toBe(200);
    expect(dupRes.body.ok).toBe(true);
    expect(dupRes.body.template.name).toBe('Kopie Web-App');
    expect(dupRes.body.template.id).not.toBe('web-app');

    // Aufraeumen
    if (dupRes.body.template && dupRes.body.template.id) {
      await request('DELETE', '/api/templates/managed/' + dupRes.body.template.id);
    }
  });

  // 7. Filter nach Difficulty
  test('GET /api/templates/managed?difficulty=advanced filtert korrekt', async () => {
    const res = await request('GET', '/api/templates/managed?difficulty=advanced');
    expect(res.status).toBe(200);
    for (const t of res.body.templates) {
      expect(t.difficulty).toBe('advanced');
    }
  });

  // 8. Validierungsfehler bei fehlendem Namen
  test('POST /api/templates/managed ohne Name gibt 400', async () => {
    const res = await request('POST', '/api/templates/managed', {
      tasks: [{ title: 'Task', description: 'Test' }]
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Name ist erforderlich');
  });

  // 9. Template anwenden
  test('POST /api/templates/managed/:id/apply startet ein Projekt', async () => {
    const res = await request('POST', '/api/templates/managed/web-app/apply', {});
    // Kann 200 (gestartet) oder 409 (Queue voll) sein, beides ist OK
    expect([200, 409]).toContain(res.status);
  });
});
