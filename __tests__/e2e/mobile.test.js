// E2E Mobile-Responsive Tests - Playwright + Jest
// Prueft ob das Layout sich korrekt an verschiedene Viewport-Groessen anpasst

'use strict';
const path = require('path');

const TEST_PORT = 3270;
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

describe('E2E Mobile-Responsive Tests', () => {
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

  test('Desktop (1920x1080): Setup-Form zentriert, alle Toolbar-Buttons sichtbar', async () => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });

    // Setup-Box muss zentriert sein (margin auto)
    const setupBox = await page.waitForSelector('.setup-box', { state: 'visible', timeout: 5000 });
    const setupBounding = await setupBox.boundingBox();
    expect(setupBounding).not.toBeNull();

    // Pruefen dass Setup-Box horizontal zentriert ist (mit Toleranz)
    const viewportWidth = 1920;
    const setupCenter = setupBounding.x + setupBounding.width / 2;
    const viewportCenter = viewportWidth / 2;
    // Toleranz: 100px (wegen Scrollbar etc.)
    expect(Math.abs(setupCenter - viewportCenter)).toBeLessThan(100);

    // Alle Toolbar-Buttons muessen sichtbar sein
    for (const id of ['#settingsToggle', '#themeToggle', '#soundToggle', '#activityToggle', '#analyticsToggle']) {
      const visible = await page.isVisible(id);
      expect(visible).toBe(true);
    }

    // Toolbar darf nicht umgebrochen sein (alle Buttons auf einer Zeile)
    const topControls = await page.$('.top-controls');
    const controlsBounding = await topControls.boundingBox();
    // Bei Desktop sollte die Toolbar-Hoehe unter 60px bleiben (eine Zeile)
    expect(controlsBounding.height).toBeLessThan(60);

    expect(jsErrors).toEqual([]);
  });

  test('Tablet (768x1024): Layout passt sich an, keine horizontale Scrollbar', async () => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });

    // Keine horizontale Scrollbar: documentElement.scrollWidth <= viewport width
    const hasHorizontalScroll = await page.evaluate(() => {
      return document.documentElement.scrollWidth > document.documentElement.clientWidth;
    });
    expect(hasHorizontalScroll).toBe(false);

    // Setup-Box muss volle Breite nutzen (max-width: 100% bei <= 768px)
    const setupBox = await page.$('.setup-box');
    const setupBounding = await setupBox.boundingBox();
    expect(setupBounding).not.toBeNull();
    // Setup-Box sollte mindestens 90% der Viewport-Breite nutzen oder max-width haben
    // Bei 768px greift max-width: 100% mit padding
    expect(setupBounding.width).toBeGreaterThan(600);

    // Top-Controls muessen noch sichtbar sein
    const topControls = await page.$('.top-controls');
    const controlsVisible = await topControls.isVisible();
    expect(controlsVisible).toBe(true);

    expect(jsErrors).toEqual([]);
  });

  test('Mobile (375x667): Single-Column, Modals fullscreen, Toolbar wrapped', async () => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });

    // Toolbar muss flex-wrap haben (Buttons umbrechen)
    const topControlsStyle = await page.evaluate(() => {
      const el = document.querySelector('.top-controls');
      if (!el) return null;
      const style = window.getComputedStyle(el);
      return {
        flexWrap: style.flexWrap,
        maxWidth: style.maxWidth
      };
    });
    expect(topControlsStyle).not.toBeNull();
    expect(topControlsStyle.flexWrap).toBe('wrap');

    // Settings-Modal oeffnen und pruefen ob es fast fullscreen ist
    await page.evaluate(() => {
      document.getElementById('settingsToggle').click();
    });
    await page.waitForFunction(
      () => document.getElementById('settingsModal') !== null,
      { timeout: 5000 }
    );

    const modalStyle = await page.evaluate(() => {
      const modal = document.querySelector('#settingsModal .modal');
      if (!modal) return null;
      const rect = modal.getBoundingClientRect();
      return {
        width: rect.width,
        maxWidth: window.getComputedStyle(modal).maxWidth
      };
    });
    expect(modalStyle).not.toBeNull();
    // Modal sollte mindestens 90% der Viewport-Breite nutzen
    expect(modalStyle.width).toBeGreaterThan(375 * 0.90);

    // Modal schliessen
    await page.evaluate(() => {
      if (typeof closeSettings === 'function') closeSettings();
    });

    expect(jsErrors).toEqual([]);
  });

  test('Agent-Cards stapeln sich vertikal auf Mobile (375px)', async () => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });

    // agent-grid muss grid-template-columns: 1fr haben auf Mobile
    const gridStyle = await page.evaluate(() => {
      const grid = document.querySelector('.agent-grid');
      if (!grid) return null;
      const style = window.getComputedStyle(grid);
      return {
        gridTemplateColumns: style.gridTemplateColumns,
        display: style.display
      };
    });

    // agent-grid existiert im DOM (auch wenn leer)
    if (gridStyle) {
      // Bei 375px sollte grid-template-columns auf 1fr stehen (Single-Column)
      // Der computed value von "1fr" ist die tatsaechliche Pixel-Breite
      const columns = gridStyle.gridTemplateColumns;
      // Entweder "1fr" oder ein einzelner Pixel-Wert (keine Leerzeichen = eine Spalte)
      const columnCount = columns.split(/\s+/).length;
      expect(columnCount).toBe(1);
    }

    // Auch pruefen: Kein horizontales Scrollen
    const hasHorizontalScroll = await page.evaluate(() => {
      return document.documentElement.scrollWidth > document.documentElement.clientWidth;
    });
    expect(hasHorizontalScroll).toBe(false);

    expect(jsErrors).toEqual([]);
  });

  test('Settings-Modal nimmt volle Breite auf Mobile (375px)', async () => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });

    // Settings oeffnen
    await page.evaluate(() => {
      document.getElementById('settingsToggle').click();
    });
    await page.waitForFunction(
      () => document.getElementById('settingsModal') !== null,
      { timeout: 5000 }
    );

    // Warten bis Tab-Bar erstellt wird
    await page.waitForFunction(
      () => document.querySelector('.settings-tab-bar') !== null,
      { timeout: 5000 }
    );

    // Settings-Modal muss fast die volle Breite nutzen
    const modalInfo = await page.evaluate(() => {
      const settingsModal = document.querySelector('#settingsModal .settings-modal');
      if (!settingsModal) return null;
      const rect = settingsModal.getBoundingClientRect();
      const style = window.getComputedStyle(settingsModal);
      return {
        width: rect.width,
        maxWidth: style.maxWidth,
        viewportWidth: window.innerWidth
      };
    });
    expect(modalInfo).not.toBeNull();
    // Settings-Modal sollte mindestens 90% des Viewports einnehmen
    expect(modalInfo.width).toBeGreaterThan(modalInfo.viewportWidth * 0.90);

    // Settings-Aktionen muessen gestackt sein (flex-direction: column)
    const actionsStyle = await page.evaluate(() => {
      const actions = document.querySelector('.settings-actions');
      if (!actions) return null;
      return window.getComputedStyle(actions).flexDirection;
    });
    if (actionsStyle) {
      expect(actionsStyle).toBe('column');
    }

    // Modal schliessen
    await page.evaluate(() => {
      if (typeof closeSettings === 'function') closeSettings();
    });
    await page.waitForFunction(
      () => document.getElementById('settingsModal') === null,
      { timeout: 5000 }
    );

    expect(jsErrors).toEqual([]);
  });
});
