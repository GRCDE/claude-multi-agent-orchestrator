// E2E History Tests - Playwright + Jest
// Prueft Projekt-Historie: Anzeige, Tabs, Filter, Sort, Detail-Klick

'use strict';
const path = require('path');
const http = require('http');
const fs = require('fs');
const express = require('express');

const TEST_PORT = 3272;
const BASE_URL = `http://localhost:${TEST_PORT}`;

// Fake-Projekte fuer die Historie
const fakeProjects = [
  {
    id: 'proj_1000001',
    title: 'Test-Projekt Alpha',
    phase: 'complete',
    agentCount: 3,
    createdAt: Date.now() - 86400000,
    totalDuration: 120000,
    projectScore: 85,
    totalTokenUsage: { inputTokens: 1000, outputTokens: 2000, totalTokens: 3000, estimatedCost: 0.05 }
  },
  {
    id: 'proj_1000002',
    title: 'Test-Projekt Beta',
    phase: 'error',
    agentCount: 2,
    createdAt: Date.now() - 172800000,
    totalDuration: 60000,
    projectScore: 30,
    totalTokenUsage: { inputTokens: 500, outputTokens: 800, totalTokens: 1300, estimatedCost: 0.02 }
  },
  {
    id: 'proj_1000003',
    title: 'Test-Projekt Gamma',
    phase: 'running',
    agentCount: 5,
    createdAt: Date.now() - 3600000,
    totalDuration: null,
    projectScore: null,
    totalTokenUsage: { inputTokens: 200, outputTokens: 300, totalTokens: 500, estimatedCost: 0.01 }
  }
];

// ── Minimaler Express-Server (nur index.html + /api/projects + /api/status + /api/stream + /api/analytics + /api/load) ──
let server;
let browser;

function createTestServer() {
  const app = express();
  app.use(express.json());

  // index.html statisch ausliefern
  app.use(express.static(path.join(__dirname, '..', '..', 'public')));

  // GET /api/projects - Fake-Projekte zurueckgeben
  app.get('/api/projects', (req, res) => {
    res.json(fakeProjects);
  });

  // GET /api/status
  app.get('/api/status', (req, res) => {
    res.json({
      phase: 'idle',
      agents: [],
      coordinator: {},
      totalTokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCost: 0 }
    });
  });

  // GET /api/analytics
  app.get('/api/analytics', (req, res) => {
    res.json({ timeline: [], roles: {}, totalCost: 0, topProjects: [], distribution: {} });
  });

  // GET /api/disk-usage
  app.get('/api/disk-usage', (req, res) => {
    res.json({ totalSize: 0, projectCount: 0 });
  });

  // GET /api/stream - SSE stub
  app.get('/api/stream', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    // Sende den initialen State
    const state = {
      phase: 'idle',
      agents: [],
      coordinator: {},
      totalTokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCost: 0 }
    };
    res.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
    req.on('close', () => res.end());
  });

  // POST /api/load/:id - Projekt laden (Stub)
  app.post('/api/load/:id', (req, res) => {
    const proj = fakeProjects.find(p => p.id === req.params.id);
    if (!proj) return res.status(404).json({ error: 'Nicht gefunden' });
    res.json({
      phase: proj.phase,
      agents: [],
      coordinator: {},
      projectTitle: proj.title,
      totalTokenUsage: proj.totalTokenUsage
    });
  });

  // GET /api/templates
  app.get('/api/templates', (req, res) => {
    res.json({ templates: [], taskPresets: [] });
  });

  // GET /api/search
  app.get('/api/search', (req, res) => {
    res.json({ results: [] });
  });

  return app;
}

beforeAll(async () => {
  const app = createTestServer();
  server = http.createServer(app);
  await new Promise((resolve) => {
    server.listen(TEST_PORT, resolve);
  });

  // Browser starten
  const { chromium } = require('playwright');
  browser = await chromium.launch({ headless: true });
}, 30000);

afterAll(async () => {
  if (browser) await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
}, 15000);

// Hilfsfunktion: Seite laden und Fake-Projekte in die Historie injizieren
async function loadPageWithHistory(page) {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });

  // Warten bis die App initialisiert ist (historyArea existiert)
  await page.waitForFunction(
    () => document.getElementById('historyArea') !== null,
    { timeout: 10000 }
  );

  // Fake-Projekte direkt in die globale Variable injizieren und rendern
  await page.evaluate((projects) => {
    window.projectHistory = projects;
    if (typeof renderHistory === 'function') renderHistory();
  }, fakeProjects);

  // Kurz warten bis DOM aktualisiert
  await page.waitForTimeout(300);
}

