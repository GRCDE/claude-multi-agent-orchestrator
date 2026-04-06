'use strict';
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;
const archiver = require('archiver');
const logger = require('./src/logger');
const { logBuffer, getLogFiles, exportAllLogs, LOGS_DIR } = require('./src/logger');
const Orchestrator = require('./orchestrator');
const { LANGUAGES, getTranslations, setLanguage } = require('./src/i18n');
const TemplateManager = require('./src/template-manager');
const WebSocket = require('ws');
const { router: webhooksRouter, init: initWebhooks } = require('./src/routes/webhooks');

const compression = require('compression');
const orchestrator = new Orchestrator();
if (typeof orchestrator._installSignalHandlers === 'function') {
  orchestrator._installSignalHandlers();
}
const app = express();
const PORT = parseInt(process.env.PORT) || 3131;

// ── Komprimierung (gzip) ─────────────────────────────────────
app.use(compression());

// ── Authentifizierungs-Middleware (optional) ──────────────────
function authMiddleware(req, res, next) {
  const token = process.env.API_TOKEN;
  if (!token) return next(); // Keine Auth konfiguriert → alles erlaubt

  const authHeader = req.headers.authorization || '';
  const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

  // Timing-safe Vergleich gegen Timing-Angriffe
  if (!provided || provided.length !== token.length ||
      !crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(token))) {
    return res.status(401).json({ error: 'Authentifizierung erforderlich' });
  }
  next();
}

// ── Security Headers ──────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  // HSTS nur bei HTTPS-Verbindungen setzen
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  }
  next();
});

