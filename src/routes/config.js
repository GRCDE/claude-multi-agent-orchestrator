'use strict';
const express = require('express');

const router = express.Router();

/**
 * Initialisiert den Config/Prompts/Budget-Router mit Abhaengigkeiten aus server.js.
 * @param {object} deps - { orchestrator, logger, authMiddleware, apiLimiter, apiReadLimiter, broadcast }
 */
function init(deps) {
  const { orchestrator, logger, authMiddleware, apiLimiter, apiReadLimiter, broadcast } = deps;

  // ── Token-Usage API ─────────────────────────────────────────
  router.get('/token-usage', (req, res) => {
    const state = orchestrator.getState();
    const budget = state.budget || {};
    const perAgent = (state.agents || []).map((agent, i) => ({
      index: i,
      title: agent.title || '',
      tokenUsage: agent.tokenUsage || { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCost: 0 }
    }));
    res.json({
      total: state.totalTokenUsage,
      coordinator: state.coordinator.tokenUsage || { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCost: 0 },
      agents: perAgent,
      budget: {
        maxTokenBudget: budget.maxTokenBudget || 0,
        warnTokenBudget: budget.warnTokenBudget || 0,
        inputCostPerMTok: budget.inputCostPerMTok || 3,
        outputCostPerMTok: budget.outputCostPerMTok || 15,
        exceeded: budget.exceeded || false,
        warned: budget.warned || false,
      }
    });
  });

  // ── Budget API ───────────────────────────────────────────────
  router.get('/budget', (req, res) => {
    const state = orchestrator.getState();
    const budget = state.budget || {};
    const usage = state.totalTokenUsage || { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCost: 0 };
    const maxBudget = budget.maxTokenBudget || 0;
    const warnBudget = budget.warnTokenBudget || 0;
    const percent = maxBudget > 0 ? Math.min(100, Math.round(usage.totalTokens / maxBudget * 100)) : 0;

    res.json({
      maxTokenBudget: maxBudget,
      warnTokenBudget: warnBudget,
      inputCostPerMTok: budget.inputCostPerMTok || 3,
      outputCostPerMTok: budget.outputCostPerMTok || 15,
      totalTokens: usage.totalTokens,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      estimatedCost: usage.estimatedCost,
      percent,
      exceeded: budget.exceeded || false,
      warned: budget.warned || false,
    });
  });

  router.post('/budget', authMiddleware, apiLimiter, (req, res) => {
    const { maxTokenBudget, warnTokenBudget, inputCostPerMTok, outputCostPerMTok } = req.body;
    try {
      const patch = {};
      if (maxTokenBudget !== undefined) patch.tokenBudget = Number(maxTokenBudget);
      if (warnTokenBudget !== undefined) patch.warnTokenBudget = Number(warnTokenBudget);
      if (inputCostPerMTok !== undefined) patch.inputCostPerMTok = Number(inputCostPerMTok);
      if (outputCostPerMTok !== undefined) patch.outputCostPerMTok = Number(outputCostPerMTok);
      orchestrator.updateConfig(patch);
      res.json({ ok: true, config: orchestrator.getConfig() });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // ── Prompt-Templates API ─────────────────────────────────────
  router.get('/prompts', (req, res) => {
    res.json(orchestrator.getPrompts());
  });

  router.post('/prompts', authMiddleware, apiLimiter, (req, res) => {
    try {
      orchestrator.updatePrompts(req.body);
      res.json({ ok: true, prompts: orchestrator.getPrompts().prompts });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.post('/prompts/reset', authMiddleware, apiLimiter, (req, res) => {
    try {
      orchestrator.resetPrompts();
      res.json({ ok: true, prompts: orchestrator.getPrompts().prompts });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Konfiguration ───────────────────────────────────────────────
  router.get('/config', (req, res) => {
    res.json(orchestrator.getConfig());
  });

  router.post('/config', authMiddleware, apiLimiter, (req, res) => {
    try {
      orchestrator.updateConfig(req.body);
      res.json({ ok: true, config: orchestrator.getConfig() });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // ── Undo/Redo API ────────────────────────────────────────────
  router.get('/undo-redo', apiReadLimiter, (req, res) => {
    res.json(orchestrator.getUndoRedoStatus());
  });

  router.post('/config/undo', authMiddleware, apiLimiter, (req, res) => {
    try {
      const config = orchestrator.undoConfig();
      broadcast('state', orchestrator.getState());
      res.json({ ok: true, config });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.post('/config/redo', authMiddleware, apiLimiter, (req, res) => {
    try {
      const config = orchestrator.redoConfig();
      broadcast('state', orchestrator.getState());
      res.json({ ok: true, config });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });
}

module.exports = { router, init };
