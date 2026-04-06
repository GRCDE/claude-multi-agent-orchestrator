'use strict';
const express = require('express');
const path = require('path');
const fsp = require('fs').promises;

const router = express.Router();

// ── Konstanten ───────────────────────────────────────────────
const VALID_INTERVENTION_TYPES = ['redirect', 'skip', 'restart', 'inject', 'complete'];

/**
 * Initialisiert den Agent-Router mit Abhaengigkeiten aus server.js.
 * @param {object} deps - { orchestrator, logger, broadcast, authMiddleware, apiLimiter, apiReadLimiter, startLimiter, getIsStarting, setIsStarting, projectQueue, MAX_QUEUE_SIZE, sortQueueByPriority, broadcastQueueUpdate, validateStartInput, startProject }
 */
function init(deps) {
  const {
    orchestrator, logger, broadcast,
    authMiddleware, apiLimiter, startLimiter,
    getIsStarting, setIsStarting,
    projectQueue, MAX_QUEUE_SIZE,
    sortQueueByPriority, broadcastQueueUpdate,
    validateStartInput, startProject
  } = deps;

  // ── Race-Condition Schutz fuer Resume ─────────────────────
  let isResuming = false;

  // ── Projekt starten (mit Input-Validierung + Race-Condition Fix + Queue) ──
  router.post('/start', authMiddleware, startLimiter, async (req, res) => {
    const { description, agentCount, requireApproval, priority } = req.body;

    // Input-Validierung
    const validationError = validateStartInput(req.body);
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    // Prioritaet validieren (1=hoch, 2=mittel, 3=niedrig)
    const prio = parseInt(priority) || 2;
    const validPrio = [1, 2, 3].includes(prio) ? prio : 2;

    // Wenn bereits ein Projekt laeuft -> in Queue einreihen
    if (getIsStarting() || orchestrator.phase === 'running' || orchestrator.phase === 'awaiting_approval') {
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

    setIsStarting(true);

    try {
      res.json({ ok: true, message: 'Projekt gestartet' });
      startProject(description, agentCount, requireApproval);
    } catch (e) {
      setIsStarting(false);
      logger.error('Start-Fehler', { error: e.message });
      res.status(500).json({ error: e.message });
    }
  });

  // ── Status abfragen ───────────────────────────────────────
  router.get('/status', (req, res) => {
    res.json(orchestrator.getState());
  });

  // ── Projekt zuruecksetzen ─────────────────────────────────
  router.post('/reset', authMiddleware, apiLimiter, (req, res) => {
    orchestrator.reset();
    setIsStarting(false);
    broadcast('state', orchestrator.getState());
    res.json({ ok: true });
  });

  // ── Laufendes Projekt abbrechen (behaelt Teilergebnisse) ──
  router.post('/abort', authMiddleware, apiLimiter, async (req, res) => {
    try {
      await orchestrator.abort();
      broadcast('state', orchestrator.getState());
      res.json({ ok: true, message: 'Projekt abgebrochen' });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // ── Plan Genehmigung ──────────────────────────────────────
  router.post('/approve', authMiddleware, apiLimiter, (req, res) => {
    try {
      orchestrator.approvePlan();
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.post('/modify-plan', authMiddleware, apiLimiter, (req, res) => {
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

  // ── Agent Retry ───────────────────────────────────────────
  router.post('/retry/:agentIndex', authMiddleware, apiLimiter, async (req, res) => {
    const idx = parseInt(req.params.agentIndex);
    if (isNaN(idx) || idx < 0) {
      return res.status(400).json({ error: 'Ungültiger Index' });
    }
    res.json({ ok: true });
    orchestrator.retryAgent(idx).catch(e => broadcast('error', { message: e.message }));
  });

  // ── Agent Intervention ────────────────────────────────────
  router.post('/intervene/:agentIndex', authMiddleware, apiLimiter, (req, res) => {
    const idx = parseInt(req.params.agentIndex);
    if (isNaN(idx) || idx < 0) {
      return res.status(400).json({ error: 'Ungültiger Index' });
    }
    const { message, type } = req.body || {};

    // Typ validieren (Default: redirect fuer Abwaertskompatibilitaet)
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

  // ── Projekt fortsetzen (Resume) ───────────────────────────
  router.post('/resume/:id', authMiddleware, startLimiter, async (req, res) => {
    const id = req.params.id;

    // Projekt-ID Validierung
    if (!id || !id.startsWith('proj_')) {
      return res.status(400).json({ error: 'Ungültige Projekt-ID (muss mit "proj_" beginnen)' });
    }

    // Race-Condition und Lauf-Check
    if (isResuming || getIsStarting() || orchestrator.phase === 'running' || orchestrator.phase === 'awaiting_approval') {
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

  // ── Agent Prompt-Log API (Debugging) ──────────────────────
  router.get('/agent-prompts/:id/:agentIndex', async (req, res) => {
    const id = req.params.id;
    const agentIndex = parseInt(req.params.agentIndex, 10);

    // Validierung
    if (!id || typeof id !== 'string') {
      return res.status(400).json({ error: 'Ungültige Projekt-ID' });
    }
    if (isNaN(agentIndex) || agentIndex < 0) {
      return res.status(400).json({ error: 'Ungültiger Agent-Index' });
    }

    const projectsDir = path.resolve(path.join(__dirname, '..', '..', 'projects'));
    const agentDir = path.resolve(path.join(__dirname, '..', '..', 'projects', id, `agent-${agentIndex + 1}`));
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
}

module.exports = { router, init, VALID_INTERVENTION_TYPES };