// ── CORS auf localhost + konfigurierte Origins beschränken ────
const allowedOrigins = (() => {
  const defaults = [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`];
  const envOrigins = process.env.ALLOWED_ORIGINS;
  if (envOrigins) {
    const extra = envOrigins.split(',').map(o => o.trim()).filter(Boolean);
    return [...defaults, ...extra];
  }
  return defaults;
})();

app.use(cors({
  origin: allowedOrigins
}));

// ── Body-Parsing mit Größenbeschränkung ──────────────────────
app.use(express.json({ limit: '1mb' }));

// ── Input-Sanitization Middleware ─────────────────────────────
app.use((req, res, next) => {
  // Content-Type Validierung bei POST/PUT
  if ((req.method === 'POST' || req.method === 'PUT') && req.body !== undefined) {
    const ct = req.headers['content-type'] || '';
    if (!ct.includes('application/json')) {
      return res.status(415).json({ error: 'Content-Type muss application/json sein' });
    }
  }
  // String-Felder in req.body trimmen
  if (req.body && typeof req.body === 'object') {
    for (const key of Object.keys(req.body)) {
      if (typeof req.body[key] === 'string') {
        req.body[key] = req.body[key].trim();
      }
    }
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// ── Rate-Limiting (differenziert) ─────────────────────────────
const rateLimit = require('express-rate-limit');

// Custom Key-Generator: IP + Auth-Token kombinieren
function rateLimitKeyGenerator(req) {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  const token = (req.headers.authorization || '').slice(0, 20);
  return `${ip}|${token}`;
}

// API-Reads (GET): 120 Requests/Minute (lockerer)
const apiReadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: rateLimitKeyGenerator,
  validate: { ip: false },
  message: { error: 'Zu viele Leseanfragen. Bitte warte eine Minute.' }
});

// API-Mutationen (POST/PUT/DELETE): 30 Requests/Minute (strenger)
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: rateLimitKeyGenerator,
  validate: { ip: false },
  message: { error: 'Zu viele Anfragen. Bitte warte eine Minute.' }
});

// Projekt-Start: 3/Minute (wie bisher, sehr streng)
const startLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 3,
  keyGenerator: rateLimitKeyGenerator,
  validate: { ip: false },
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Zu viele Projekt-Starts. Bitte warte eine Minute.' }
});

// Export-Endpoints: 10/Minute (teure Operationen)
const exportLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  keyGenerator: rateLimitKeyGenerator,
  validate: { ip: false },
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Zu viele Export-Anfragen. Bitte warte eine Minute.' }
});

// ── Webhook-Router initialisieren und mounten ────────────────
initWebhooks({ orchestrator, logger, authMiddleware, apiLimiter, apiReadLimiter });
app.use('/api', webhooksRouter);

// SSE/WS-Verbindungen: max 5 pro IP
const sseConnectionsPerIp = new Map();
const MAX_SSE_PER_IP = 5;

// ── Performance-Metriken ────────────────────────────────────
const metrics = {
  requestCount: new Map(),   // endpoint → count
  responseTimes: new Map(),  // endpoint → [durations] (letzte 100)
  startTime: Date.now(),
  _cpuPrev: process.cpuUsage()
};

// Timing-Middleware (lightweight)
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    const key = req.method + ' ' + (req.route ? req.route.path : req.path);
    metrics.requestCount.set(key, (metrics.requestCount.get(key) || 0) + 1);
    let times = metrics.responseTimes.get(key);
    if (!times) { times = []; metrics.responseTimes.set(key, times); }
    times.push(duration);
    if (times.length > 100) times.shift();
  });
  next();
});

// GET /api/metrics – Performance-Metriken
app.get('/api/metrics', (req, res) => {
  const mem = process.memoryUsage();
  const uptimeSec = process.uptime();

  // CPU-Usage berechnen (seit letztem Aufruf)
  const cpuNow = process.cpuUsage(metrics._cpuPrev);
  metrics._cpuPrev = process.cpuUsage();
  const cpuPercent = Math.min(100, Math.round(((cpuNow.user + cpuNow.system) / 1000) / (uptimeSec * 10)));

  // Endpoint-Statistiken
  const endpoints = [];
  for (const [key, count] of metrics.requestCount) {
    const times = metrics.responseTimes.get(key) || [];
    const avg = times.length > 0 ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : 0;
    const max = times.length > 0 ? Math.max(...times) : 0;
    endpoints.push({ endpoint: key, count, avgMs: avg, maxMs: max });
  }
  endpoints.sort((a, b) => b.count - a.count);

  res.json({
    uptime: Math.round(uptimeSec),
    memory: {
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      rss: mem.rss,
      external: mem.external
    },
    cpu: cpuPercent,
    connections: {
      sse: clients.size,
      ws: wsClients.size
    },
    endpoints: endpoints.slice(0, 20),
    serverStart: metrics.startTime
  });
});

// DELETE /api/metrics – Metriken zuruecksetzen
app.delete('/api/metrics', authMiddleware, (req, res) => {
  metrics.requestCount.clear();
  metrics.responseTimes.clear();
  metrics._cpuPrev = process.cpuUsage();
  res.json({ ok: true, message: 'Metriken zurueckgesetzt' });
});

// ── SSE Clients (Map mit Max 50) ────────────────────────────
let clientIdCounter = 0;
const clients = new Map();
const MAX_CLIENTS = 50;

// ── SSE Event-Historie für Reconnect-Recovery ────────────────
let eventId = 0;
const eventHistory = [];
const MAX_EVENT_HISTORY = 200;

// Heartbeat: Prüfe alle 30s ob Clients noch leben
const sseHeartbeatInterval = setInterval(() => {
  for (const [id, client] of clients) {
    try {
      client.res.write(': heartbeat\n\n');
    } catch {
      clients.delete(id);
    }
  }
}, 30000);

// Idle-Timeout: Clients nach 5 Minuten ohne Aktivitaet entfernen
const sseIdleCheckInterval = setInterval(() => {
  const now = Date.now();
  for (const [id, client] of clients) {
    if (now - client.lastActivity > 300000) { // 5 Minuten
      try { client.res.end(); } catch { /* best-effort, Client evtl. bereits getrennt */ }
      clients.delete(id);
    }
  }
}, 60000);

// ── WebSocket Server (Dual-Mode: WS + SSE) ──────────────────
const wss = new WebSocket.Server({ noServer: true });
const wsClients = new Set();

// WS-Heartbeat: Alle 30s Ping senden, Timeout nach 60s ohne Pong
const WS_PING_INTERVAL = 30000;
const WS_PONG_TIMEOUT = 60000;

const wsHeartbeat = setInterval(() => {
  const now = Date.now();
  for (const client of wsClients) {
    if (now - client._lastPong > WS_PONG_TIMEOUT) {
      // Client hat zu lange nicht geantwortet → entfernen
      logger.info('WebSocket Client Timeout, wird entfernt');
      client.terminate();
      wsClients.delete(client);
      continue;
    }
    try {
      client.ping();
    } catch {
      wsClients.delete(client);
    }
  }
}, WS_PING_INTERVAL);

wss.on('connection', (ws) => {
  ws._lastPong = Date.now();
  ws._subscribedEvents = null; // null = alle Events empfangen
  wsClients.add(ws);
  logger.info('WebSocket Client verbunden', { totalWsClients: wsClients.size });

  // Aktuellen Zustand sofort senden
  try {
    ws.send(JSON.stringify({ event: 'state', data: orchestrator.getState() }));
  } catch { /* best-effort, WS-Client evtl. bereits getrennt */ }

  ws.on('pong', () => {
    ws._lastPong = Date.now();
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.action === 'ping') {
        ws.send(JSON.stringify({ event: 'pong', data: { timestamp: Date.now() } }));
      } else if (msg.action === 'subscribe' && Array.isArray(msg.events)) {
        ws._subscribedEvents = new Set(msg.events);
        ws.send(JSON.stringify({ event: 'subscribed', data: { events: msg.events } }));
      }
    } catch {
      // Ungueltige Nachricht ignorieren
    }
  });

  ws.on('close', () => {
    wsClients.delete(ws);
    logger.info('WebSocket Client getrennt', { totalWsClients: wsClients.size });
  });

  ws.on('error', () => {
    wsClients.delete(ws);
  });
});

function broadcastWs(eventName, data) {
  if (wsClients.size === 0) return;
  const msg = JSON.stringify({ event: eventName, data });
  for (const client of wsClients) {
    if (client.readyState !== WebSocket.OPEN) {
      wsClients.delete(client);
      continue;
    }
    // Event-Filter prüfen
    if (client._subscribedEvents && !client._subscribedEvents.has(eventName)) {
      continue;
    }
    try {
      client.send(msg);
    } catch {
      wsClients.delete(client);
    }
  }
}

function broadcast(eventName, data) {
  eventId++;
  eventHistory.push({ id: eventId, event: eventName, data, timestamp: Date.now() });
  if (eventHistory.length > MAX_EVENT_HISTORY) eventHistory.shift();

  // SSE-Clients
  const msg = `id: ${eventId}\nevent: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const [id, client] of clients) {
    try {
      client.res.write(msg);
      client.lastActivity = Date.now();
    } catch {
      // Toter Client – entfernen
      clients.delete(id);
    }
  }

  // WebSocket-Clients
  broadcastWs(eventName, data);
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
    eventId++;
    eventHistory.push({ id: eventId, event, data, timestamp: Date.now() });
    if (eventHistory.length > MAX_EVENT_HISTORY) eventHistory.shift();

    // SSE-Clients
    const msg = `id: ${eventId}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const [id, client] of clients) {
      try { client.res.write(msg); client.lastActivity = Date.now(); } catch { clients.delete(id); }
    }

    // WebSocket-Clients
    broadcastWs(event, data);
  }
}

// Statt direktem broadcast: queueBroadcast verwenden
orchestrator.on('update', ({ event, data }) => queueBroadcast(event, data));

// ── SSE Endpoint ─────────────────────────────────────────────
app.get('/api/stream', (req, res) => {
  if (clients.size >= MAX_CLIENTS) {
    return res.status(503).json({ error: 'Maximale Anzahl SSE-Verbindungen erreicht' });
  }

  // SSE-Verbindungen pro IP begrenzen
  const clientIp = req.ip || req.connection.remoteAddress || 'unknown';
  const currentCount = sseConnectionsPerIp.get(clientIp) || 0;
  if (currentCount >= MAX_SSE_PER_IP) {
    return res.status(429).json({ error: 'Zu viele SSE-Verbindungen von dieser IP (max ' + MAX_SSE_PER_IP + ')' });
  }
  sseConnectionsPerIp.set(clientIp, currentCount + 1);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Prüfe ob Client sich reconnected und verpasste Events nachholen will
  const lastEventId = parseInt(req.headers['last-event-id']);
  if (lastEventId && !isNaN(lastEventId)) {
    // Verpasste Events seit letzter bekannter ID wiederholen
    const missedEvents = eventHistory.filter(e => e.id > lastEventId).slice(-50);
    for (const evt of missedEvents) {
      res.write(`id: ${evt.id}\nevent: ${evt.event}\ndata: ${JSON.stringify(evt.data)}\n\n`);
    }
    // Recovery-Info an Client senden
    res.write(`id: ${eventId}\nevent: reconnect_recovery\ndata: ${JSON.stringify({ recoveredCount: missedEvents.length, lastKnownId: lastEventId, currentId: eventId })}\n\n`);
  } else {
    // Erster Connect: aktuellen Zustand sofort senden
    res.write(`event: state\ndata: ${JSON.stringify(orchestrator.getState())}\n\n`);
  }

  // Keep-alive Ping
  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* best-effort, SSE-Client evtl. bereits getrennt */ }
  }, 30000);

  const id = ++clientIdCounter;
  clients.set(id, { res, lastActivity: Date.now() });

  req.on('close', () => {
    clearInterval(ping);
    clients.delete(id);
    // SSE-Verbindungszähler pro IP reduzieren
    const count = sseConnectionsPerIp.get(clientIp) || 0;
    if (count <= 1) {
      sseConnectionsPerIp.delete(clientIp);
    } else {
      sseConnectionsPerIp.set(clientIp, count - 1);
    }
  });
});

// ── Race-Condition Schutz ────────────────────────────────────
let isStarting = false;

// ── Projekt-Warteschlange ────────────────────────────────────
const projectQueue = [];
const MAX_QUEUE_SIZE = 10;

// Durchschnittliche Projektdauer tracken (für geschätzte Wartezeit)
const completedProjectDurations = []; // Array von Millisekunden
const MAX_TRACKED_DURATIONS = 20;
let _currentProjectStartedAt = null;

function getAverageProjectDuration() {
  if (completedProjectDurations.length === 0) return 5 * 60 * 1000; // Default: 5 Min
  const sum = completedProjectDurations.reduce((a, b) => a + b, 0);
  return Math.round(sum / completedProjectDurations.length);
}

function sortQueueByPriority() {
  projectQueue.sort((a, b) => (a.priority || 2) - (b.priority || 2));
}

function broadcastQueueUpdate() {
  const avgDuration = getAverageProjectDuration();
  broadcast('queue_updated', {
    length: projectQueue.length,
    items: projectQueue.map((item, i) => ({
      ...item,
      position: i + 1,
      estimatedWaitTime: avgDuration * (i + 1)
    }))
  });
}

// Input-Validierung für Projektstart (wiederverwendbar für Queue + Start)
function validateStartInput(body) {
  const { description, agentCount } = body;
  if (!description || typeof description !== 'string') {
    return 'Beschreibung ist erforderlich und muss ein Text sein';
  }
  if (description.length < 1 || description.length > 5000) {
    return 'Beschreibung muss zwischen 1 und 5000 Zeichen lang sein';
  }
  const count = parseInt(agentCount);
  if (!Number.isInteger(count) || count < 2 || count > 10) {
    return 'Agentenanzahl muss eine Ganzzahl zwischen 2 und 10 sein';
  }
  return null;
}

function startProject(description, agentCount, requireApproval) {
  isStarting = true;
  _currentProjectStartedAt = Date.now();
  const count = parseInt(agentCount);
  orchestrator.start(description, count, !!requireApproval).catch(e => {
    logger.error('Projekt-Fehler', { error: e.message });
    broadcast('error', { message: e.message });
  }).finally(() => {
    isStarting = false;
  });
}

// Auto-Dequeue: wenn Projekt fertig, nächstes aus Queue starten
let _queueDequeueDelay = 3000; // Exponential Backoff bei Fehlern
orchestrator.on('phase', (data) => {
  const phase = data.phase;
  if (phase === 'complete' || phase === 'error' || phase === 'partial') {
    // Projektdauer tracken (nur bei Erfolg/Teilerfolg)
    if (_currentProjectStartedAt && (phase === 'complete' || phase === 'partial')) {
      const duration = Date.now() - _currentProjectStartedAt;
      completedProjectDurations.push(duration);
      if (completedProjectDurations.length > MAX_TRACKED_DURATIONS) {
        completedProjectDurations.shift();
      }
    }
    _currentProjectStartedAt = null;
    // Bei Fehler: Delay erhöhen (max 60s), bei Erfolg: zurücksetzen
    if (phase === 'error') {
      _queueDequeueDelay = Math.min(_queueDequeueDelay * 2, 60000);
    } else {
      _queueDequeueDelay = 3000;
    }
    if (projectQueue.length > 0) {
      setTimeout(() => {
        if (isStarting || orchestrator.phase === 'running' || orchestrator.phase === 'awaiting_approval') return;
        const next = projectQueue.shift();
        broadcastQueueUpdate();
        if (next) {
          logger.info('Nächstes Projekt aus Queue gestartet', { description: next.description.slice(0, 50) });
          startProject(next.description, next.agentCount, next.requireApproval);
        }
      }, _queueDequeueDelay);
    }
  }
});

// ── REST API ─────────────────────────────────────────────────

// Projekt starten (mit Input-Validierung + Race-Condition Fix + Queue)
app.post('/api/start', authMiddleware, startLimiter, async (req, res) => {
  const { description, agentCount, requireApproval, priority } = req.body;

  // Input-Validierung
  const validationError = validateStartInput(req.body);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  // Priorität validieren (1=hoch, 2=mittel, 3=niedrig)
  const prio = parseInt(priority) || 2;
  const validPrio = [1, 2, 3].includes(prio) ? prio : 2;

  // Wenn bereits ein Projekt läuft → in Queue einreihen
  if (isStarting || orchestrator.phase === 'running' || orchestrator.phase === 'awaiting_approval') {
    if (projectQueue.length >= MAX_QUEUE_SIZE) {
      return res.status(409).json({ error: 'Warteschlange ist voll (max ' + MAX_QUEUE_SIZE + ' Projekte)' });
    }
    const newItem = {
      description,
      agentCount: parseInt(agentCount),
      requireApproval: !!requireApproval,
      priority: validPrio,
      queuedAt: Date.now()
    };
    projectQueue.push(newItem);
    sortQueueByPriority();
    broadcastQueueUpdate();
    const pos = projectQueue.indexOf(newItem) + 1;
    return res.json({ ok: true, queued: true, position: pos });
  }

  isStarting = true;

  try {
    res.json({ ok: true, message: 'Projekt gestartet' });
    startProject(description, agentCount, requireApproval);
  } catch (e) {
    isStarting = false;
    logger.error('Start-Fehler', { error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// ── Queue API ────────────────────────────────────────────────

// Warteschlange anzeigen (mit Statistiken)
app.get('/api/queue', (req, res) => {
  const avgDuration = getAverageProjectDuration();
  res.json(projectQueue.map((item, i) => ({
    ...item,
    position: i + 1,
    estimatedWaitTime: avgDuration * (i + 1)
  })));
});

// Einzelnes Element aus Warteschlange entfernen
app.delete('/api/queue/:index', authMiddleware, apiLimiter, (req, res) => {
  const index = parseInt(req.params.index);
  if (isNaN(index) || index < 0 || index >= projectQueue.length) {
    return res.status(400).json({ error: 'Ungültiger Index' });
  }
  const removed = projectQueue.splice(index, 1)[0];
  broadcastQueueUpdate();
  res.json({ ok: true, removed });
});

// Queue-Reihenfolge ändern (Drag & Drop)
app.post('/api/queue/reorder', authMiddleware, apiLimiter, (req, res) => {
  const { from, to } = req.body;
  const fromIdx = parseInt(from);
  const toIdx = parseInt(to);
  if (isNaN(fromIdx) || isNaN(toIdx) ||
      fromIdx < 0 || fromIdx >= projectQueue.length ||
      toIdx < 0 || toIdx >= projectQueue.length ||
      fromIdx === toIdx) {
    return res.status(400).json({ error: 'Ungültige Indizes' });
  }
  const [item] = projectQueue.splice(fromIdx, 1);
  projectQueue.splice(toIdx, 0, item);
  broadcastQueueUpdate();
  res.json({ ok: true, queue: projectQueue.map((item, i) => ({ ...item, position: i + 1 })) });
});

// Gesamte Warteschlange leeren
app.post('/api/queue/clear', authMiddleware, apiLimiter, (req, res) => {
  const count = projectQueue.length;
  projectQueue.length = 0;
  broadcastQueueUpdate();
  res.json({ ok: true, cleared: count });
});

// Status abfragen
app.get('/api/status', (req, res) => {
  res.json(orchestrator.getState());
});

// Projekt zurücksetzen
app.post('/api/reset', authMiddleware, apiLimiter, (req, res) => {
  orchestrator.reset();
  isStarting = false;
  broadcast('state', orchestrator.getState());
  res.json({ ok: true });
});

// Laufendes Projekt abbrechen (behält Teilergebnisse)
app.post('/api/abort', authMiddleware, apiLimiter, async (req, res) => {
  try {
    await orchestrator.abort();
    broadcast('state', orchestrator.getState());
    res.json({ ok: true, message: 'Projekt abgebrochen' });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── Templates API (CRUD) ────────────────────────────────────
const TEMPLATES_FILE = path.join(__dirname, 'templates.json');

async function loadTemplatesFile() {
  try {
    const raw = await fsp.readFile(TEMPLATES_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (Array.isArray(data)) return { templates: data, taskPresets: [] };
    return {
      templates: Array.isArray(data.templates) ? data.templates : [],
      taskPresets: Array.isArray(data.taskPresets) ? data.taskPresets : []
    };
  } catch (e) {
    return { templates: [], taskPresets: [] };
  }
}

async function saveTemplatesFile(data) {
  await fsp.writeFile(TEMPLATES_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// GET /api/templates - Alle Templates laden
app.get('/api/templates', async (req, res) => {
  try {
    const data = await loadTemplatesFile();
    res.json(data);
  } catch (e) {
    logger.error('Templates laden fehlgeschlagen', { error: e.message });
    res.status(500).json({ error: 'Templates konnten nicht geladen werden' });
  }
});

// POST /api/templates - Neues Template erstellen
app.post('/api/templates', authMiddleware, apiLimiter, async (req, res) => {
  try {
    const { title, description, agentCount, icon, tags } = req.body;
    if (!title || typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({ error: 'Titel ist erforderlich' });
    }
    if (!description || typeof description !== 'string' || !description.trim()) {
      return res.status(400).json({ error: 'Beschreibung ist erforderlich' });
    }
    const count = parseInt(agentCount);
    if (!agentCount || isNaN(count) || count < 1 || count > 20) {
      return res.status(400).json({ error: 'Agentenzahl ist erforderlich (1-20)' });
    }

    const data = await loadTemplatesFile();
    const newTemplate = {
      id: 'tpl-' + Date.now(),
      name: title.trim(),
      description: description.trim(),
      suggestedAgents: count,
      icon: (icon && typeof icon === 'string') ? icon.trim() : '\uD83D\uDCC4',
      tags: Array.isArray(tags) ? tags.filter(function(t) { return typeof t === 'string' && t.trim(); }).map(function(t) { return t.trim(); }) : [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    data.templates.push(newTemplate);
    await saveTemplatesFile(data);
    logger.info('Template erstellt', { id: newTemplate.id, name: newTemplate.name });
    res.json({ ok: true, template: newTemplate });
  } catch (e) {
    logger.error('Template erstellen fehlgeschlagen', { error: e.message });
    res.status(500).json({ error: 'Template konnte nicht erstellt werden' });
  }
});

// PUT /api/templates/:id - Template aktualisieren
app.put('/api/templates/:id', authMiddleware, apiLimiter, async (req, res) => {
  try {
    const data = await loadTemplatesFile();
    const idx = data.templates.findIndex(function(t) { return t.id === req.params.id; });
    if (idx === -1) {
      return res.status(404).json({ error: 'Template nicht gefunden' });
    }
    const { title, description, agentCount, icon, tags } = req.body;
    if (title !== undefined) {
      if (typeof title !== 'string' || !title.trim()) {
        return res.status(400).json({ error: 'Titel darf nicht leer sein' });
      }
      data.templates[idx].name = title.trim();
    }
    if (description !== undefined) {
      if (typeof description !== 'string' || !description.trim()) {
        return res.status(400).json({ error: 'Beschreibung darf nicht leer sein' });
      }
      data.templates[idx].description = description.trim();
    }
    if (agentCount !== undefined) {
      const count = parseInt(agentCount);
      if (isNaN(count) || count < 1 || count > 20) {
        return res.status(400).json({ error: 'Agentenzahl muss zwischen 1 und 20 liegen' });
      }
      data.templates[idx].suggestedAgents = count;
    }
    if (icon !== undefined && typeof icon === 'string') {
      data.templates[idx].icon = icon.trim() || '\uD83D\uDCC4';
    }
    if (tags !== undefined) {
      data.templates[idx].tags = Array.isArray(tags) ? tags.filter(function(t) { return typeof t === 'string' && t.trim(); }).map(function(t) { return t.trim(); }) : [];
    }
    data.templates[idx].updatedAt = new Date().toISOString();
    await saveTemplatesFile(data);
    logger.info('Template aktualisiert', { id: req.params.id });
    res.json({ ok: true, template: data.templates[idx] });
  } catch (e) {
    logger.error('Template aktualisieren fehlgeschlagen', { error: e.message });
    res.status(500).json({ error: 'Template konnte nicht aktualisiert werden' });
  }
});

// DELETE /api/templates/:id - Template loeschen
app.delete('/api/templates/:id', authMiddleware, apiLimiter, async (req, res) => {
  try {
    const data = await loadTemplatesFile();
    const idx = data.templates.findIndex(function(t) { return t.id === req.params.id; });
    if (idx === -1) {
      return res.status(404).json({ error: 'Template nicht gefunden' });
    }
    const removed = data.templates.splice(idx, 1)[0];
    await saveTemplatesFile(data);
    logger.info('Template geloescht', { id: req.params.id, name: removed.name });
    res.json({ ok: true });
  } catch (e) {
    logger.error('Template loeschen fehlgeschlagen', { error: e.message });
    res.status(500).json({ error: 'Template konnte nicht geloescht werden' });
  }
});

// POST /api/templates/import - Templates aus JSON importieren
app.post('/api/templates/import', authMiddleware, apiLimiter, async (req, res) => {
  try {
    const imported = req.body;
    if (!imported || !Array.isArray(imported.templates)) {
      return res.status(400).json({ error: 'Ungueltiges Format. Erwartet: { templates: [...] }' });
    }
    for (let i = 0; i < imported.templates.length; i++) {
      const t = imported.templates[i];
      if (!t.name || !t.description) {
        return res.status(400).json({ error: 'Jedes Template braucht mindestens name und description' });
      }
    }
    const data = await loadTemplatesFile();
    let addedCount = 0;
    for (let i = 0; i < imported.templates.length; i++) {
      const t = imported.templates[i];
      const existing = t.id ? data.templates.findIndex(function(ex) { return ex.id === t.id; }) : -1;
      const tpl = {
        id: (existing === -1 && t.id) ? t.id : ('tpl-' + Date.now() + '-' + addedCount),
        name: String(t.name).trim(),
        description: String(t.description).trim(),
        suggestedAgents: parseInt(t.suggestedAgents || t.agentCount) || 3,
        icon: t.icon || '\uD83D\uDCC4',
        tags: Array.isArray(t.tags) ? t.tags : [],
        createdAt: t.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      if (existing !== -1) {
        data.templates[existing] = tpl;
      } else {
        data.templates.push(tpl);
      }
      addedCount++;
    }
    if (Array.isArray(imported.taskPresets)) {
      data.taskPresets = imported.taskPresets;
    }
    await saveTemplatesFile(data);
    logger.info('Templates importiert', { count: addedCount });
    res.json({ ok: true, imported: addedCount, total: data.templates.length });
  } catch (e) {
    logger.error('Templates importieren fehlgeschlagen', { error: e.message });
    res.status(500).json({ error: 'Import fehlgeschlagen: ' + e.message });
  }
});

// GET /api/templates/export - Alle Templates als JSON exportieren
app.get('/api/templates/export', exportLimiter, async (req, res) => {
  try {
    const data = await loadTemplatesFile();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="templates-export.json"');
    res.json(data);
  } catch (e) {
    logger.error('Templates exportieren fehlgeschlagen', { error: e.message });
    res.status(500).json({ error: 'Export fehlgeschlagen' });
  }
});

// ── Template-Manager API (Erweitert: Verzeichnis-basiert) ────
const templateManager = new TemplateManager();

// GET /api/templates/managed - Alle verwalteten Templates (aus templates/ Verzeichnis)
app.get('/api/templates/managed', apiReadLimiter, async (req, res) => {
  try {
    const filters = {};
    if (req.query.tag) filters.tag = req.query.tag;
    if (req.query.category) filters.category = req.query.category;
    if (req.query.difficulty) filters.difficulty = req.query.difficulty;
    const templates = await templateManager.listTemplates(filters);
    res.json({ templates });
  } catch (e) {
    logger.error('Verwaltete Templates laden fehlgeschlagen', { error: e.message });
    res.status(500).json({ error: 'Templates konnten nicht geladen werden' });
  }
});

// GET /api/templates/managed/:id - Einzelnes verwaltetes Template
app.get('/api/templates/managed/:id', apiReadLimiter, async (req, res) => {
  try {
    const template = await templateManager.getTemplate(req.params.id);
    if (!template) {
      return res.status(404).json({ error: 'Template nicht gefunden' });
    }
    res.json({ template });
  } catch (e) {
    logger.error('Template laden fehlgeschlagen', { error: e.message, id: req.params.id });
    res.status(500).json({ error: 'Template konnte nicht geladen werden' });
  }
});

// POST /api/templates/managed - Neues verwaltetes Template erstellen
app.post('/api/templates/managed', authMiddleware, apiLimiter, async (req, res) => {
  try {
    const template = await templateManager.saveTemplate(req.body);
    logger.info('Verwaltetes Template erstellt', { id: template.id, name: template.name });
    res.json({ ok: true, template });
  } catch (e) {
    logger.error('Verwaltetes Template erstellen fehlgeschlagen', { error: e.message });
    res.status(400).json({ error: e.message });
  }
});

// PUT /api/templates/managed/:id - Verwaltetes Template aktualisieren
app.put('/api/templates/managed/:id', authMiddleware, apiLimiter, async (req, res) => {
  try {
    const existing = await templateManager.getTemplate(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: 'Template nicht gefunden' });
    }
    const updated = { ...existing, ...req.body, id: req.params.id };
    const template = await templateManager.saveTemplate(updated);
    logger.info('Verwaltetes Template aktualisiert', { id: template.id });
    res.json({ ok: true, template });
  } catch (e) {
    logger.error('Verwaltetes Template aktualisieren fehlgeschlagen', { error: e.message });
    res.status(400).json({ error: e.message });
  }
});

// DELETE /api/templates/managed/:id - Verwaltetes Template loeschen
app.delete('/api/templates/managed/:id', authMiddleware, apiLimiter, async (req, res) => {
  try {
    await templateManager.deleteTemplate(req.params.id);
    logger.info('Verwaltetes Template geloescht', { id: req.params.id });
    res.json({ ok: true });
  } catch (e) {
    logger.error('Verwaltetes Template loeschen fehlgeschlagen', { error: e.message });
    res.status(404).json({ error: e.message });
  }
});

// POST /api/templates/managed/:id/duplicate - Template duplizieren
app.post('/api/templates/managed/:id/duplicate', authMiddleware, apiLimiter, async (req, res) => {
  try {
    const newName = req.body.name || undefined;
    const duplicate = await templateManager.duplicateTemplate(req.params.id, newName);
    logger.info('Template dupliziert', { originalId: req.params.id, newId: duplicate.id });
    res.json({ ok: true, template: duplicate });
  } catch (e) {
    logger.error('Template duplizieren fehlgeschlagen', { error: e.message });
    res.status(404).json({ error: e.message });
  }
});

// POST /api/templates/managed/:id/rate - Template bewerten
app.post('/api/templates/managed/:id/rate', authMiddleware, apiLimiter, async (req, res) => {
  try {
    const { rating } = req.body;
    const template = await templateManager.rateTemplate(req.params.id, rating);
    logger.info('Template bewertet', { id: req.params.id, rating });
    res.json({ ok: true, template });
  } catch (e) {
    logger.error('Template bewerten fehlgeschlagen', { error: e.message });
    res.status(400).json({ error: e.message });
  }
});

// POST /api/templates/managed/import - Template aus JSON importieren
app.post('/api/templates/managed/import', authMiddleware, apiLimiter, async (req, res) => {
  try {
    const jsonString = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    const template = await templateManager.importTemplate(jsonString);
    logger.info('Template importiert', { id: template.id, name: template.name });
    res.json({ ok: true, template });
  } catch (e) {
    logger.error('Template importieren fehlgeschlagen', { error: e.message });
    res.status(400).json({ error: e.message });
  }
});

// GET /api/templates/managed/:id/export - Template als JSON exportieren
app.get('/api/templates/managed/:id/export', exportLimiter, async (req, res) => {
  try {
    const jsonStr = await templateManager.exportTemplate(req.params.id);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="template-' + req.params.id + '.json"');
    res.send(jsonStr);
  } catch (e) {
    logger.error('Template exportieren fehlgeschlagen', { error: e.message });
    res.status(404).json({ error: e.message });
  }
});

// POST /api/templates/managed/:id/apply - Template als Projekt starten
app.post('/api/templates/managed/:id/apply', authMiddleware, startLimiter, async (req, res) => {
  try {
    const template = await templateManager.getTemplate(req.params.id);
    if (!template) {
      return res.status(404).json({ error: 'Template nicht gefunden' });
    }

    // Overrides aus Body anwenden
    const overrides = req.body || {};
    const agentCount = parseInt(overrides.agentCount) || template.agentCount || template.tasks.length;
    const description = overrides.description ||
      (template.name + ': ' + template.tasks.map(function(t) { return t.title; }).join(', '));

    // Pruefen ob bereits ein Projekt laeuft
    if (isStarting || orchestrator.phase === 'running' || orchestrator.phase === 'awaiting_approval') {
      if (projectQueue.length >= MAX_QUEUE_SIZE) {
        return res.status(409).json({ error: 'Warteschlange ist voll' });
      }
      projectQueue.push({
        description,
        agentCount,
        requireApproval: !!overrides.requireApproval,
        priority: parseInt(overrides.priority) || 2,
        queuedAt: Date.now()
      });
      sortQueueByPriority();
      broadcastQueueUpdate();
      return res.json({ ok: true, queued: true, templateId: template.id });
    }

    res.json({ ok: true, message: 'Projekt aus Template gestartet', templateId: template.id });
    startProject(description, agentCount, !!overrides.requireApproval);
  } catch (e) {
    logger.error('Template anwenden fehlgeschlagen', { error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// ── Token-Usage API ─────────────────────────────────────────
app.get('/api/token-usage', (req, res) => {
  const state = orchestrator.getState();
  const budget = state.budget || {};
  const perAgent = (state.agents || []).map((agent, i) => ({
    index: i,
    title: agent.title || '',
    tokenUsage: agent.tokenUsage || { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCost: 0 }
  }));
  res.json({
    total: state.totalTokenUsage,
    coordinator: state.coordinator.tokenUsage || { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCost: 0 },
    agents: perAgent,
    budget: {
      maxTokenBudget: budget.maxTokenBudget || 0,
      warnTokenBudget: budget.warnTokenBudget || 0,
      inputCostPerMTok: budget.inputCostPerMTok || 3,
      outputCostPerMTok: budget.outputCostPerMTok || 15,
      exceeded: budget.exceeded || false,
      warned: budget.warned || false,
    }
  });
});

// ── Budget API ───────────────────────────────────────────────
app.get('/api/budget', (req, res) => {
  const state = orchestrator.getState();
  const budget = state.budget || {};
  const usage = state.totalTokenUsage || { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCost: 0 };
  const maxBudget = budget.maxTokenBudget || 0;
  const warnBudget = budget.warnTokenBudget || 0;
  const percent = maxBudget > 0 ? Math.min(100, Math.round(usage.totalTokens / maxBudget * 100)) : 0;

  res.json({
    maxTokenBudget: maxBudget,
    warnTokenBudget: warnBudget,
    inputCostPerMTok: budget.inputCostPerMTok || 3,
    outputCostPerMTok: budget.outputCostPerMTok || 15,
    totalTokens: usage.totalTokens,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    estimatedCost: usage.estimatedCost,
    percent,
    exceeded: budget.exceeded || false,
    warned: budget.warned || false,
  });
});

app.post('/api/budget', authMiddleware, apiLimiter, (req, res) => {
  const { maxTokenBudget, warnTokenBudget, inputCostPerMTok, outputCostPerMTok } = req.body;
  try {
    const patch = {};
    if (maxTokenBudget !== undefined) patch.tokenBudget = Number(maxTokenBudget);
    if (warnTokenBudget !== undefined) patch.warnTokenBudget = Number(warnTokenBudget);
    if (inputCostPerMTok !== undefined) patch.inputCostPerMTok = Number(inputCostPerMTok);
    if (outputCostPerMTok !== undefined) patch.outputCostPerMTok = Number(outputCostPerMTok);
    orchestrator.updateConfig(patch);
    res.json({ ok: true, config: orchestrator.getConfig() });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── Health-Check (beide Pfade: /health und /api/health) ─────
function healthHandler(req, res) {
  res.json({
    status: 'ok',
    uptime: Math.round(process.uptime()),
    phase: orchestrator.phase,
    memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB'
  });
}
app.get('/health', healthHandler);
app.get('/api/health', healthHandler);

// ── Health-Monitor: Erweiterte Endpoints ─────────────────────
app.get('/api/health/detailed', (req, res) => {
  if (!orchestrator.healthMonitor) {
    return res.status(503).json({ error: 'Health-Monitor nicht verfuegbar' });
  }
  // Verbindungszaehler setzen
  orchestrator.healthMonitor._getConnections = () => ({
    sse: clients.size,
    websocket: wsClients.size,
  });
  const health = orchestrator.healthMonitor.getHealth();
  res.json(health);
});

app.get('/api/health/history', (req, res) => {
  if (!orchestrator.healthMonitor) {
    return res.status(503).json({ error: 'Health-Monitor nicht verfuegbar' });
  }
  const minutes = parseInt(req.query.minutes) || 30;
  res.json(orchestrator.healthMonitor.getHealthHistory(minutes));
});

app.get('/api/health/diagnostics', (req, res) => {
  if (!orchestrator.healthMonitor) {
    return res.status(503).json({ error: 'Health-Monitor nicht verfuegbar' });
  }
  res.json(orchestrator.healthMonitor.getDiagnostics());
});

app.get('/api/health/alerts', (req, res) => {
  if (!orchestrator.healthMonitor) {
    return res.status(503).json({ error: 'Health-Monitor nicht verfuegbar' });
  }
  res.json(orchestrator.healthMonitor.getAlerts());
});

app.post('/api/health/alerts/:id/clear', (req, res) => {
  if (!orchestrator.healthMonitor) {
    return res.status(503).json({ error: 'Health-Monitor nicht verfuegbar' });
  }
  const id = parseInt(req.params.id);
  const cleared = orchestrator.healthMonitor.clearAlert(id);
  if (!cleared) {
    return res.status(404).json({ error: 'Alert nicht gefunden' });
  }
  res.json({ ok: true });
});

app.get('/api/health/thresholds', (req, res) => {
  if (!orchestrator.healthMonitor) {
    return res.status(503).json({ error: 'Health-Monitor nicht verfuegbar' });
  }
  res.json(orchestrator.healthMonitor.getThresholds());
});

app.put('/api/health/thresholds', (req, res) => {
  if (!orchestrator.healthMonitor) {
    return res.status(503).json({ error: 'Health-Monitor nicht verfuegbar' });
  }
  try {
    const body = req.body;
    if (!body || typeof body !== 'object') {
      return res.status(400).json({ error: 'Body muss ein Objekt mit Schwellwerten sein' });
    }
    for (const [metric, value] of Object.entries(body)) {
      orchestrator.healthMonitor.setAlertThreshold(metric, value);
    }
    res.json({ ok: true, thresholds: orchestrator.healthMonitor.getThresholds() });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── Log-Viewer API (strukturiert, paginiert, filterbar) ─────
app.get('/api/logs', (req, res) => {
  const { level, category, search, offset, limit } = req.query;
  let entries = logBuffer.slice().reverse(); // newest first

  // Filter: Level
  if (level) {
    entries = entries.filter(e => e.level === level);
  }
  // Filter: Kategorie
  if (category) {
    entries = entries.filter(e => e.category === category);
  }
  // Filter: Suchtext
  if (search) {
    const q = search.toLowerCase();
    entries = entries.filter(e =>
      (e.message || '').toLowerCase().includes(q) ||
      (e.category || '').toLowerCase().includes(q) ||
      (e.metadata ? JSON.stringify(e.metadata).toLowerCase().includes(q) : false)
    );
  }

  // Pagination
  const off = Math.max(0, parseInt(offset) || 0);
  const lim = Math.min(200, Math.max(1, parseInt(limit) || 100));
  const total = entries.length;
  const paged = entries.slice(off, off + lim);

  res.json({ entries: paged, total, offset: off, limit: lim });
});

// ── Log-Export (alle Logs als JSONL-Download) ────────────────
app.get('/api/logs/export', exportLimiter, (req, res) => {
  try {
    const jsonl = exportAllLogs();
    const filename = `logs_export_${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`;
    res.setHeader('Content-Type', 'application/jsonl');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(jsonl);
  } catch (e) {
    logger.error('Log-Export fehlgeschlagen', { error: e.message });
    res.status(500).json({ error: 'Log-Export fehlgeschlagen' });
  }
});

// ── Rotierte Log-Dateien auflisten ──────────────────────────
app.get('/api/logs/files', (req, res) => {
  try {
    res.json(getLogFiles());
  } catch (e) {
    logger.error('Log-Dateien lesen fehlgeschlagen', { error: e.message });
    res.status(500).json({ error: 'Fehler beim Lesen der Log-Dateien' });
  }
});

// ── Projekt-Historie ─────────────────────────────────────────

// Alle Projekte auflisten
app.get('/api/projects', async (req, res) => {
  const dir = path.join(__dirname, 'projects');
  try {
    await fsp.access(dir);
  } catch {
    return res.json([]);
  }

  try {
    const entries = await fsp.readdir(dir);
    const projDirs = entries.filter(d => d.startsWith('proj_'));

    const projects = await Promise.all(projDirs.map(async (d) => {
      let state = null;
      try {
        state = JSON.parse(await fsp.readFile(path.join(dir, d, 'state.json'), 'utf8'));
      } catch (e) { logger.debug('state.json nicht lesbar', { project: d, error: e.message }); }
      return {
        id: d,
        title: state?.projectTitle || d,
        phase: state?.phase || 'unknown',
        agentCount: state?.agents?.length || 0,
        createdAt: parseInt(d.replace('proj_', '')) || 0,
        totalDuration: state?.totalDuration || null,
        startedAt: state?.startedAt || null,
        completedAt: state?.completedAt || null,
        projectStats: state?.projectStats || null,
        projectScore: state?.projectScore || null,
        totalTokenUsage: state?.totalTokenUsage || null
      };
    }));

    projects.sort((a, b) => b.createdAt - a.createdAt);
    res.json(projects);
  } catch (e) {
    logger.error('Projektliste lesen fehlgeschlagen', { error: e.message });
    res.status(500).json({ error: 'Projektliste konnte nicht gelesen werden' });
  }
});

// Einzelnes Projekt laden
app.get('/api/projects/:id', async (req, res) => {
  const stateFile = path.join(__dirname, 'projects', req.params.id, 'state.json');
  // Pfad-Traversal verhindern
  if (!stateFile.startsWith(path.join(__dirname, 'projects'))) {
    return res.status(400).json({ error: 'Ungültiger Pfad' });
  }
  try {
    const data = await fsp.readFile(stateFile, 'utf8');
    res.json(JSON.parse(data));
  } catch {
    res.status(404).json({ error: 'Projekt nicht gefunden' });
  }
});

// ── Projekt löschen ─────────────────────────────────────────
app.delete('/api/projects/:id', authMiddleware, apiLimiter, async (req, res) => {
  const id = req.params.id;
  if (!id.startsWith('proj_')) {
    return res.status(400).json({ error: 'Ungültige Projekt-ID' });
  }
  const dir = path.join(__dirname, 'projects', id);
  // Pfad-Traversal verhindern
  if (!dir.startsWith(path.join(__dirname, 'projects'))) {
    return res.status(400).json({ error: 'Ungültiger Pfad' });
  }
  try { await fsp.access(dir); } catch {
    return res.status(404).json({ error: 'Projekt nicht gefunden' });
  }
  try {
    await fsp.rm(dir, { recursive: true, force: true });
    logger.info('Projekt gelöscht', { id });
    res.json({ ok: true, deleted: id });
  } catch (e) {
    logger.error('Projekt löschen fehlgeschlagen', { id, error: e.message });
    res.status(500).json({ error: 'Löschen fehlgeschlagen: ' + e.message });
  }
});

// ── Alte Projekte aufräumen ─────────────────────────────────
app.post('/api/cleanup', authMiddleware, apiLimiter, async (req, res) => {
  const dir = path.join(__dirname, 'projects');
  try { await fsp.access(dir); } catch {
    return res.json({ ok: true, deleted: [], count: 0 });
  }

  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const deleted = [];

  const entries = await fsp.readdir(dir);
  const oldProjects = entries.filter(d => {
    if (!d.startsWith('proj_')) return false;
    const ts = parseInt(d.replace('proj_', ''));
    return !isNaN(ts) && (now - ts) > sevenDaysMs;
  });

  await Promise.all(oldProjects.map(async d => {
    const fullPath = path.join(dir, d);
    if (fullPath.startsWith(path.join(__dirname, 'projects'))) {
      try {
        await fsp.rm(fullPath, { recursive: true, force: true });
        deleted.push(d);
      } catch (e) {
        logger.error('Aufräumen: Löschen fehlgeschlagen', { id: d, error: e.message });
      }
    }
  }));

  logger.info('Alte Projekte aufgeräumt', { count: deleted.length, deleted });
  res.json({ ok: true, deleted, count: deleted.length });
});

// ── Speicherplatz-Info ──────────────────────────────────────
app.get('/api/disk-usage', apiReadLimiter, async (req, res) => {
  const dir = path.join(__dirname, 'projects');
  try { await fsp.access(dir); } catch {
    return res.json({ totalSize: '0 MB', projectCount: 0, oldestProject: null, newestProject: null });
  }

  async function getDirSize(d) {
    let size = 0;
    try {
      const entries = await fsp.readdir(d, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) {
          size += await getDirSize(full);
        } else {
          try { size += (await fsp.stat(full)).size; } catch { /* best-effort, Datei evtl. zwischenzeitlich geloescht */ }
        }
      }
    } catch { /* best-effort, Verzeichnis evtl. nicht lesbar */ }
    return size;
  }

  const allEntries = await fsp.readdir(dir);
  const projects = allEntries.filter(d => d.startsWith('proj_'));
  const totalSize = await getDirSize(dir);
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
app.get('/api/files/:id', async (req, res) => {
  const dir = path.join(__dirname, 'projects', req.params.id);
  // Pfad-Traversal verhindern
  if (!dir.startsWith(path.join(__dirname, 'projects'))) {
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
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico',
  '.woff', '.woff2', '.ttf', '.eot',
  '.zip', '.tar', '.gz', '.exe', '.dll', '.so', '.dylib'
]);
const MAX_FILE_SIZE = 1 * 1024 * 1024; // 1 MB

app.get('/api/file-content/:id/:filePath(*)', apiLimiter, async (req, res) => {
  const projectDir = path.join(__dirname, 'projects', req.params.id);
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

// ── ZIP Export ───────────────────────────────────────────
app.get('/api/export/:id', exportLimiter, async (req, res) => {
  const dir = path.join(__dirname, 'projects', req.params.id);
  // Pfad-Traversal verhindern
  if (!dir.startsWith(path.join(__dirname, 'projects'))) {
    return res.status(400).json({ error: 'Ungültiger Pfad' });
  }
  try { await fsp.access(dir); } catch {
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

// ── JSON Export ───────────────────────────────────────────
// ── Export Helpers (async) ─────────────────────────────────
async function loadProjectState(id) {
  const projectDir = path.join(__dirname, 'projects', id);
  if (!projectDir.startsWith(path.join(__dirname, 'projects'))) return null;
  try {
    await fsp.access(projectDir);
    const raw = await fsp.readFile(path.join(projectDir, 'state.json'), 'utf8');
    return { state: JSON.parse(raw), projectDir };
  } catch { return null; }
}

async function listAgentFilesAsync(agentDir) {
  try {
    const files = await fsp.readdir(agentDir);
    return files.filter(f => f !== 'conversation.jsonl');
  } catch { return []; }
}

async function readConversationAsync(agentDir) {
  const logFile = path.join(agentDir, 'conversation.jsonl');
  try {
    const raw = await fsp.readFile(logFile, 'utf8');
    return raw.split('\n')
      .filter(line => line.trim())
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

app.get('/api/export-json/:id', exportLimiter, async (req, res) => {
  const id = req.params.id;
  const loaded = await loadProjectState(id);
  if (!loaded) return res.status(404).json({ error: 'Projekt nicht gefunden' });
  const { state, projectDir } = loaded;

  const agents = await Promise.all((state.agents || []).map(async (agent, i) => {
    const agentDir = path.join(projectDir, 'agent-' + (i + 1));
    const [files, conversation] = await Promise.all([
      listAgentFilesAsync(agentDir),
      readConversationAsync(agentDir)
    ]);
    return {
      title: agent.title || '',
      role: agent.role || '',
      task: agent.task || '',
      status: agent.status || '',
      duration: agent.duration || null,
      files,
      conversation
    };
  }));

  const result = {
    projectTitle: state.projectTitle || '',
    projectSummary: state.projectSummary || (state.coordinator && state.coordinator.summary) || '',
    createdAt: state.startedAt ? new Date(state.startedAt).toISOString() : '',
    totalDuration: state.totalDuration || null,
    agents
  };

  const fileName = id + '.json';
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="' + fileName + '"');
  res.send(JSON.stringify(result, null, 2));
});

// ── Markdown Export ───────────────────────────────────────
app.get('/api/export-markdown/:id', exportLimiter, async (req, res) => {
  const id = req.params.id;
  const loaded = await loadProjectState(id);
  if (!loaded) return res.status(404).json({ error: 'Projekt nicht gefunden' });
  const { state, projectDir } = loaded;

  function formatDurationMd(seconds) {
    if (!seconds) return 'k.A.';
    if (seconds < 60) return seconds + 's';
    var m = Math.floor(seconds / 60);
    var s = seconds % 60;
    return m + 'min ' + s + 's';
  }

  const statusLabels = {
    done: 'Fertig', error: 'Fehler', working: 'In Arbeit',
    waiting: 'Wartend', asking: 'Fragt Koordinator'
  };

  let md = '# ' + (state.projectTitle || 'Projekt') + '\n\n';
  md += (state.projectSummary || (state.coordinator && state.coordinator.summary) || '') + '\n\n';

  if (state.startedAt) {
    md += '**Erstellt:** ' + new Date(state.startedAt).toLocaleString('de-DE') + '\n\n';
  }
  if (state.totalDuration) {
    md += '**Gesamtdauer:** ' + formatDurationMd(state.totalDuration) + '\n\n';
  }

  md += '---\n\n';

  for (let i = 0; i < (state.agents || []).length; i++) {
    const agent = state.agents[i];
    const agentDir = path.join(projectDir, 'agent-' + (i + 1));
    const [files, conversation] = await Promise.all([
      listAgentFilesAsync(agentDir),
      readConversationAsync(agentDir)
    ]);

    md += '## Agent ' + (i + 1) + ': ' + (agent.title || 'Unbenannt') + '\n\n';
    md += '**Rolle:** ' + (agent.role || 'k.A.') + '\n\n';
    md += '**Aufgabe:** ' + (agent.task || 'k.A.') + '\n\n';
    md += '**Status:** ' + (statusLabels[agent.status] || agent.status || 'k.A.');
    md += ' | **Dauer:** ' + formatDurationMd(agent.duration) + '\n\n';

    if (files.length > 0) {
      md += '### Dateien\n\n';
      files.forEach(f => { md += '- ' + f + '\n'; });
      md += '\n';
    }

    if (conversation.length > 0) {
      md += '### Verlauf\n\n';
      conversation.forEach(msg => {
        const role = msg.role === 'agent' ? 'Agent' : (msg.role === 'coordinator' ? 'Koordinator' : (msg.role || 'System'));
        const text = (msg.content || msg.text || '').replace(/\n/g, '\n> ');
        md += '> **' + role + ':** ' + text + '\n>\n';
      });
      md += '\n';
    }

    md += '---\n\n';
  }

  const fileName = id + '-bericht.md';
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="' + fileName + '"');
  res.send(md);
});

// ── Zusammengeführte Dateien ──────────────────────────────────
app.get('/api/merged/:id', async (req, res) => {
  const dir = path.join(__dirname, 'projects', req.params.id, 'merged');
  // Pfad-Traversal verhindern
  if (!dir.startsWith(path.join(__dirname, 'projects'))) {
    return res.status(400).json({ error: 'Ungültiger Pfad' });
  }
  try {
    await fsp.access(dir);
  } catch {
    return res.status(404).json({ error: 'Zusammengeführte Dateien nicht gefunden' });
  }

  try {
    const names = await fsp.readdir(dir);
    const files = await Promise.all(names.map(async name => {
      const stat = await fsp.stat(path.join(dir, name));
      return { name, size: stat.size, modified: stat.mtimeMs };
    }));

    // Merge-Report lesen falls vorhanden
    let mergeReport = null;
    try {
      const reportPath = path.join(dir, 'MERGE_REPORT.md');
      mergeReport = await fsp.readFile(reportPath, 'utf-8');
    } catch { /* MERGE_REPORT.md nicht vorhanden */ }

    // Konflikte-Info lesen falls vorhanden
    let conflictsInfo = null;
    try {
      const conflictsPath = path.join(dir, 'CONFLICTS.md');
      conflictsInfo = await fsp.readFile(conflictsPath, 'utf-8');
    } catch { /* CONFLICTS.md nicht vorhanden */ }

    // Letztes Merge-Ergebnis aus Orchestrator holen (falls aktuelles Projekt)
    const lastMerge = orchestrator.getLastMergeResult();
    const mergeStats = lastMerge ? {
      totalFiles: lastMerge.totalFiles,
      conflicts: lastMerge.conflicts,
      strategy: lastMerge.strategy,
      duration: lastMerge.duration,
      totalSize: lastMerge.totalSize,
      scannedAgents: lastMerge.scannedAgents,
      conflictDetails: lastMerge.conflictDetails || [],
      fileOrigins: lastMerge.fileOrigins || [],
    } : null;

    res.json({ files, dir, mergeReport, conflictsInfo, mergeStats });
  } catch (e) {
    res.status(500).json({ error: 'Fehler beim Lesen der zusammengeführten Dateien' });
  }
});

// ── Manuelles Merge triggern / Re-Merge ─────────────────────────
app.post('/api/merge/:id', authMiddleware, apiLimiter, async (req, res) => {
  const id = req.params.id;
  // Pfad-Traversal verhindern
  if (!/^proj_\d+$/.test(id)) {
    return res.status(400).json({ error: 'Ungültige Projekt-ID' });
  }
  const { strategy } = req.body || {};
  const validStrategies = ['latest', 'largest', 'manual'];
  if (strategy && !validStrategies.includes(strategy)) {
    return res.status(400).json({ error: `Ungültige Strategie. Erlaubt: ${validStrategies.join(', ')}` });
  }

  // Prüfe ob das aktuelle Projekt gemeint ist
  if (orchestrator.projectId !== id) {
    return res.status(400).json({ error: 'Projekt-ID stimmt nicht mit dem aktuellen Projekt überein' });
  }

  try {
    const result = await orchestrator.remerge(strategy || null);
    if (result) {
      res.json({
        ok: true,
        totalFiles: result.totalFiles,
        conflicts: result.conflicts,
        strategy: result.strategy,
        duration: result.duration,
      });
    } else {
      res.status(500).json({ error: 'Merge fehlgeschlagen' });
    }
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── Plan Genehmigung ─────────────────────────────────────────
app.post('/api/approve', authMiddleware, apiLimiter, (req, res) => {
  try {
    orchestrator.approvePlan();
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/modify-plan', authMiddleware, apiLimiter, (req, res) => {
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

// ── Rollen API ───────────────────────────────────────────────────
app.get('/api/roles', apiReadLimiter, (req, res) => {
  try {
    const roles = orchestrator.getRoles();
    const rolesData = orchestrator.getRolesData();
    res.json({ roles, defaultRoles: rolesData.defaultRoles, customRoles: rolesData.customRoles });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/roles', authMiddleware, apiLimiter, (req, res) => {
  try {
    const role = orchestrator.createRole(req.body);
    res.json({ ok: true, role });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/roles/:id', authMiddleware, apiLimiter, (req, res) => {
  try {
    const role = orchestrator.updateRole(req.params.id, req.body);
    res.json({ ok: true, role });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/roles/:id', authMiddleware, apiLimiter, (req, res) => {
  try {
    orchestrator.deleteRole(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── Prompt-Templates API ─────────────��───────────────────────────
app.get('/api/prompts', (req, res) => {
  res.json(orchestrator.getPrompts());
});

app.post('/api/prompts', authMiddleware, apiLimiter, (req, res) => {
  try {
    orchestrator.updatePrompts(req.body);
    res.json({ ok: true, prompts: orchestrator.getPrompts().prompts });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/prompts/reset', authMiddleware, apiLimiter, (req, res) => {
  try {
    orchestrator.resetPrompts();
    res.json({ ok: true, prompts: orchestrator.getPrompts().prompts });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Konfiguration ───────────────────────────────────────────────
app.get('/api/config', (req, res) => {
  res.json(orchestrator.getConfig());
});

app.post('/api/config', authMiddleware, apiLimiter, (req, res) => {
  try {
    orchestrator.updateConfig(req.body);
    res.json({ ok: true, config: orchestrator.getConfig() });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── Config-Profile API ────────────────────────────────────────
app.get('/api/profiles', apiReadLimiter, (req, res) => {
  try {
    res.json(orchestrator.getProfiles());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/profiles/:name', apiReadLimiter, (req, res) => {
  try {
    const profile = orchestrator.profileManager.loadProfile(req.params.name);
    res.json(profile);
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

app.post('/api/profiles', authMiddleware, apiLimiter, (req, res) => {
  try {
    const { name, description, config } = req.body;
    if (!name || !config) {
      return res.status(400).json({ error: 'name und config sind erforderlich' });
    }
    const profile = orchestrator.profileManager.saveProfile(name, config, description);
    res.status(201).json(profile);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/profiles/:name', authMiddleware, apiLimiter, (req, res) => {
  try {
    orchestrator.profileManager.deleteProfile(req.params.name);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/profiles/:name/apply', authMiddleware, apiLimiter, (req, res) => {
  try {
    const result = orchestrator.applyProfile(req.params.name);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/profiles/save-current', authMiddleware, apiLimiter, (req, res) => {
  try {
    const { name, description } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'name ist erforderlich' });
    }
    const profile = orchestrator.saveCurrentAsProfile(name, description);
    res.status(201).json(profile);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/profiles/import', authMiddleware, apiLimiter, (req, res) => {
  try {
    const jsonString = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    const profile = orchestrator.profileManager.importProfile(jsonString);
    res.status(201).json(profile);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/profiles/:name/export', apiReadLimiter, (req, res) => {
  try {
    const json = orchestrator.profileManager.exportProfile(req.params.name);
    res.setHeader('Content-Type', 'application/json');
    res.send(json);
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

// ── Retry-Strategien API ─────────────────────────────────────
app.get('/api/retry-strategies', apiReadLimiter, (req, res) => {
  res.json(orchestrator.getRetryStrategies());
});

app.get('/api/retry-strategy', apiReadLimiter, (req, res) => {
  res.json(orchestrator.getRetryStrategy());
});

app.put('/api/retry-strategy', authMiddleware, apiLimiter, (req, res) => {
  try {
    const result = orchestrator.setRetryStrategy(req.body);
    res.json({ ok: true, strategy: result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── Undo/Redo API ────────────────────────────────────────────
app.get('/api/undo-redo', apiReadLimiter, (req, res) => {
  res.json(orchestrator.getUndoRedoStatus());
});

app.post('/api/config/undo', authMiddleware, apiLimiter, (req, res) => {
  try {
    const config = orchestrator.undoConfig();
    broadcast('state', orchestrator.getState());
    res.json({ ok: true, config });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/config/redo', authMiddleware, apiLimiter, (req, res) => {
  try {
    const config = orchestrator.redoConfig();
    broadcast('state', orchestrator.getState());
    res.json({ ok: true, config });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/plan/undo', authMiddleware, apiLimiter, (req, res) => {
  try {
    const result = orchestrator.undoPlan();
    broadcast('state', orchestrator.getState());
    res.json({ ok: true, tasks: result.tasks, agents: result.agents });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/plan/redo', authMiddleware, apiLimiter, (req, res) => {
  try {
    const result = orchestrator.redoPlan();
    broadcast('state', orchestrator.getState());
    res.json({ ok: true, tasks: result.tasks, agents: result.agents });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});



// ── Projekt-Statistiken aggregiert ────────────────────────────
app.get('/api/stats', apiReadLimiter, async (req, res) => {
  const dir = path.join(__dirname, 'projects');
  try { await fsp.access(dir); } catch {
    return res.json({ totalProjects: 0, completedProjects: 0, failedProjects: 0, totalAgents: 0, avgDuration: 0, avgScore: 0 });
  }

  try {
    const entries = await fsp.readdir(dir);
    const projects = entries.filter(d => d.startsWith('proj_'));
    let completedProjects = 0, failedProjects = 0, partialProjects = 0;
    let totalAgents = 0, totalDuration = 0, durationCount = 0;
    let totalScore = 0, scoreCount = 0;
    let totalFiles = 0, totalLines = 0;

    await Promise.all(projects.map(async (d) => {
      try {
        const state = JSON.parse(await fsp.readFile(path.join(dir, d, 'state.json'), 'utf8'));
        if (state.phase === 'complete') completedProjects++;
        else if (state.phase === 'error') failedProjects++;
        else if (state.phase === 'partial') partialProjects++;

        totalAgents += (state.agents || []).length;

        if (state.totalDuration) {
          totalDuration += state.totalDuration;
          durationCount++;
        }

        if (state.projectScore) {
          totalScore += state.projectScore;
          scoreCount++;
        }

        if (state.projectStats) {
          totalFiles += state.projectStats.totalFiles || 0;
          totalLines += state.projectStats.totalLines || 0;
        }
      } catch (e) { logger.debug('Projekt-Statistik nicht lesbar', { project: d, error: e.message }); }
    }));

    res.json({
      totalProjects: projects.length,
      completedProjects,
      failedProjects,
      partialProjects,
      totalAgents,
      avgDuration: durationCount > 0 ? Math.round(totalDuration / durationCount) : 0,
      avgScore: scoreCount > 0 ? Math.round(totalScore / scoreCount) : 0,
      totalFiles,
      totalLines,
    });
  } catch (e) {
    logger.error('Stats lesen fehlgeschlagen', { error: e.message });
    res.status(500).json({ error: 'Stats konnten nicht gelesen werden' });
  }
});

// ── Analytics API (cached 60s) ────────────────────────────────
let analyticsCache = { data: null, timestamp: 0 };
const ANALYTICS_CACHE_TTL = 60 * 1000; // 60 Sekunden

function getISOWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return d.getUTCFullYear() + '-W' + String(weekNo).padStart(2, '0');
}

async function computeAnalytics() {
  const dir = path.join(__dirname, 'projects');
  const empty = {
    timeline: [],
    roleStats: [],
    costEfficiency: { avgTokensPerProject: 0, avgTokensPerAgent: 0, avgTokensPerFile: 0, avgCostPerProject: 0 },
    topStats: { bestProject: null, worstProject: null, fastestProject: null, longestProject: null },
    distribution: {
      scoreBuckets: [
        { range: '0-20', count: 0 }, { range: '21-40', count: 0 }, { range: '41-60', count: 0 },
        { range: '61-80', count: 0 }, { range: '81-100', count: 0 }
      ],
      durationBuckets: [
        { range: '0-60s', count: 0 }, { range: '61-120s', count: 0 }, { range: '121-300s', count: 0 },
        { range: '301-600s', count: 0 }, { range: '600s+', count: 0 }
      ]
    }
  };

  try { await fsp.access(dir); } catch { return empty; }

  const entries = await fsp.readdir(dir);
  const projectDirs = entries.filter(d => d.startsWith('proj_'));
  if (projectDirs.length === 0) return empty;

  const states = (await Promise.all(projectDirs.map(async (d) => {
    try {
      const state = JSON.parse(await fsp.readFile(path.join(dir, d, 'state.json'), 'utf8'));
      state._dirName = d;
      return state;
    } catch { return null; }
  }))).filter(Boolean);

  if (states.length === 0) return empty;

  // ── Timeline: group by week ──
  const weekMap = {};
  for (const s of states) {
    const ts = s.startedAt || parseInt(s._dirName.replace('proj_', '')) || 0;
    if (!ts) continue;
    const week = getISOWeek(new Date(ts));
    if (!weekMap[week]) weekMap[week] = { projectCount: 0, successCount: 0, failCount: 0, scores: [], durations: [] };
    weekMap[week].projectCount++;
    if (s.phase === 'complete') weekMap[week].successCount++;
    if (s.phase === 'error') weekMap[week].failCount++;
    if (s.projectScore) weekMap[week].scores.push(s.projectScore);
    if (s.totalDuration) weekMap[week].durations.push(s.totalDuration);
  }
  const timeline = Object.keys(weekMap).sort().map(week => {
    const w = weekMap[week];
    return {
      week,
      projectCount: w.projectCount,
      successCount: w.successCount,
      failCount: w.failCount,
      avgScore: w.scores.length > 0 ? Math.round(w.scores.reduce((a, b) => a + b, 0) / w.scores.length) : 0,
      avgDuration: w.durations.length > 0 ? Math.round(w.durations.reduce((a, b) => a + b, 0) / w.durations.length) : 0
    };
  });

  // ── Role statistics ──
  const roleMap = {};
  for (const s of states) {
    for (const agent of (s.agents || [])) {
      const role = agent.role || 'unknown';
      if (!roleMap[role]) roleMap[role] = { count: 0, scores: [], durations: [], successCount: 0 };
      roleMap[role].count++;
      if (agent.score != null) roleMap[role].scores.push(agent.score);
      if (agent.duration != null) roleMap[role].durations.push(agent.duration);
      if (agent.status === 'done') roleMap[role].successCount++;
    }
  }
  const roleStats = Object.keys(roleMap).map(role => {
    const r = roleMap[role];
    return {
      role,
      count: r.count,
      avgScore: r.scores.length > 0 ? Math.round(r.scores.reduce((a, b) => a + b, 0) / r.scores.length) : 0,
      avgDuration: r.durations.length > 0 ? Math.round(r.durations.reduce((a, b) => a + b, 0) / r.durations.length) : 0,
      successRate: r.count > 0 ? Math.round((r.successCount / r.count) * 100) : 0
    };
  });

  // ── Cost efficiency ──
  let totalTokens = 0, totalAgents = 0, totalFiles = 0, totalCost = 0;
  for (const s of states) {
    if (s.totalTokenUsage) {
      totalTokens += s.totalTokenUsage.totalTokens || 0;
      totalCost += s.totalTokenUsage.estimatedCost || 0;
    }
    totalAgents += (s.agents || []).length;
    if (s.projectStats) totalFiles += s.projectStats.totalFiles || 0;
  }
  const costEfficiency = {
    avgTokensPerProject: states.length > 0 ? Math.round(totalTokens / states.length) : 0,
    avgTokensPerAgent: totalAgents > 0 ? Math.round(totalTokens / totalAgents) : 0,
    avgTokensPerFile: totalFiles > 0 ? Math.round(totalTokens / totalFiles) : 0,
    avgCostPerProject: states.length > 0 ? parseFloat((totalCost / states.length).toFixed(6)) : 0
  };

  // ── Top stats ──
  let bestProject = null, worstProject = null, fastestProject = null, longestProject = null;
  for (const s of states) {
    const id = s._dirName;
    const title = s.projectTitle || id;
    if (s.projectScore != null) {
      if (!bestProject || s.projectScore > bestProject.score) bestProject = { id, title, score: s.projectScore };
      if (!worstProject || s.projectScore < worstProject.score) worstProject = { id, title, score: s.projectScore };
    }
    if (s.totalDuration != null) {
      if (!fastestProject || s.totalDuration < fastestProject.duration) fastestProject = { id, title, duration: s.totalDuration };
      if (!longestProject || s.totalDuration > longestProject.duration) longestProject = { id, title, duration: s.totalDuration };
    }
  }
  const topStats = { bestProject, worstProject, fastestProject, longestProject };

  // ── Distribution ──
  const scoreBuckets = [
    { range: '0-20', count: 0 }, { range: '21-40', count: 0 }, { range: '41-60', count: 0 },
    { range: '61-80', count: 0 }, { range: '81-100', count: 0 }
  ];
  const durationBuckets = [
    { range: '0-60s', count: 0 }, { range: '61-120s', count: 0 }, { range: '121-300s', count: 0 },
    { range: '301-600s', count: 0 }, { range: '600s+', count: 0 }
  ];
  for (const s of states) {
    if (s.projectScore != null) {
      const sc = s.projectScore;
      if (sc <= 20) scoreBuckets[0].count++;
      else if (sc <= 40) scoreBuckets[1].count++;
      else if (sc <= 60) scoreBuckets[2].count++;
      else if (sc <= 80) scoreBuckets[3].count++;
      else scoreBuckets[4].count++;
    }
    if (s.totalDuration != null) {
      const dur = s.totalDuration;
      if (dur <= 60) durationBuckets[0].count++;
      else if (dur <= 120) durationBuckets[1].count++;
      else if (dur <= 300) durationBuckets[2].count++;
      else if (dur <= 600) durationBuckets[3].count++;
      else durationBuckets[4].count++;
    }
  }

  return { timeline, roleStats, costEfficiency, topStats, distribution: { scoreBuckets, durationBuckets } };
}

app.get('/api/analytics', apiReadLimiter, async (req, res) => {
  const now = Date.now();
  if (analyticsCache.data && (now - analyticsCache.timestamp) < ANALYTICS_CACHE_TTL) {
    return res.json(analyticsCache.data);
  }
  try {
    const data = await computeAnalytics();
    analyticsCache = { data, timestamp: now };
    res.json(data);
  } catch (e) {
    logger.error('Analytics-Fehler', { error: e.message });
    res.status(500).json({ error: 'Analytics konnten nicht berechnet werden' });
  }
});

// ── Agent Retry ──────────────────────────────────────────────
app.post('/api/retry/:agentIndex', authMiddleware, apiLimiter, async (req, res) => {
  const idx = parseInt(req.params.agentIndex);
  if (isNaN(idx) || idx < 0) {
    return res.status(400).json({ error: 'Ungültiger Index' });
  }
  res.json({ ok: true });
  orchestrator.retryAgent(idx).catch(e => broadcast('error', { message: e.message }));
});

// ── Agent Intervention ──────────────────────────────────────
const VALID_INTERVENTION_TYPES = ['redirect', 'skip', 'restart', 'inject', 'complete'];

app.post('/api/intervene/:agentIndex', authMiddleware, apiLimiter, (req, res) => {
  const idx = parseInt(req.params.agentIndex);
  if (isNaN(idx) || idx < 0) {
    return res.status(400).json({ error: 'Ungültiger Index' });
  }
  const { message, type } = req.body || {};

  // Typ validieren (Default: redirect für Abwärtskompatibilität)
  const interventionType = type || 'redirect';
  if (!VALID_INTERVENTION_TYPES.includes(interventionType)) {
    return res.status(400).json({
      error: 'Ungültiger Intervention-Typ: ' + interventionType + '. Erlaubt: ' + VALID_INTERVENTION_TYPES.join(', ')
    });
  }

  // Nachricht-Validierung: bei skip/complete/restart ist Nachricht optional
  const needsMessage = interventionType === 'redirect' || interventionType === 'inject';
  if (needsMessage && (!message || typeof message !== 'string' || message.trim().length === 0)) {
    return res.status(400).json({ error: 'Nachricht ist erforderlich für Typ "' + interventionType + '"' });
  }
  if (message && message.length > 2000) {
    return res.status(400).json({ error: 'Nachricht darf maximal 2000 Zeichen lang sein' });
  }
  try {
    orchestrator.setIntervention(idx, (message || '').trim(), interventionType);
    res.json({ ok: true, type: interventionType });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── Projekt laden (Historie anzeigen) ─────────────────────────
app.post('/api/load/:id', authMiddleware, apiLimiter, (req, res) => {
  const id = req.params.id;
  if (!id || !id.startsWith('proj_')) {
    return res.status(400).json({ error: 'Ungültige Projekt-ID' });
  }
  if (orchestrator.phase === 'running' || orchestrator.phase === 'awaiting_approval') {
    return res.status(409).json({ error: 'Kann Projekt nicht laden während ein anderes läuft' });
  }
  try {
    const state = orchestrator.loadProject(id);
    broadcast('state', state);
    res.json({ ok: true, state });
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

// ── Projekt fortsetzen (Resume) ──────────────────────────────
let isResuming = false;

app.post('/api/resume/:id', authMiddleware, startLimiter, async (req, res) => {
  const id = req.params.id;

  // Projekt-ID Validierung
  if (!id || !id.startsWith('proj_')) {
    return res.status(400).json({ error: 'Ungültige Projekt-ID (muss mit "proj_" beginnen)' });
  }

  // Race-Condition und Lauf-Check
  if (isResuming || isStarting || orchestrator.phase === 'running' || orchestrator.phase === 'awaiting_approval') {
    return res.status(409).json({ error: 'Projekt läuft bereits oder wird gerade fortgesetzt' });
  }

  isResuming = true;

  try {
    res.json({ ok: true, message: 'Projekt wird fortgesetzt' });

    // Async starten (non-blocking)
    orchestrator.resume(id).catch(e => {
      logger.error('Resume-Fehler', { error: e.message, projectId: id });
      broadcast('error', { message: e.message });
    }).finally(() => {
      isResuming = false;
    });
  } catch (e) {
    isResuming = false;
    logger.error('Resume-Start-Fehler', { error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// ── Projekt klonen (Einstellungen übernehmen) ────────────────
app.post('/api/clone/:id', authMiddleware, apiLimiter, async (req, res) => {
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
    const state = JSON.parse(await fsp.readFile(stateFile, 'utf8'));
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

// ── Agent Prompt-Log API (Debugging) ─────────────────────────
app.get('/api/agent-prompts/:id/:agentIndex', async (req, res) => {
  const id = req.params.id;
  const agentIndex = parseInt(req.params.agentIndex, 10);

  // Validierung
  if (!id || typeof id !== 'string') {
    return res.status(400).json({ error: 'Ungültige Projekt-ID' });
  }
  if (isNaN(agentIndex) || agentIndex < 0) {
    return res.status(400).json({ error: 'Ungültiger Agent-Index' });
  }

  const projectsDir = path.resolve(path.join(__dirname, 'projects'));
  const agentDir = path.resolve(path.join(__dirname, 'projects', id, `agent-${agentIndex + 1}`));
  const promptsFile = path.resolve(path.join(agentDir, 'prompts.jsonl'));

  // Pfad-Traversal verhindern
  if (!agentDir.startsWith(projectsDir + path.sep) && agentDir !== projectsDir) {
    return res.status(400).json({ error: 'Ungültiger Pfad' });
  }
  if (!promptsFile.startsWith(projectsDir + path.sep)) {
    return res.status(400).json({ error: 'Ungültiger Pfad' });
  }

  let content;
  try {
    content = await fsp.readFile(promptsFile, 'utf-8');
  } catch {
    return res.status(404).json({ error: 'Prompt-Log nicht gefunden' });
  }

  try {
    const lines = content.trim().split('\n').filter(Boolean);
    const entries = lines.map(line => {
      const entry = JSON.parse(line);
      return {
        round: entry.round,
        prompt: entry.prompt,
        response: entry.response,
        ts: entry.ts,
        promptTokens: Math.ceil((entry.prompt || '').length / 4),
        responseTokens: Math.ceil((entry.response || '').length / 4),
      };
    });
    res.json(entries);
  } catch (e) {
    res.status(500).json({ error: 'Fehler beim Lesen des Prompt-Logs' });
  }
});

// ── Crash-Recovery API ────────────────────────────────────────

// GET /api/recovery - Prüfe ob Crash-Recovery möglich ist
app.get('/api/recovery', async (req, res) => {
  try {
    const result = await Orchestrator._detectCrashRecovery();
    res.json(result);
  } catch (e) {
    logger.error('Recovery-Check fehlgeschlagen', { error: e.message });
    res.status(500).json({ hasCrash: false, error: e.message });
  }
});

// POST /api/recovery/restore - Stelle aus Checkpoint wieder her
app.post('/api/recovery/restore', authMiddleware, apiLimiter, async (req, res) => {
  try {
    if (isStarting || orchestrator.phase === 'running' || orchestrator.phase === 'awaiting_approval') {
      return res.status(409).json({ error: 'Es laeuft bereits ein Projekt. Bitte erst abbrechen.' });
    }

    const recovery = await Orchestrator._detectCrashRecovery();
    if (!recovery.hasCrash) {
      return res.status(404).json({ error: 'Kein Checkpoint zur Wiederherstellung gefunden' });
    }

    isStarting = true;
    res.json({ ok: true, message: 'Projekt wird aus Checkpoint wiederhergestellt', projectId: recovery.projectId, projectTitle: recovery.projectTitle });

    try {
      await orchestrator.restoreFromCheckpoint(recovery.checkpoint, recovery.projectDir);
    } catch (e) {
      logger.error('Recovery fehlgeschlagen', { error: e.message });
      broadcast('error', { message: 'Recovery fehlgeschlagen: ' + e.message });
    } finally {
      isStarting = false;
    }
  } catch (e) {
    isStarting = false;
    logger.error('Recovery-Restore fehlgeschlagen', { error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// POST /api/recovery/discard - Verwerfe Checkpoint und starte frisch
app.post('/api/recovery/discard', authMiddleware, apiLimiter, async (req, res) => {
  try {
    const recovery = await Orchestrator._detectCrashRecovery();
    if (!recovery.hasCrash) {
      return res.status(404).json({ error: 'Kein Checkpoint zum Verwerfen gefunden' });
    }

    await Orchestrator._discardCheckpoints(recovery.projectDir);
    logger.info('Checkpoint verworfen', { projectId: recovery.projectId });
    res.json({ ok: true, message: 'Checkpoint verworfen', projectId: recovery.projectId });
  } catch (e) {
    logger.error('Recovery-Discard fehlgeschlagen', { error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// ── Snapshot API ─────────────────────────────────────────────

// GET /api/snapshots – Alle Snapshots (optional ?projectId=X)
app.get('/api/snapshots', apiReadLimiter, async (req, res) => {
  try {
    const projectId = req.query.projectId || null;
    const snapshots = await orchestrator.getSnapshots(projectId);
    res.json({ snapshots });
  } catch (e) {
    logger.error('Snapshots laden fehlgeschlagen', { error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// GET /api/snapshots/:id – Einzelner Snapshot mit State
app.get('/api/snapshots/:id', apiReadLimiter, async (req, res) => {
  const id = req.params.id;
  if (!id || !id.startsWith('snap_')) {
    return res.status(400).json({ error: 'Ungueltige Snapshot-ID' });
  }
  try {
    const state = await orchestrator.snapshotManager.restoreSnapshot(id);
    // Auch Metadata laden
    const allSnaps = await orchestrator.snapshotManager.listAllSnapshots();
    const meta = allSnaps.find(s => s.id === id) || {};
    res.json({ id, metadata: meta, state });
  } catch (e) {
    if (e.message.includes('nicht gefunden')) {
      return res.status(404).json({ error: e.message });
    }
    res.status(500).json({ error: e.message });
  }
});

// POST /api/snapshots – Manuellen Snapshot erstellen
app.post('/api/snapshots', authMiddleware, apiLimiter, async (req, res) => {
  const { name, description } = req.body || {};
  try {
    const result = await orchestrator.createSnapshot(name, description);
    res.json({ ok: true, ...result });
  } catch (e) {
    if (e.message.includes('Kein aktives Projekt')) {
      return res.status(400).json({ error: e.message });
    }
    logger.error('Snapshot erstellen fehlgeschlagen', { error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/snapshots/:id – Snapshot loeschen
app.delete('/api/snapshots/:id', authMiddleware, apiLimiter, async (req, res) => {
  const id = req.params.id;
  if (!id || !id.startsWith('snap_')) {
    return res.status(400).json({ error: 'Ungueltige Snapshot-ID' });
  }
  try {
    const result = await orchestrator.snapshotManager.deleteSnapshot(id);
    res.json({ ok: true, ...result });
  } catch (e) {
    if (e.message.includes('nicht gefunden')) {
      return res.status(404).json({ error: e.message });
    }
    res.status(500).json({ error: e.message });
  }
});

// POST /api/snapshots/:id/restore – Snapshot wiederherstellen
app.post('/api/snapshots/:id/restore', authMiddleware, apiLimiter, async (req, res) => {
  const id = req.params.id;
  if (!id || !id.startsWith('snap_')) {
    return res.status(400).json({ error: 'Ungueltige Snapshot-ID' });
  }
  try {
    const state = await orchestrator.restoreSnapshot(id);
    broadcast('state', orchestrator.getState());
    res.json({ ok: true, snapshotId: id, restoredPhase: state.phase });
  } catch (e) {
    if (e.message.includes('nicht gefunden')) {
      return res.status(404).json({ error: e.message });
    }
    res.status(500).json({ error: e.message });
  }
});

// GET /api/snapshots/:id1/compare/:id2 – Zwei Snapshots vergleichen
app.get('/api/snapshots/:id1/compare/:id2', apiReadLimiter, async (req, res) => {
  const { id1, id2 } = req.params;
  if (!id1 || !id1.startsWith('snap_') || !id2 || !id2.startsWith('snap_')) {
    return res.status(400).json({ error: 'Ungueltige Snapshot-IDs' });
  }
  try {
    const comparison = await orchestrator.compareSnapshots(id1, id2);
    res.json(comparison);
  } catch (e) {
    if (e.message.includes('nicht gefunden')) {
      return res.status(404).json({ error: e.message });
    }
    res.status(500).json({ error: e.message });
  }
});

// GET /api/snapshots/:id/size – Snapshot-Groesse
app.get('/api/snapshots/:id/size', apiReadLimiter, async (req, res) => {
  const id = req.params.id;
  if (!id || !id.startsWith('snap_')) {
    return res.status(400).json({ error: 'Ungueltige Snapshot-ID' });
  }
  try {
    const result = await orchestrator.snapshotManager.getSnapshotSize(id);
    res.json(result);
  } catch (e) {
    if (e.message.includes('nicht gefunden')) {
      return res.status(404).json({ error: e.message });
    }
    res.status(500).json({ error: e.message });
  }
});

// ── Meilenstein API ──────────────────────────────────────────
const MILESTONES_FILE = path.join(__dirname, 'milestones.json');

// Meilensteine laden
app.get('/api/milestones', async (req, res) => {
  try {
    const data = JSON.parse(await fsp.readFile(MILESTONES_FILE, 'utf8'));
    res.json(data);
  } catch (e) {
    if (e.code === 'ENOENT') {
      return res.json({ milestones: [] });
    }
    logger.error('Meilensteine laden fehlgeschlagen', { error: e.message });
    res.status(500).json({ error: 'Meilensteine konnten nicht geladen werden' });
  }
});

// Meilensteine speichern
app.post('/api/milestones', authMiddleware, apiLimiter, async (req, res) => {
  const { milestones } = req.body;
  if (!Array.isArray(milestones)) {
    return res.status(400).json({ error: 'milestones muss ein Array sein' });
  }
  for (const m of milestones) {
    if (!m.id || !m.title || !Array.isArray(m.tasks) || m.tasks.length === 0) {
      return res.status(400).json({ error: 'Jeder Meilenstein braucht id, title und mindestens eine Task' });
    }
    if (m.tasks.length > 10) {
      return res.status(400).json({ error: 'Maximal 10 Tasks pro Meilenstein erlaubt' });
    }
  }
  try {
    await fsp.writeFile(MILESTONES_FILE, JSON.stringify({ milestones }, null, 2), 'utf8');
    logger.info('Meilensteine gespeichert', { count: milestones.length });
    res.json({ ok: true, count: milestones.length });
  } catch (e) {
    logger.error('Meilensteine speichern fehlgeschlagen', { error: e.message });
    res.status(500).json({ error: 'Speichern fehlgeschlagen: ' + e.message });
  }
});

// Projekt mit Meilenstein starten
app.post('/api/start-milestone', authMiddleware, startLimiter, async (req, res) => {
  const { milestoneId, tasks: customTasks } = req.body;
  if (!milestoneId || typeof milestoneId !== 'string') {
    return res.status(400).json({ error: 'milestoneId ist erforderlich' });
  }

  let milestones;
  try {
    const data = JSON.parse(await fsp.readFile(MILESTONES_FILE, 'utf8'));
    milestones = data.milestones || [];
  } catch (e) {
    return res.status(500).json({ error: 'Meilensteine konnten nicht geladen werden' });
  }

  const milestone = milestones.find(m => m.id === milestoneId);
  if (!milestone) {
    return res.status(404).json({ error: 'Meilenstein nicht gefunden: ' + milestoneId });
  }

  const tasks = Array.isArray(customTasks) && customTasks.length > 0 ? customTasks : milestone.tasks;
  const agentCount = tasks.length;

  if (agentCount < 2 || agentCount > 10) {
    return res.status(400).json({ error: 'Agentenanzahl muss zwischen 2 und 10 liegen' });
  }

  const description = milestone.title + ': ' + milestone.description + '\n\n' +
    'Vordefinierte Aufgaben:\n' +
    tasks.map(function(t, i) {
      return (i + 1) + '. ' + t.title + ' \u2013 ' + t.task + ' (Lieferergebnis: ' + t.deliverable + ')' +
        (t.depends_on && t.depends_on.length > 0 ? ' [Abh\u00E4ngig von: ' + t.depends_on.map(function(d) { return 'Agent ' + (d + 1); }).join(', ') + ']' : '');
    }).join('\n');

  if (isStarting || orchestrator.phase === 'running' || orchestrator.phase === 'awaiting_approval') {
    if (projectQueue.length >= MAX_QUEUE_SIZE) {
      return res.status(409).json({ error: 'Warteschlange ist voll (max ' + MAX_QUEUE_SIZE + ' Projekte)' });
    }
    const newItem = {
      description,
      agentCount,
      requireApproval: false,
      priority: 2,
      queuedAt: Date.now()
    };
    projectQueue.push(newItem);
    sortQueueByPriority();
    broadcastQueueUpdate();
    const pos = projectQueue.indexOf(newItem) + 1;
    return res.json({ ok: true, queued: true, position: pos });
  }

  isStarting = true;
  try {
    res.json({ ok: true, message: 'Meilenstein-Projekt gestartet: ' + milestone.title });
    startProject(description, agentCount, false);
  } catch (e) {
    isStarting = false;
    logger.error('Meilenstein-Start-Fehler', { error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// ── Changelog: chronologische Agent-Aktionen ─────────────────
app.get('/api/projects/:id/changelog', async (req, res) => {
  const id = req.params.id;
  if (!id.startsWith('proj_')) {
    return res.status(400).json({ error: 'Ungültige Projekt-ID' });
  }
  const loaded = await loadProjectState(id);
  if (!loaded) return res.status(404).json({ error: 'Projekt nicht gefunden' });
  const { state: projState, projectDir } = loaded;
  const agents = projState.agents || [];
  const changelog = [];

  for (let i = 0; i < agents.length; i++) {
    const agent = agents[i];
    const agentDir = path.join(projectDir, 'agent-' + (i + 1));
    const [files, conversation] = await Promise.all([
      listAgentFilesAsync(agentDir),
      readConversationAsync(agentDir)
    ]);

    const agentStart = agent.startedAt || projState.startedAt || null;

    conversation.forEach((msg, msgIdx) => {
      const ts = msg.timestamp || msg.ts || (agentStart ? agentStart + msgIdx * 1000 : Date.now());
      const role = msg.role || 'system';
      const content = msg.content || msg.text || '';

      if (role === 'agent' || role === 'assistant') {
        const fileMatches = content.match(/(?:erstellt|erzeugt|geschrieben|angelegt|created|wrote|generated|saved)[\s:]*[`"']?([^\s`"'\n,]+\.\w+)/gi) || [];
        const mentionedFiles = fileMatches.map(m => {
          const parts = m.match(/[`"']?([^\s`"'\n,]+\.\w+)/);
          return parts ? parts[1] : null;
        }).filter(Boolean);

        let action = 'arbeitet';
        let summary = content.substring(0, 200);
        if (/FERTIG|fertig|done|abgeschlossen/i.test(content)) {
          action = 'abgeschlossen';
        } else if (/FRAGE:|Frage an Koordinator/i.test(content)) {
          action = 'frage';
          summary = content.replace(/^FRAGE:\s*/i, '').substring(0, 200);
        }

        changelog.push({
          timestamp: ts,
          agentIndex: i,
          agentTitle: agent.title || 'Agent ' + (i + 1),
          action,
          files: mentionedFiles.length > 0 ? mentionedFiles : [],
          summary
        });
      } else if (role === 'coordinator' || role === 'system') {
        changelog.push({
          timestamp: ts,
          agentIndex: i,
          agentTitle: agent.title || 'Agent ' + (i + 1),
          action: role === 'coordinator' ? 'koordinator-antwort' : 'system',
          files: [],
          summary: content.substring(0, 200)
        });
      }
    });

    if (conversation.length === 0 && agent.status) {
      changelog.push({
        timestamp: agentStart || Date.now(),
        agentIndex: i,
        agentTitle: agent.title || 'Agent ' + (i + 1),
        action: agent.status === 'done' ? 'abgeschlossen' : agent.status,
        files,
        summary: agent.task || ''
      });
    }
  }

  changelog.sort((a, b) => a.timestamp - b.timestamp);
  res.json(changelog);
});

