// E2E Project-Flow Test - Playwright + Jest
// Testet den kompletten Setup-Flow: Formular, Slider, Approval, Historie, Templates

'use strict';
const path = require('path');

const TEST_PORT = 3264;
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

  // Warten bis Server bereit ist
  await new Promise(resolve => setTimeout(resolve, 1000));

  const { chromium } = require('playwright');
  browser = await chromium.launch({ headless: true });
}, 30000);

afterAll(async () => {
  if (browser) await browser.close();
  if (serverMod && serverMod.cleanup) await serverMod.cleanup();
}, 15000);

describe('E2E Project-Flow Tests', () => {
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

  test('Seite laden: Setup-Formular ist sichtbar', async () => {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });

    // Setup-Box muss sichtbar sein
    await page.waitForSelector('.setup-box', { state: 'visible', timeout: 5000 });
    const setupVisible = await page.isVisible('.setup-box');
    expect(setupVisible).toBe(true);

    // textarea#desc und button#startBtn muessen vorhanden sein
    await page.waitForSelector('#desc', { state: 'visible', timeout: 5000 });
    expect(await page.isVisible('#desc')).toBe(true);

    await page.waitForSelector('#startBtn', { state: 'visible', timeout: 5000 });
    expect(await page.isVisible('#startBtn')).toBe(true);

    // countSlider muss vorhanden sein
    await page.waitForSelector('#countSlider', { state: 'visible', timeout: 5000 });
    expect(await page.isVisible('#countSlider')).toBe(true);

    // Keine JS-Fehler
    expect(jsErrors).toEqual([]);
  });

  test('Projektbeschreibung eingeben (textarea#desc)', async () => {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });
    await page.waitForSelector('#desc', { state: 'visible', timeout: 5000 });

    // Beschreibung eingeben
    const testDesc = 'Erstelle eine REST API mit Express.js und PostgreSQL fuer einen Online-Shop';
    await page.fill('#desc', testDesc);

    // Wert pruefen
    const value = await page.inputValue('#desc');
    expect(value).toBe(testDesc);

    // Textarea muss nicht leer sein
    const isEmpty = await page.evaluate(() => document.getElementById('desc').value.length === 0);
    expect(isEmpty).toBe(false);

    expect(jsErrors).toEqual([]);
  });

  test('Agenten-Anzahl per Slider auf 5 aendern', async () => {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });
    await page.waitForSelector('#countSlider', { state: 'visible', timeout: 5000 });

    // Default-Wert pruefen (sollte 3 sein)
    const defaultVal = await page.inputValue('#countSlider');
    expect(defaultVal).toBe('3');

    // Display-Wert pruefen
    const defaultDisplay = await page.evaluate(() =>
      document.getElementById('countDisplay').textContent
    );
    expect(defaultDisplay).toBe('3');

    // Slider auf 5 setzen via JavaScript (zuverlaessiger als Drag)
    await page.evaluate(() => {
      var slider = document.getElementById('countSlider');
      slider.value = '5';
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // Neuen Wert pruefen
    const newVal = await page.inputValue('#countSlider');
    expect(newVal).toBe('5');

    // Display muss aktualisiert sein
    const newDisplay = await page.evaluate(() =>
      document.getElementById('countDisplay').textContent
    );
    expect(newDisplay).toBe('5');

    expect(jsErrors).toEqual([]);
  });

  test('Approval-Checkbox aktivieren', async () => {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });
    await page.waitForSelector('#approvalCheck', { timeout: 5000 });

    // Checkbox sollte standardmaessig nicht aktiviert sein
    const checkedBefore = await page.evaluate(() =>
      document.getElementById('approvalCheck').checked
    );
    expect(checkedBefore).toBe(false);

    // Checkbox aktivieren
    await page.click('#approvalCheck');

    // Pruefen dass Checkbox jetzt aktiviert ist
    const checkedAfter = await page.evaluate(() =>
      document.getElementById('approvalCheck').checked
    );
    expect(checkedAfter).toBe(true);

    // Nochmal klicken zum Deaktivieren
    await page.click('#approvalCheck');

    const checkedFinal = await page.evaluate(() =>
      document.getElementById('approvalCheck').checked
    );
    expect(checkedFinal).toBe(false);

    expect(jsErrors).toEqual([]);
  });

  test('Projekt-Historie: historyArea ist scrollbar', async () => {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });

    // historyArea muss im DOM existieren
    await page.waitForSelector('#historyArea', { timeout: 5000 });
    const exists = await page.evaluate(() =>
      document.getElementById('historyArea') !== null
    );
    expect(exists).toBe(true);

    // Pruefen dass historyArea role="list" hat
    const role = await page.getAttribute('#historyArea', 'role');
    expect(role).toBe('list');

    // Pruefen dass historyArea scrollbar ist (overflow-Eigenschaft)
    const isScrollable = await page.evaluate(() => {
      var el = document.getElementById('historyArea');
      var style = window.getComputedStyle(el);
      // overflow-y muss auto oder scroll sein, oder max-height gesetzt
      return style.overflowY === 'auto' || style.overflowY === 'scroll' ||
        style.overflow === 'auto' || style.overflow === 'scroll' ||
        el.classList.contains('history-list');
    });
    expect(isScrollable).toBe(true);

    expect(jsErrors).toEqual([]);
  });

  test('Template-Auswahl: Klick auf Template-Karte fuellt Beschreibung', async () => {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });
    await page.waitForSelector('#desc', { state: 'visible', timeout: 5000 });

    // Warten bis Templates geladen sind (template-card muss vorhanden sein)
    await page.waitForSelector('.template-card', { timeout: 5000 });

    // Beschreibung sollte anfangs leer sein
    const descBefore = await page.inputValue('#desc');
    expect(descBefore).toBe('');

    // Erste Template-Karte klicken
    await page.evaluate(() => {
      var card = document.querySelector('.template-card');
      if (card) card.click();
    });

    // Beschreibung sollte jetzt gefuellt sein
    const descAfter = await page.inputValue('#desc');
    expect(descAfter.length).toBeGreaterThan(0);

    // Slider sollte sich auch geaendert haben (Template hat suggestedAgents)
    const sliderVal = await page.inputValue('#countSlider');
    expect(Number(sliderVal)).toBeGreaterThanOrEqual(2);
    expect(Number(sliderVal)).toBeLessThanOrEqual(10);

    // Template-Karte muss als selected markiert sein
    const hasSelected = await page.evaluate(() => {
      return document.querySelector('.template-card.selected') !== null;
    });
    expect(hasSelected).toBe(true);

    // Nochmal klicken zum Abwaehlen (Toggle-Verhalten)
    await page.evaluate(() => {
      var card = document.querySelector('.template-card.selected');
      if (card) card.click();
    });

    // Beschreibung sollte wieder leer sein
    const descReset = await page.inputValue('#desc');
    expect(descReset).toBe('');

    expect(jsErrors).toEqual([]);
  });
});
