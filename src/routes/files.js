'use strict';
const express = require('express');
const path = require('path');
const fsp = require('fs').promises;

const router = express.Router();

// ── Konstanten ───────────────────────────────────────────────
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico',
  '.woff', '.woff2', '.ttf', '.eot',
  '.zip', '.tar', '.gz', '.exe', '.dll', '.so', '.dylib'
]);
const MAX_FILE_SIZE = 1 * 1024 * 1024; // 1 MB

/**
 * Initialisiert den Files-Router mit Abhaengigkeiten aus server.js.
 * @param {object} deps - { orchestrator, logger, authMiddleware, apiLimiter, apiReadLimiter, app, PORT }
 */
function init(deps) {
  const { orchestrator, logger, authMiddleware, apiLimiter, apiReadLimiter, app, PORT } = deps;

  // ── Dateibaum API ────────────────────────────────────────────
  router.get('/files/:id', async (req, res) => {
    const dir = path.join(__dirname, '..', '..', 'projects', req.params.id);
    // Pfad-Traversal verhindern
    if (!dir.startsWith(path.join(__dirname, '..', '..', 'projects'))) {
      return res.status(400).json({ error: 'Ungültiger Pfad' });
    }
    try { await fsp.access(dir); } catch {
      return res.status(404).json({ error: 'Nicht gefunden' });
    }

    async function list(d, prefix = '') {
      const entries = await fsp.readdir(d, { withFileTypes: true });
      const results = [];
      for (const e of entries) {
        const rel = prefix ? prefix + '/' + e.name : e.name;
        if (e.isDirectory()) {
          results.push(...await list(path.join(d, e.name), rel));
        } else {
          const stat = await fsp.stat(path.join(d, e.name));
          results.push({ path: rel, size: stat.size });
        }
      }
      return results;
    }

    try {
      res.json(await list(dir));
    } catch (e) {
      res.status(500).json({ error: 'Fehler beim Lesen der Dateien' });
    }
  });

  // ── Datei-Inhalt API ──────────────────────────────────────
  router.get('/file-content/:id/:filePath(*)', apiLimiter, async (req, res) => {
    const projectDir = path.join(__dirname, '..', '..', 'projects', req.params.id);
    const filePath = decodeURIComponent(req.params.filePath);
    const resolved = path.resolve(projectDir, filePath);

    // Pfad-Traversal verhindern
    const normalizedProjectDir = path.resolve(projectDir);
    if (!resolved.startsWith(normalizedProjectDir + path.sep) && resolved !== normalizedProjectDir) {
      return res.status(400).json({ error: 'Ungültiger Pfad' });
    }

    let stat;
    try {
      stat = await fsp.stat(resolved);
    } catch {
      return res.status(404).json({ error: 'Datei nicht gefunden' });
    }

    if (stat.isDirectory()) {
      return res.status(400).json({ error: 'Pfad ist ein Verzeichnis' });
    }

    if (stat.size > MAX_FILE_SIZE) {
      return res.status(413).json({ error: 'Datei zu groß (max 1 MB)', size: stat.size, path: filePath });
    }

    const ext = path.extname(resolved).toLowerCase();
    if (BINARY_EXTENSIONS.has(ext)) {
      return res.json({ binary: true, size: stat.size, path: filePath });
    }

    try {
      const content = await fsp.readFile(resolved, 'utf8');
      res.json({ content, size: stat.size, path: filePath });
    } catch {
      return res.status(500).json({ error: 'Datei konnte nicht gelesen werden' });
    }
  });

  // ── API-Dokumentation ─────────────────────────────────────────
  const { generateApiDocs, generateMarkdown, generateOpenApiSpec } = require('../api-docs');
  const swaggerUi = require('swagger-ui-express');

  app.use('/api/docs/ui', swaggerUi.serve, swaggerUi.setup(null, { swaggerUrl: '/api/docs/openapi' }));

  router.get('/docs/json', (req, res) => {
    res.json(generateApiDocs());
  });

  router.get('/docs/openapi', (req, res) => {
    res.json(generateOpenApiSpec());
  });

  router.get('/docs/markdown', (req, res) => {
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.send(generateMarkdown());
  });

  router.get('/docs', (req, res) => {
    const docs = generateApiDocs();
    const categories = docs.categories;
    let categoriesHtml = '';

    for (const catName of Object.keys(categories)) {
      const endpoints = categories[catName];
      let endpointsHtml = '';
      for (const ep of endpoints) {
        const methodClass = ep.method.toLowerCase();
        const paramsEntries = Object.entries(ep.parameters || {});
        let paramsHtml = '';
        if (paramsEntries.length > 0) {
          paramsHtml = '<div class="params"><strong>Parameter:</strong><ul>';
          for (const [pType, fields] of paramsEntries) {
            if (typeof fields === 'object' && fields !== null) {
              for (const [k, v] of Object.entries(fields)) {
                paramsHtml += '<li><code>' + k + '</code> <em>(' + pType + ')</em>: ' + v.replace(/</g, '&lt;') + '</li>';
              }
            }
          }
          paramsHtml += '</ul></div>';
        }
        let responsesHtml = '';
        if (ep.responses) {
          responsesHtml = '<div class="responses"><strong>Responses:</strong><ul>';
          for (const [code, desc] of Object.entries(ep.responses)) {
            responsesHtml += '<li><code>' + code + '</code>: ' + desc.replace(/</g, '&lt;') + '</li>';
          }
          responsesHtml += '</ul></div>';
        }
        endpointsHtml += '<div class="endpoint"><div class="endpoint-header"><span class="method ' + methodClass + '">' + ep.method + '</span><span class="path">' + ep.path + '</span></div><p class="description">' + ep.description + '</p>' + paramsHtml + responsesHtml + (ep.example ? '<div class="example"><strong>Beispiel:</strong> <code>' + ep.example.replace(/</g, '&lt;') + '</code></div>' : '') + '</div>';
      }
      categoriesHtml += '<div class="category" id="cat-' + catName.toLowerCase() + '"><h2>' + catName + ' <span class="badge">' + endpoints.length + '</span></h2>' + endpointsHtml + '</div>';
    }

    var totalEndpoints = 0;
    for (const catName of Object.keys(categories)) {
      totalEndpoints += categories[catName].length;
    }

    const navHtml = Object.keys(categories).map(function(c) {
      return '<a href="#cat-' + c.toLowerCase() + '">' + c + ' (' + categories[c].length + ')</a>';
    }).join('');

    const html = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + docs.title + '</title><style>'
      + 'body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;margin:0;background:#f5f5f5;color:#333}'
      + '.container{max-width:1100px;margin:0 auto;padding:20px}'
      + 'h1{color:#1a1a2e;margin-bottom:5px}'
      + '.subtitle{color:#666;margin-bottom:20px}'
      + '.nav{background:#1a1a2e;padding:10px 20px;position:sticky;top:0;z-index:100;display:flex;flex-wrap:wrap;gap:8px}'
      + '.nav a{color:#8be9fd;text-decoration:none;font-size:14px;padding:4px 8px;border-radius:4px}'
      + '.nav a:hover{background:rgba(255,255,255,0.1)}'
      + '.category{margin-bottom:30px}'
      + '.category h2{border-bottom:2px solid #1a1a2e;padding-bottom:8px}'
      + '.badge{background:#1a1a2e;color:#fff;font-size:12px;padding:2px 8px;border-radius:10px}'
      + '.endpoint{background:#fff;border:1px solid #ddd;border-radius:8px;padding:16px;margin-bottom:12px}'
      + '.endpoint-header{display:flex;align-items:center;gap:10px;margin-bottom:8px}'
      + '.method{padding:4px 10px;border-radius:4px;font-weight:bold;font-size:13px;color:#fff;text-transform:uppercase}'
      + '.get{background:#61affe}.post{background:#49cc90}.put{background:#fca130}.delete{background:#f93e3e}'
      + '.path{font-family:monospace;font-size:15px;font-weight:bold}'
      + '.description{color:#555;margin:8px 0}'
      + '.params,.responses,.example{margin:8px 0;font-size:14px}'
      + '.params ul,.responses ul{margin:4px 0;padding-left:20px}'
      + '.params li,.responses li{margin:2px 0}'
      + 'code{background:#f0f0f0;padding:2px 6px;border-radius:3px;font-size:13px}'
      + '.formats{margin:20px 0;display:flex;gap:10px}'
      + '.formats a{padding:8px 16px;background:#1a1a2e;color:#fff;text-decoration:none;border-radius:6px;font-size:14px}'
      + '.formats a:hover{background:#2d2d4e}'
      + '</style></head><body>'
      + '<div class="nav">' + navHtml + '</div>'
      + '<div class="container">'
      + '<h1>' + docs.title + '</h1>'
      + '<p class="subtitle">Version ' + docs.version + ' &mdash; ' + totalEndpoints + ' Endpoints &mdash; ' + docs.description + '</p>'
      + '<div class="formats"><a href="/api/docs/json">JSON</a><a href="/api/docs/openapi">OpenAPI 3.0</a><a href="/api/docs/markdown">Markdown</a><a href="/api/docs/ui/">Swagger UI</a></div>'
      + categoriesHtml
      + '</div></body></html>';

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  });

  // ── i18n Endpoints ────────────────────────────────────────────
  const { LANGUAGES, getTranslations } = require('../i18n');

  // Accept-Language Header auswerten und ggf. als Default setzen
  function detectLanguageFromHeader(req) {
    const acceptLang = req.headers['accept-language'] || '';
    // Einfache Auswertung: erstes Match auf 'en' oder 'de'
    const supported = Object.keys(LANGUAGES);
    const parts = acceptLang.split(',').map(p => p.trim().split(';')[0].trim().toLowerCase());
    for (const part of parts) {
      const lang = part.slice(0, 2);
      if (supported.includes(lang)) return lang;
    }
    return null;
  }

  // GET /api/i18n - verfuegbare Sprachen
  router.get('/i18n', apiReadLimiter, (req, res) => {
    const config = orchestrator.getConfig();
    res.json({
      languages: LANGUAGES,
      current: config.language,
      default: 'de',
    });
  });

  // GET /api/i18n/:lang - alle Uebersetzungen fuer eine Sprache
  router.get('/i18n/:lang', apiReadLimiter, (req, res) => {
    const lang = req.params.lang;
    const trans = getTranslations(lang);
    if (!trans) {
      return res.status(404).json({ error: `Sprache '${lang}' nicht gefunden. Verfügbar: ${Object.keys(LANGUAGES).join(', ')}` });
    }
    res.json({ language: lang, label: LANGUAGES[lang], translations: trans });
  });

  // Middleware: Accept-Language auswerten wenn kein language in Config gesetzt
  app.use((req, res, next) => {
    const config = orchestrator.getConfig();
    if (!config.language || config.language === 'de') {
      const detected = detectLanguageFromHeader(req);
      if (detected && detected !== 'de') {
        // Nur als Hinweis in Header setzen, nicht automatisch Config aendern
        res.setHeader('X-Detected-Language', detected);
      }
    }
    next();
  });

  // ── Rollen API ───────────────────────────────────────────────────
  router.get('/roles', apiReadLimiter, (req, res) => {
    try {
      const roles = orchestrator.getRoles();
      const rolesData = orchestrator.getRolesData();
      res.json({ roles, defaultRoles: rolesData.defaultRoles, customRoles: rolesData.customRoles });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/roles', authMiddleware, apiLimiter, (req, res) => {
    try {
      const role = orchestrator.createRole(req.body);
      res.json({ ok: true, role });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.put('/roles/:id', authMiddleware, apiLimiter, (req, res) => {
    try {
      const role = orchestrator.updateRole(req.params.id, req.body);
      res.json({ ok: true, role });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.delete('/roles/:id', authMiddleware, apiLimiter, (req, res) => {
    try {
      orchestrator.deleteRole(req.params.id);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // ── Retry-Strategien API ─────────────────────────────────────
  router.get('/retry-strategies', apiReadLimiter, (req, res) => {
    res.json(orchestrator.getRetryStrategies());
  });

  router.get('/retry-strategy', apiReadLimiter, (req, res) => {
    res.json(orchestrator.getRetryStrategy());
  });

  router.put('/retry-strategy', authMiddleware, apiLimiter, (req, res) => {
    try {
      const result = orchestrator.setRetryStrategy(req.body);
      res.json({ ok: true, strategy: result });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // ── Batch-Operations API ─────────────────────────────────────
  const BatchProcessor = require('../batch-processor');
  const batchProcessor = new BatchProcessor(20, 30000);

  /**
   * Simuliert einen internen HTTP-Request gegen die Express-App.
   */
  function simulateRequest(expressApp, method, urlPath, body) {
    return new Promise((resolve) => {
      const http = require('http');
      const options = {
        hostname: 'localhost',
        port: PORT,
        path: urlPath,
        method: method.toUpperCase(),
        headers: { 'Content-Type': 'application/json' },
      };

      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          let parsed;
          try { parsed = JSON.parse(data); } catch { parsed = data; }
          resolve({ status: res.statusCode, body: parsed });
        });
      });

      req.on('error', (err) => {
        resolve({ status: 500, body: { error: err.message } });
      });

      if (body && (method.toUpperCase() === 'POST' || method.toUpperCase() === 'PUT')) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  }

  // POST /api/batch - Batch-Request verarbeiten
  router.post('/batch', apiLimiter, async (req, res) => {
    try {
      const { operations } = req.body || {};

      if (!operations) {
        return res.status(400).json({ error: 'operations ist erforderlich' });
      }

      const validation = batchProcessor.validateBatch(operations);
      if (!validation.valid) {
        return res.status(400).json({ error: 'Validierung fehlgeschlagen', details: validation.errors });
      }

      const result = await batchProcessor.processBatch(operations, async (op) => {
        return simulateRequest(app, op.method, op.path, op.body);
      });

      res.json(result);
    } catch (err) {
      if (logger) logger.error('Batch-Verarbeitung fehlgeschlagen', { error: err.message });
      res.status(500).json({ error: 'Batch-Verarbeitung fehlgeschlagen', details: err.message });
    }
  });

  // GET /api/batch/stats - Batch-Statistiken
  router.get('/batch/stats', apiReadLimiter, (req, res) => {
    res.json(batchProcessor.getBatchStats());
  });

  // GET /api/batch/blocked - Liste der blockierten Endpoints
  router.get('/batch/blocked', apiReadLimiter, (req, res) => {
    res.json({ blocked: batchProcessor.blockedEndpoints });
  });
}

module.exports = { router, init };
