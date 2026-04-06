// E2E Analytics Dashboard Test - Playwright + Jest
// Prueft ob das Analytics-Dashboard korrekt oeffnet, Daten anzeigt und schliesst

'use strict';
const path = require('path');

const TEST_PORT = 3265;
const BASE_URL = `http://localhost:${TEST_PORT}`;

// ── child_process Mock: nur execSync faken, spawn durchreichen ──
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

describe('E2E Analytics Dashboard Tests', () => {
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

  test('Taste "n" oeffnet Analytics-Modal', async () => {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });

    // Analytics-Modal sollte nicht existieren
    const modalBefore = await page.$('#analyticsModal');
    expect(modalBefore).toBeNull();

    // Taste 'n' druecken
    await page.keyboard.press('n');

    // Warten bis Modal im DOM erscheint
    await page.waitForFunction(
      () => document.getElementById('analyticsModal') !== null,
      { timeout: 5000 }
    );

    const modalVisible = await page.isVisible('#analyticsModal');
    expect(modalVisible).toBe(true);

    // Modal muss analytics-modal Klasse haben
    const hasClass = await page.evaluate(() => {
      return document.querySelector('#analyticsModal .analytics-modal') !== null;
    });
    expect(hasClass).toBe(true);

    expect(jsErrors).toEqual([]);
  });

  test('Analytics enthaelt Timeline-Daten', async () => {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });

    // Analytics oeffnen via Button (zuverlaessiger als Tastatur)
    await page.evaluate(() => {
      document.getElementById('analyticsToggle').click();
    });

    // Warten bis Modal erscheint und Daten geladen sind
    await page.waitForFunction(
      () => document.getElementById('analyticsModal') !== null,
      { timeout: 5000 }
    );

    // Warten bis Loading-Spinner verschwunden ist (Daten geladen oder leer)
    await page.waitForFunction(
      () => {
        var modal = document.querySelector('#analyticsModal .analytics-modal');
        if (!modal) return false;
        var loading = modal.querySelector('.analytics-loading');
        return loading === null;
      },
      { timeout: 5000 }
    );

    // Pruefen ob Timeline-Sektion oder "Keine Daten" angezeigt wird
    // (ohne Projekte zeigt es "Keine Daten" an, was auch korrekt ist)
    const content = await page.evaluate(() => {
      var modal = document.querySelector('#analyticsModal .analytics-modal');
      return modal ? modal.innerHTML : '';
    });

    // Modal muss entweder Timeline oder "Keine Daten" enthalten
    const hasTimeline = content.includes('Timeline') || content.includes('Projekte pro Woche');
    const hasEmpty = content.includes('Keine Daten');
    expect(hasTimeline || hasEmpty).toBe(true);

    expect(jsErrors).toEqual([]);
  });

  test('Analytics enthaelt Rollen-Statistiken', async () => {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });

    // Analytics oeffnen
    await page.evaluate(() => {
      document.getElementById('analyticsToggle').click();
    });

    await page.waitForFunction(
      () => document.getElementById('analyticsModal') !== null,
      { timeout: 5000 }
    );

    // Warten bis Daten geladen
    await page.waitForFunction(
      () => {
        var modal = document.querySelector('#analyticsModal .analytics-modal');
        if (!modal) return false;
        return modal.querySelector('.analytics-loading') === null;
      },
      { timeout: 5000 }
    );

    // Pruefen ob Rollen-Statistiken oder "Keine Daten" angezeigt wird
    const content = await page.evaluate(() => {
      var modal = document.querySelector('#analyticsModal .analytics-modal');
      return modal ? modal.innerHTML : '';
    });

    const hasRoles = content.includes('Rollen-Statistiken') || content.includes('Rolle');
    const hasEmpty = content.includes('Keine Daten');
    expect(hasRoles || hasEmpty).toBe(true);

    expect(jsErrors).toEqual([]);
  });

  test('Analytics enthaelt Kosten-Uebersicht', async () => {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });

    // Analytics oeffnen
    await page.evaluate(() => {
      document.getElementById('analyticsToggle').click();
    });

    await page.waitForFunction(
      () => document.getElementById('analyticsModal') !== null,
      { timeout: 5000 }
    );

    // Warten bis Daten geladen
    await page.waitForFunction(
      () => {
        var modal = document.querySelector('#analyticsModal .analytics-modal');
        if (!modal) return false;
        return modal.querySelector('.analytics-loading') === null;
      },
      { timeout: 5000 }
    );

    // Pruefen ob Kosten-Uebersicht oder "Keine Daten" angezeigt wird
    const content = await page.evaluate(() => {
      var modal = document.querySelector('#analyticsModal .analytics-modal');
      return modal ? modal.innerHTML : '';
    });

    const hasCosts = content.includes('Kosten') || content.includes('USD') || content.includes('Tokens');
    const hasEmpty = content.includes('Keine Daten');
    expect(hasCosts || hasEmpty).toBe(true);

    expect(jsErrors).toEqual([]);
  });

  test('Modal schliessbar mit Esc oder X-Button', async () => {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });

    // --- Test 1: Schliessen mit X-Button ---
    await page.evaluate(() => {
      document.getElementById('analyticsToggle').click();
    });

    await page.waitForFunction(
      () => document.getElementById('analyticsModal') !== null,
      { timeout: 5000 }
    );

    // X-Button klicken
    await page.evaluate(() => {
      var closeBtn = document.querySelector('#analyticsModal .modal-close');
      if (closeBtn) closeBtn.click();
    });

    // Warten bis Modal entfernt ist
    await page.waitForFunction(
      () => document.getElementById('analyticsModal') === null,
      { timeout: 5000 }
    );
    const modalAfterX = await page.$('#analyticsModal');
    expect(modalAfterX).toBeNull();

    // --- Test 2: Schliessen mit Escape-Taste ---
    await page.evaluate(() => {
      document.getElementById('analyticsToggle').click();
    });

    await page.waitForFunction(
      () => document.getElementById('analyticsModal') !== null,
      { timeout: 5000 }
    );

    // Escape druecken
    await page.keyboard.press('Escape');

    // Warten bis Modal entfernt ist
    await page.waitForFunction(
      () => document.getElementById('analyticsModal') === null,
      { timeout: 5000 }
    );
    const modalAfterEsc = await page.$('#analyticsModal');
    expect(modalAfterEsc).toBeNull();

    expect(jsErrors).toEqual([]);
  });
});
