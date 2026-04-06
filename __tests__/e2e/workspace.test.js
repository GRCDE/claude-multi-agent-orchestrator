// E2E Workspace View Test - Playwright + Jest
// Prueft ob die Workspace-Ansicht (Karten/Timeline/Graph) korrekt funktioniert

'use strict';
const path = require('path');

const TEST_PORT = 3278;
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
      this.phase = 'running';
      this.agents = [
        { title: 'Agent 1', task: 'Aufgabe 1', status: 'done', output: 'Ergebnis 1', rounds: 2, tokenUsage: { inputTokens: 100, outputTokens: 200, totalTokens: 300 }, score: { overall: 85 }, fileChanges: [] },
        { title: 'Agent 2', task: 'Aufgabe 2', status: 'working', output: '', rounds: 1, tokenUsage: { inputTokens: 50, outputTokens: 100, totalTokens: 150 }, score: null, fileChanges: [] },
        { title: 'Agent 3', task: 'Aufgabe 3', status: 'pending', output: '', rounds: 0, tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, score: null, fileChanges: [] },
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
        agents: this.agents,
        coordinator: { status: 'done', plan: 'Testplan' },
        totalTokenUsage: { inputTokens: 150, outputTokens: 300, totalTokens: 450, estimatedCost: 0.01 },
        projectId: 'test-workspace',
        title: 'Workspace Test Projekt',
        startedAt: this.startedAt,
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

describe('E2E Workspace View Tests', () => {
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

  test('Workspace View-Toggle Buttons existieren', async () => {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });

    // Warten bis Agenten gerendert werden (State muss via WS/SSE ankommen)
    await page.waitForFunction(
      () => document.querySelector('.view-toggle-group') !== null,
      { timeout: 15000 }
    );

    // Drei View-Toggle Buttons muessen vorhanden sein: Karten, Timeline, Graph
    const buttons = await page.locator('.view-toggle-btn').all();
    expect(buttons.length).toBe(3);

    // Button-Texte pruefen
    const texts = await Promise.all(buttons.map(btn => btn.textContent()));
    expect(texts).toContain('Karten');
    expect(texts).toContain('Timeline');
    expect(texts).toContain('Graph');

    // Karten ist standardmaessig aktiv
    const activeBtn = await page.locator('.view-toggle-btn.active').textContent();
    expect(activeBtn).toBe('Karten');

    expect(jsErrors).toEqual([]);
  });

  test('Klick auf Timeline wechselt die Ansicht', async () => {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });

    // Warten bis Agenten gerendert werden
    await page.waitForFunction(
      () => document.querySelector('.view-toggle-group') !== null,
      { timeout: 15000 }
    );

    // Pruefen dass Karten-Ansicht aktiv ist (agent-grid sichtbar)
    const agentGridBefore = await page.$('.agent-grid');
    expect(agentGridBefore).not.toBeNull();

    // Timeline-Button klicken
    await page.evaluate(() => {
      setViewMode('timeline');
    });

    // Warten bis Timeline gerendert ist
    await page.waitForFunction(
      () => document.querySelector('.view-toggle-btn.active') &&
            document.querySelector('.view-toggle-btn.active').textContent === 'Timeline',
      { timeout: 5000 }
    );

    // Timeline-Button muss jetzt aktiv sein
    const activeBtn = await page.locator('.view-toggle-btn.active').textContent();
    expect(activeBtn).toBe('Timeline');

    // agent-grid sollte nicht mehr da sein (Timeline-Ansicht zeigt anderes Layout)
    const agentGridAfter = await page.$('.agent-grid');
    expect(agentGridAfter).toBeNull();

    expect(jsErrors).toEqual([]);
  });

  test('Karten-Ansicht zeigt kompakte Projekt-Uebersicht mit Agent-Cards', async () => {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });

    // Warten bis Agenten gerendert werden
    await page.waitForFunction(
      () => document.querySelector('.view-toggle-group') !== null,
      { timeout: 15000 }
    );

    // Sicherstellen dass Karten-Ansicht aktiv ist
    await page.evaluate(() => {
      setViewMode('cards');
    });

    // Warten bis Agent-Grid gerendert ist
    await page.waitForFunction(
      () => document.querySelector('.agent-grid') !== null,
      { timeout: 5000 }
    );

    // Agent-Cards muessen vorhanden sein (3 Agenten im Mock, class="agent-card")
    const agentCards = await page.locator('.agent-grid .agent-card').all();
    expect(agentCards.length).toBe(3);

    // Filter-Bar mit Status-Filtern muss vorhanden sein
    const filterBar = await page.$('.filter-bar');
    expect(filterBar).not.toBeNull();

    // Filter-Buttons pruefen (Alle, Aktiv, Fertig, Fehler)
    const filterBtns = await page.locator('.filter-btn').all();
    expect(filterBtns.length).toBe(4);

    expect(jsErrors).toEqual([]);
  });

  test('View-Mode laesst sich zurueckwechseln', async () => {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });

    // Warten bis Agenten gerendert werden
    await page.waitForFunction(
      () => document.querySelector('.view-toggle-group') !== null,
      { timeout: 15000 }
    );

    // Start: Karten-Ansicht
    let activeBtn = await page.locator('.view-toggle-btn.active').textContent();
    expect(activeBtn).toBe('Karten');

    // Wechsel zu Graph
    await page.evaluate(() => { setViewMode('graph'); });
    await page.waitForFunction(
      () => document.querySelector('.view-toggle-btn.active') &&
            document.querySelector('.view-toggle-btn.active').textContent === 'Graph',
      { timeout: 5000 }
    );
    activeBtn = await page.locator('.view-toggle-btn.active').textContent();
    expect(activeBtn).toBe('Graph');

    // Agent-Grid darf nicht sichtbar sein
    const gridInGraph = await page.$('.agent-grid');
    expect(gridInGraph).toBeNull();

    // Zurueck zu Karten
    await page.evaluate(() => { setViewMode('cards'); });
    await page.waitForFunction(
      () => document.querySelector('.view-toggle-btn.active') &&
            document.querySelector('.view-toggle-btn.active').textContent === 'Karten',
      { timeout: 5000 }
    );
    activeBtn = await page.locator('.view-toggle-btn.active').textContent();
    expect(activeBtn).toBe('Karten');

    // Agent-Grid muss wieder da sein
    await page.waitForSelector('.agent-grid', { state: 'visible', timeout: 5000 });
    const gridRestored = await page.$('.agent-grid');
    expect(gridRestored).not.toBeNull();

    expect(jsErrors).toEqual([]);
  });
});
