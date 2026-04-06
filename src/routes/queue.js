'use strict';
const express = require('express');
const path = require('path');
const fsp = require('fs').promises;

const router = express.Router();

// ── Konstanten ───────────────────────────────────────────────
const MILESTONES_FILE = path.join(__dirname, '..', '..', 'milestones.json');
const MAX_QUEUE_SIZE = 10;

// ── Queue-Zustand (wird von server.js mitbenutzt) ───────────
const projectQueue = [];

// Durchschnittliche Projektdauer tracken (fuer geschaetzte Wartezeit)
const completedProjectDurations = []; // Array von Millisekunden
const MAX_TRACKED_DURATIONS = 20;

function getAverageProjectDuration() {
  if (completedProjectDurations.length === 0) return 5 * 60 * 1000; // Default: 5 Min
  const sum = completedProjectDurations.reduce((a, b) => a + b, 0);
  return Math.round(sum / completedProjectDurations.length);
}

function sortQueueByPriority() {
  projectQueue.sort((a, b) => (a.priority || 2) - (b.priority || 2));
}

// broadcastQueueUpdate wird in init() gesetzt (braucht broadcast-Referenz)
let _broadcast = null;

function broadcastQueueUpdate() {
  if (!_broadcast) return;
  const avgDuration = getAverageProjectDuration();
  _broadcast('queue_updated', {
    length: projectQueue.length,
    items: projectQueue.map((item, i) => ({
      ...item,
      position: i + 1,
      estimatedWaitTime: avgDuration * (i + 1)
    }))
  });
}

// Input-Validierung fuer Projektstart (wiederverwendbar fuer Queue + Start)
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

/**
 * Initialisiert den Queue- und Meilenstein-Router mit Abhaengigkeiten aus server.js.
 * @param {object} deps - { orchestrator, logger, authMiddleware, apiLimiter, apiReadLimiter, startLimiter, broadcast, getIsStarting, setIsStarting, startProject }
 */
function init(deps) {
  const { orchestrator, logger, authMiddleware, apiLimiter, apiReadLimiter, startLimiter, broadcast, getIsStarting, setIsStarting, startProject } = deps;
  _broadcast = broadcast;

  // ── Queue API ────────────────────────────────────────────────

  // Warteschlange anzeigen (mit Statistiken)
  router.get('/queue', (req, res) => {
    const avgDuration = getAverageProjectDuration();
    res.json(projectQueue.map((item, i) => ({
      ...item,
      position: i + 1,
      estimatedWaitTime: avgDuration * (i + 1)
    })));
  });

  // Einzelnes Element aus Warteschlange entfernen
  router.delete('/queue/:index', authMiddleware, apiLimiter, (req, res) => {
    const index = parseInt(req.params.index);
    if (isNaN(index) || index < 0 || index >= projectQueue.length) {
      return res.status(400).json({ error: 'Ung\u00fcltiger Index' });
    }
    const removed = projectQueue.splice(index, 1)[0];
    broadcastQueueUpdate();
    res.json({ ok: true, removed });
  });

  // Queue-Reihenfolge aendern (Drag & Drop)
  router.post('/queue/reorder', authMiddleware, apiLimiter, (req, res) => {
    const { from, to } = req.body;
    const fromIdx = parseInt(from);
    const toIdx = parseInt(to);
    if (isNaN(fromIdx) || isNaN(toIdx) ||
        fromIdx < 0 || fromIdx >= projectQueue.length ||
        toIdx < 0 || toIdx >= projectQueue.length ||
        fromIdx === toIdx) {
      return res.status(400).json({ error: 'Ung\u00fcltige Indizes' });
    }
    const [item] = projectQueue.splice(fromIdx, 1);
    projectQueue.splice(toIdx, 0, item);
    broadcastQueueUpdate();
    res.json({ ok: true, queue: projectQueue.map((item, i) => ({ ...item, position: i + 1 })) });
  });

  // Gesamte Warteschlange leeren
  router.post('/queue/clear', authMiddleware, apiLimiter, (req, res) => {
    const count = projectQueue.length;
    projectQueue.length = 0;
    broadcastQueueUpdate();
    res.json({ ok: true, cleared: count });
  });

  // ── Meilenstein API ──────────────────────────────────────────

  // Meilensteine laden
  router.get('/milestones', async (req, res) => {
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
  router.post('/milestones', authMiddleware, apiLimiter, async (req, res) => {
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
  router.post('/start-milestone', authMiddleware, startLimiter, async (req, res) => {
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

    if (getIsStarting() || orchestrator.phase === 'running' || orchestrator.phase === 'awaiting_approval') {
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

    setIsStarting(true);
    try {
      res.json({ ok: true, message: 'Meilenstein-Projekt gestartet: ' + milestone.title });
      startProject(description, agentCount, false);
    } catch (e) {
      setIsStarting(false);
      logger.error('Meilenstein-Start-Fehler', { error: e.message });
      res.status(500).json({ error: e.message });
    }
  });

  // ── Auto-Dequeue: wenn Projekt fertig, naechstes aus Queue starten ──
  let _queueDequeueDelay = 3000;
  orchestrator.on('phase', (data) => {
    const phase = data.phase;
    if (phase === 'complete' || phase === 'error' || phase === 'partial') {
      // Projektdauer tracken (nur bei Erfolg/Teilerfolg)
      if (router._currentProjectStartedAt && (phase === 'complete' || phase === 'partial')) {
        const duration = Date.now() - router._currentProjectStartedAt;
        completedProjectDurations.push(duration);
        if (completedProjectDurations.length > MAX_TRACKED_DURATIONS) {
          completedProjectDurations.shift();
        }
      }
      router._currentProjectStartedAt = null;
      // Bei Fehler: Delay erhoehen (max 60s), bei Erfolg: zuruecksetzen
      if (phase === 'error') {
        _queueDequeueDelay = Math.min(_queueDequeueDelay * 2, 60000);
      } else {
        _queueDequeueDelay = 3000;
      }
      if (projectQueue.length > 0) {
        setTimeout(() => {
          if (getIsStarting() || orchestrator.phase === 'running' || orchestrator.phase === 'awaiting_approval') return;
          const next = projectQueue.shift();
          broadcastQueueUpdate();
          if (next) {
            logger.info('N\u00e4chstes Projekt aus Queue gestartet', { description: next.description.slice(0, 50) });
            startProject(next.description, next.agentCount, next.requireApproval, { tags: next.tags || [] });
          }
        }, _queueDequeueDelay);
      }
    }
  });
}

// _currentProjectStartedAt wird von server.js gesetzt/gelesen
router._currentProjectStartedAt = null;

module.exports = {
  router,
  init,
  projectQueue,
  MAX_QUEUE_SIZE,
  sortQueueByPriority,
  broadcastQueueUpdate,
  getAverageProjectDuration,
  validateStartInput,
  completedProjectDurations,
  MAX_TRACKED_DURATIONS
};
