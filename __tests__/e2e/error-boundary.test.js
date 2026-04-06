// E2E Error Boundary Test - Playwright + Jest
// Prueft ob das Error-Banner korrekt angezeigt und geschlossen werden kann

'use strict';

const TEST_PORT = 3285;
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

describe('E2E Error Boundary Tests', () => {
  let page;

  beforeEach(async () => {
    const context = await browser.newContext();
    page = await context.newPage();
  });

  afterEach(async () => {
    if (page) await page.close();
  });

  test('Error-Banner ist initial nicht sichtbar', async () => {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });

    // Banner-Element existiert im DOM
    const banner = await page.$('#errorBanner');
    expect(banner).not.toBeNull();

    // Aber es ist nicht sichtbar (display: none, keine .visible Klasse)
    const isVisible = await page.isVisible('#errorBanner');
    expect(isVisible).toBe(false);

    const hasVisibleClass = await page.evaluate(() => {
      return document.getElementById('errorBanner').classList.contains('visible');
    });
    expect(hasVisibleClass).toBe(false);
  });

  test('Simulierter JS-Fehler zeigt Banner', async () => {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });

    // Banner sollte initial nicht sichtbar sein
    expect(await page.isVisible('#errorBanner')).toBe(false);

    // Fehler ueber _showErrorBanner ausloesen
    await page.evaluate(() => {
      window._showErrorBanner('Test-Fehler aufgetreten');
    });

    // Banner muss jetzt sichtbar sein
    await page.waitForSelector('#errorBanner.visible', { timeout: 3000 });
    expect(await page.isVisible('#errorBanner')).toBe(true);

    // Fehlermeldung pruefen
    const msg = await page.textContent('#errorBannerMsg');
    expect(msg).toBe('Test-Fehler aufgetreten');
  });

  test('Banner enthaelt "Seite neu laden" Button', async () => {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });

    // Banner anzeigen
    await page.evaluate(() => {
      window._showErrorBanner('Fehler');
    });

    await page.waitForSelector('#errorBanner.visible', { timeout: 3000 });

    // "Seite neu laden" Button suchen
    const reloadBtn = await page.$('#errorBanner .error-banner-reload');
    expect(reloadBtn).not.toBeNull();

    const btnText = await reloadBtn.textContent();
    expect(btnText).toContain('Seite neu laden');
  });

  test('Dismiss schliesst Banner', async () => {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });

    // Banner anzeigen
    await page.evaluate(() => {
      window._showErrorBanner('Dismiss-Test');
    });

    await page.waitForSelector('#errorBanner.visible', { timeout: 3000 });
    expect(await page.isVisible('#errorBanner')).toBe(true);

    // Dismiss-Button klicken
    await page.evaluate(() => {
      document.getElementById('errorBannerDismiss').click();
    });

    // Banner muss verschwunden sein
    await page.waitForFunction(
      () => !document.getElementById('errorBanner').classList.contains('visible'),
      { timeout: 3000 }
    );
    expect(await page.isVisible('#errorBanner')).toBe(false);
  });
});
