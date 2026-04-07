'use strict';
const express = require('express');
const path = require('path');

const router = express.Router();

let _deps = {};

function init(deps) {
  _deps = deps;
}

// ── Git-Status ────────────────────────────────────────────────
router.get('/git/status', (req, res) => {
  const git = _deps.orchestrator.gitIntegration;
  if (!git) return res.json({ ok: false, error: 'Git-Integration nicht verfuegbar' });
  const config = git.getConfig();
  const status = config.enabled && config.workDir ? git.getStatus() : null;
  res.json({ ok: true, config, status });
});

// ── Git-Log ───────────────────────────────────────────────────
router.get('/git/log', (req, res) => {
  const git = _deps.orchestrator.gitIntegration;
  if (!git) return res.json({ ok: false, commits: [] });
  const count = Math.min(parseInt(req.query.count) || 20, 100);
  res.json(git.getLog(count));
});

// ── Git-Branches ──────────────────────────────────────────────
router.get('/git/branches', (req, res) => {
  const git = _deps.orchestrator.gitIntegration;
  if (!git) return res.json({ ok: false, branches: [] });
  res.json(git.getBranches());
});

// ── Git-Diff fuer Commit ──────────────────────────────────────
router.get('/git/diff/:hash', (req, res) => {
  const git = _deps.orchestrator.gitIntegration;
  if (!git) return res.json({ ok: false, diff: '' });
  res.json(git.getCommitDiff(req.params.hash));
});

// ── Git-Config lesen ──────────────────────────────────────────
router.get('/git/config', (req, res) => {
  const git = _deps.orchestrator.gitIntegration;
  if (!git) return res.json({ ok: false, error: 'Git-Integration nicht verfuegbar' });
  res.json({ ok: true, ...git.getConfig() });
});

// ── Git-Config aendern ────────────────────────────────────────
router.post('/git/config', (req, res, next) => {
  if (_deps.authMiddleware) return _deps.authMiddleware(req, res, next);
  next();
}, (req, res) => {
  const git = _deps.orchestrator.gitIntegration;
  if (!git) return res.status(500).json({ ok: false, error: 'Git-Integration nicht verfuegbar' });
  const errors = git.updateConfig(req.body);
  if (errors.length > 0) {
    return res.status(400).json({ ok: false, errors });
  }
  if (_deps.logger) _deps.logger.info('Git-Config geaendert', req.body);
  res.json({ ok: true, ...git.getConfig() });
});

// ── Manueller Commit ──────────────────────────────────────────
router.post('/git/commit', (req, res, next) => {
  if (_deps.authMiddleware) return _deps.authMiddleware(req, res, next);
  next();
}, async (req, res) => {
  const git = _deps.orchestrator.gitIntegration;
  if (!git || !git.enabled) return res.status(400).json({ ok: false, error: 'Git-Integration deaktiviert' });
  const message = req.body.message || 'Manueller Commit';
  const result = git.commit(message);
  if (result.ok && _deps.broadcast) {
    _deps.broadcast('git_commit', { hash: result.hash, message });
  }
  res.json(result);
});

// ── Manueller Push ────────────────────────────────────────────
router.post('/git/push', (req, res, next) => {
  if (_deps.authMiddleware) return _deps.authMiddleware(req, res, next);
  next();
}, (req, res) => {
  const git = _deps.orchestrator.gitIntegration;
  if (!git || !git.enabled) return res.status(400).json({ ok: false, error: 'Git-Integration deaktiviert' });
  const result = git.push();
  if (result.ok && _deps.broadcast) {
    _deps.broadcast('git_push', { branch: result.branch });
  }
  res.json(result);
});

// ── Branch wechseln ───────────────────────────────────────────
router.post('/git/checkout', (req, res, next) => {
  if (_deps.authMiddleware) return _deps.authMiddleware(req, res, next);
  next();
}, (req, res) => {
  const git = _deps.orchestrator.gitIntegration;
  if (!git || !git.enabled) return res.status(400).json({ ok: false, error: 'Git-Integration deaktiviert' });
  if (!req.body.branch) return res.status(400).json({ ok: false, error: 'Branch-Name erforderlich' });
  const result = git.checkout(req.body.branch);
  res.json(result);
});

// ── Git-Repo initialisieren ───────────────────────────────────
router.post('/git/init', (req, res, next) => {
  if (_deps.authMiddleware) return _deps.authMiddleware(req, res, next);
  next();
}, async (req, res) => {
  const git = _deps.orchestrator.gitIntegration;
  if (!git) return res.status(500).json({ ok: false, error: 'Git-Integration nicht verfuegbar' });
  try {
    await git.initRepo(req.body.dir);
    res.json({ ok: true, message: 'Git-Repository initialisiert' });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ── Projekt-Ergebnisse manuell committen ──────────────────────
router.post('/git/commit-project/:id', (req, res, next) => {
  if (_deps.authMiddleware) return _deps.authMiddleware(req, res, next);
  next();
}, async (req, res) => {
  const git = _deps.orchestrator.gitIntegration;
  if (!git || !git.enabled) return res.status(400).json({ ok: false, error: 'Git-Integration deaktiviert' });

  const state = _deps.orchestrator.getState();
  if (!state || state.phase === 'idle') {
    return res.status(400).json({ ok: false, error: 'Kein aktives Projekt' });
  }

  const mergedDir = _deps.orchestrator.projectDir
    ? path.join(_deps.orchestrator.projectDir, 'merged')
    : null;

  if (!mergedDir) return res.status(400).json({ ok: false, error: 'Kein Merge-Verzeichnis vorhanden' });

  const result = await git.commitProjectResults(
    req.params.id,
    _deps.orchestrator.projectTitle || req.params.id,
    mergedDir,
    _deps.orchestrator.agents || []
  );

  if (result.ok && _deps.broadcast) {
    _deps.broadcast('git_commit', { hash: result.hash, branch: result.branch, projectId: req.params.id });
  }
  res.json(result);
});

module.exports = { router, init };
