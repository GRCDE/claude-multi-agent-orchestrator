'use strict';
const express = require('express');
const path = require('path');
const fsp = require('fs').promises;
const TemplateManager = require('../template-manager');

const router = express.Router();

// ── Konstanten ───────────────────────────────────────────────
const TEMPLATES_FILE = path.join(__dirname, '..', '..', 'templates.json');

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

const templateManager = new TemplateManager();

/**
 * Initialisiert den Templates-Router mit Abhaengigkeiten aus server.js.
 * @param {object} deps - { orchestrator, logger, authMiddleware, apiLimiter, apiReadLimiter, exportLimiter, startLimiter, isStarting, projectQueue, MAX_QUEUE_SIZE, sortQueueByPriority, broadcastQueueUpdate, startProject }
 */
function init(deps) {
  const { logger, authMiddleware, apiLimiter, apiReadLimiter, exportLimiter, startLimiter } = deps;

  // ── Templates CRUD (JSON-Datei basiert) ────────────────────

  // GET /api/templates - Alle Templates laden
  router.get('/templates', async (req, res) => {
    try {
      const data = await loadTemplatesFile();
      res.json(data);
    } catch (e) {
      logger.error('Templates laden fehlgeschlagen', { error: e.message });
      res.status(500).json({ error: 'Templates konnten nicht geladen werden' });
    }
  });

  // GET /api/tags - Alle einzigartigen Tags aus Templates aggregieren
  router.get('/tags', async (req, res) => {
    try {
      const data = await loadTemplatesFile();
      const tagSet = new Set();
      for (const t of data.templates) {
        if (Array.isArray(t.tags)) {
          for (const tag of t.tags) {
            if (typeof tag === 'string' && tag.trim()) tagSet.add(tag.trim());
          }
        }
      }
      res.json({ tags: Array.from(tagSet).sort() });
    } catch (e) {
      logger.error('Tags laden fehlgeschlagen', { error: e.message });
      res.status(500).json({ error: 'Tags konnten nicht geladen werden' });
    }
  });

  // POST /api/templates - Neues Template erstellen
  router.post('/templates', authMiddleware, apiLimiter, async (req, res) => {
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
  router.put('/templates/:id', authMiddleware, apiLimiter, async (req, res) => {
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
  router.delete('/templates/:id', authMiddleware, apiLimiter, async (req, res) => {
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
  router.post('/templates/import', authMiddleware, apiLimiter, async (req, res) => {
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
  router.get('/templates/export', exportLimiter, async (req, res) => {
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

  // GET /api/templates/managed - Alle verwalteten Templates (aus templates/ Verzeichnis)
  router.get('/templates/managed', apiReadLimiter, async (req, res) => {
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
  router.get('/templates/managed/:id', apiReadLimiter, async (req, res) => {
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
  router.post('/templates/managed', authMiddleware, apiLimiter, async (req, res) => {
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
  router.put('/templates/managed/:id', authMiddleware, apiLimiter, async (req, res) => {
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
  router.delete('/templates/managed/:id', authMiddleware, apiLimiter, async (req, res) => {
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
  router.post('/templates/managed/:id/duplicate', authMiddleware, apiLimiter, async (req, res) => {
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
  router.post('/templates/managed/:id/rate', authMiddleware, apiLimiter, async (req, res) => {
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
  router.post('/templates/managed/import', authMiddleware, apiLimiter, async (req, res) => {
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
  router.get('/templates/managed/:id/export', exportLimiter, async (req, res) => {
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
  router.post('/templates/managed/:id/apply', authMiddleware, startLimiter, async (req, res) => {
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
      const { isStarting, orchestrator, projectQueue, MAX_QUEUE_SIZE, sortQueueByPriority, broadcastQueueUpdate, startProject } = deps;
      if ((typeof isStarting === 'function' ? isStarting() : isStarting) || orchestrator.phase === 'running' || orchestrator.phase === 'awaiting_approval') {
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
}

module.exports = { router, init, loadTemplatesFile, saveTemplatesFile, templateManager };
