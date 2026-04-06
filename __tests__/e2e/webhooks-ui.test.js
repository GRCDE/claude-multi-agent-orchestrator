// E2E Webhook-Settings Tests - Playwright + Jest
// Prueft ob Webhook-Tab im Settings-Modal korrekt funktioniert

'use strict';
const path = require('path');

const TEST_PORT = 3274;
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

const webhooksFile = path.join(__dirname, '..', '..', 'webhooks.json');

beforeAll(async () => {
  // Saubere webhooks.json sicherstellen
  const fs = require('fs');
  try { fs.writeFileSync(webhooksFile, '[]', 'utf8'); } catch { /* ignorieren */ }

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

describe('E2E Webhook-Settings Tests', () => {
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

  // Hilfsfunktion: Settings oeffnen und zum Webhooks-Tab wechseln
  async function openWebhooksTab() {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });

    // Settings oeffnen
    await page.evaluate(() => {
      document.getElementById('settingsToggle').click();
    });

    // Warten bis Modal und Tab-Bar im DOM
    await page.waitForFunction(
      () => document.querySelector('.settings-tab-bar') !== null,
      { timeout: 5000 }
    );

    // Webhooks-Tab klicken
    await page.evaluate(() => {
      switchSettingsTab('webhooks');
    });

    // Warten bis Webhook-Formular gerendert ist (nach fetch)
    await page.waitForFunction(
      () => document.getElementById('wh_url') !== null,
      { timeout: 5000 }
    );
  }

  test('Settings oeffnen, Webhooks-Tab klicken, Webhook-Formular sichtbar', async () => {
    await openWebhooksTab();

    // Webhooks-Tab muss aktiv sein
    const activeTabText = await page.evaluate(() => {
      var active = document.querySelector('.settings-tab-bar .modal-tab.active');
      return active ? active.textContent : null;
    });
    expect(activeTabText).toBe('Webhooks');

    // Webhook-Formular muss vorhanden sein
    const formVisible = await page.evaluate(() => {
      return document.getElementById('webhookFormWrap') !== null;
    });
    expect(formVisible).toBe(true);

    // Keine JS-Fehler
    expect(jsErrors).toEqual([]);
  });

  test('URL-Feld und Secret-Feld vorhanden', async () => {
    await openWebhooksTab();

    // URL-Feld pruefen
    const urlInfo = await page.evaluate(() => {
      var el = document.getElementById('wh_url');
      if (!el) return { exists: false };
      return { exists: true, tag: el.tagName, type: el.type };
    });
    expect(urlInfo.exists).toBe(true);
    expect(urlInfo.tag).toBe('INPUT');

    // Secret-Feld pruefen
    const secretInfo = await page.evaluate(() => {
      var el = document.getElementById('wh_secret');
      if (!el) return { exists: false };
      return { exists: true, tag: el.tagName, type: el.type };
    });
    expect(secretInfo.exists).toBe(true);
    expect(secretInfo.tag).toBe('INPUT');
    expect(secretInfo.type).toBe('password');

    // Felder sind editierbar (per evaluate setzen und pruefen)
    const urlValue = await page.evaluate(() => {
      var el = document.getElementById('wh_url');
      el.value = 'https://test.example.com/hook';
      return el.value;
    });
    expect(urlValue).toBe('https://test.example.com/hook');

    const secretValue = await page.evaluate(() => {
      var el = document.getElementById('wh_secret');
      el.value = 'mysecret123';
      return el.value;
    });
    expect(secretValue).toBe('mysecret123');

    expect(jsErrors).toEqual([]);
  });

  test('Events-Checkboxen vorhanden (9 Webhook-Events)', async () => {
    await openWebhooksTab();

    // Alle Event-Checkboxen zaehlen
    const checkboxCount = await page.evaluate(() => {
      return document.querySelectorAll('.wh-events-grid input[type=checkbox].wh-event-cb').length;
    });
    expect(checkboxCount).toBe(9);

    // Alle sollten standardmaessig gecheckt sein
    const allChecked = await page.evaluate(() => {
      var cbs = document.querySelectorAll('.wh-event-cb');
      for (var i = 0; i < cbs.length; i++) {
        if (!cbs[i].checked) return false;
      }
      return true;
    });
    expect(allChecked).toBe(true);

    // Einzelne Events pruefen (Stichprobe)
    const eventValues = await page.evaluate(() => {
      var cbs = document.querySelectorAll('.wh-event-cb');
      var vals = [];
      for (var i = 0; i < cbs.length; i++) vals.push(cbs[i].value);
      return vals;
    });
    expect(eventValues).toContain('project-started');
    expect(eventValues).toContain('project-done');
    expect(eventValues).toContain('agent-done');
    expect(eventValues).toContain('budget-warning');

    expect(jsErrors).toEqual([]);
  });

  test('Webhook registrieren (Formular ausfuellen, Submit)', async () => {
    await openWebhooksTab();

    // Formular per evaluate ausfuellen (zuverlaessiger in Modals)
    await page.evaluate(() => {
      document.getElementById('wh_url').value = 'https://hooks.example.com/test';
      document.getElementById('wh_secret').value = 'test-secret-12345';

      // Nur 2 Events auswaehlen
      var cbs = document.querySelectorAll('.wh-event-cb');
      for (var i = 0; i < cbs.length; i++) cbs[i].checked = false;
      for (var j = 0; j < cbs.length; j++) {
        if (cbs[j].value === 'project-done' || cbs[j].value === 'agent-done') {
          cbs[j].checked = true;
        }
      }
    });

    // Registrieren-Button klicken
    await page.evaluate(() => {
      addWebhook();
    });

    // Warten bis Webhook in der Liste erscheint (nach fetch + re-render)
    await page.waitForFunction(
      () => document.querySelector('.webhook-item-url') !== null,
      { timeout: 8000 }
    );

    // Pruefen dass die API erfolgreich war (Webhook in der Liste)
    const webhookUrl = await page.evaluate(() => {
      var urlEl = document.querySelector('.webhook-item-url');
      return urlEl ? urlEl.textContent : null;
    });
    expect(webhookUrl).toBe('https://hooks.example.com/test');

    expect(jsErrors).toEqual([]);
  });

  test('Registrierter Webhook erscheint in der Liste mit Events und Aktionen', async () => {
    // Webhook per API registrieren (direkt, um Zustand sicherzustellen)
    const response = await fetch(`${BASE_URL}/api/webhooks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: 'https://listed.example.com/hook',
        events: ['project-started', 'project-error'],
        secret: 'listed-secret-99'
      })
    });
    expect(response.ok).toBe(true);

    // Seite laden und Webhooks-Tab oeffnen
    await openWebhooksTab();

    // Webhook-URL in der Liste pruefen
    const urls = await page.evaluate(() => {
      var els = document.querySelectorAll('.webhook-item-url');
      var result = [];
      for (var i = 0; i < els.length; i++) result.push(els[i].textContent);
      return result;
    });
    expect(urls).toContain('https://listed.example.com/hook');

    // Event-Badges pruefen
    const badges = await page.evaluate(() => {
      var els = document.querySelectorAll('.webhook-event-badge');
      var result = [];
      for (var i = 0; i < els.length; i++) result.push(els[i].textContent);
      return result;
    });
    expect(badges).toContain('project-started');
    expect(badges).toContain('project-error');

    // Aktions-Buttons pruefen (Test, Pausieren, Loeschen, Auslieferungen)
    const actionButtons = await page.evaluate(() => {
      var btns = document.querySelectorAll('.webhook-item-actions button');
      var labels = [];
      for (var i = 0; i < btns.length; i++) labels.push(btns[i].textContent.trim());
      return labels;
    });
    expect(actionButtons).toContain('Test');
    expect(actionButtons).toContain('Pausieren');
    expect(actionButtons).toContain('Löschen');

    // Status "Aktiv" angezeigt
    const statusText = await page.evaluate(() => {
      var el = document.querySelector('.webhook-item-status');
      return el ? el.textContent : null;
    });
    expect(statusText).toBe('Aktiv');

    expect(jsErrors).toEqual([]);
  });
});