describe('E2E History Tests', () => {
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

  test('Historie zeigt Projekte an (historyArea hat Inhalt)', async () => {
    await loadPageWithHistory(page);

    // historyArea muss existieren und Inhalt haben
    const areaExists = await page.evaluate(() => {
      var el = document.getElementById('historyArea');
      return el !== null && el.innerHTML.length > 0;
    });
    expect(areaExists).toBe(true);

    // Alle 3 Projekte muessen als Karten sichtbar sein
    const cardCount = await page.locator('.history-card').count();
    expect(cardCount).toBe(3);

    // Projekttitel muessen sichtbar sein
    const titles = await page.evaluate(() => {
      var cards = document.querySelectorAll('.history-card-title');
      return Array.from(cards).map(function(el) { return el.textContent; });
    });
    expect(titles).toContain('Test-Projekt Alpha');
    expect(titles).toContain('Test-Projekt Beta');
    expect(titles).toContain('Test-Projekt Gamma');

    // Section-Label "Bisherige Projekte (3)" vorhanden
    const label = await page.evaluate(() => {
      var el = document.querySelector('.section-label');
      return el ? el.textContent : '';
    });
    expect(label).toContain('Bisherige Projekte');
    expect(label).toContain('3');

    expect(jsErrors).toEqual([]);
  });

  test('Filter-Tabs funktionieren (Liste/Kalender/Statistik)', async () => {
    await loadPageWithHistory(page);

    // Standard-Tab ist "Liste" und muss aktiv sein
    const activeTab = await page.evaluate(() => {
      var el = document.querySelector('.history-tab.active');
      return el ? el.textContent : '';
    });
    expect(activeTab).toBe('Liste');

    // Alle 3 Tabs muessen existieren
    const tabTexts = await page.evaluate(() => {
      var tabs = document.querySelectorAll('.history-tab');
      return Array.from(tabs).map(function(el) { return el.textContent; });
    });
    expect(tabTexts).toEqual(['Liste', 'Kalender', 'Statistiken']);

    // Kalender-Tab klicken
    await page.evaluate(() => { setHistoryView('calendar'); });
    await page.waitForTimeout(200);

    const calendarActive = await page.evaluate(() => {
      var el = document.querySelector('.history-tab.active');
      return el ? el.textContent : '';
    });
    expect(calendarActive).toBe('Kalender');

    // Kalender-spezifischer Inhalt muss vorhanden sein (calendar-grid oder calendar-nav)
    const hasCalendar = await page.evaluate(() => {
      var area = document.getElementById('historyArea');
      if (!area) return false;
      var html = area.innerHTML;
      return html.indexOf('calendar') !== -1 || html.indexOf('Kalender') !== -1;
    });
    expect(hasCalendar).toBe(true);

    // Statistiken-Tab klicken
    await page.evaluate(() => { setHistoryView('stats'); });
    await page.waitForTimeout(200);

    const statsActive = await page.evaluate(() => {
      var el = document.querySelector('.history-tab.active');
      return el ? el.textContent : '';
    });
    expect(statsActive).toBe('Statistiken');

    // Zurueck zu Liste
    await page.evaluate(() => { setHistoryView('list'); });
    await page.waitForTimeout(200);

    const listActive = await page.evaluate(() => {
      var el = document.querySelector('.history-tab.active');
      return el ? el.textContent : '';
    });
    expect(listActive).toBe('Liste');

    // History-Cards muessen wieder sichtbar sein
    const cardCount = await page.locator('.history-card').count();
    expect(cardCount).toBe(3);

    expect(jsErrors).toEqual([]);
  });

  test('Status-Filter funktioniert (Alle/Fertig/Fehler/Sonstige)', async () => {
    await loadPageWithHistory(page);

    // Standard: Alle Projekte sichtbar (3)
    let cardCount = await page.locator('.history-card').count();
    expect(cardCount).toBe(3);

    // Filter auf "Fertig" setzen (phase: done)
    await page.evaluate(() => { setHistoryFilter('phase', 'done'); });
    await page.waitForTimeout(200);

    cardCount = await page.locator('.history-card').count();
    expect(cardCount).toBe(1);

    // Der aktive Filter-Button muss "Fertig" sein
    const activeFilter = await page.evaluate(() => {
      var btns = document.querySelectorAll('.history-filter-btn.active');
      for (var i = 0; i < btns.length; i++) {
        if (btns[i].textContent === 'Fertig') return 'Fertig';
      }
      return '';
    });
    expect(activeFilter).toBe('Fertig');

    // Nur Alpha (complete) sollte sichtbar sein
    const titles = await page.evaluate(() => {
      var cards = document.querySelectorAll('.history-card-title');
      return Array.from(cards).map(function(el) { return el.textContent; });
    });
    expect(titles).toContain('Test-Projekt Alpha');
    expect(titles).not.toContain('Test-Projekt Beta');

    // Filter auf "Fehler" setzen
    await page.evaluate(() => { setHistoryFilter('phase', 'error'); });
    await page.waitForTimeout(200);

    cardCount = await page.locator('.history-card').count();
    expect(cardCount).toBe(1);

    const errorTitles = await page.evaluate(() => {
      var cards = document.querySelectorAll('.history-card-title');
      return Array.from(cards).map(function(el) { return el.textContent; });
    });
    expect(errorTitles).toContain('Test-Projekt Beta');

    // Filter auf "Sonstige" (partial) -- Gamma ist "running"
    await page.evaluate(() => { setHistoryFilter('phase', 'partial'); });
    await page.waitForTimeout(200);

    cardCount = await page.locator('.history-card').count();
    expect(cardCount).toBe(1);

    const partialTitles = await page.evaluate(() => {
      var cards = document.querySelectorAll('.history-card-title');
      return Array.from(cards).map(function(el) { return el.textContent; });
    });
    expect(partialTitles).toContain('Test-Projekt Gamma');

    // Zurueck zu "Alle"
    await page.evaluate(() => { setHistoryFilter('phase', 'alle'); });
    await page.waitForTimeout(200);

    cardCount = await page.locator('.history-card').count();
    expect(cardCount).toBe(3);

    expect(jsErrors).toEqual([]);
  });

  test('Sort-Select funktioniert', async () => {
    await loadPageWithHistory(page);

    // Standard-Sortierung: datum-desc (neustes zuerst)
    // Gamma (createdAt: now - 1h) > Alpha (now - 1d) > Beta (now - 2d)
    let titles = await page.evaluate(() => {
      var cards = document.querySelectorAll('.history-card-title');
      return Array.from(cards).map(function(el) { return el.textContent; });
    });
    expect(titles[0]).toBe('Test-Projekt Gamma');
    expect(titles[2]).toBe('Test-Projekt Beta');

    // Sort auf "Score (hoch)" aendern
    await page.evaluate(() => { setHistorySort('score-desc'); });
    await page.waitForTimeout(200);

    titles = await page.evaluate(() => {
      var cards = document.querySelectorAll('.history-card-title');
      return Array.from(cards).map(function(el) { return el.textContent; });
    });
    // Alpha (85) > Beta (30) > Gamma (null = 0)
    expect(titles[0]).toBe('Test-Projekt Alpha');
    expect(titles[1]).toBe('Test-Projekt Beta');
    expect(titles[2]).toBe('Test-Projekt Gamma');

    // Select-Element muss den richtigen Wert haben
    const selectValue = await page.evaluate(() => {
      var sel = document.querySelector('.history-sort-select');
      return sel ? sel.value : '';
    });
    expect(selectValue).toBe('score-desc');

    // Sort auf "Agents (viele)" aendern
    await page.evaluate(() => { setHistorySort('agents-desc'); });
    await page.waitForTimeout(200);

    titles = await page.evaluate(() => {
      var cards = document.querySelectorAll('.history-card-title');
      return Array.from(cards).map(function(el) { return el.textContent; });
    });
    // Gamma (5) > Alpha (3) > Beta (2)
    expect(titles[0]).toBe('Test-Projekt Gamma');
    expect(titles[1]).toBe('Test-Projekt Alpha');
    expect(titles[2]).toBe('Test-Projekt Beta');

    expect(jsErrors).toEqual([]);
  });

  test('Projekt-Klick oeffnet Details (loadProject wird aufgerufen)', async () => {
    await loadPageWithHistory(page);

    // confirm-Dialog abfangen und bestaetigen
    page.on('dialog', async dialog => {
      await dialog.accept();
    });

    // Pruefen dass history-card-title klickbar ist und loadProject aufruft
    const titleOnclick = await page.evaluate(() => {
      var title = document.querySelector('.history-card-title');
      return title ? title.getAttribute('onclick') : '';
    });
    expect(titleOnclick).toContain('loadProject');

    // Netzwerk-Request abfangen um zu pruefen dass /api/load aufgerufen wird
    let loadRequested = false;
    let loadUrl = '';
    page.on('request', req => {
      if (req.url().includes('/api/load/')) {
        loadRequested = true;
        loadUrl = req.url();
      }
    });

    // Klick auf den ersten Projekt-Titel
    await page.evaluate(() => {
      var title = document.querySelector('.history-card-title');
      if (title) title.click();
    });

    // Warten bis Request abgeschickt wurde
    await page.waitForTimeout(500);

    expect(loadRequested).toBe(true);
    expect(loadUrl).toContain('/api/load/proj_');

    expect(jsErrors).toEqual([]);
  });
});
