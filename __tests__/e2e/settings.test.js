// E2E Settings Tabs Test - Playwright + Jest
// Prueft ob die Settings-Tabs korrekt rendern und funktionieren

'use strict';
const path = require('path');

const TEST_PORT = 3263;
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
      this.profileManager = {
        listProfiles: () => [
          { name: 'Default', description: 'Standard-Konfiguration', isDefault: true, isActive: false },
          { name: 'Performance', description: 'Optimiert fuer Speed', isDefault: true, isActive: false },
          { name: 'Quality', description: 'Maximale Qualitaet', isDefault: true, isActive: false },
        ],
        getActiveProfile: () => null,
        saveProfile: () => ({}),
        deleteProfile: () => {},
        loadProfile: () => ({}),
      };
      this.snapshotManager = {
        listAllSnapshots: async () => [],
        listSnapshots: async () => [],
      };
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
    getProfiles() {
      return this.profileManager.listProfiles();
    }
    getActiveProfile() {
      return this.profileManager.getActiveProfile();
    }
    async getSnapshots() {
      return this.snapshotManager.listAllSnapshots();
    }
    applyProfile() { return { ok: true }; }
    async createSnapshot() { return { snapshotId: 'snap_test', name: 'Test' }; }
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

// Hilfsfunktion: Settings-Modal oeffnen und Tab-Bar abwarten
async function openSettingsAndWaitForTabs(page) {
  await page.evaluate(() => {
    document.getElementById('settingsToggle').click();
  });
  await page.waitForFunction(
    () => document.getElementById('settingsModal') !== null,
    { timeout: 5000 }
  );
  await page.waitForFunction(
    () => document.querySelector('.settings-tab-bar') !== null,
    { timeout: 5000 }
  );
}

