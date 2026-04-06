// E2E Clipboard Test - Playwright + Jest
// Prueft copyToClipboard Funktion, Toast-Notification und Copy-Buttons

'use strict';
const path = require('path');
const http = require('http');

jest.setTimeout(60000);

const TEST_PORT = 3287;
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

// ── Hilfsfunktion: Warten bis Port frei ist ──────────────────
function waitForPortFree(port, retries = 10, delay = 500) {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    function check() {
      const tester = http.createServer();
      tester.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && attempt < retries) {
          attempt++;
          setTimeout(check, delay);
        } else {
          reject(err);
        }
      });
      tester.once('listening', () => {
        tester.close(() => resolve());
      });
      tester.listen(port);
    }
    check();
  });
}

// ── Hilfsfunktion: Warten bis Server antwortet ───────────────
function waitForServerReady(url, retries = 20, delay = 500) {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    function check() {
      http.get(url, (res) => {
        res.resume();
        resolve();
      }).on('error', () => {
        if (attempt < retries) {
          attempt++;
          setTimeout(check, delay);
        } else {
          reject(new Error(`Server not ready after ${retries} attempts`));
        }
      });
    }
    check();
  });
}

// ── Test Suite ────────────────────────────────────────────────

let browser;
let serverMod;

beforeAll(async () => {
  await waitForPortFree(TEST_PORT);

  process.env.PORT = String(TEST_PORT);
  Object.keys(require.cache).forEach(key => {
    if (key.includes('server.js')) delete require.cache[key];
  });
  serverMod = require('../../server');

  await waitForServerReady(`http://localhost:${TEST_PORT}/health`);

  const { chromium } = require('playwright');
  browser = await chromium.launch({ headless: true });
}, 60000);

afterAll(async () => {
  if (browser) await browser.close();
  if (serverMod && serverMod.cleanup) await serverMod.cleanup();
}, 30000);

describe('E2E Clipboard Tests', () => {
  let page;
  let context;

  beforeEach(async () => {
    context = await browser.newContext({
      bypassCSP: true
    });
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    page = await context.newPage();

    await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 15000 });
  });

  afterEach(async () => {
    if (page) await page.close();
    if (context) await context.close();
  });

  test('copyToClipboard Funktion existiert als globale Funktion', async () => {
    const fnExists = await page.evaluate(() => {
      return typeof copyToClipboard === 'function';
    });
    expect(fnExists).toBe(true);
  });

  test('copyToClipboard zeigt Toast-Notification an', async () => {
    // copyToClipboard aufrufen
    await page.evaluate(() => {
      copyToClipboard('test-inhalt', 'Test-Label');
    });

    // Warten bis Toast im DOM erscheint
    await page.waitForFunction(
      () => {
        var toast = document.querySelector('.shortcut-toast');
        return toast !== null && toast.textContent.includes('kopiert');
      },
      { timeout: 5000 }
    );

    const toastText = await page.evaluate(() => {
      var toast = document.querySelector('.shortcut-toast');
      return toast ? toast.textContent : null;
    });
    expect(toastText).toContain('Test-Label');
    expect(toastText).toContain('kopiert');
  });

  test('Copy-Buttons (.btn-copy-inline) sind in der UI vorhanden wenn Projekt aktiv', async () => {
    // CSS-Klasse .btn-copy-inline muss im Stylesheet definiert sein
    const styleExists = await page.evaluate(() => {
      var sheets = document.styleSheets;
      for (var i = 0; i < sheets.length; i++) {
        try {
          var rules = sheets[i].cssRules || sheets[i].rules;
          for (var j = 0; j < rules.length; j++) {
            if (rules[j].selectorText && rules[j].selectorText.includes('.btn-copy-inline')) {
              return true;
            }
          }
        } catch (e) { /* cross-origin */ }
      }
      return false;
    });
    expect(styleExists).toBe(true);

    // Simuliere Projekt-Status mit projectDir und projectId um Copy-Buttons zu erzeugen
    const hasCopyButtons = await page.evaluate(() => {
      if (typeof state !== 'undefined') {
        state.phase = 'complete';
        state.projectDir = '/tmp/test-project';
        state.projectId = 'test-123';
        state.agents = [];
        state.coordinator = { status: 'done', summary: 'Fertig' };
      }
      if (typeof render === 'function') render();
      var buttons = document.querySelectorAll('.btn-copy-inline');
      return buttons.length;
    });
    expect(hasCopyButtons).toBeGreaterThanOrEqual(1);
  });
});
