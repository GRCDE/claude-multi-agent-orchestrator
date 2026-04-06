// E2E Keyboard Shortcut Tests - Playwright + Jest
// Prueft ob Tastenkuerzel korrekt funktionieren

'use strict';
const path = require('path');

const TEST_PORT = 3261;
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

  // Warten bis Server bereit ist
  await new Promise(resolve => setTimeout(resolve, 1000));

  const { chromium } = require('playwright');
  browser = await chromium.launch({ headless: true });
}, 30000);

afterAll(async () => {
  if (browser) await browser.close();
  if (serverMod && serverMod.cleanup) await serverMod.cleanup();
}, 15000);

describe('E2E Keyboard Shortcut Tests', () => {
  let page;

  beforeEach(async () => {
    const context = await browser.newContext();
    page = await context.newPage();
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });
    // Klick auf body damit kein Input-Feld fokussiert ist
    await page.click('body');
    await page.waitForTimeout(200);
  });

  afterEach(async () => {
    if (page) await page.close();
  });

  test("'d' Taste togglet Dark Mode (data-theme Attribut)", async () => {
    // Initiales Theme lesen
    const themeBefore = await page.evaluate(() =>
      document.documentElement.getAttribute('data-theme')
    );

    // 'd' druecken
    await page.keyboard.press('d');
    await page.waitForTimeout(200);

    const themeAfter = await page.evaluate(() =>
      document.documentElement.getAttribute('data-theme')
    );

    // Theme muss sich geaendert haben
    expect(themeAfter).not.toBe(themeBefore);

    // Nochmal 'd' druecken -> zurueck zum Original
    await page.keyboard.press('d');
    await page.waitForTimeout(200);

    const themeRestored = await page.evaluate(() =>
      document.documentElement.getAttribute('data-theme')
    );
    expect(themeRestored).toBe(themeBefore);
  });

  test("'?' oeffnet Shortcuts-Hilfe-Modal", async () => {
    // Modal sollte nicht existieren
    const before = await page.$('#shortcutsModal');
    expect(before).toBeNull();

    // '?' druecken (Shift+/ auf US-Tastatur)
    await page.keyboard.press('?');
    await page.waitForTimeout(300);

    // Modal muss sichtbar sein
    const visible = await page.evaluate(() => {
      var el = document.getElementById('shortcutsModal');
      return el !== null;
    });
    expect(visible).toBe(true);
  });

  test("F1 oeffnet Hilfe-Panel", async () => {
    // Hilfe-Panel sollte nicht existieren
    const before = await page.$('#helpPanelOverlay');
    expect(before).toBeNull();

    // F1 druecken
    await page.keyboard.press('F1');
    await page.waitForTimeout(300);

    // Hilfe-Panel muss sichtbar sein
    const visible = await page.evaluate(() => {
      var el = document.getElementById('helpPanelOverlay');
      return el !== null;
    });
    expect(visible).toBe(true);
  });

  test("'Esc' schliesst offenes Modal", async () => {
    // Settings-Modal oeffnen (per JavaScript, zuverlaessig)
    await page.evaluate(() => {
      document.getElementById('settingsToggle').click();
    });

    // Warten bis Modal im DOM erscheint
    await page.waitForFunction(
      () => document.getElementById('settingsOverlay') !== null ||
            document.getElementById('settingsModal') !== null,
      { timeout: 5000 }
    );

    await page.waitForTimeout(300);

    // Escape druecken
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    // Modal muss weg sein
    const modalGone = await page.evaluate(() => {
      return document.getElementById('settingsOverlay') === null &&
             document.getElementById('settingsModal') === null;
    });
    expect(modalGone).toBe(true);
  });

  test("'n' oeffnet Analytics Dashboard", async () => {
    // Analytics Modal sollte nicht existieren
    const before = await page.$('#analyticsModal');
    expect(before).toBeNull();

    // 'n' druecken
    await page.keyboard.press('n');
    await page.waitForTimeout(300);

    // Analytics Modal muss sichtbar sein
    const visible = await page.evaluate(() => {
      var el = document.getElementById('analyticsModal');
      return el !== null;
    });
    expect(visible).toBe(true);
  });
});
