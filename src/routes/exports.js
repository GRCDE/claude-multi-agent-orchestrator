'use strict';
const express = require('express');
const path = require('path');
const fsp = require('fs').promises;
const archiver = require('archiver');

const router = express.Router();

// ── Export Helpers (async) ─────────────────────────────────
async function loadProjectState(id) {
  const projectDir = path.join(__dirname, '..', '..', 'projects', id);
  if (!projectDir.startsWith(path.join(__dirname, '..', '..', 'projects'))) return null;
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

/**
 * Initialisiert den Export-Router mit Abhaengigkeiten aus server.js.
 * @param {object} deps - { orchestrator, logger, authMiddleware, apiLimiter, exportLimiter }
 */
function init(deps) {
  const { orchestrator, logger, authMiddleware, apiLimiter, exportLimiter } = deps;

  // ── ZIP Export ───────────────────────────────────────────
  router.get('/export/:id', exportLimiter, async (req, res) => {
    const dir = path.join(__dirname, '..', '..', 'projects', req.params.id);
    // Pfad-Traversal verhindern
    if (!dir.startsWith(path.join(__dirname, '..', '..', 'projects'))) {
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
  router.get('/export-json/:id', exportLimiter, async (req, res) => {
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
  router.get('/export-markdown/:id', exportLimiter, async (req, res) => {
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

  // ── Zusammengefuehrte Dateien ──────────────────────────────────
  router.get('/merged/:id', async (req, res) => {
    const dir = path.join(__dirname, '..', '..', 'projects', req.params.id, 'merged');
    // Pfad-Traversal verhindern
    if (!dir.startsWith(path.join(__dirname, '..', '..', 'projects'))) {
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
  router.post('/merge/:id', authMiddleware, apiLimiter, async (req, res) => {
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
}

module.exports = { router, init, loadProjectState, listAgentFilesAsync, readConversationAsync };
