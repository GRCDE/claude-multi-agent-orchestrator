// E2E File-Viewer Test - Playwright + Jest
// Prueft Dateibaum und Datei-Inhalt Modal

'use strict';

jest.setTimeout(60000);

const path = require('path');
const fs = require('fs');
const http = require('http');

const TEST_PORT = 3267;
const BASE_URL = `http://localhost:${TEST_PORT}`;
const TEST_PROJECT_ID = 'e2e-file-viewer-test';
const PROJECTS_DIR = path.join(__dirname, '..', '..', 'projects');
const PROJECT_DIR = path.join(PROJECTS_DIR, TEST_PROJECT_ID);

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
      this.phase = 'complete';
      this.projectDir = null;
      this.agents = [
        { index: 0, title: 'Test-Agent', status: 'done', task: 'Test-Aufgabe', rounds: 1, tokenUsage: { inputTokens: 100, outputTokens: 200 } }
      ];
      this.startedAt = new Date().toISOString();
    }
    emit(event, data) {
      super.emit('update', { event, data, ts: Date.now() });
      super.emit(event, data);
      return true;
    }
    getState() {
      return {
        phase: this.phase,
        projectDir: this.projectDir,
        agents: this.agents,
        coordinator: { summary: 'Test-Zusammenfassung' },
        totalTokenUsage: { inputTokens: 100, outputTokens: 200, totalTokens: 300, estimatedCost: 0.01 }
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

// ── Hilfsfunktionen ──────────────────────────────────────────

function isPortFree(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/health`, (res) => {
      res.resume();
      resolve(false); // Port besetzt = nicht frei
    });
    req.on('error', () => resolve(true)); // Fehler = Port frei
    req.setTimeout(1000, () => { req.destroy(); resolve(true); });
  });
}

async function waitForServerReady(port, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const free = await isPortFree(port);
    if (!free) return; // Server antwortet
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(`Server did not become ready on port ${port} within ${timeout}ms`);
}

// ── Test Suite ────────────────────────────────────────────────

let browser;
let serverMod;
let orchestratorInstance;

beforeAll(async () => {
  // Test-Projekt-Verzeichnis mit Dateien anlegen
  const agentDir = path.join(PROJECT_DIR, 'agent-0');
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, 'task.md'), '# Test-Aufgabe\nDies ist eine Test-Aufgabe.');
  fs.writeFileSync(path.join(agentDir, 'transcript.md'), '# Transkript\nAgent hat gearbeitet.');
  fs.writeFileSync(path.join(PROJECT_DIR, 'state.json'), JSON.stringify({
    phase: 'complete',
    projectDir: PROJECT_DIR,
    agents: [{ index: 0, title: 'Test-Agent', status: 'done', task: 'Test-Aufgabe' }]
  }));

  // Warten bis Port frei ist (EADDRINUSE vermeiden)
  let portFree = await isPortFree(TEST_PORT);
  if (!portFree) {
    // Bis zu 10s warten bis Port frei wird
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 500));
      portFree = await isPortFree(TEST_PORT);
      if (portFree) break;
    }
    if (!portFree) throw new Error(`Port ${TEST_PORT} is still in use`);
  }

  // Server starten
  process.env.PORT = String(TEST_PORT);
  Object.keys(require.cache).forEach(key => {
    if (key.includes('server.js')) delete require.cache[key];
  });
  serverMod = require('../../server');

  // Orchestrator-Instanz holen und projectDir setzen
  const Orchestrator = require('../../orchestrator');
  orchestratorInstance = serverMod.orchestrator || serverMod._orchestrator;
  if (!orchestratorInstance) {
    // Fallback: suchen in server exports
    const keys = Object.keys(serverMod);
    for (const k of keys) {
      if (serverMod[k] instanceof Orchestrator) {
        orchestratorInstance = serverMod[k];
        break;
      }
    }
  }

  // Warten bis Server tatsaechlich Requests annimmt
  await waitForServerReady(TEST_PORT, 15000);

  // Browser starten
  const { chromium } = require('playwright');
  browser = await chromium.launch({ headless: true });
}, 60000);

afterAll(async () => {
  if (browser) await browser.close();
  if (serverMod && serverMod.cleanup) await serverMod.cleanup();

  // Test-Projekt aufraumen
  try {
    fs.rmSync(PROJECT_DIR, { recursive: true, force: true });
  } catch { /* ignore */ }
}, 15000);

describe('E2E File-Viewer Tests', () => {
  let page;

  beforeEach(async () => {
    const context = await browser.newContext();
    page = await context.newPage();
  });

  afterEach(async () => {
    if (page) await page.close();
  });

  test('Dateibaum-Toggle oeffnet File-Tree Bereich', async () => {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });

    // State auf complete setzen mit projectDir, damit der File-Tree verfuegbar wird
    await page.evaluate((projId) => {
      // Globalen State anpassen
      if (typeof state !== 'undefined') {
        state.phase = 'complete';
        state.projectDir = 'projects/' + projId;
        state.agents = [{ index: 0, title: 'Test-Agent', status: 'done', task: 'Test-Aufgabe', rounds: 1 }];
      }
      // render() aufrufen damit der Dateibaum-Toggle angezeigt wird
      if (typeof render === 'function') render();
    }, TEST_PROJECT_ID);

    // Warten bis der Dateibaum-Toggle sichtbar wird
    await page.waitForFunction(
      () => {
        var toggles = document.querySelectorAll('.file-tree-toggle');
        return toggles.length > 0;
      },
      { timeout: 5000 }
    );

    // Dateibaum ist initial geschlossen
    const contentBefore = await page.evaluate(() => {
      var el = document.getElementById('fileTreeContent');
      return el ? el.style.display : null;
    });
    expect(contentBefore).toBe('none');

    // Dateibaum oeffnen
    await page.evaluate(() => {
      if (typeof toggleFileTree === 'function') toggleFileTree();
    });

    // Warten bis der Content sichtbar ist
    await page.waitForFunction(
      () => {
        var el = document.getElementById('fileTreeContent');
        return el && el.style.display !== 'none';
      },
      { timeout: 5000 }
    );

    const contentAfter = await page.evaluate(() => {
      var el = document.getElementById('fileTreeContent');
      return el ? el.style.display : null;
    });
    expect(contentAfter).not.toBe('none');
  });

  test('Dateibaum zeigt Dateien des Projekts an', async () => {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });

    // State setzen
    await page.evaluate((projId) => {
      if (typeof state !== 'undefined') {
        state.phase = 'complete';
        state.projectDir = 'projects/' + projId;
        state.agents = [{ index: 0, title: 'Test-Agent', status: 'done', task: 'Test-Aufgabe', rounds: 1 }];
      }
      if (typeof render === 'function') render();
    }, TEST_PROJECT_ID);

    // Dateibaum-Toggle abwarten
    await page.waitForFunction(
      () => document.querySelectorAll('.file-tree-toggle').length > 0,
      { timeout: 5000 }
    );

    // Dateibaum oeffnen
    await page.evaluate(() => {
      if (typeof toggleFileTree === 'function') toggleFileTree();
    });

    // Warten bis Dateien geladen sind (file-item Elemente im DOM)
    await page.waitForFunction(
      () => {
        var items = document.querySelectorAll('#fileTreeContent .file-item');
        return items.length > 0;
      },
      { timeout: 8000 }
    );

    // Pruefen dass die erstellten Dateien angezeigt werden
    const fileNames = await page.evaluate(() => {
      var items = document.querySelectorAll('#fileTreeContent .file-name');
      var names = [];
      for (var i = 0; i < items.length; i++) {
        names.push(items[i].textContent);
      }
      return names;
    });

    expect(fileNames).toContain('task.md');
    expect(fileNames).toContain('transcript.md');
  });

  test('Klick auf Datei oeffnet Inhalt im Modal', async () => {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });

    // State setzen
    await page.evaluate((projId) => {
      if (typeof state !== 'undefined') {
        state.phase = 'complete';
        state.projectDir = 'projects/' + projId;
        state.agents = [{ index: 0, title: 'Test-Agent', status: 'done', task: 'Test-Aufgabe', rounds: 1 }];
      }
      if (typeof render === 'function') render();
    }, TEST_PROJECT_ID);

    // Dateibaum oeffnen
    await page.waitForFunction(
      () => document.querySelectorAll('.file-tree-toggle').length > 0,
      { timeout: 5000 }
    );
    await page.evaluate(() => {
      if (typeof toggleFileTree === 'function') toggleFileTree();
    });

    // Warten bis Dateien geladen sind
    await page.waitForFunction(
      () => document.querySelectorAll('#fileTreeContent .file-item').length > 0,
      { timeout: 8000 }
    );

    // Kein Modal vorher
    const modalBefore = await page.$('#fileModal');
    expect(modalBefore).toBeNull();

    // Auf task.md klicken
    await page.evaluate(() => {
      var items = document.querySelectorAll('#fileTreeContent .file-item');
      for (var i = 0; i < items.length; i++) {
        var name = items[i].querySelector('.file-name');
        if (name && name.textContent === 'task.md') {
          items[i].click();
          break;
        }
      }
    });

    // Warten bis Modal erscheint
    await page.waitForSelector('#fileModal', { state: 'attached', timeout: 5000 });

    // Modal muss sichtbar sein
    const modalVisible = await page.isVisible('#fileModal');
    expect(modalVisible).toBe(true);

    // Warten bis Inhalt geladen (nicht mehr "Wird geladen")
    await page.waitForFunction(
      () => {
        var code = document.getElementById('fileContentCode');
        return code && !code.textContent.includes('Wird geladen');
      },
      { timeout: 5000 }
    );

    // Inhalt pruefen
    const content = await page.evaluate(() => {
      var code = document.getElementById('fileContentCode');
      return code ? code.textContent : null;
    });
    expect(content).toContain('Test-Aufgabe');
  });

  test('File-Modal laesst sich schliessen', async () => {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });

    // State setzen
    await page.evaluate((projId) => {
      if (typeof state !== 'undefined') {
        state.phase = 'complete';
        state.projectDir = 'projects/' + projId;
        state.agents = [{ index: 0, title: 'Test-Agent', status: 'done', task: 'Test-Aufgabe', rounds: 1 }];
      }
      if (typeof render === 'function') render();
    }, TEST_PROJECT_ID);

    // Datei-Modal direkt oeffnen via openFileContent
    await page.waitForFunction(
      () => document.querySelectorAll('.file-tree-toggle').length > 0,
      { timeout: 5000 }
    );

    // Modal oeffnen via JavaScript
    await page.evaluate((projId) => {
      // Sicherstellen dass getProjectId den richtigen Wert liefert
      if (typeof state !== 'undefined') {
        state.projectDir = 'projects/' + projId;
      }
      if (typeof openFileContent === 'function') {
        openFileContent('agent-0/task.md');
      }
    }, TEST_PROJECT_ID);

    // Warten bis Modal erscheint
    await page.waitForSelector('#fileModal', { state: 'attached', timeout: 5000 });
    const modalVisible = await page.isVisible('#fileModal');
    expect(modalVisible).toBe(true);

    // Modal ueber closeFileModal schliessen
    await page.evaluate(() => {
      if (typeof closeFileModal === 'function') closeFileModal();
    });

    // Warten bis Modal weg ist
    await page.waitForFunction(
      () => document.getElementById('fileModal') === null,
      { timeout: 5000 }
    );
    const modalAfter = await page.$('#fileModal');
    expect(modalAfter).toBeNull();

    // Nochmal oeffnen und mit Escape schliessen
    await page.evaluate((projId) => {
      if (typeof state !== 'undefined') {
        state.projectDir = 'projects/' + projId;
      }
      if (typeof openFileContent === 'function') {
        openFileContent('agent-0/task.md');
      }
    }, TEST_PROJECT_ID);

    await page.waitForSelector('#fileModal', { state: 'attached', timeout: 5000 });

    // Escape druecken
    await page.keyboard.press('Escape');

    // Modal muss verschwinden
    await page.waitForFunction(
      () => document.getElementById('fileModal') === null,
      { timeout: 5000 }
    );
    const modalAfterEsc = await page.$('#fileModal');
    expect(modalAfterEsc).toBeNull();
  });
});
