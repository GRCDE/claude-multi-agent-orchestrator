'use strict';
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');
const logger = require('./src/logger');
const Orchestrator = require('./orchestrator');

const orchestrator = new Orchestrator();
const app = express();
const PORT = parseInt(process.env.PORT) || 3131;

// ── CORS auf localhost beschränken ───────────────────────────
app.use(cors({
  origin: [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`]
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Rate-Limiting ─────────────────────────────────────────────
const rateLimit = require('express-rate-limit');

const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 Minute
  max: 10, // max 10 Requests pro Minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Zu viele Anfragen. Bitte warte eine Minute.' }
});

const startLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 3, // max 3 Projekt-Starts pro Minute
  message: { error: 'Zu viele Projekt-Starts. Bitte warte eine Minute.' }
});

// ── SSE Clients (Map mit Max 50) ────────────────────────────
let clientIdCounter = 0;
const clients = new Map();
const MAX_CLIENTS = 50;

// Heartbeat: Prüfe alle 30s ob Clients noch leben
setInterval(() => {
  for (const [id, res] of clients) {
    try {
      res.write(': heartbeat\n\n');
    } catch {
      clients.delete(id);
    }
  }
}, 30000);

function broadcast(eventName, data) {
  const msg = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const [id, res] of clients) {
    try {
      res.write(msg);
    } catch {
      // Toter Client – entfernen
      clients.delete(id);
    }
  }
}

// ── SSE Event-Batching ──────────────────────────────────────
let eventBatch = [];
let batchTimer = null;
const BATCH_INTERVAL = 100; // ms

function queueBroadcast(eventName, data) {
  eventBatch.push({ event: eventName, data });
  if (!batchTimer) {
    batchTimer = setTimeout(flushBatch, BATCH_INTERVAL);
  }
}

function flushBatch() {
  batchTimer = null;
  if (eventBatch.length === 0) return;

  const batch = eventBatch;
  eventBatch = [];

  // Einzelne Events senden (nicht als Array, damit Frontend kompatibel bleibt)
  for (const { event, data } of batch) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const [id, res] of clients) {
      try { res.write(msg); } catch { clients.delete(id); }
    }
  }
}

// Statt direktem broadcast: queueBroadcast verwenden
orchestrator.on('update', ({ event, data }) => queueBroadcast(event, data));

// ── SSE Endpoint ─────────────────────────────────────────────
app.get('/api/stream', (req, res) => {
  if (clients.size >= MAX_CLIENTS) {
    return res.status(503).json({ error: 'Maximale Anzahl SSE-Verbindungen erreicht' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Aktuellen Zustand sofort senden
  res.write(`event: state\ndata: ${JSON.stringify(orchestrator.getState())}\n\n`);

  // Keep-alive Ping
  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch {}
  }, 30000);

  const id = ++clientIdCounter;
  clients.set(id, res);

  req.on('close', () => {
    clearInterval(ping);
    clients.delete(id);
  });
});

// ── Race-Condition Schutz ────────────────────────────────────
let isStarting = false;

// ── REST API ─────────────────────────────────────────────────

// Projekt starten (mit Input-Validierung + Race-Condition Fix)
app.post('/api/start', startLimiter, async (req, res) => {
  if (isStarting || orchestrator.phase === 'running' || orchestrator.phase === 'awaiting_approval') {
    return res.status(409).json({ error: 'Projekt läuft bereits' });
  }

  const { description, agentCount, requireApproval } = req.body;

  // Input-Validierung
  if (!description || typeof description !== 'string') {
    return res.status(400).json({ error: 'Beschreibung ist erforderlich und muss ein Text sein' });
  }
  if (description.length < 1 || description.length > 5000) {
    return res.status(400).json({ error: 'Beschreibung muss zwischen 1 und 5000 Zeichen lang sein' });
  }

  const count = parseInt(agentCount);
  if (!Number.isInteger(count) || count < 2 || count > 10) {
    return res.status(400).json({ error: 'Agentenanzahl muss eine Ganzzahl zwischen 2 und 10 sein' });
  }

  isStarting = true;

  try {
    res.json({ ok: true, message: 'Projekt gestartet' });

    // Async starten (non-blocking)
    orchestrator.start(description, count, !!requireApproval).catch(e => {
      logger.error('Projekt-Fehler', { error: e.message });
      broadcast('error', { message: e.message });
    }).finally(() => {
      isStarting = false;
    });
  } catch (e) {
    isStarting = false;
    logger.error('Start-Fehler', { error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// Status abfragen
app.get('/api/status', (req, res) => {
  res.json(orchestrator.getState());
});

// Projekt zurücksetzen
app.post('/api/reset', apiLimiter, (req, res) => {
  orchestrator.reset();
  isStarting = false;
  broadcast('state', orchestrator.getState());
  res.json({ ok: true });
});

// ── Templates API ───────────────────────────────────────────
app.get('/api/templates', (req, res) => {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'templates.json'), 'utf8'));
    res.json(data);
  } catch (e) {
    logger.error('Templates laden fehlgeschlagen', { error: e.message });
    res.status(500).json({ error: 'Templates konnten nicht geladen werden' });
  }
});

// ── Health-Check ─────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.round(process.uptime()),
    phase: orchestrator.phase,
    memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB'
  });
});

// ── Projekt-Historie ─────────────────────────────────────────

// Alle Projekte auflisten
app.get('/api/projects', (req, res) => {
  const dir = path.join(__dirname, 'projects');
  if (!fs.existsSync(dir)) return res.json([]);

  const projects = fs.readdirSync(dir)
    .filter(d => d.startsWith('proj_'))
    .map(d => {
      let state = null;
      try {
        state = JSON.parse(fs.readFileSync(path.join(dir, d, 'state.json'), 'utf8'));
      } catch {}
      return {
        id: d,
        title: state?.projectTitle || d,
        phase: state?.phase || 'unknown',
        agentCount: state?.agents?.length || 0,
        createdAt: parseInt(d.replace('proj_', '')) || 0,
        totalDuration: state?.totalDuration || null,
        startedAt: state?.startedAt || null,
        completedAt: state?.completedAt || null
      };
    })
    .sort((a, b) => b.createdAt - a.createdAt);

  res.json(projects);
});

// Einzelnes Projekt laden
app.get('/api/projects/:id', (req, res) => {
  const stateFile = path.join(__dirname, 'projects', req.params.id, 'state.json');
  // Pfad-Traversal verhindern
  if (!stateFile.startsWith(path.join(__dirname, 'projects'))) {
    return res.status(400).json({ error: 'Ungültiger Pfad' });
  }
  try {
    res.json(JSON.parse(fs.readFileSync(stateFile, 'utf8')));
  } catch {
    res.status(404).json({ error: 'Projekt nicht gefunden' });
  }
});

// ── Projekt löschen ─────────────────────────────────────────
app.delete('/api/projects/:id', apiLimiter, (req, res) => {
  const id = req.params.id;
  if (!id.startsWith('proj_')) {
    return res.status(400).json({ error: 'Ungültige Projekt-ID' });
  }
  const dir = path.join(__dirname, 'projects', id);
  // Pfad-Traversal verhindern
  if (!dir.startsWith(path.join(__dirname, 'projects'))) {
    return res.status(400).json({ error: 'Ungültiger Pfad' });
  }
  if (!fs.existsSync(dir)) {
    return res.status(404).json({ error: 'Projekt nicht gefunden' });
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    logger.info('Projekt gelöscht', { id });
    res.json({ ok: true, deleted: id });
  } catch (e) {
    logger.error('Projekt löschen fehlgeschlagen', { id, error: e.message });
    res.status(500).json({ error: 'Löschen fehlgeschlagen: ' + e.message });
  }
});

// ── Alte Projekte aufräumen ─────────────────────────────────
app.post('/api/cleanup', apiLimiter, (req, res) => {
  const dir = path.join(__dirname, 'projects');
  if (!fs.existsSync(dir)) return res.json({ ok: true, deleted: [], count: 0 });

  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const deleted = [];

  fs.readdirSync(dir)
    .filter(d => d.startsWith('proj_'))
    .forEach(d => {
      const ts = parseInt(d.replace('proj_', ''));
      if (!isNaN(ts) && (now - ts) > sevenDaysMs) {
        const fullPath = path.join(dir, d);
        // Pfad-Traversal verhindern
        if (fullPath.startsWith(path.join(__dirname, 'projects'))) {
          try {
            fs.rmSync(fullPath, { recursive: true, force: true });
            deleted.push(d);
          } catch (e) {
            logger.error('Aufräumen: Löschen fehlgeschlagen', { id: d, error: e.message });
          }
        }
      }
    });

  logger.info('Alte Projekte aufgeräumt', { count: deleted.length, deleted });
  res.json({ ok: true, deleted, count: deleted.length });
});

// ── Speicherplatz-Info ──────────────────────────────────────
app.get('/api/disk-usage', (req, res) => {
  const dir = path.join(__dirname, 'projects');
  if (!fs.existsSync(dir)) {
    return res.json({ totalSize: '0 MB', projectCount: 0, oldestProject: null, newestProject: null });
  }

  function getDirSize(d) {
    let size = 0;
    try {
      const entries = fs.readdirSync(d, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) {
          size += getDirSize(full);
        } else {
          try { size += fs.statSync(full).size; } catch {}
        }
      }
    } catch {}
    return size;
  }

  const projects = fs.readdirSync(dir).filter(d => d.startsWith('proj_'));
  const totalSize = getDirSize(dir);
  const sizeMB = (totalSize / (1024 * 1024)).toFixed(2);

  let oldest = null;
  let newest = null;
  projects.forEach(d => {
    const ts = parseInt(d.replace('proj_', ''));
    if (!isNaN(ts)) {
      if (!oldest || ts < oldest.ts) oldest = { id: d, ts };
      if (!newest || ts > newest.ts) newest = { id: d, ts };
    }
  });

  res.json({
    totalSize: sizeMB + ' MB',
    projectCount: projects.length,
    oldestProject: oldest ? oldest.id : null,
    newestProject: newest ? newest.id : null
  });
});

// ── Dateibaum API ────────────────────────────────────────────
app.get('/api/files/:id', (req, res) => {
  const dir = path.join(__dirname, 'projects', req.params.id);
  // Pfad-Traversal verhindern
  if (!dir.startsWith(path.join(__dirname, 'projects'))) {
    return res.status(400).json({ error: 'Ungültiger Pfad' });
  }
  if (!fs.existsSync(dir)) {
    return res.status(404).json({ error: 'Nicht gefunden' });
  }

  function list(d, prefix = '') {
    return fs.readdirSync(d, { withFileTypes: true }).flatMap(e => {
      const rel = prefix ? prefix + '/' + e.name : e.name;
      if (e.isDirectory()) return list(path.join(d, e.name), rel);
      const stat = fs.statSync(path.join(d, e.name));
      return [{ path: rel, size: stat.size }];
    });
  }

  res.json(list(dir));
});

// ── Datei-Inhalt API ──────────────────────────────────────
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico',
  '.woff', '.woff2', '.ttf', '.eot',
  '.zip', '.tar', '.gz', '.exe', '.dll', '.so', '.dylib'
]);
const MAX_FILE_SIZE = 1 * 1024 * 1024; // 1 MB

app.get('/api/file-content/:id/:filePath(*)', apiLimiter, (req, res) => {
  const projectDir = path.join(__dirname, 'projects', req.params.id);
  const filePath = decodeURIComponent(req.params.filePath);
  const resolved = path.resolve(projectDir, filePath);

  // Pfad-Traversal verhindern
  const normalizedProjectDir = path.resolve(projectDir);
  if (!resolved.startsWith(normalizedProjectDir + path.sep) && resolved !== normalizedProjectDir) {
    return res.status(400).json({ error: 'Ungültiger Pfad' });
  }

  if (!fs.existsSync(resolved)) {
    return res.status(404).json({ error: 'Datei nicht gefunden' });
  }

  let stat;
  try {
    stat = fs.statSync(resolved);
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
    const content = fs.readFileSync(resolved, 'utf8');
    res.json({ content, size: stat.size, path: filePath });
  } catch {
    return res.status(500).json({ error: 'Datei konnte nicht gelesen werden' });
  }
});

// ── ZIP Export ───────────────────────────────────────────
app.get('/api/export/:id', (req, res) => {
  const dir = path.join(__dirname, 'projects', req.params.id);
  // Pfad-Traversal verhindern
  if (!dir.startsWith(path.join(__dirname, 'projects'))) {
    return res.status(400).json({ error: 'Ungültiger Pfad' });
  }
  if (!fs.existsSync(dir)) {
    return res.status(404).json({ error: 'Projekt nicht gefunden' });
  }

  const zipName = req.params.id + '.zip';
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="' + zipName + '"');

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (err) => {
    logger.error('ZIP-Export Fehler', { error: err.message });
    if (!res.headersSent) {
      res.status(500).json({ error: 'ZIP-Erstellung fehlgeschlagen' });
    }
  });

  archive.pipe(res);
  archive.directory(dir, req.params.id);
  archive.finalize();
});

// ── Zusammengeführte Dateien ──────────────────────────────────
app.get('/api/merged/:id', (req, res) => {
  const dir = path.join(__dirname, 'projects', req.params.id, 'merged');
  // Pfad-Traversal verhindern
  if (!dir.startsWith(path.join(__dirname, 'projects'))) {
    return res.status(400).json({ error: 'Ungültiger Pfad' });
  }
  if (!fs.existsSync(dir)) {
    return res.status(404).json({ error: 'Zusammengeführte Dateien nicht gefunden' });
  }

  try {
    const files = fs.readdirSync(dir).map(name => {
      const stat = fs.statSync(path.join(dir, name));
      return { name, size: stat.size };
    });
    res.json({ files, dir });
  } catch (e) {
    res.status(500).json({ error: 'Fehler beim Lesen der zusammengeführten Dateien' });
  }
});

// ── Plan Genehmigung ─────────────────────────────────────────
app.post('/api/approve', apiLimiter, (req, res) => {
  try {
    orchestrator.approvePlan();
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/modify-plan', apiLimiter, (req, res) => {
  try {
    const { tasks } = req.body;
    if (!Array.isArray(tasks) || tasks.length === 0) {
      return res.status(400).json({ error: 'Tasks müssen ein nicht-leeres Array sein' });
    }
    orchestrator.modifyPlan(tasks);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── Konfiguration ───────────────────────────────────────────────
app.get('/api/config', (req, res) => {
  res.json(orchestrator.getConfig());
});

app.post('/api/config', apiLimiter, (req, res) => {
  try {
    orchestrator.updateConfig(req.body);
    res.json({ ok: true, config: orchestrator.getConfig() });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── Agent Retry ──────────────────────────────────────────────
app.post('/api/retry/:agentIndex', apiLimiter, async (req, res) => {
  const idx = parseInt(req.params.agentIndex);
  if (isNaN(idx) || idx < 0) {
    return res.status(400).json({ error: 'Ungültiger Index' });
  }
  res.json({ ok: true });
  orchestrator.retryAgent(idx).catch(e => broadcast('error', { message: e.message }));
});

// ── Projekt klonen (Einstellungen übernehmen) ────────────────
app.post('/api/clone/:id', apiLimiter, (req, res) => {
  const id = req.params.id;
  if (!id || !id.startsWith('proj_')) {
    return res.status(400).json({ error: 'Ungültige Projekt-ID' });
  }
  const stateFile = path.join(__dirname, 'projects', id, 'state.json');
  // Pfad-Traversal verhindern
  if (!stateFile.startsWith(path.join(__dirname, 'projects'))) {
    return res.status(400).json({ error: 'Ungültiger Pfad' });
  }
  try {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const description = state.projectDesc || state.projectSummary || '';
    const agentCount = (state.agents || []).length || 3;
    const tasks = (state.tasks || []).map(function(t) {
      return { title: t.title || '', task: t.task || '', deliverable: t.deliverable || '' };
    });
    res.json({ ok: true, description: description, agentCount: agentCount, tasks: tasks });
  } catch {
    res.status(404).json({ error: 'Projekt nicht gefunden oder state.json fehlt' });
  }
});

// ── Server starten ───────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log('');
  console.log('  ╔═══════════════════════════════════════╗');
  console.log('  ║   Claude Multi-Agent Orchestrator v2  ║');
  console.log('  ╚═══════════════════════════════════════╝');
  console.log('');
  console.log(`  Server:   http://localhost:${PORT}`);
  console.log(`  Node:     ${process.version}`);
  console.log(`  Projekte: ${path.join(__dirname, 'projects')}`);
  console.log('');
  logger.info('Server gestartet', { port: PORT });
});

// ── Graceful Shutdown ────────────────────────────────────────
function gracefulShutdown(signal) {
  logger.info('Shutdown eingeleitet', { signal });
  orchestrator.reset();
  for (const [, res] of clients) {
    try { res.end(); } catch {}
  }
  clients.clear();
  server.close(() => process.exit(0));
  // Fallback: nach 10s hart beenden
  setTimeout(() => process.exit(1), 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