// ── Projekt-Diff: zwei Projekte vergleichen ───────────────────
app.get('/api/projects/:id1/diff/:id2', async (req, res) => {
  const id1 = req.params.id1;
  const id2 = req.params.id2;
  if (!id1.startsWith('proj_') || !id2.startsWith('proj_')) {
    return res.status(400).json({ error: 'Ungültige Projekt-IDs' });
  }

  const [loaded1, loaded2] = await Promise.all([
    loadProjectState(id1),
    loadProjectState(id2)
  ]);

  if (!loaded1) return res.status(404).json({ error: 'Projekt ' + id1 + ' nicht gefunden' });
  if (!loaded2) return res.status(404).json({ error: 'Projekt ' + id2 + ' nicht gefunden' });

  const state1 = loaded1.state;
  const state2 = loaded2.state;
  const agents1 = state1.agents || [];
  const agents2 = state2.agents || [];

  const titles1 = new Set(agents1.map(a => a.title || ''));
  const titles2 = new Set(agents2.map(a => a.title || ''));

  const added = agents2.filter(a => !titles1.has(a.title || '')).map(a => ({
    title: a.title || '(Unbenannt)',
    task: a.task || '',
    status: a.status || 'unknown'
  }));

  const removed = agents1.filter(a => !titles2.has(a.title || '')).map(a => ({
    title: a.title || '(Unbenannt)',
    task: a.task || '',
    status: a.status || 'unknown'
  }));

  const changed = [];
  agents1.forEach(a1 => {
    const match = agents2.find(a2 => (a2.title || '') === (a1.title || '') && (a1.title || '') !== '');
    if (match) {
      const diffs = [];
      if (a1.status !== match.status) diffs.push({ field: 'status', from: a1.status, to: match.status });
      if (a1.task !== match.task) diffs.push({ field: 'task', from: (a1.task || '').substring(0, 100), to: (match.task || '').substring(0, 100) });
      if ((a1.score || null) !== (match.score || null)) diffs.push({ field: 'score', from: a1.score, to: match.score });
      if ((a1.rounds || 0) !== (match.rounds || 0)) diffs.push({ field: 'rounds', from: a1.rounds || 0, to: match.rounds || 0 });
      if (diffs.length > 0) {
        changed.push({ title: a1.title, diffs });
      }
    }
  });

  const score1 = state1.projectScore != null ? state1.projectScore : null;
  const score2 = state2.projectScore != null ? state2.projectScore : null;
  const scoresDiff = {
    project1: { id: id1, title: state1.projectTitle || id1, score: score1, agentCount: agents1.length, duration: state1.totalDuration || null, phase: state1.phase || 'unknown' },
    project2: { id: id2, title: state2.projectTitle || id2, score: score2, agentCount: agents2.length, duration: state2.totalDuration || null, phase: state2.phase || 'unknown' },
    scoreDelta: (score1 != null && score2 != null) ? score2 - score1 : null
  };

  res.json({ added, removed, changed, scoresDiff });
});

