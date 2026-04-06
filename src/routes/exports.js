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

  // ── PDF (druckfreundliches HTML) Export ─────────────────────────
  router.get('/export-pdf/:id', exportLimiter, async (req, res) => {
    const id = req.params.id;
    const loaded = await loadProjectState(id);
    if (!loaded) return res.status(404).json({ error: 'Projekt nicht gefunden' });
    const { state } = loaded;

    const statusLabels = {
      done: 'Fertig', error: 'Fehler', working: 'In Arbeit',
      waiting: 'Wartend', asking: 'Fragt Koordinator'
    };

    function esc(s) {
      return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    function fmtDur(seconds) {
      if (!seconds) return 'k.A.';
      if (seconds < 60) return seconds + 's';
      return Math.floor(seconds / 60) + 'min ' + (seconds % 60) + 's';
    }

    const title = esc(state.projectTitle || 'Projekt');
    const summary = esc(state.projectSummary || (state.coordinator && state.coordinator.summary) || '');
    const created = state.startedAt ? new Date(state.startedAt).toLocaleString('de-DE') : 'k.A.';
    const duration = fmtDur(state.totalDuration);

    // Token-Verbrauch
    const tokens = state.totalTokens || state.tokenUsage || {};
    const inputTokens = tokens.input || tokens.inputTokens || 0;
    const outputTokens = tokens.output || tokens.outputTokens || 0;
    const totalTokens = inputTokens + outputTokens;

    let agentRows = '';
    for (let i = 0; i < (state.agents || []).length; i++) {
      const a = state.agents[i];
      const score = (a.score && a.score.overall != null) ? a.score.overall + '/100' : 'k.A.';
      const st = statusLabels[a.status] || a.status || 'k.A.';
      const statusClass = a.status === 'done' ? 'status-done' : (a.status === 'error' ? 'status-error' : '');
      agentRows += '<tr>' +
        '<td>' + (i + 1) + '</td>' +
        '<td>' + esc(a.title || 'Agent ' + (i + 1)) + '</td>' +
        '<td>' + esc(a.role || 'k.A.') + '</td>' +
        '<td class="' + statusClass + '">' + esc(st) + '</td>' +
        '<td>' + esc(score) + '</td>' +
        '<td>' + esc(fmtDur(a.duration)) + '</td>' +
        '</tr>';
    }

    const html = `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #1a1a1a; max-width: 800px; margin: 0 auto; padding: 24px; }
  h1 { font-size: 1.6em; margin-bottom: 8px; }
  .summary { color: #444; margin-bottom: 16px; line-height: 1.5; }
  .meta { display: flex; gap: 24px; margin-bottom: 20px; font-size: 0.9em; color: #555; }
  .meta span { background: #f0f0f0; padding: 4px 10px; border-radius: 4px; }
  table { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 0.9em; }
  th, td { padding: 8px 10px; text-align: left; border-bottom: 1px solid #ddd; }
  th { background: #f5f5f5; font-weight: 600; }
  .status-done { color: #16a34a; font-weight: 600; }
  .status-error { color: #dc2626; font-weight: 600; }
  .section { margin-top: 28px; }
  .section h2 { font-size: 1.15em; margin-bottom: 10px; border-bottom: 2px solid #e5e5e5; padding-bottom: 6px; }
  .token-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
  .token-box { background: #f8f8f8; padding: 12px; border-radius: 6px; text-align: center; }
  .token-box .val { font-size: 1.3em; font-weight: 700; }
  .token-box .lbl { font-size: 0.8em; color: #666; margin-top: 2px; }
  .print-btn { position: fixed; top: 16px; right: 16px; padding: 8px 18px; background: #2563eb; color: #fff; border: none; border-radius: 6px; cursor: pointer; font-size: 0.9em; }
  .print-btn:hover { background: #1d4ed8; }
  @media print {
    .print-btn { display: none; }
    body { padding: 0; }
  }
</style>
</head>
<body>
<button class="print-btn" onclick="window.print()">Als PDF drucken</button>
<h1>${title}</h1>
${summary ? '<p class="summary">' + summary + '</p>' : ''}
<div class="meta">
  <span>Erstellt: ${esc(created)}</span>
  <span>Dauer: ${esc(duration)}</span>
  <span>Agenten: ${(state.agents || []).length}</span>
</div>

<div class="section">
  <h2>Token-Verbrauch</h2>
  <div class="token-grid">
    <div class="token-box"><div class="val">${totalTokens.toLocaleString('de-DE')}</div><div class="lbl">Gesamt</div></div>
    <div class="token-box"><div class="val">${inputTokens.toLocaleString('de-DE')}</div><div class="lbl">Input</div></div>
    <div class="token-box"><div class="val">${outputTokens.toLocaleString('de-DE')}</div><div class="lbl">Output</div></div>
  </div>
</div>

<div class="section">
  <h2>Agenten</h2>
  <table>
    <thead><tr><th>#</th><th>Titel</th><th>Rolle</th><th>Status</th><th>Score</th><th>Dauer</th></tr></thead>
    <tbody>${agentRows || '<tr><td colspan="6">Keine Agenten</td></tr>'}</tbody>
  </table>
</div>

<div style="margin-top:32px;font-size:0.75em;color:#999;text-align:center;">
  Claude Multi-Agent Orchestrator &mdash; Exportiert am ${new Date().toLocaleString('de-DE')}
</div>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
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
