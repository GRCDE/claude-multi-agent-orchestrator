// E2E Queue Tests - Playwright + Jest
// Prueft Queue-Anzeige, Setup-Formular, Agent-Count-Slider und Plan-Approval Checkbox

'use strict';
const path = require('path');

const TEST_PORT = 3262;
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

describe('E2E Queue Tests', () => {
  let page;

  beforeEach(async () => {
    const context = await browser.newContext();
    page = await context.newPage();
  });

  afterEach(async () => {
    if (page) await page.close();
  });

  test('Leere Queue wird korrekt angezeigt (kein Queue-Bereich sichtbar)', async () => {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });

    // Bei leerer Queue darf kein .queue-section Element im DOM sein
    const queueSection = await page.$('.queue-section');
    expect(queueSection).toBeNull();

    // Der Slot-Container existiert, ist aber leer
    const slotContent = await page.evaluate(() => {
      const slot = document.querySelector('.queue-section-slot');
      return slot ? slot.innerHTML.trim() : null;
    });
    // Slot existiert und ist leer (kein Queue-HTML gerendert)
    expect(slotContent === '' || slotContent === null).toBe(true);
  });

  test('Projekt-Setup-Formular ist sichtbar und funktional', async () => {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });

    // textarea#desc muss sichtbar sein
    await page.waitForSelector('#desc', { state: 'visible', timeout: 5000 });
    expect(await page.isVisible('#desc')).toBe(true);

    // Start-Button muss sichtbar sein
    await page.waitForSelector('#startBtn', { state: 'visible', timeout: 5000 });
    expect(await page.isVisible('#startBtn')).toBe(true);

    // Textarea editierbar
    await page.fill('#desc', 'Queue-Test Projektbeschreibung');
    const value = await page.inputValue('#desc');
    expect(value).toBe('Queue-Test Projektbeschreibung');

    // countSlider und countDisplay muessen vorhanden sein
    expect(await page.isVisible('#countSlider')).toBe(true);
    expect(await page.isVisible('#countDisplay')).toBe(true);

    // approvalCheck Checkbox muss vorhanden sein
    const approvalCheck = await page.$('#approvalCheck');
    expect(approvalCheck).not.toBeNull();
  });

  test('Agent-Count-Slider funktioniert (Wert aendern, Display pruefen)', async () => {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });

    await page.waitForSelector('#countSlider', { state: 'visible', timeout: 5000 });

    // Startwert pruefen (Default: 3)
    const initialValue = await page.inputValue('#countSlider');
    expect(initialValue).toBe('3');
    const initialDisplay = await page.textContent('#countDisplay');
    expect(initialDisplay).toBe('3');

    // Slider auf 7 setzen per JavaScript (zuverlaessiger als Drag)
    await page.evaluate(() => {
      const slider = document.getElementById('countSlider');
      slider.value = '7';
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // Display muss aktualisiert sein
    const updatedDisplay = await page.textContent('#countDisplay');
    expect(updatedDisplay).toBe('7');

    // aria-valuenow muss aktualisiert sein
    const ariaValue = await page.getAttribute('#countSlider', 'aria-valuenow');
    expect(ariaValue).toBe('7');

    // Auf Minimum setzen
    await page.evaluate(() => {
      const slider = document.getElementById('countSlider');
      slider.value = '2';
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(await page.textContent('#countDisplay')).toBe('2');

    // Auf Maximum setzen
    await page.evaluate(() => {
      const slider = document.getElementById('countSlider');
      slider.value = '10';
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(await page.textContent('#countDisplay')).toBe('10');
  });

  test('Plan-Approval Checkbox funktioniert', async () => {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });

    await page.waitForSelector('#approvalCheck', { timeout: 5000 });

    // Checkbox soll initial unchecked sein
    const initialChecked = await page.isChecked('#approvalCheck');
    expect(initialChecked).toBe(false);

    // Checkbox anklicken
    await page.check('#approvalCheck');
    expect(await page.isChecked('#approvalCheck')).toBe(true);

    // Nochmal klicken -> unchecked
    await page.uncheck('#approvalCheck');
    expect(await page.isChecked('#approvalCheck')).toBe(false);
  });
});