// ── Projektübergreifende Suche ────────────────────────────────
app.get('/api/search', apiReadLimiter, async (req, res) => {
  const q = (req.query.q || '').trim();
  const scope = req.query.scope || 'all'; // all|files|conversations|titles
  if (!q || q.length < 2) {
    return res.json([]);
  }
  if (!['all', 'files', 'conversations', 'titles'].includes(scope)) {
    return res.status(400).json({ error: 'Ungültiger Scope. Erlaubt: all, files, conversations, titles' });
  }

  const SEARCH_TIMEOUT = 5000;
  const MAX_RESULTS = 50;
  const MAX_FILE_SIZE_SEARCH = 1 * 1024 * 1024; // 1 MB

  const projectsDir = path.join(__dirname, 'projects');
  let entries;
  try {
    entries = await fsp.readdir(projectsDir);
  } catch {
    return res.json([]);
  }
  const projDirs = entries.filter(d => d.startsWith('proj_'));

  const searchLower = q.toLowerCase();
  let results = [];
  let aborted = false;

  // Timeout-Controller
  const timeoutPromise = new Promise(resolve => {
    setTimeout(() => { aborted = true; resolve(); }, SEARCH_TIMEOUT);
  });

  // Hilfsfunktion: Kontext um einen Treffer extrahieren (Zeile davor + danach)
  function extractContext(text, matchIndex, lineText) {
    const lines = text.split('\n');
    let currentPos = 0;
    for (let i = 0; i < lines.length; i++) {
      const lineEnd = currentPos + lines[i].length;
      if (matchIndex >= currentPos && matchIndex <= lineEnd) {
        const before = i > 0 ? lines[i - 1] : '';
        const after = i < lines.length - 1 ? lines[i + 1] : '';
        return {
          before: before.substring(0, 200),
          match: lines[i].substring(0, 300),
          after: after.substring(0, 200),
          line: i + 1
        };
      }
      currentPos = lineEnd + 1; // +1 für \n
    }
    return { before: '', match: lineText || text.substring(matchIndex, matchIndex + 200), after: '', line: 0 };
  }

  // Einzelnes Projekt durchsuchen
  async function searchProject(projId) {
    if (aborted || results.length >= MAX_RESULTS) return;

    const projDir = path.join(projectsDir, projId);
    let state = null;
    try {
      const raw = await fsp.readFile(path.join(projDir, 'state.json'), 'utf8');
      state = JSON.parse(raw);
    } catch { return; } // Kein state.json → überspringen

    const projectTitle = state.projectTitle || projId;
    const createdAt = parseInt(projId.replace('proj_', '')) || 0;

    // 1) Titel-Suche (Projekt-Titel + Agent-Titel)
    if ((scope === 'all' || scope === 'titles') && !aborted && results.length < MAX_RESULTS) {
      if (projectTitle.toLowerCase().includes(searchLower)) {
        results.push({
          projectId: projId,
          projectTitle,
          type: 'title',
          path: '',
          match: projectTitle,
          context: { before: '', match: projectTitle, after: state.projectSummary ? state.projectSummary.substring(0, 200) : '', line: 0 },
          timestamp: createdAt
        });
      }

      // Agent-Titel durchsuchen
      if (Array.isArray(state.agents)) {
        for (let i = 0; i < state.agents.length && results.length < MAX_RESULTS; i++) {
          const agent = state.agents[i];
          const agentTitle = agent.title || '';
          const agentTask = agent.task || '';
          if (agentTitle.toLowerCase().includes(searchLower) || agentTask.toLowerCase().includes(searchLower)) {
            results.push({
              projectId: projId,
              projectTitle,
              type: 'title',
              path: 'Agent ' + (i + 1) + ': ' + agentTitle,
              match: agentTitle.toLowerCase().includes(searchLower) ? agentTitle : agentTask.substring(0, 200),
              context: { before: '', match: agentTitle, after: agentTask.substring(0, 200), line: 0 },
              timestamp: createdAt
            });
          }
        }
      }
    }

    // 2) Conversation-Suche
    if ((scope === 'all' || scope === 'conversations') && !aborted && results.length < MAX_RESULTS) {
      if (Array.isArray(state.agents)) {
        for (let i = 0; i < state.agents.length && results.length < MAX_RESULTS && !aborted; i++) {
          const agentDir = path.join(projDir, 'agent-' + (i + 1));
          const convFile = path.join(agentDir, 'conversation.jsonl');
          try {
            const convStat = await fsp.stat(convFile);
            if (convStat.size > MAX_FILE_SIZE_SEARCH) continue;
            const raw = await fsp.readFile(convFile, 'utf8');
            const lines = raw.split('\n').filter(l => l.trim());
            for (let li = 0; li < lines.length && results.length < MAX_RESULTS; li++) {
              try {
                const entry = JSON.parse(lines[li]);
                const text = entry.text || entry.content || entry.message || '';
                const idx = text.toLowerCase().indexOf(searchLower);
                if (idx !== -1) {
                  const agentTitle = (state.agents[i] && state.agents[i].title) || 'Agent ' + (i + 1);
                  results.push({
                    projectId: projId,
                    projectTitle,
                    type: 'conversation',
                    path: 'Agent ' + (i + 1) + ': ' + agentTitle,
                    match: text.substring(idx, idx + 100),
                    context: extractContext(text, idx, ''),
                    timestamp: entry.timestamp || createdAt
                  });
                }
              } catch { /* JSON parse Fehler → überspringen */ }
            }
          } catch { /* Datei nicht vorhanden → überspringen */ }
        }
      }

      // Auch coordinator.log durchsuchen
      if (Array.isArray(state.coordinator && state.coordinator.log)) {
        for (let li = 0; li < state.coordinator.log.length && results.length < MAX_RESULTS; li++) {
          const entry = state.coordinator.log[li];
          const question = entry.question || entry.q || '';
          const answer = entry.answer || entry.a || '';
          const combined = question + ' ' + answer;
          const idx = combined.toLowerCase().indexOf(searchLower);
          if (idx !== -1) {
            results.push({
              projectId: projId,
              projectTitle,
              type: 'conversation',
              path: 'Koordinator-Protokoll',
              match: combined.substring(idx, idx + 100),
              context: { before: '', match: combined.substring(Math.max(0, idx - 50), idx + 150), after: '', line: li + 1 },
              timestamp: createdAt
            });
          }
        }
      }
    }

    // 3) Datei-Inhalte durchsuchen
    if ((scope === 'all' || scope === 'files') && !aborted && results.length < MAX_RESULTS) {
      async function searchDir(dir, relPrefix) {
        if (aborted || results.length >= MAX_RESULTS) return;
        let dirEntries;
        try { dirEntries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of dirEntries) {
          if (aborted || results.length >= MAX_RESULTS) return;
          const fullPath = path.join(dir, entry.name);
          const relPath = relPrefix ? relPrefix + '/' + entry.name : entry.name;
          if (entry.isDirectory()) {
            await searchDir(fullPath, relPath);
          } else {
            // Binärdateien überspringen
            const ext = path.extname(entry.name).toLowerCase();
            if (BINARY_EXTENSIONS.has(ext)) continue;
            // conversation.jsonl wird oben schon durchsucht
            if (entry.name === 'conversation.jsonl' || entry.name === 'state.json') continue;
            try {
              const fileStat = await fsp.stat(fullPath);
              if (fileStat.size > MAX_FILE_SIZE_SEARCH || fileStat.size === 0) continue;
              const content = await fsp.readFile(fullPath, 'utf8');
              const idx = content.toLowerCase().indexOf(searchLower);
              if (idx !== -1) {
                results.push({
                  projectId: projId,
                  projectTitle,
                  type: 'file',
                  path: relPath,
                  match: content.substring(idx, idx + 100),
                  context: extractContext(content, idx, ''),
                  timestamp: fileStat.mtimeMs || createdAt
                });
              }
            } catch { /* Lese-Fehler → überspringen */ }
          }
        }
      }
      await searchDir(projDir, '');
    }
  }

  // Alle Projekte parallel durchsuchen
  const searchPromise = Promise.all(projDirs.map(id => searchProject(id)));
  await Promise.race([searchPromise, timeoutPromise]);

  // Ergebnisse auf MAX_RESULTS begrenzen und sortieren (neueste zuerst)
  results = results.slice(0, MAX_RESULTS);
  results.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

  res.json(results);
});

