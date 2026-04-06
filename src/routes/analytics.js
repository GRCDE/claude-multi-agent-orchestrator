'use strict';
const express = require('express');
const path = require('path');
const fsp = require('fs').promises;

const router = express.Router();

// ── Konstanten ───────────────────────────────────────────────
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico',
  '.woff', '.woff2', '.ttf', '.eot',
  '.zip', '.tar', '.gz', '.exe', '.dll', '.so', '.dylib'
]);

// ── Analytics Cache ──────────────────────────────────────────
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
  const dir = path.join(__dirname, '..', '..', 'projects');
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

/**
 * Initialisiert den Analytics-Router mit Abhaengigkeiten aus server.js.
 * @param {object} deps - { logger, authMiddleware, apiReadLimiter, metrics, clients, wsClients, logSearchEngine }
 */
function init(deps) {
  const { logger, authMiddleware, apiReadLimiter, metrics, clients, wsClients, logSearchEngine } = deps;

  // ── GET /api/metrics – Performance-Metriken ──────────────────
  router.get('/metrics', (req, res) => {
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

  // ── DELETE /api/metrics – Metriken zuruecksetzen ─────────────
  router.delete('/metrics', authMiddleware, (req, res) => {
    metrics.requestCount.clear();
    metrics.responseTimes.clear();
    metrics._cpuPrev = process.cpuUsage();
    res.json({ ok: true, message: 'Metriken zurueckgesetzt' });
  });

  // ── GET /api/stats – Projekt-Statistiken aggregiert ──────────
  router.get('/stats', apiReadLimiter, async (req, res) => {
    const dir = path.join(__dirname, '..', '..', 'projects');
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

  // ── GET /api/analytics – Analytics API (cached 60s) ──────────
  router.get('/analytics', apiReadLimiter, async (req, res) => {
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

  // ── GET /api/search – Projektuebergreifende Suche ────────────
  router.get('/search', apiReadLimiter, async (req, res) => {
    const q = (req.query.q || '').trim();
    const scope = req.query.scope || 'all'; // all|files|conversations|titles
    if (!q || q.length < 2) {
      return res.json([]);
    }
    if (!['all', 'files', 'conversations', 'titles'].includes(scope)) {
      return res.status(400).json({ error: 'Ung\u00fcltiger Scope. Erlaubt: all, files, conversations, titles' });
    }

    const SEARCH_TIMEOUT = 5000;
    const MAX_RESULTS = 50;
    const MAX_FILE_SIZE_SEARCH = 1 * 1024 * 1024; // 1 MB

    const projectsDir = path.join(__dirname, '..', '..', 'projects');
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
        currentPos = lineEnd + 1; // +1 fuer \n
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
      } catch { return; } // Kein state.json -> ueberspringen

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
                } catch { /* JSON parse Fehler -> ueberspringen */ }
              }
            } catch { /* Datei nicht vorhanden -> ueberspringen */ }
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
              // Binaerdateien ueberspringen
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
              } catch { /* Lese-Fehler -> ueberspringen */ }
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

  // ── GET /api/search/suggest – Auto-Suggest ───────────────────
  router.get('/search/suggest', apiReadLimiter, (req, res) => {
    const prefix = (req.query.q || '').trim();
    if (!prefix) return res.json([]);

    try {
      const suggestions = logSearchEngine.getSuggestions(prefix, 10);
      res.json(suggestions);
    } catch (e) {
      res.status(500).json({ error: 'Suggest-Fehler: ' + e.message });
    }
  });
}

module.exports = { router, init };
