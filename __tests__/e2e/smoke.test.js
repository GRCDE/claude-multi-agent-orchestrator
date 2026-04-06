// E2E Smoke Test - Playwright + Jest
// Prueft ob die App korrekt rendert (headless Browser)

'use strict';
const path = require('path');

const TEST_PORT = 3260;
const BASE_URL = `http://localhost:${TEST_PORT}`;
const SCREENSHOT_DIR = path.join(__dirname, '..', '..', 'screenshots');

// ── child_process Mock: nur execSync faken, spawn durchreichen ──
// Playwright braucht den echten spawn um den Browser zu starten.
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
  // Server starten
  process.env.PORT = String(TEST_PORT);
  Object.keys(require.cache).forEach(key => {
    if (key.includes('server.js')) delete require.cache[key];
  });
  serverMod = require('../../server');

  // Warten bis Server bereit ist
  await new Promise(resolve => setTimeout(resolve, 1000));

  // Browser starten (require hier damit der Mock schon aktiv ist)
  const { chromium } = require('playwright');
  browser = await chromium.launch({ headless: true });
}, 30000);

afterAll(async () => {
  if (browser) await browser.close();
  if (serverMod && serverMod.cleanup) await serverMod.cleanup();
}, 15000);

describe('E2E Smoke Tests', () => {
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

  test('Seite laedt ohne JS-Fehler', async () => {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });

    // Seite muss geladen sein
    const title = await page.title();
    expect(title).toBeTruthy();

    // Keine JS-Fehler
    expect(jsErrors).toEqual([]);
  });

  test('Setup-Formular sichtbar (textarea#desc, button#startBtn)', async () => {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });

    // textarea#desc muss sichtbar sein
    await page.waitForSelector('#desc', { state: 'visible', timeout: 5000 });
    const descVisible = await page.isVisible('#desc');
    expect(descVisible).toBe(true);

    // button#startBtn muss sichtbar sein
    await page.waitForSelector('#startBtn', { state: 'visible', timeout: 5000 });
    const startBtnVisible = await page.isVisible('#startBtn');
    expect(startBtnVisible).toBe(true);

    // Pruefen dass textarea editierbar ist
    await page.fill('#desc', 'Test-Beschreibung');
    const value = await page.inputValue('#desc');
    expect(value).toBe('Test-Beschreibung');
  });

  test('Toolbar-Icons vorhanden', async () => {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });

    // Toolbar-Buttons mit class "top-btn" muessen vorhanden sein
    const count = await page.locator('.top-btn').count();
    expect(count).toBeGreaterThanOrEqual(5);

    // Spezifische Buttons pruefen
    for (const id of ['#settingsToggle', '#themeToggle', '#soundToggle', '#activityToggle', '#analyticsToggle']) {
      const visible = await page.isVisible(id);
      expect(visible).toBe(true);
    }
  });

  test('Suchfeld "Projekte durchsuchen" vorhanden', async () => {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });

    await page.waitForSelector('#globalSearchInput', { state: 'visible', timeout: 5000 });
    const visible = await page.isVisible('#globalSearchInput');
    expect(visible).toBe(true);

    // Placeholder pruefen
    const placeholder = await page.getAttribute('#globalSearchInput', 'placeholder');
    expect(placeholder).toContain('Projekte durchsuchen');
  });

  test('Settings-Modal oeffnet sich bei Klick auf Zahnrad-Icon', async () => {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });

    // Settings-Modal sollte nicht sichtbar sein
    const modalBefore = await page.$('#settingsModal');
    expect(modalBefore).toBeNull();

    // Zahnrad-Icon klicken via JavaScript (zuverlaessiger als .click())
    await page.evaluate(() => {
      document.getElementById('settingsToggle').click();
    });

    // Warten bis Modal im DOM erscheint
    await page.waitForFunction(
      () => document.getElementById('settingsModal') !== null,
      { timeout: 5000 }
    );

    const modalVisible = await page.isVisible('#settingsModal');
    expect(modalVisible).toBe(true);

    // Modal muss Settings-Inhalt haben
    const hasSettingsClass = await page.evaluate(() => {
      const el = document.querySelector('#settingsModal .settings-modal');
      return el !== null;
    });
    expect(hasSettingsClass).toBe(true);

    // Modal schliessen via JavaScript
    await page.evaluate(() => {
      if (typeof closeSettings === 'function') closeSettings();
    });

    // Warten bis Modal entfernt ist
    await page.waitForFunction(
      () => document.getElementById('settingsModal') === null,
      { timeout: 5000 }
    );
    const modalAfter = await page.$('#settingsModal');
    expect(modalAfter).toBeNull();
  });

  test('Screenshot erstellen', async () => {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });

    // Kurz warten damit alles gerendert ist
    await page.waitForTimeout(500);

    const screenshotPath = path.join(SCREENSHOT_DIR, 'smoke-test.png');
    await page.screenshot({ path: screenshotPath, fullPage: true });

    // Pruefen dass die Datei erstellt wurde
    const fs = require('fs');
    expect(fs.existsSync(screenshotPath)).toBe(true);

    const stat = fs.statSync(screenshotPath);
    expect(stat.size).toBeGreaterThan(0);
  });
});
