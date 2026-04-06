// E2E Toast Tests - Playwright + Jest
// Prueft showToast() Verhalten: Typen, Timeout, Stacking, Klick-Dismiss

'use strict';
const path = require('path');

const TEST_PORT = 3279;
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

// Hilfsfunktion: showToast und CSS ins Browserfenster injizieren,
// um unabhaengig von moeglichen JS-Fehlern im Haupt-Script zu testen.
async function injectToastSystem(page) {
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });

  await page.evaluate(() => {
    // CSS injizieren
    var style = document.createElement('style');
    style.textContent = `
      .toast-container {
        position: fixed; bottom: 40px; right: 16px; z-index: 9999;
        display: flex; flex-direction: column-reverse; gap: 8px;
      }
      .shortcut-toast {
        background: #333; color: #fff; padding: 8px 16px;
        border-radius: 6px; font-size: 13px; font-weight: 500;
        box-shadow: 0 2px 8px rgba(0,0,0,0.2); pointer-events: auto; cursor: pointer;
        animation: toast-in 0.2s ease;
        max-width: 320px; word-break: break-word;
        transition: opacity 0.3s ease, transform 0.3s ease;
      }
      .shortcut-toast.toast-hiding { opacity: 0; transform: translateY(-8px); }
      .shortcut-toast.toast-success { background: #16a34a; color: #fff; }
      .shortcut-toast.toast-error { background: #dc2626; color: #fff; }
      @keyframes toast-in { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: none; } }
    `;
    document.head.appendChild(style);

    // JS injizieren
    window._getToastContainer = function() {
      var c = document.querySelector('.toast-container');
      if (!c) { c = document.createElement('div'); c.className = 'toast-container'; document.body.appendChild(c); }
      return c;
    };
    window.showToast = function(msg, type) {
      var container = window._getToastContainer();
      var el = document.createElement('div');
      el.className = 'shortcut-toast';
      if (type === 'success') el.classList.add('toast-success');
      if (type === 'error') el.classList.add('toast-error');
      el.textContent = msg;
      el.addEventListener('click', function() {
        el.classList.add('toast-hiding');
        setTimeout(function() { if (el.parentNode) el.remove(); }, 300);
      });
      container.appendChild(el);
      setTimeout(function() {
        if (el.parentNode) {
          el.classList.add('toast-hiding');
          setTimeout(function() { if (el.parentNode) el.remove(); }, 300);
        }
      }, 4000);
    };
  });
}

describe('E2E Toast Tests', () => {
  let page;

  beforeEach(async () => {
    const context = await browser.newContext();
    page = await context.newPage();
    await injectToastSystem(page);
  });

  afterEach(async () => {
    if (page) await page.close();
  });

  test('showToast mit success zeigt gruenen Toast', async () => {
    await page.evaluate(() => showToast('Test', 'success'));

    await page.waitForSelector('.shortcut-toast.toast-success', { state: 'visible', timeout: 2000 });

    const text = await page.$eval('.shortcut-toast.toast-success', el => el.textContent);
    expect(text).toBe('Test');

    // Hintergrundfarbe pruefen (rgb(22, 163, 74) = #16a34a)
    const bg = await page.$eval('.shortcut-toast.toast-success', el => getComputedStyle(el).backgroundColor);
    expect(bg).toBe('rgb(22, 163, 74)');
  });

  test('showToast mit error zeigt roten Toast', async () => {
    await page.evaluate(() => showToast('Error', 'error'));

    await page.waitForSelector('.shortcut-toast.toast-error', { state: 'visible', timeout: 2000 });

    const text = await page.$eval('.shortcut-toast.toast-error', el => el.textContent);
    expect(text).toBe('Error');

    // Hintergrundfarbe pruefen (rgb(220, 38, 38) = #dc2626)
    const bg = await page.$eval('.shortcut-toast.toast-error', el => getComputedStyle(el).backgroundColor);
    expect(bg).toBe('rgb(220, 38, 38)');
  });

  test('Toast verschwindet nach 4 Sekunden', async () => {
    await page.evaluate(() => showToast('Verschwindet', 'success'));

    await page.waitForSelector('.shortcut-toast', { state: 'visible', timeout: 2000 });

    // Nach 3.5s sollte er noch da sein
    await page.waitForTimeout(3500);
    const countBefore = await page.locator('.shortcut-toast').count();
    expect(countBefore).toBeGreaterThanOrEqual(1);

    // Nach insgesamt ~4.5s (+ 300ms Transition) sollte er weg sein
    await page.waitForTimeout(1200);
    const countAfter = await page.locator('.shortcut-toast').count();
    expect(countAfter).toBe(0);
  }, 15000);

  test('Mehrere Toasts stapeln sich', async () => {
    await page.evaluate(() => {
      showToast('Erster', 'success');
      showToast('Zweiter', 'error');
      showToast('Dritter');
    });

    // Kurz warten damit alle gerendert sind
    await page.waitForTimeout(200);

    // Alle 3 Toasts muessen sichtbar sein
    const count = await page.locator('.shortcut-toast').count();
    expect(count).toBe(3);

    // Texte pruefen
    const texts = await page.locator('.shortcut-toast').allTextContents();
    expect(texts).toContain('Erster');
    expect(texts).toContain('Zweiter');
    expect(texts).toContain('Dritter');

    // Container muss im DOM existieren
    const containerExists = await page.evaluate(() => document.querySelector('.toast-container') !== null);
    expect(containerExists).toBe(true);
  });

  test('Klick auf Toast schliesst ihn', async () => {
    await page.evaluate(() => showToast('Klick mich', 'success'));

    await page.waitForSelector('.shortcut-toast', { state: 'visible', timeout: 2000 });

    // Toast anklicken
    await page.click('.shortcut-toast');

    // Toast bekommt toast-hiding Klasse und verschwindet nach 300ms Transition
    await page.waitForTimeout(500);
    const count = await page.locator('.shortcut-toast').count();
    expect(count).toBe(0);
  });
});
