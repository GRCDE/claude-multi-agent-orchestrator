// E2E Cost-Banner Test - Playwright + Jest
// Prueft ob showCostBanner() und dismissCostBanner() korrekt funktionieren

'use strict';
const path = require('path');

const TEST_PORT = 3284;
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

describe('E2E Cost-Banner Tests', () => {
  let page;

  beforeEach(async () => {
    const context = await browser.newContext();
    page = await context.newPage();
  });

  afterEach(async () => {
    if (page) await page.close();
  });

  test('Cost-Banner Element existiert und ist standardmaessig versteckt', async () => {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });

    const exists = await page.evaluate(() => {
      var el = document.getElementById('costBanner');
      return el !== null;
    });
    expect(exists).toBe(true);

    const hidden = await page.evaluate(() => {
      var el = document.getElementById('costBanner');
      return el.style.display === 'none';
    });
    expect(hidden).toBe(true);
  });

  test('showCostBanner("warn", "Test") zeigt gelbes Banner', async () => {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });

    await page.evaluate(() => {
      showCostBanner('warn', 'Test Warnung');
    });

    const result = await page.evaluate(() => {
      var el = document.getElementById('costBanner');
      return {
        visible: el.style.display !== 'none',
        text: el.textContent,
        hasWarnClass: el.classList.contains('warn'),
        hasErrorClass: el.classList.contains('error')
      };
    });

    expect(result.visible).toBe(true);
    expect(result.text).toBe('Test Warnung');
    expect(result.hasWarnClass).toBe(true);
    expect(result.hasErrorClass).toBe(false);
  });

  test('showCostBanner("error", "Test") zeigt rotes Banner', async () => {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });

    await page.evaluate(() => {
      showCostBanner('error', 'Budget ueberschritten');
    });

    const result = await page.evaluate(() => {
      var el = document.getElementById('costBanner');
      return {
        visible: el.style.display !== 'none',
        text: el.textContent,
        hasWarnClass: el.classList.contains('warn'),
        hasErrorClass: el.classList.contains('error')
      };
    });

    expect(result.visible).toBe(true);
    expect(result.text).toBe('Budget ueberschritten');
    expect(result.hasWarnClass).toBe(false);
    expect(result.hasErrorClass).toBe(true);
  });

  test('dismissCostBanner() versteckt das Banner', async () => {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });

    // Erst anzeigen
    await page.evaluate(() => {
      showCostBanner('warn', 'Wird gleich geschlossen');
    });

    // Pruefen dass es sichtbar ist
    const visibleBefore = await page.evaluate(() => {
      var el = document.getElementById('costBanner');
      return el.style.display !== 'none';
    });
    expect(visibleBefore).toBe(true);

    // Dann schliessen
    await page.evaluate(() => {
      dismissCostBanner();
    });

    const result = await page.evaluate(() => {
      var el = document.getElementById('costBanner');
      return {
        hidden: el.style.display === 'none',
        text: el.textContent,
        className: el.className
      };
    });

    expect(result.hidden).toBe(true);
    expect(result.text).toBe('');
    expect(result.className).toBe('cost-banner');
  });
});