describe('E2E Settings Tabs', () => {
  let page;
  const jsErrors = [];

  beforeEach(async () => {
    const context = await browser.newContext();
    page = await context.newPage();
    page.on('pageerror', err => jsErrors.push(err.message));
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  });

  afterEach(async () => {
    if (page) await page.close();
    jsErrors.length = 0;
  });

  test('Settings-Modal oeffnet mit Allgemein-Tab aktiv', async () => {
    await openSettingsAndWaitForTabs(page);

    // Allgemein-Tab muss aktiv sein
    const activeTabText = await page.evaluate(() => {
      var active = document.querySelector('.settings-tab-bar .modal-tab.active');
      return active ? active.textContent : null;
    });
    expect(activeTabText).toBe('Allgemein');

    // Allgemein-Tab-Inhalt muss sichtbar sein
    const generalVisible = await page.evaluate(() => {
      var el = document.getElementById('settingsTabGeneral');
      return el && el.style.display !== 'none';
    });
    expect(generalVisible).toBe(true);

    // Andere Tabs muessen verborgen sein
    const webhooksHidden = await page.evaluate(() => {
      var el = document.getElementById('webhooksTabContent');
      return el && el.style.display === 'none';
    });
    expect(webhooksHidden).toBe(true);

    expect(jsErrors).toEqual([]);
  });

  test('Webhooks-Tab zeigt Webhook-Formular', async () => {
    await openSettingsAndWaitForTabs(page);

    // Zum Webhooks-Tab wechseln
    await page.evaluate(() => { switchSettingsTab('webhooks'); });
    await page.waitForTimeout(500);

    // Webhooks-Tab muss aktiv sein
    const activeTabText = await page.evaluate(() => {
      var active = document.querySelector('.settings-tab-bar .modal-tab.active');
      return active ? active.textContent : null;
    });
    expect(activeTabText).toBe('Webhooks');

    // Webhook-Formular muss vorhanden sein (URL-Input, Secret-Input, Registrieren-Button)
    const hasForm = await page.evaluate(() => {
      var container = document.getElementById('webhooksTabContent');
      if (!container || container.style.display === 'none') return false;
      var urlInput = container.querySelector('#wh_url') || container.querySelector('input[placeholder*="https"]');
      var secretInput = container.querySelector('#wh_secret') || container.querySelector('input[type="password"]');
      return !!(urlInput && secretInput);
    });
    expect(hasForm).toBe(true);

    expect(jsErrors).toEqual([]);
  });

  test('Profile-Tab zeigt Profil-Liste (3 Default-Profile)', async () => {
    await openSettingsAndWaitForTabs(page);

    // Zum Profile-Tab wechseln
    await page.evaluate(() => { switchSettingsTab('profiles'); });
    await page.waitForTimeout(500);

    // Profile-Tab muss aktiv sein
    const activeTabText = await page.evaluate(() => {
      var active = document.querySelector('.settings-tab-bar .modal-tab.active');
      return active ? active.textContent : null;
    });
    expect(activeTabText).toBe('Profile');

    // Warten auf Profil-Rendering (fetch + render)
    await page.waitForFunction(
      () => {
        var container = document.getElementById('profilesTabContent');
        return container && container.textContent.includes('Default');
      },
      { timeout: 5000 }
    );

    // 3 Profile muessen sichtbar sein
    const profileNames = await page.evaluate(() => {
      var container = document.getElementById('profilesTabContent');
      if (!container) return [];
      var strongs = container.querySelectorAll('strong');
      var names = [];
      for (var i = 0; i < strongs.length; i++) {
        names.push(strongs[i].textContent);
      }
      return names;
    });
    expect(profileNames).toContain('Default');
    expect(profileNames).toContain('Performance');
    expect(profileNames).toContain('Quality');
    expect(profileNames.length).toBe(3);

    expect(jsErrors).toEqual([]);
  });

  test('Snapshots-Tab zeigt Snapshot-Liste', async () => {
    await openSettingsAndWaitForTabs(page);

    // Zum Snapshots-Tab wechseln
    await page.evaluate(() => { switchSettingsTab('snapshots'); });
    await page.waitForTimeout(500);

    // Snapshots-Tab muss aktiv sein
    const activeTabText = await page.evaluate(() => {
      var active = document.querySelector('.settings-tab-bar .modal-tab.active');
      return active ? active.textContent : null;
    });
    expect(activeTabText).toBe('Snapshots');

    // Warten bis der Tab geladen hat
    await page.waitForFunction(
      () => {
        var container = document.getElementById('snapshotsTabContent');
        return container && !container.textContent.includes('Lade Snapshots');
      },
      { timeout: 5000 }
    );

    // Snapshot-Tab muss sichtbar sein und Input + Button fuer neuen Snapshot haben
    const hasSnapshotUI = await page.evaluate(() => {
      var container = document.getElementById('snapshotsTabContent');
      if (!container || container.style.display === 'none') return false;
      var nameInput = container.querySelector('#snapshotNameInput') || container.querySelector('input[placeholder*="Snapshot"]');
      var createBtn = container.querySelector('button');
      return !!(nameInput && createBtn);
    });
    expect(hasSnapshotUI).toBe(true);

    // Ueberschrift muss vorhanden sein
    const hasTitle = await page.evaluate(() => {
      var container = document.getElementById('snapshotsTabContent');
      return container && container.textContent.includes('Projekt-Snapshots');
    });
    expect(hasTitle).toBe(true);

    expect(jsErrors).toEqual([]);
  });

  test('Logs-Tab zeigt Log-Eintraege mit Level-Filter-Buttons', async () => {
    await openSettingsAndWaitForTabs(page);

    // Zum Logs-Tab wechseln
    await page.evaluate(() => { switchSettingsTab('logs'); });
    await page.waitForTimeout(500);

    // Logs-Tab muss aktiv sein
    const activeTabText = await page.evaluate(() => {
      var active = document.querySelector('.settings-tab-bar .modal-tab.active');
      return active ? active.textContent : null;
    });
    expect(activeTabText).toBe('Logs');

    // Warten bis der Tab geladen hat (nicht mehr "Lade Logs...")
    await page.waitForFunction(
      () => {
        var container = document.getElementById('logsTabContent');
        return container && !container.textContent.includes('Lade Logs');
      },
      { timeout: 5000 }
    );

    // Level-Filter Buttons muessen vorhanden sein: Alle, Info, Warn, Error
    const filterLabels = await page.evaluate(() => {
      var container = document.getElementById('logsTabContent');
      if (!container) return [];
      var buttons = container.querySelectorAll('button');
      var labels = [];
      for (var i = 0; i < buttons.length; i++) {
        var text = buttons[i].textContent.trim();
        if (['Alle', 'Info', 'Warn', 'Error'].indexOf(text) !== -1) {
          labels.push(text);
        }
      }
      return labels;
    });
    expect(filterLabels).toContain('Alle');
    expect(filterLabels).toContain('Info');
    expect(filterLabels).toContain('Warn');
    expect(filterLabels).toContain('Error');

    // Suchfeld muss vorhanden sein
    const hasSearch = await page.evaluate(() => {
      var container = document.getElementById('logsTabContent');
      return container && !!(container.querySelector('#logsSearchInput') || container.querySelector('input[placeholder*="Suche"]'));
    });
    expect(hasSearch).toBe(true);

    expect(jsErrors).toEqual([]);
  });

  test('Alle Tabs schliessen korrekt wenn Modal geschlossen wird', async () => {
    await openSettingsAndWaitForTabs(page);

    // Durch alle Tabs klicken
    const tabNames = ['webhooks', 'profiles', 'snapshots', 'logs', 'general'];
    for (const tab of tabNames) {
      await page.evaluate((t) => { switchSettingsTab(t); }, tab);
      await page.waitForTimeout(200);
    }

    // Modal schliessen
    await page.evaluate(() => {
      if (typeof closeSettings === 'function') closeSettings();
    });

    // Warten bis Modal entfernt ist
    await page.waitForFunction(
      () => document.getElementById('settingsModal') === null,
      { timeout: 5000 }
    );

    // Modal darf nicht mehr im DOM sein
    const modalGone = await page.$('#settingsModal');
    expect(modalGone).toBeNull();

    // Erneut oeffnen muss funktionieren
    await openSettingsAndWaitForTabs(page);

    // Allgemein-Tab muss wieder aktiv sein
    const activeTabText = await page.evaluate(() => {
      var active = document.querySelector('.settings-tab-bar .modal-tab.active');
      return active ? active.textContent : null;
    });
    expect(activeTabText).toBe('Allgemein');

    // Schliessen via Escape
    await page.keyboard.press('Escape');
    await page.waitForFunction(
      () => document.getElementById('settingsModal') === null,
      { timeout: 5000 }
    );
    const modalGone2 = await page.$('#settingsModal');
    expect(modalGone2).toBeNull();

    expect(jsErrors).toEqual([]);
  });
});
