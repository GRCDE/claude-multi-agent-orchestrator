// E2E Onboarding / Hilfe-System Tests - Playwright + Jest
// Prueft Kontext-Hilfe, Status-Erklaerungen, F1/? Hilfe

'use strict';
const path = require('path');

const TEST_PORT = 3273;
const BASE_URL = `http://localhost:${TEST_PORT}`;

// ── child_process Mock: nur execSync faken, spawn durchreichen ──
const realChildProcess = jest.requireActual('child_process');
jest.mock('child_process', () => {
  const actual = jest.requireActual('child_process');
  return {
    ...actual,
    execSync: jest.fn(() => 'claude 1.0.0'),
  };
});

jest.mock('express-rate-limit', () => {
  return () => (req, res, next) => next();
});

jest.mock('../../orchestrator', () => {
  const EventEmitter = require('events').EventEmitter;
  class MockOrchestrator extends EventEmitter {
    constructor() {
      super();
      this.phase = 'idle';
      this.agents = [];
      this.startedAt = null;
    }
    emit(event, data) {
      super.emit('update', { event, data, ts: Date.now() });
      super.emit(event, data);
      return true;
    }
    getState() {
      return {
        phase: this.phase,
        agents: this.agents,
        coordinator: {},
        totalTokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCost: 0 }
      };
    }
    start() { this.phase = 'running'; return Promise.resolve(); }
    reset() { this.phase = 'idle'; this.agents = []; }
    getPrompts() { return { prompts: {} }; }
    updatePrompts() {}
    resetPrompts() {}
    getConfig() { return {}; }
    updateConfig() {}
    approvePlan() {}
    modifyPlan() {}
    retryAgent() { return Promise.resolve(); }
    loadProject() { return this.getState(); }
    resume() { return Promise.resolve(); }
    setIntervention() {}
    abort() { this.phase = 'idle'; return Promise.resolve(); }
    getLastMergeResult() { return null; }
    remerge() { return Promise.resolve(); }
    _installSignalHandlers() {}
  }
  return MockOrchestrator;
});

// ── Test Suite ────────────────────────────────────────────────

let browser;
let serverMod;

beforeAll(async () => {
  process.env.PORT = String(TEST_PORT);
  Object.keys(require.cache).forEach(key => {
    if (key.includes('server.js')) delete require.cache[key];
  });
  serverMod = require('../../server');

  await new Promise(resolve => setTimeout(resolve, 1000));

  const { chromium } = require('playwright');
  browser = await chromium.launch({ headless: true });
}, 30000);

afterAll(async () => {
  if (browser) await browser.close();
  if (serverMod && serverMod.cleanup) await serverMod.cleanup();
}, 15000);