// ── Performance API ──────────────────────────────────────────

// Cache fuer Performance-Daten (30s TTL)
let performanceCache = { data: null, timestamp: 0 };
const PERFORMANCE_CACHE_TTL = 30 * 1000;

async function computePerformanceData() {
  const dir = path.join(__dirname, 'projects');
  const empty = {
    avgAgentDuration: 0,
    tokenTrend: [],
    successRate: { completed: 0, failed: 0, partial: 0, total: 0, rate: 0 },
    avgQuestionsPerAgent: 0,
    fastestAgent: null,
    slowestAgent: null,
    totalRuntime: 0,
    projectCount: 0
  };

  try { await fsp.access(dir); } catch { return empty; }

  const entries = await fsp.readdir(dir);
  const projectDirs = entries.filter(d => d.startsWith('proj_'));
  if (projectDirs.length === 0) return empty;

  const states = (await Promise.all(projectDirs.map(async (d) => {
    try {
      const state = JSON.parse(await fsp.readFile(path.join(dir, d, 'state.json'), 'utf8'));
      state._dirName = d;
      return state;
    } catch { return null; }
  }))).filter(Boolean);

  if (states.length === 0) return empty;

  let totalAgentDuration = 0, agentDurationCount = 0;
  let totalQuestions = 0, totalAgentCount = 0;
  let completedProjects = 0, failedProjects = 0, partialProjects = 0;
  let totalRuntime = 0;
  let fastestAgent = null, slowestAgent = null;
  const tokenTrend = [];

  for (const state of states) {
    if (state.phase === 'complete') completedProjects++;
    else if (state.phase === 'error') failedProjects++;
    else if (state.phase === 'partial') partialProjects++;

    if (state.totalDuration) totalRuntime += state.totalDuration;

    const agents = state.agents || [];
    totalAgentCount += agents.length;

    let projectTokens = 0;
    for (const agent of agents) {
      if (agent.duration) {
        totalAgentDuration += agent.duration;
        agentDurationCount++;

        if (!fastestAgent || agent.duration < fastestAgent.duration) {
          fastestAgent = { title: agent.title || 'Unbenannt', duration: agent.duration, project: state.projectTitle || state._dirName };
        }
        if (!slowestAgent || agent.duration > slowestAgent.duration) {
          slowestAgent = { title: agent.title || 'Unbenannt', duration: agent.duration, project: state.projectTitle || state._dirName };
        }
      }
      totalQuestions += agent.questions || 0;
      if (agent.tokenUsage) {
        projectTokens += agent.tokenUsage.totalTokens || 0;
      }
    }

    const ts = parseInt(state._dirName.replace('proj_', '')) || 0;
    tokenTrend.push({
      project: state.projectTitle || state._dirName,
      timestamp: ts,
      tokens: projectTokens,
      agents: agents.length
    });
  }

  tokenTrend.sort((a, b) => a.timestamp - b.timestamp);

  const totalProjects = states.length;
  return {
    avgAgentDuration: agentDurationCount > 0 ? Math.round(totalAgentDuration / agentDurationCount) : 0,
    tokenTrend: tokenTrend.slice(-20),
    successRate: {
      completed: completedProjects,
      failed: failedProjects,
      partial: partialProjects,
      total: totalProjects,
      rate: totalProjects > 0 ? Math.round((completedProjects / totalProjects) * 100) : 0
    },
    avgQuestionsPerAgent: totalAgentCount > 0 ? Math.round((totalQuestions / totalAgentCount) * 100) / 100 : 0,
    fastestAgent,
    slowestAgent,
    totalRuntime,
    projectCount: totalProjects
  };
}

