'use strict';
const express = require('express');

const router = express.Router();

/**
 * Initialisiert den Health/Logs/Recovery-Router mit Abhaengigkeiten aus server.js.
 * @param {object} deps - { orchestrator, Orchestrator, logger, authMiddleware, apiLimiter, exportLimiter, logBuffer, exportAllLogs, getLogFiles, clients, wsClients, isStartingFn, setIsStarting, broadcast }
 */
function init(deps) {
  const {
    orchestrator,
    Orchestrator,
    logger,
    authMiddleware,
    apiLimiter,
    exportLimiter,
    logBuffer,
    exportAllLogs,
    getLogFiles,
    clients,
    wsClients,
    isStartingFn,
    setIsStarting,
    broadcast,
  } = deps;

  // ── Health-Check (beide Pfade: /health und /api/health) ─────
  function healthHandler(req, res) {
    const config = orchestrator.getConfig();
    res.json({
      status: 'ok',
      uptime: Math.round(process.uptime()),
      phase: orchestrator.phase,
      memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
      sdk: {
        mode: config.claudeMode || 'cli',
        available: config.sdkAvailable,
        info: config.sdkInfo || {},
      }
    });
  }
  router.get('/health', healthHandler);
  router.get('/api/health', healthHandler);

  // ── Health-Monitor: Erweiterte Endpoints ─────────────────────
  router.get('/api/health/detailed', (req, res) => {
    if (!orchestrator.healthMonitor) {
      return res.status(503).json({ error: 'Health-Monitor nicht verfuegbar' });
    }
    // Verbindungszaehler setzen
    orchestrator.healthMonitor._getConnections = () => ({
      sse: clients.size,
      websocket: wsClients.size,
    });
    const health = orchestrator.healthMonitor.getHealth();
    const config = orchestrator.getConfig();

    // Add SDK info to detailed health response
    health.sdk = {
      mode: config.claudeMode || 'cli',
      available: config.sdkAvailable,
      info: config.sdkInfo || {},
    };

    res.json(health);
  });

  router.get('/api/health/history', (req, res) => {
    if (!orchestrator.healthMonitor) {
      return res.status(503).json({ error: 'Health-Monitor nicht verfuegbar' });
    }
    const minutes = parseInt(req.query.minutes) || 30;
    res.json(orchestrator.healthMonitor.getHealthHistory(minutes));
  });

  router.get('/api/health/diagnostics', (req, res) => {
    if (!orchestrator.healthMonitor) {
      return res.status(503).json({ error: 'Health-Monitor nicht verfuegbar' });
    }
    res.json(orchestrator.healthMonitor.getDiagnostics());
  });

  router.get('/api/health/alerts', (req, res) => {
    if (!orchestrator.healthMonitor) {
      return res.status(503).json({ error: 'Health-Monitor nicht verfuegbar' });
    }
    res.json(orchestrator.healthMonitor.getAlerts());
  });

  router.post('/api/health/alerts/:id/clear', (req, res) => {
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

  router.get('/api/health/thresholds', (req, res) => {
    if (!orchestrator.healthMonitor) {
      return res.status(503).json({ error: 'Health-Monitor nicht verfuegbar' });
    }
    res.json(orchestrator.healthMonitor.getThresholds());
  });

  router.put('/api/health/thresholds', (req, res) => {
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
  router.get('/api/logs', (req, res) => {
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
  router.get('/api/logs/export', exportLimiter, (req, res) => {
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
  router.get('/api/logs/files', (req, res) => {
    try {
      res.json(getLogFiles());
    } catch (e) {
      logger.error('Log-Dateien lesen fehlgeschlagen', { error: e.message });
      res.status(500).json({ error: 'Fehler beim Lesen der Log-Dateien' });
    }
  });

  // ── Crash-Recovery API ────────────────────────────────────────

  // GET /api/recovery - Pruefe ob Crash-Recovery moeglich ist
  router.get('/api/recovery', async (req, res) => {
    try {
      const result = await Orchestrator._detectCrashRecovery();
      res.json(result);
    } catch (e) {
      logger.error('Recovery-Check fehlgeschlagen', { error: e.message });
      res.status(500).json({ hasCrash: false, error: e.message });
    }
  });

  // POST /api/recovery/restore - Stelle aus Checkpoint wieder her
  router.post('/api/recovery/restore', authMiddleware, apiLimiter, async (req, res) => {
    try {
      if (isStartingFn() || orchestrator.phase === 'running' || orchestrator.phase === 'awaiting_approval') {
        return res.status(409).json({ error: 'Es laeuft bereits ein Projekt. Bitte erst abbrechen.' });
      }

      const recovery = await Orchestrator._detectCrashRecovery();
      if (!recovery.hasCrash) {
        return res.status(404).json({ error: 'Kein Checkpoint zur Wiederherstellung gefunden' });
      }

      setIsStarting(true);
      res.json({ ok: true, message: 'Projekt wird aus Checkpoint wiederhergestellt', projectId: recovery.projectId, projectTitle: recovery.projectTitle });

      try {
        await orchestrator.restoreFromCheckpoint(recovery.checkpoint, recovery.projectDir);
      } catch (e) {
        logger.error('Recovery fehlgeschlagen', { error: e.message });
        broadcast('error', { message: 'Recovery fehlgeschlagen: ' + e.message });
      } finally {
        setIsStarting(false);
      }
    } catch (e) {
      setIsStarting(false);
      logger.error('Recovery-Restore fehlgeschlagen', { error: e.message });
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/recovery/discard - Verwerfe Checkpoint und starte frisch
  router.post('/api/recovery/discard', authMiddleware, apiLimiter, async (req, res) => {
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
}

module.exports = { router, init };
