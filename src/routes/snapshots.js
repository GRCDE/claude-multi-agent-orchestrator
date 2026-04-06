'use strict';
const express = require('express');

const router = express.Router();

/**
 * Initialisiert den Snapshot- und Profile-Router mit Abhaengigkeiten aus server.js.
 * @param {object} deps - { orchestrator, logger, authMiddleware, apiLimiter, apiReadLimiter, broadcast }
 */
function init(deps) {
  const { orchestrator, logger, authMiddleware, apiLimiter, apiReadLimiter, broadcast } = deps;

  // ── Config-Profile API ────────────────────────────────────────
  router.get('/profiles', apiReadLimiter, (req, res) => {
    try {
      res.json(orchestrator.getProfiles());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/profiles/:name', apiReadLimiter, (req, res) => {
    try {
      const profile = orchestrator.profileManager.loadProfile(req.params.name);
      res.json(profile);
    } catch (e) {
      res.status(404).json({ error: e.message });
    }
  });

  router.post('/profiles', authMiddleware, apiLimiter, (req, res) => {
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

  router.delete('/profiles/:name', authMiddleware, apiLimiter, (req, res) => {
    try {
      orchestrator.profileManager.deleteProfile(req.params.name);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.post('/profiles/:name/apply', authMiddleware, apiLimiter, (req, res) => {
    try {
      const result = orchestrator.applyProfile(req.params.name);
      res.json(result);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.post('/profiles/save-current', authMiddleware, apiLimiter, (req, res) => {
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

  router.post('/profiles/import', authMiddleware, apiLimiter, (req, res) => {
    try {
      const jsonString = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
      const profile = orchestrator.profileManager.importProfile(jsonString);
      res.status(201).json(profile);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.get('/profiles/:name/export', apiReadLimiter, (req, res) => {
    try {
      const json = orchestrator.profileManager.exportProfile(req.params.name);
      res.setHeader('Content-Type', 'application/json');
      res.send(json);
    } catch (e) {
      res.status(404).json({ error: e.message });
    }
  });

  // ── Snapshot API ─────────────────────────────────────────────

  // GET /api/snapshots – Alle Snapshots (optional ?projectId=X)
  router.get('/snapshots', apiReadLimiter, async (req, res) => {
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
  router.get('/snapshots/:id', apiReadLimiter, async (req, res) => {
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
  router.post('/snapshots', authMiddleware, apiLimiter, async (req, res) => {
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
  router.delete('/snapshots/:id', authMiddleware, apiLimiter, async (req, res) => {
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
  router.post('/snapshots/:id/restore', authMiddleware, apiLimiter, async (req, res) => {
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
  router.get('/snapshots/:id1/compare/:id2', apiReadLimiter, async (req, res) => {
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
  router.get('/snapshots/:id/size', apiReadLimiter, async (req, res) => {
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
}

module.exports = { router, init };
