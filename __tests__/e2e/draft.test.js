// E2E Draft Auto-Save Test - Playwright + Jest
// Prueft ob Draft in localStorage gespeichert und wiederhergestellt wird

'use strict';

const TEST_PORT = 3281;
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

describe('E2E Draft Auto-Save Tests', () => {
  let context;
  let page;

  beforeEach(async () => {
    context = await browser.newContext({ bypassCSP: true });
    page = await context.newPage();
  });

  afterEach(async () => {
    if (page) await page.close();
    if (context) await context.close();
  });

  test('Beschreibung wird in localStorage gespeichert', async () => {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#desc', { state: 'visible', timeout: 10000 });

    // Text eingeben und saveDraft direkt aufrufen (Listener wird erst nach
    // restoreDraft mit vorhandenem Draft registriert)
    await page.fill('#desc', 'Mein Test-Projekt');
    await page.evaluate(() => { saveDraft(); });

    // localStorage pruefen
    const stored = await page.evaluate(() => {
      return localStorage.getItem('orchestrator_draft');
    });
    expect(stored).toBeTruthy();

    const draft = JSON.parse(stored);
    expect(draft.desc).toBe('Mein Test-Projekt');
  });

  test('Beschreibung wird nach Seiten-Reload wiederhergestellt', async () => {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#desc', { state: 'visible', timeout: 10000 });

    // Draft in localStorage setzen
    await page.evaluate(() => {
      localStorage.setItem('orchestrator_draft', JSON.stringify({
        desc: 'Wiederhergestellter Text',
        agents: '3',
        approval: false,
        priority: '2'
      }));
    });

    // Seite neu laden
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#desc', { state: 'visible', timeout: 10000 });

    // Beschreibung muss wiederhergestellt sein
    const value = await page.inputValue('#desc');
    expect(value).toBe('Wiederhergestellter Text');
  });

  test('Agenten-Anzahl wird nach Seiten-Reload wiederhergestellt', async () => {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#desc', { state: 'visible', timeout: 10000 });

    // Draft mit anderer Agenten-Anzahl in localStorage setzen
    await page.evaluate(() => {
      localStorage.setItem('orchestrator_draft', JSON.stringify({
        desc: 'Projekt mit 7 Agenten',
        agents: '7',
        approval: false,
        priority: '2'
      }));
    });

    // Seite neu laden
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#countSlider', { state: 'visible', timeout: 10000 });

    // Agenten-Anzahl muss auf 7 stehen
    const sliderValue = await page.inputValue('#countSlider');
    expect(sliderValue).toBe('7');

    // Display-Wert pruefen
    const displayText = await page.evaluate(() => {
      var el = document.getElementById('countDisplay');
      return el ? el.textContent : null;
    });
    expect(displayText).toBe('7');
  });

  test('Draft wird nach Projekt-Start geloescht', async () => {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#desc', { state: 'visible', timeout: 10000 });

    // Draft setzen
    await page.evaluate(() => {
      localStorage.setItem('orchestrator_draft', JSON.stringify({
        desc: 'Wird gleich gestartet',
        agents: '3',
        approval: false,
        priority: '2'
      }));
    });

    // Seite neu laden damit Draft wiederhergestellt wird
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#desc', { state: 'visible', timeout: 10000 });

    // Pruefen dass Draft vorhanden ist
    const before = await page.evaluate(() => localStorage.getItem('orchestrator_draft'));
    expect(before).toBeTruthy();

    // Projekt starten via startProject()
    await page.evaluate(() => {
      document.getElementById('startBtn').click();
    });

    // Warten bis startProject() clearDraft() aufgerufen hat
    await page.waitForTimeout(500);

    // Draft muss geloescht sein
    const after = await page.evaluate(() => localStorage.getItem('orchestrator_draft'));
    expect(after).toBeNull();
  });
});