// GET /api/performance - Aggregierte Performance-Daten
app.get('/api/performance', apiReadLimiter, async (req, res) => {
  const now = Date.now();
  if (performanceCache.data && (now - performanceCache.timestamp) < PERFORMANCE_CACHE_TTL) {
    return res.json(performanceCache.data);
  }
  try {
    const data = await computePerformanceData();
    performanceCache = { data, timestamp: now };
    res.json(data);
  } catch (e) {
    logger.error('Performance-Daten Fehler', { error: e.message });
    res.status(500).json({ error: 'Performance-Daten konnten nicht berechnet werden' });
  }
});

// GET /api/performance/history - Historische Performance-Daten
app.get('/api/performance/history', apiReadLimiter, async (req, res) => {
  const dir = path.join(__dirname, 'projects');
  try { await fsp.access(dir); } catch {
    return res.json([]);
  }

  try {
    const entries = await fsp.readdir(dir);
    const projectDirs = entries.filter(d => d.startsWith('proj_'));

    const history = (await Promise.all(projectDirs.map(async (d) => {
      try {
        const state = JSON.parse(await fsp.readFile(path.join(dir, d, 'state.json'), 'utf8'));
        const agents = state.agents || [];
        const totalTokens = agents.reduce((sum, a) => sum + ((a.tokenUsage && a.tokenUsage.totalTokens) || 0), 0);
        const coordTokens = (state.coordinator && state.coordinator.tokenUsage && state.coordinator.tokenUsage.totalTokens) || 0;
        const totalQuestions = agents.reduce((sum, a) => sum + (a.questions || 0), 0);
        const completedAgents = agents.filter(a => a.status === 'done').length;
        const failedAgents = agents.filter(a => a.status === 'error').length;

        return {
          id: d,
          title: state.projectTitle || d,
          phase: state.phase || 'unknown',
          agentCount: agents.length,
          completedAgents,
          failedAgents,
          totalDuration: state.totalDuration || 0,
          totalTokens: totalTokens + coordTokens,
          estimatedCost: (state.totalTokenUsage && state.totalTokenUsage.estimatedCost) || 0,
          totalQuestions,
          score: state.projectScore || null,
          createdAt: parseInt(d.replace('proj_', '')) || 0
        };
      } catch { return null; }
    }))).filter(Boolean);

    history.sort((a, b) => b.createdAt - a.createdAt);
    res.json(history.slice(0, 20));
  } catch (e) {
    logger.error('Performance-History Fehler', { error: e.message });
    res.status(500).json({ error: 'Performance-History konnte nicht gelesen werden' });
  }
});

