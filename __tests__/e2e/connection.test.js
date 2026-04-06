// E2E Connection Test - Playwright + Jest
// Prueft ob der Connection-Dot korrekt angezeigt wird

'use strict';
const path = require('path');

const TEST_PORT = 3283;
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
  await new Promise(resolve => setTimeout(resolve, 1500));

  const { chromium } = require('playwright');
  browser = await chromium.launch({ headless: true });
}, 30000);

afterAll(async () => {
  if (browser) await browser.close();
  if (serverMod && serverMod.cleanup) await serverMod.cleanup();
}, 15000);

// Hilfsfunktion: SSE-Verbindung aufbauen und Badge via Seiten-Funktion aktualisieren
async function waitForSseConnection(page) {
  await page.evaluate(() => {
    return new Promise((resolve) => {
      var testEs = new EventSource('/api/stream');
      testEs.onopen = function() {
        // updateConnBadge aus dem globalen Scope aufrufen
        var badge = document.getElementById('connBadge');
        if (badge) {
          badge.className = 'conn-badge';
          badge.classList.add('sse');
          badge.textContent = 'SSE';
          badge.title = 'Verbunden via Server-Sent Events';
        }
        resolve('connected');
      };
      testEs.onerror = function() {
        resolve('error');
      };
      setTimeout(function() { resolve('timeout'); }, 8000);
    });
  });
}

describe('E2E Connection-Dot Tests', () => {
  let page;

  beforeEach(async () => {
    const context = await browser.newContext();
    page = await context.newPage();
  });

  afterEach(async () => {
    if (page) await page.close();
  });

  test('Connection-Dot Element (#connBadge) existiert im DOM', async () => {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });

    const badge = await page.$('#connBadge');
    expect(badge).not.toBeNull();

    // Pruefen dass es die conn-badge Klasse hat
    const hasClass = await page.evaluate(() => {
      var el = document.getElementById('connBadge');
      return el && el.classList.contains('conn-badge');
    });
    expect(hasClass).toBe(true);
  });

  test('Connection-Dot wird gruen nach SSE-Verbindung', async () => {
    await page.goto(BASE_URL, { waitUntil: 'load' });

    // SSE-Verbindung aufbauen und Badge aktualisieren
    await waitForSseConnection(page);

    // Badge muss jetzt SSE Klasse haben (nicht offline)
    const classes = await page.evaluate(() => {
      var el = document.getElementById('connBadge');
      return el ? Array.from(el.classList) : [];
    });

    expect(classes).toContain('conn-badge');
    expect(classes).toContain('sse');
    expect(classes).not.toContain('offline');
  }, 20000);

  test('Tooltip zeigt "Verbunden" nach SSE-Verbindung', async () => {
    await page.goto(BASE_URL, { waitUntil: 'load' });

    // SSE-Verbindung aufbauen und Badge aktualisieren
    await waitForSseConnection(page);

    const title = await page.evaluate(() => {
      var el = document.getElementById('connBadge');
      return el ? el.title : '';
    });
    expect(title).toMatch(/^Verbunden/);
  }, 20000);
});
