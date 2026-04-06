'use strict';
const express = require('express');
const path = require('path');
const fsp = require('fs').promises;

const router = express.Router();

// ── Hilfsfunktionen ─────────────────────────────────────────

const PROJECTS_DIR = path.join(__dirname, '..', '..', 'projects');

async function loadProjectState(id) {
  const projectDir = path.join(PROJECTS_DIR, id);
  if (!projectDir.startsWith(PROJECTS_DIR)) return null;
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

/**
 * Initialisiert den Projects-Router mit Abhaengigkeiten aus server.js.
 * @param {object} deps - { orchestrator, logger, broadcast, authMiddleware, apiLimiter, apiReadLimiter }
 */
function init(deps) {
  const { orchestrator, logger, broadcast, authMiddleware, apiLimiter, apiReadLimiter } = deps;

  // ── GET /api/projects ───────────────────────────────────────
  router.get('/projects', async (req, res) => {
    const dir = PROJECTS_DIR;
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
          totalTokenUsage: state?.totalTokenUsage || null,
          tags: state?.tags || [],
          archived: state?.archived || false
        };
      }));

      // Archivierte standardmaessig ausblenden
      const includeArchived = req.query.includeArchived === 'true';
      const filtered = includeArchived ? projects : projects.filter(p => !p.archived);

      filtered.sort((a, b) => b.createdAt - a.createdAt);
      res.json(filtered);
    } catch (e) {
      logger.error('Projektliste lesen fehlgeschlagen', { error: e.message });
      res.status(500).json({ error: 'Projektliste konnte nicht gelesen werden' });
    }
  });

  // ── GET /api/tags ─────────────────────────────────────────────
  router.get('/tags', async (req, res) => {
    const dir = PROJECTS_DIR;
    try { await fsp.access(dir); } catch { return res.json([]); }

    try {
      const entries = await fsp.readdir(dir);
      const projDirs = entries.filter(d => d.startsWith('proj_'));
      const tagCounts = {};

      await Promise.all(projDirs.map(async (d) => {
        try {
          const raw = await fsp.readFile(path.join(dir, d, 'state.json'), 'utf8');
          const state = JSON.parse(raw);
          if (Array.isArray(state.tags)) {
            for (const tag of state.tags) {
              if (typeof tag === 'string' && tag.trim()) {
                const t = tag.trim().toLowerCase();
                tagCounts[t] = (tagCounts[t] || 0) + 1;
              }
            }
          }
        } catch { /* state.json nicht lesbar */ }
      }));

      const result = Object.entries(tagCounts)
        .map(([tag, count]) => ({ tag, count }))
        .sort((a, b) => b.count - a.count);

      res.json(result);
    } catch (e) {
      logger.error('Tags aggregieren fehlgeschlagen', { error: e.message });
      res.status(500).json({ error: 'Tags konnten nicht gelesen werden' });
    }
  });

  // ── GET /api/projects/:id ─────────────────────────────────────
  router.get('/projects/:id', async (req, res) => {
    const stateFile = path.join(PROJECTS_DIR, req.params.id, 'state.json');
    // Pfad-Traversal verhindern
    if (!stateFile.startsWith(PROJECTS_DIR)) {
      return res.status(400).json({ error: 'Ungültiger Pfad' });
    }
    try {
      const data = await fsp.readFile(stateFile, 'utf8');
      res.json(JSON.parse(data));
    } catch {
      res.status(404).json({ error: 'Projekt nicht gefunden' });
    }
  });

  // ── DELETE /api/projects/:id ──────────────────────────────────
  router.delete('/projects/:id', authMiddleware, apiLimiter, async (req, res) => {
    const id = req.params.id;
    if (!id.startsWith('proj_')) {
      return res.status(400).json({ error: 'Ungültige Projekt-ID' });
    }
    const dir = path.join(PROJECTS_DIR, id);
    // Pfad-Traversal verhindern
    if (!dir.startsWith(PROJECTS_DIR)) {
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

  // ── POST /api/projects/:id/archive ────────────────────────────
  router.post('/projects/:id/archive', authMiddleware, apiLimiter, async (req, res) => {
    const id = req.params.id;
    if (!id.startsWith('proj_')) return res.status(400).json({ error: 'Ungültige Projekt-ID' });
    const stateFile = path.join(PROJECTS_DIR, id, 'state.json');
    if (!stateFile.startsWith(PROJECTS_DIR)) return res.status(400).json({ error: 'Ungültiger Pfad' });
    try {
      const data = JSON.parse(await fsp.readFile(stateFile, 'utf8'));
      data.archived = true;
      await fsp.writeFile(stateFile, JSON.stringify(data, null, 2), 'utf8');
      logger.info('Projekt archiviert', { id });
      res.json({ ok: true, id, archived: true });
    } catch {
      res.status(404).json({ error: 'Projekt nicht gefunden' });
    }
  });

  // ── POST /api/projects/:id/unarchive ─────────────────────────
  router.post('/projects/:id/unarchive', authMiddleware, apiLimiter, async (req, res) => {
    const id = req.params.id;
    if (!id.startsWith('proj_')) return res.status(400).json({ error: 'Ungültige Projekt-ID' });
    const stateFile = path.join(PROJECTS_DIR, id, 'state.json');
    if (!stateFile.startsWith(PROJECTS_DIR)) return res.status(400).json({ error: 'Ungültiger Pfad' });
    try {
      const data = JSON.parse(await fsp.readFile(stateFile, 'utf8'));
      delete data.archived;
      await fsp.writeFile(stateFile, JSON.stringify(data, null, 2), 'utf8');
      logger.info('Projekt dearchiviert', { id });
      res.json({ ok: true, id, archived: false });
    } catch {
      res.status(404).json({ error: 'Projekt nicht gefunden' });
    }
  });

  // ── POST /api/cleanup ─────────────────────────────────────────
  router.post('/cleanup', authMiddleware, apiLimiter, async (req, res) => {
    const dir = PROJECTS_DIR;
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
      if (fullPath.startsWith(PROJECTS_DIR)) {
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

  // ── GET /api/disk-usage ───────────────────────────────────────
  router.get('/disk-usage', apiReadLimiter, async (req, res) => {
    const dir = PROJECTS_DIR;
    try { await fsp.access(dir); } catch {
      return res.json({ totalSize: '0 MB', projectCount: 0, oldestProject: null, newestProject: null });
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

  // ── POST /api/load/:id ────────────────────────────────────────
  router.post('/load/:id', authMiddleware, apiLimiter, (req, res) => {
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

  // ── POST /api/clone/:id ───────────────────────────────────────
  router.post('/clone/:id', authMiddleware, apiLimiter, async (req, res) => {
    const id = req.params.id;
    if (!id || !id.startsWith('proj_')) {
      return res.status(400).json({ error: 'Ungültige Projekt-ID' });
    }
    const stateFile = path.join(PROJECTS_DIR, id, 'state.json');
    // Pfad-Traversal verhindern
    if (!stateFile.startsWith(PROJECTS_DIR)) {
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

  // ── GET /api/projects/:id/changelog ───────────────────────────
  router.get('/projects/:id/changelog', async (req, res) => {
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

  // ── GET /api/projects/:id1/diff/:id2 ──────────────────────────
  router.get('/projects/:id1/diff/:id2', async (req, res) => {
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
}

module.exports = { router, init, loadProjectState, listAgentFilesAsync, readConversationAsync };
