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

  test('Dark Mode Toggle: Klick wechselt Theme', async () => {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });

    // Aktuelles Theme ermitteln
    const themeBefore = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));

    // Theme-Button klicken
    await page.evaluate(() => {
      document.getElementById('themeToggle').click();
    });

    // Theme muss gewechselt haben
    const themeAfter = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    expect(themeAfter).not.toBe(themeBefore);

    // Zurueck klicken
    await page.evaluate(() => {
      document.getElementById('themeToggle').click();
    });

    const themeRestored = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    expect(themeRestored).toBe(themeBefore);
  });

  test('Projekt-Historie: historyArea existiert', async () => {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });

    // Settings oeffnen (dort wird historyArea erzeugt)
    // historyArea wird im Hauptbereich gerendert wenn Projekte vorhanden
    // Pruefen ob das Element im DOM ist (kann leer sein bei 0 Projekten)
    const historyExists = await page.evaluate(() => {
      // historyArea wird dynamisch erstellt wenn Projekte geladen werden
      // Wir triggern die Projekt-Ansicht
      if (typeof loadProjects === 'function') loadProjects();
      return true;
    });
    expect(historyExists).toBe(true);

    // Warte kurz damit loadProjects fertig ist
    await page.waitForTimeout(500);

    // Pruefen dass historyArea im DOM existiert
    const areaInDom = await page.evaluate(() => {
      var el = document.getElementById('historyArea');
      return el !== null;
    });
    expect(areaInDom).toBe(true);
  });

  test('Search: Text eingeben loest Reaktion aus', async () => {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });

    await page.waitForSelector('#globalSearchInput', { state: 'visible', timeout: 5000 });

    // Text eingeben
    await page.fill('#globalSearchInput', 'Testsuche');
    const value = await page.inputValue('#globalSearchInput');
    expect(value).toBe('Testsuche');

    // Warten auf Debounce (300ms) + etwas Puffer
    await page.waitForTimeout(500);

    // Pruefen ob das Suchfeld den Wert behalten hat (kein Fehler aufgetreten)
    const valueAfter = await page.inputValue('#globalSearchInput');
    expect(valueAfter).toBe('Testsuche');

    // Keine JS-Fehler durch die Suche
    expect(jsErrors).toEqual([]);
  });

  test('Settings Tabs: Alle 5 Tabs durchklicken', async () => {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });

    // Settings oeffnen
    await page.evaluate(() => {
      document.getElementById('settingsToggle').click();
    });

    // Warten bis Modal im DOM erscheint
    await page.waitForFunction(
      () => document.getElementById('settingsModal') !== null,
      { timeout: 5000 }
    );

    // Warten bis Tab-Bar erstellt wird (setTimeout 150ms im Code)
    await page.waitForFunction(
      () => document.querySelector('.settings-tab-bar') !== null,
      { timeout: 5000 }
    );

    // Alle 5 Tabs pruefen
    const tabNames = ['general', 'webhooks', 'profiles', 'snapshots', 'logs'];
    const tabLabels = ['Allgemein', 'Webhooks', 'Profile', 'Snapshots', 'Logs'];

    for (let i = 0; i < tabNames.length; i++) {
      // Tab klicken
      await page.evaluate((tabName) => {
        switchSettingsTab(tabName);
      }, tabNames[i]);

      // Kurz warten
      await page.waitForTimeout(200);

      // Pruefen dass der richtige Tab aktiv ist
      const activeTabText = await page.evaluate(() => {
        var active = document.querySelector('.settings-tab-bar .modal-tab.active');
        return active ? active.textContent : null;
      });
      expect(activeTabText).toBe(tabLabels[i]);

      // Keine JS-Fehler
      expect(jsErrors).toEqual([]);
    }

    // Modal schliessen
    await page.evaluate(() => {
      if (typeof closeSettings === 'function') closeSettings();
    });
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