// GET /api/performance/agents - Agent-Level Performance-Vergleich
app.get('/api/performance/agents', apiReadLimiter, async (req, res) => {
  const dir = path.join(__dirname, 'projects');
  try { await fsp.access(dir); } catch {
    return res.json([]);
  }

  try {
    const entries = await fsp.readdir(dir);
    const projectDirs = entries.filter(d => d.startsWith('proj_'));

    const agentStats = [];

    await Promise.all(projectDirs.slice(-10).map(async (d) => {
      try {
        const state = JSON.parse(await fsp.readFile(path.join(dir, d, 'state.json'), 'utf8'));
        const agents = state.agents || [];
        agents.forEach((agent, i) => {
          agentStats.push({
            project: state.projectTitle || d,
            projectId: d,
            index: i,
            title: agent.title || ('Agent ' + (i + 1)),
            status: agent.status || 'unknown',
            duration: agent.duration || 0,
            rounds: agent.rounds || 0,
            questions: agent.questions || 0,
            tokens: (agent.tokenUsage && agent.tokenUsage.totalTokens) || 0,
            inputTokens: (agent.tokenUsage && agent.tokenUsage.inputTokens) || 0,
            outputTokens: (agent.tokenUsage && agent.tokenUsage.outputTokens) || 0,
            estimatedCost: (agent.tokenUsage && agent.tokenUsage.estimatedCost) || 0,
            score: agent.score || null,
            filesCreated: (agent.stats && agent.stats.filesCreated) || 0,
            linesOfCode: (agent.stats && agent.stats.linesOfCode) || 0
          });
        });
      } catch (e) { logger.debug('Agent-Performance nicht lesbar', { project: d, error: e.message }); }
    }));

    res.json(agentStats);
  } catch (e) {
    logger.error('Performance-Agents Fehler', { error: e.message });
    res.status(500).json({ error: 'Agent-Performance konnte nicht gelesen werden' });
  }
});

