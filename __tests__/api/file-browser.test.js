// File Browser API - Tests
// Testet GET /api/files/:id und GET /api/file-content/:id/:filePath

'use strict';
const http = require('http');
const path = require('path');
const fs = require('fs');

const TEST_PORT = 3212;

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
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        let body;
        try { body = JSON.parse(raw.toString('utf8')); }
        catch { body = raw.toString('utf8'); }
        resolve({ status: res.statusCode, body, headers: res.headers });
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

// Test-Projekt erstellen
const testProjectId = 'proj_filebrowser_test_' + Date.now();
const projectsDir = path.join(__dirname, '../../projects');
const testDir = path.join(projectsDir, testProjectId);

describe('File Browser API', () => {
  beforeAll(done => {
    // Projektstruktur erstellen
    fs.mkdirSync(path.join(testDir, 'agent-1', 'src'), { recursive: true });
    fs.mkdirSync(path.join(testDir, 'agent-2'), { recursive: true });

    // Verschiedene Dateitypen erstellen
    fs.writeFileSync(path.join(testDir, 'state.json'), JSON.stringify({ phase: 'complete' }));
    fs.writeFileSync(path.join(testDir, 'agent-1', 'task.md'), '# Task 1\nBeschreibung');
    fs.writeFileSync(path.join(testDir, 'agent-1', 'index.js'), 'const x = 1;\nconsole.log(x);');
    fs.writeFileSync(path.join(testDir, 'agent-1', 'src', 'utils.js'), 'module.exports = {};');
    fs.writeFileSync(path.join(testDir, 'agent-2', 'output.html'), '<h1>Ergebnis</h1>');

    // Binary-Datei simulieren (leere PNG-Signatur)
    const pngHeader = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    fs.writeFileSync(path.join(testDir, 'agent-1', 'logo.png'), pngHeader);

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
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  // ── GET /api/files/:id ─────────────────────────────────────

  describe('GET /api/files/:id', () => {
    test('listet alle Dateien eines Projekts', async () => {
      const res = await request('GET', `/api/files/${testProjectId}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThanOrEqual(5);

      // Jeder Eintrag hat path und size
      for (const file of res.body) {
        expect(file).toHaveProperty('path');
        expect(file).toHaveProperty('size');
        expect(typeof file.path).toBe('string');
        expect(typeof file.size).toBe('number');
      }
    });

    test('enthaelt erwartete Dateipfade', async () => {
      const res = await request('GET', `/api/files/${testProjectId}`);
      const paths = res.body.map(f => f.path);

      expect(paths).toContain('state.json');
      expect(paths).toContain('agent-1/task.md');
      expect(paths).toContain('agent-1/index.js');
      expect(paths).toContain('agent-1/src/utils.js');
      expect(paths).toContain('agent-2/output.html');
      expect(paths).toContain('agent-1/logo.png');
    });

    test('enthaelt verschachtelte Unterverzeichnisse', async () => {
      const res = await request('GET', `/api/files/${testProjectId}`);
      const paths = res.body.map(f => f.path);
      // src/utils.js liegt in einem Unterverzeichnis
      expect(paths.some(p => p.includes('src/'))).toBe(true);
    });

    test('gibt 404 fuer nicht-existierendes Projekt', async () => {
      const res = await request('GET', '/api/files/proj_nichtexistent_files');
      expect(res.status).toBe(404);
      expect(res.body).toHaveProperty('error');
    });

    test('gibt Dateigroessen zurueck', async () => {
      const res = await request('GET', `/api/files/${testProjectId}`);
      const indexJs = res.body.find(f => f.path === 'agent-1/index.js');
      expect(indexJs).toBeDefined();
      expect(indexJs.size).toBeGreaterThan(0);
    });
  });

  // ── GET /api/file-content/:id/:filePath ────────────────────

  describe('GET /api/file-content/:id/:filePath', () => {
    test('liest Textdatei-Inhalt', async () => {
      const res = await request('GET', `/api/file-content/${testProjectId}/agent-1/index.js`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('content');
      expect(res.body.content).toContain('const x = 1');
      expect(res.body).toHaveProperty('size');
      expect(res.body).toHaveProperty('path', 'agent-1/index.js');
    });

    test('liest Markdown-Datei', async () => {
      const res = await request('GET', `/api/file-content/${testProjectId}/agent-1/task.md`);
      expect(res.status).toBe(200);
      expect(res.body.content).toContain('# Task 1');
    });

    test('liest Dateien in Unterverzeichnissen', async () => {
      const res = await request('GET', `/api/file-content/${testProjectId}/agent-1/src/utils.js`);
      expect(res.status).toBe(200);
      expect(res.body.content).toContain('module.exports');
    });

    test('gibt 404 fuer nicht-existierende Datei', async () => {
      const res = await request('GET', `/api/file-content/${testProjectId}/agent-1/nichtda.txt`);
      expect(res.status).toBe(404);
      expect(res.body).toHaveProperty('error');
    });

    test('gibt 404 fuer nicht-existierendes Projekt', async () => {
      const res = await request('GET', '/api/file-content/proj_nichtexistent_fc/index.js');
      expect(res.status).toBe(404);
    });
  });

  // ── Pfad-Traversal Schutz ──────────────────────────────────

  describe('Pfad-Traversal wird verhindert', () => {
    test('blockiert ../../../etc/passwd in file-content', async () => {
      const res = await request('GET', `/api/file-content/${testProjectId}/..%2F..%2F..%2Fetc%2Fpasswd`);
      expect([400, 404]).toContain(res.status);
      // Kein Dateiinhalt zurueckgegeben
      if (res.body && typeof res.body === 'object') {
        expect(res.body).not.toHaveProperty('content');
      }
    });

    test('blockiert ..\\..\\..\\etc\\passwd (Windows-Pfade) in file-content', async () => {
      const res = await request('GET', `/api/file-content/${testProjectId}/..%5C..%5C..%5Cetc%5Cpasswd`);
      expect([400, 404]).toContain(res.status);
    });

    test('blockiert Traversal mit encoded dots in file-content', async () => {
      const res = await request('GET', `/api/file-content/${testProjectId}/%2e%2e/%2e%2e/etc/passwd`);
      expect([400, 404]).toContain(res.status);
    });

    test('blockiert Pfad-Traversal in files-Endpoint', async () => {
      const res = await request('GET', '/api/files/..%2F..%2Fetc');
      expect([400, 404]).toContain(res.status);
    });

    test('erlaubt normale Unterpfade', async () => {
      const res = await request('GET', `/api/file-content/${testProjectId}/agent-1/src/utils.js`);
      // 200 oder 429 (Rate-Limit nach vielen file-content Requests)
      expect([200, 429]).toContain(res.status);
      if (res.status === 200) {
        expect(res.body).toHaveProperty('content');
      }
    });
  });

  // ── Binary-Dateien und Sonderfaelle ──────────────────────
  // Hinweis: /api/file-content hat apiLimiter (10 req/min).
  // Wir kombinieren Tests um unter dem Limit zu bleiben.

  describe('Binary-Dateien werden korrekt erkannt', () => {
    test('PNG wird als binary markiert, JS und HTML nicht', async () => {
      // PNG → binary
      const resPng = await request('GET', `/api/file-content/${testProjectId}/agent-1/logo.png`);
      // 200 oder 429 (Rate-Limit)
      if (resPng.status === 200) {
        expect(resPng.body).toHaveProperty('binary', true);
        expect(resPng.body).toHaveProperty('size');
        expect(resPng.body).toHaveProperty('path', 'agent-1/logo.png');
        expect(resPng.body).not.toHaveProperty('content');
      } else {
        expect(resPng.status).toBe(429);
      }

      // JS → nicht binary
      const resJs = await request('GET', `/api/file-content/${testProjectId}/agent-1/index.js`);
      if (resJs.status === 200) {
        expect(resJs.body).not.toHaveProperty('binary');
        expect(resJs.body).toHaveProperty('content');
      } else {
        expect(resJs.status).toBe(429);
      }

      // HTML → nicht binary
      const resHtml = await request('GET', `/api/file-content/${testProjectId}/agent-2/output.html`);
      if (resHtml.status === 200) {
        expect(resHtml.body).not.toHaveProperty('binary');
        expect(resHtml.body).toHaveProperty('content');
        expect(resHtml.body.content).toContain('<h1>Ergebnis</h1>');
      } else {
        expect(resHtml.status).toBe(429);
      }
    });
  });

  // ── Verzeichnis als Datei ──────────────────────────────────

  describe('Verzeichnis-Zugriff', () => {
    test('gibt 400 oder 404 wenn Pfad ein Verzeichnis ist', async () => {
      const res = await request('GET', `/api/file-content/${testProjectId}/agent-1/src`);
      // 400 (ist ein Verzeichnis), 404 oder 429 (Rate-Limit)
      expect([400, 404, 429]).toContain(res.status);
    });
  });
});