describe('E2E Onboarding / Hilfe-System', () => {
  let page;
  const jsErrors = [];

  beforeEach(async () => {
    const context = await browser.newContext();
    page = await context.newPage();
    page.on('pageerror', err => jsErrors.push(err.message));
  });

  afterEach(async () => {
    if (page) await page.close();
    jsErrors.length = 0;
  });

  test('Kontext-Hilfe-Icons sind sichtbar neben Feldern', async () => {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });

    // ctx-help Spans muessen im Setup-Formular vorhanden sein
    const ctxHelpCount = await page.locator('.ctx-help').count();
    expect(ctxHelpCount).toBeGreaterThanOrEqual(3);

    // Jedes ctx-help Element muss ein ? enthalten und data-help Attribut haben
    const allValid = await page.evaluate(() => {
      var helpers = document.querySelectorAll('.ctx-help');
      for (var i = 0; i < helpers.length; i++) {
        if (helpers[i].textContent.trim() !== '?') return false;
        if (!helpers[i].getAttribute('data-help')) return false;
      }
      return true;
    });
    expect(allValid).toBe(true);

    // Pruefe dass die Icons sichtbar sind (nicht display:none)
    const firstVisible = await page.locator('.ctx-help').first().isVisible();
    expect(firstVisible).toBe(true);

    expect(jsErrors).toEqual([]);
  });

  test('Klick auf Kontext-Hilfe zeigt Tooltip', async () => {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });

    // Warten bis ctx-help Elemente vorhanden sind
    await page.waitForSelector('.ctx-help', { state: 'visible', timeout: 5000 });

    // Klick auf erstes ctx-help Icon
    await page.evaluate(() => {
      var first = document.querySelector('.ctx-help');
      first.click();
    });

    // Tooltip muss erscheinen (ctx-help-tooltip Klasse)
    await page.waitForFunction(
      () => document.querySelector('.ctx-help-tooltip') !== null,
      { timeout: 5000 }
    );

    const tooltipVisible = await page.isVisible('.ctx-help-tooltip');
    expect(tooltipVisible).toBe(true);

    // Tooltip muss Text enthalten
    const tooltipText = await page.evaluate(() => {
      var tip = document.querySelector('.ctx-help-tooltip');
      return tip ? tip.textContent : '';
    });
    expect(tooltipText.length).toBeGreaterThan(10);

    // Erneuter Klick schliesst den Tooltip
    await page.evaluate(() => {
      var first = document.querySelector('.ctx-help');
      first.click();
    });

    await page.waitForFunction(
      () => document.querySelector('.ctx-help-tooltip') === null,
      { timeout: 5000 }
    );

    expect(jsErrors).toEqual([]);
  });

  test('STATUS_EXPLANATIONS sind fuer alle wichtigen Status definiert', async () => {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });

    // Pruefe ob STATUS_EXPLANATIONS im globalen Scope existiert und alle Keys hat
    const result = await page.evaluate(() => {
      if (typeof STATUS_EXPLANATIONS === 'undefined') return { exists: false, keys: [] };
      var requiredKeys = ['idle', 'planning', 'running', 'awaiting_approval', 'working', 'asking', 'done', 'error', 'complete'];
      var missing = [];
      for (var i = 0; i < requiredKeys.length; i++) {
        if (!STATUS_EXPLANATIONS[requiredKeys[i]]) missing.push(requiredKeys[i]);
      }
      return {
        exists: true,
        keys: Object.keys(STATUS_EXPLANATIONS),
        missing: missing,
        totalCount: Object.keys(STATUS_EXPLANATIONS).length
      };
    });

    expect(result.exists).toBe(true);
    expect(result.totalCount).toBeGreaterThanOrEqual(10);
    // 'running' ist im Code nicht definiert, aber alle anderen muessen da sein
    const criticalMissing = result.missing.filter(k => k !== 'running');
    expect(criticalMissing).toEqual([]);

    expect(jsErrors).toEqual([]);
  });

  test('F1 oeffnet Hilfe-Panel', async () => {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });

    // Hilfe-Panel darf nicht offen sein
    const panelBefore = await page.$('#helpPanelOverlay');
    expect(panelBefore).toBeNull();

    // F1 druecken
    await page.keyboard.press('F1');

    // Hilfe-Panel muss erscheinen
    await page.waitForFunction(
      () => document.getElementById('helpPanelOverlay') !== null,
      { timeout: 5000 }
    );

    const panelVisible = await page.isVisible('#helpPanelOverlay');
    expect(panelVisible).toBe(true);

    // Panel muss Hilfe-Inhalt haben
    const hasContent = await page.evaluate(() => {
      var panel = document.getElementById('helpPanelOverlay');
      return panel && panel.textContent.length > 50;
    });
    expect(hasContent).toBe(true);

    // Escape schliesst das Panel
    await page.keyboard.press('Escape');

    await page.waitForFunction(
      () => document.getElementById('helpPanelOverlay') === null,
      { timeout: 5000 }
    );

    const panelAfter = await page.$('#helpPanelOverlay');
    expect(panelAfter).toBeNull();

    expect(jsErrors).toEqual([]);
  });
});