// GET /api/performance/realtime - Aktuelle Echtzeit-Metriken
app.get('/api/performance/realtime', apiReadLimiter, (req, res) => {
  const state = orchestrator.getState();
  const agents = state.agents || [];
  const activeAgents = agents.filter(a => a.status === 'working' || a.status === 'asking');
  const completedAgents = agents.filter(a => a.status === 'done');
  const failedAgents = agents.filter(a => a.status === 'error');

  const totalTokens = agents.reduce((sum, a) => sum + ((a.tokenUsage && a.tokenUsage.totalTokens) || 0), 0);
  const coordTokens = (state.coordinator && state.coordinator.tokenUsage && state.coordinator.tokenUsage.totalTokens) || 0;
  const allTokens = totalTokens + coordTokens;

  // Token/Sekunde berechnen
  const elapsedSec = state.startedAt ? Math.max(1, (Date.now() - state.startedAt) / 1000) : 1;
  const tokensPerSecond = state.phase === 'running' ? Math.round(allTokens / elapsedSec) : 0;

  // Geschaetzte Restkosten
  const progress = agents.length > 0
    ? agents.reduce((sum, a) => sum + (a.progress || 0), 0) / agents.length
    : 0;
  const currentCost = (state.totalTokenUsage && state.totalTokenUsage.estimatedCost) || 0;
  const estimatedTotalCost = progress > 0 ? currentCost / (progress / 100) : currentCost;
  const estimatedRemainingCost = Math.max(0, estimatedTotalCost - currentCost);

  res.json({
    phase: state.phase,
    activeAgents: activeAgents.map(a => ({
      title: a.title || 'Agent',
      status: a.status,
      progress: a.progress || 0,
      rounds: a.rounds || 0,
      tokens: (a.tokenUsage && a.tokenUsage.totalTokens) || 0
    })),
    completedCount: completedAgents.length,
    failedCount: failedAgents.length,
    totalAgents: agents.length,
    tokensPerSecond,
    totalTokens: allTokens,
    currentCost,
    estimatedRemainingCost: Math.round(estimatedRemainingCost * 10000) / 10000,
    estimatedTotalCost: Math.round(estimatedTotalCost * 10000) / 10000,
    elapsedMs: state.startedAt ? Date.now() - state.startedAt : 0,
    progress: Math.round(progress)
  });
});

// ── API-Dokumentation ─────────────────────────────────────────
const { generateApiDocs, generateMarkdown, generateOpenApiSpec } = require('./src/api-docs');
const swaggerUi = require('swagger-ui-express');

app.use('/api/docs/ui', swaggerUi.serve, swaggerUi.setup(null, { swaggerUrl: '/api/docs/openapi' }));

app.get('/api/docs/json', (req, res) => {
  res.json(generateApiDocs());
});

app.get('/api/docs/openapi', (req, res) => {
  res.json(generateOpenApiSpec());
});

app.get('/api/docs/markdown', (req, res) => {
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.send(generateMarkdown());
});

app.get('/api/docs', (req, res) => {
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

// GET /api/i18n – verfügbare Sprachen
app.get('/api/i18n', apiReadLimiter, (req, res) => {
  const config = orchestrator.getConfig();
  res.json({
    languages: LANGUAGES,
    current: config.language,
    default: 'de',
  });
});

// GET /api/i18n/:lang – alle Übersetzungen für eine Sprache
app.get('/api/i18n/:lang', apiReadLimiter, (req, res) => {
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
      // Nur als Hinweis in Header setzen, nicht automatisch Config ändern
      res.setHeader('X-Detected-Language', detected);
    }
  }
  next();
});

// ── Batch-Operations API ─────────────────────────────────────
const BatchProcessor = require('./src/batch-processor');
const batchProcessor = new BatchProcessor(20, 30000);

/**
 * Simuliert einen internen HTTP-Request gegen die Express-App.
 * Erstellt mock req/res Objekte die durch das Express-Routing laufen.
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

// POST /api/batch – Batch-Request verarbeiten
app.post('/api/batch', apiLimiter, async (req, res) => {
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
    logger.error('Batch-Verarbeitung fehlgeschlagen', { error: err.message });
    res.status(500).json({ error: 'Batch-Verarbeitung fehlgeschlagen', details: err.message });
  }
});

// GET /api/batch/stats – Batch-Statistiken
app.get('/api/batch/stats', apiReadLimiter, (req, res) => {
  res.json(batchProcessor.getBatchStats());
});

// GET /api/batch/blocked – Liste der blockierten Endpoints
app.get('/api/batch/blocked', apiReadLimiter, (req, res) => {
  res.json({ blocked: batchProcessor.blockedEndpoints });
});

// ── Erweiterte Log-Suche (Full-Text-Search) ─────────────────
const LogSearchEngine = require('./src/log-search');
const logSearchEngine = new LogSearchEngine();

// GET /api/search/full → Erweiterte Suche
app.get('/api/search/full', apiReadLimiter, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ results: [], total: 0, query: '' });

  const options = {
    projectId: req.query.projectId || null,
    agentId: req.query.agentId || null,
    dateFrom: req.query.dateFrom || null,
    dateTo: req.query.dateTo || null,
    type: req.query.type || 'all',
    limit: Math.min(parseInt(req.query.limit) || 50, 200),
    offset: parseInt(req.query.offset) || 0,
    highlight: req.query.highlight === 'true' || req.query.highlight === '1'
  };

  // Validierung type
  if (!['conversation', 'log', 'all'].includes(options.type)) {
    return res.status(400).json({ error: 'Ungültiger type. Erlaubt: conversation, log, all' });
  }

  try {
    const result = logSearchEngine.search(q, options);
    res.json(result);
  } catch (e) {
    logger.error('Erweiterte Suche fehlgeschlagen', { error: e.message });
    res.status(500).json({ error: 'Suchfehler: ' + e.message });
  }
});

// GET /api/search/logs → Suche nur in System-Logs
app.get('/api/search/logs', apiReadLimiter, (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ results: [], total: 0, query: '' });

  const options = {
    limit: Math.min(parseInt(req.query.limit) || 50, 200),
    offset: parseInt(req.query.offset) || 0,
    highlight: req.query.highlight === 'true' || req.query.highlight === '1',
    dateFrom: req.query.dateFrom || null,
    dateTo: req.query.dateTo || null
  };

  try {
    const result = logSearchEngine.searchLogs(q, options);
    res.json(result);
  } catch (e) {
    logger.error('Log-Suche fehlgeschlagen', { error: e.message });
    res.status(500).json({ error: 'Suchfehler: ' + e.message });
  }
});

// GET /api/search/stats → Suchindex-Statistiken
app.get('/api/search/stats', apiReadLimiter, (req, res) => {
  try {
    res.json(logSearchEngine.getSearchStats());
  } catch (e) {
    res.status(500).json({ error: 'Statistik-Fehler: ' + e.message });
  }
});

// POST /api/search/reindex → Index neu aufbauen
app.post('/api/search/reindex', apiLimiter, async (req, res) => {
  try {
    logSearchEngine.clearIndex();
    const projectsDir = path.join(__dirname, 'projects');
    let entries;
    try { entries = await fsp.readdir(projectsDir); } catch { entries = []; }
    const projDirs = entries.filter(d => d.startsWith('proj_'));

    let indexed = 0;
    for (const projId of projDirs) {
      await logSearchEngine.indexProject(projId, path.join(projectsDir, projId));
      indexed++;
    }

    res.json({
      success: true,
      indexed,
      stats: logSearchEngine.getSearchStats()
    });
  } catch (e) {
    logger.error('Reindex fehlgeschlagen', { error: e.message });
    res.status(500).json({ error: 'Reindex-Fehler: ' + e.message });
  }
});

// GET /api/search/suggest → Auto-Suggest basierend auf häufigen Begriffen
app.get('/api/search/suggest', apiReadLimiter, (req, res) => {
  const prefix = (req.query.q || '').trim();
  if (!prefix) return res.json([]);

  try {
    const suggestions = logSearchEngine.getSuggestions(prefix, 10);
    res.json(suggestions);
  } catch (e) {
    res.status(500).json({ error: 'Suggest-Fehler: ' + e.message });
  }
});

// ── Server starten ───────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log('');
  console.log('  ╔════════════════════════════════════════╗');
  console.log('  ║  Claude Multi-Agent Orchestrator v4.0  ║');
  console.log('  ╚════════════════════════════════════════╝');
  console.log('');
  console.log(`  Server:   http://localhost:${PORT}`);
  console.log(`  WS:       ws://localhost:${PORT}/ws`);
  console.log(`  Node:     ${process.version}`);
  console.log(`  Projekte: ${path.join(__dirname, 'projects')}`);
  console.log('');
  logger.info('Server gestartet', {
    port: PORT,
    ws: true,
    node: process.version,
    projectDir: path.join(__dirname, 'projects'),
    url: `http://localhost:${PORT}`,
    wsUrl: `ws://localhost:${PORT}/ws`
  });
});

// ── WebSocket Upgrade-Handler ─────────────────────────────────
server.on('upgrade', (request, socket, head) => {
  const { pathname } = new URL(request.url, `http://${request.headers.host}`);
  if (pathname === '/ws') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

// ── Graceful Shutdown ────────────────────────────────────────
function gracefulShutdown(signal) {
  logger.info('Shutdown eingeleitet', { signal });
  // State sichern + Checkpoint erstellen
  try {
    if (orchestrator.phase === 'running' || orchestrator.phase === 'awaiting_approval') {
      // Checkpoint synchron erstellen fuer Crash-Recovery
      if (orchestrator.projectDir) {
        try {
          const json = JSON.stringify({
            ...orchestrator.getState(),
            _checkpoint: {
              reason: 'shutdown_' + signal,
              createdAt: Date.now(),
              createdAtISO: new Date().toISOString(),
              projectDir: orchestrator.projectDir,
              projectDesc: orchestrator.projectDesc,
            }
          }, null, 2);
          fs.writeFileSync(path.join(orchestrator.projectDir, 'state.checkpoint.1.json'), json);
          logger.info('Shutdown-Checkpoint erstellt', { signal });
        } catch (e) {
          logger.error('Shutdown-Checkpoint fehlgeschlagen', { error: e.message });
        }
      }
      orchestrator._abortController.abort();
      for (const proc of orchestrator._activeProcesses) {
        try { proc.kill('SIGTERM'); } catch { /* best-effort, Prozess evtl. bereits beendet */ }
      }
      orchestrator._activeProcesses.clear();
    }
    orchestrator._saveStateImmediate().catch(() => {});
  } catch { /* best-effort, Shutdown darf nicht fehlschlagen */ }
  // SSE-Clients schliessen
  for (const [, client] of clients) {
    try { client.res.end(); } catch { /* best-effort, Client evtl. bereits getrennt */ }
  }
  clients.clear();
  // WebSocket-Clients schliessen
  clearInterval(sseHeartbeatInterval);
  clearInterval(sseIdleCheckInterval);
  clearInterval(wsHeartbeat);
  wss.close();
  for (const ws of wsClients) {
    try { ws.close(1001, 'Server wird heruntergefahren'); } catch { /* best-effort */ }
  }
  wsClients.clear();
  if (batchTimer) { clearTimeout(batchTimer); batchTimer = null; }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ── Export fuer Tests ────────────────────────────────────────
module.exports = { server, wss, cleanup: () => {
  clearInterval(sseHeartbeatInterval);
  clearInterval(sseIdleCheckInterval);
  clearInterval(wsHeartbeat);
  if (batchTimer) { clearTimeout(batchTimer); batchTimer = null; }
  for (const [, client] of clients) {
    try { client.res.end(); } catch { /* best-effort */ }
  }
  clients.clear();
  wss.close();
  for (const ws of wsClients) {
    try { ws.close(1001, 'Test-Cleanup'); } catch { /* best-effort */ }
  }
  wsClients.clear();
  return new Promise(resolve => server.close(resolve));
}};
