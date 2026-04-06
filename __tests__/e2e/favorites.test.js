// E2E Favorites Tests - Playwright + Jest
// Prueft Stern-Icon, Toggle, localStorage-Persistenz und Favoriten-Filter

'use strict';
const path = require('path');
const http = require('http');
const express = require('express');

jest.setTimeout(60000);

const TEST_PORT = 3280;
const BASE_URL = `http://localhost:${TEST_PORT}`;

// Fake-Projekte fuer die Historie
const fakeProjects = [
  {
    id: 'proj_fav_001',
    title: 'Favorit-Projekt Alpha',
    phase: 'complete',
    agentCount: 3,
    createdAt: Date.now() - 86400000,
    totalDuration: 120000,
    projectScore: 85,
    totalTokenUsage: { inputTokens: 1000, outputTokens: 2000, totalTokens: 3000, estimatedCost: 0.05 }
  },
  {
    id: 'proj_fav_002',
    title: 'Favorit-Projekt Beta',
    phase: 'error',
    agentCount: 2,
    createdAt: Date.now() - 172800000,
    totalDuration: 60000,
    projectScore: 30,
    totalTokenUsage: { inputTokens: 500, outputTokens: 800, totalTokens: 1300, estimatedCost: 0.02 }
  },
  {
    id: 'proj_fav_003',
    title: 'Favorit-Projekt Gamma',
    phase: 'complete',
    agentCount: 5,
    createdAt: Date.now() - 3600000,
    totalDuration: 90000,
    projectScore: 70,
    totalTokenUsage: { inputTokens: 200, outputTokens: 300, totalTokens: 500, estimatedCost: 0.01 }
  }
];

// ── Minimaler Express-Server ──
let server;
let browser;

function createTestServer() {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', '..', 'public')));

  app.get('/api/projects', (req, res) => {
    res.json(fakeProjects);
  });

  app.get('/api/status', (req, res) => {
    res.json({
      phase: 'idle',
      agents: [],
      coordinator: {},
      totalTokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCost: 0 }
    });
  });

  app.get('/api/analytics', (req, res) => {
    res.json({ timeline: [], roles: {}, totalCost: 0, topProjects: [], distribution: {} });
  });

  app.get('/api/disk-usage', (req, res) => {
    res.json({ totalSize: 0, projectCount: 0 });
  });

  app.get('/api/stream', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    const state = {
      phase: 'idle',
      agents: [],
      coordinator: {},
      totalTokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCost: 0 }
    };
    res.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
    req.on('close', () => res.end());
  });

  app.get('/api/templates', (req, res) => {
    res.json({ templates: [], taskPresets: [] });
  });

  app.get('/api/search', (req, res) => {
    res.json({ results: [] });
  });

  app.get('/api/roles', (req, res) => {
    res.json({ roles: [] });
  });

  app.get('/api/config', (req, res) => {
    res.json({});
  });

  app.get('/api/milestones', (req, res) => {
    res.json([]);
  });

  return app;
}

beforeAll(async () => {
  // Port freigeben falls noch belegt
  try {
    const { execSync } = require('child_process');
    execSync(`npx -y kill-port ${TEST_PORT}`, { stdio: 'ignore', timeout: 5000 });
  } catch (e) { /* Port war nicht belegt */ }

  const app = createTestServer();
  server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(TEST_PORT, resolve);
  });

  const { chromium } = require('playwright');
  browser = await chromium.launch({ headless: true });
}, 30000);

afterAll(async () => {
  if (browser) await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
}, 15000);

// Hilfsfunktion: Seite laden und Fake-Projekte in die Historie injizieren
async function loadPageWithHistory(page) {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });

  // Warten bis historyArea existiert (erstellt durch SSE state -> render -> renderSetup)
  await page.waitForFunction(
    () => document.getElementById('historyArea') !== null,
    { timeout: 20000 }
  );

  // localStorage zuruecksetzen damit keine alten Favoriten stoeren
  await page.evaluate(() => {
    localStorage.removeItem('projectFavorites');
  });

  // Fake-Projekte injizieren und rendern
  await page.evaluate((projects) => {
    window.projectHistory = projects;
    if (typeof renderHistory === 'function') renderHistory();
  }, fakeProjects);

  // Warten bis history-cards im DOM sind
  await page.waitForSelector('.history-card', { timeout: 5000 });
}

describe('E2E Favorites Tests', () => {
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

  test('Stern-Icon ist in jeder Projekt-Karte sichtbar', async () => {
    await loadPageWithHistory(page);

    // Jede history-card muss genau einen fav-star enthalten
    const starCount = await page.locator('.history-card .fav-star').count();
    expect(starCount).toBe(fakeProjects.length);

    // Alle Sterne muessen sichtbar sein
    for (let i = 0; i < starCount; i++) {
      const visible = await page.locator('.history-card .fav-star').nth(i).isVisible();
      expect(visible).toBe(true);
    }

    // Sterne zeigen das Stern-Zeichen
    const text = await page.locator('.history-card .fav-star').first().textContent();
    expect(text.trim()).toBe('\u2605');

    expect(jsErrors).toEqual([]);
  });

  test('Klick auf Stern toggled Favorit (Klasse wechselt)', async () => {
    await loadPageWithHistory(page);

    const star = page.locator('.history-card .fav-star').first();

    // Anfangs nicht aktiv
    const hasActiveBefore = await star.evaluate(el => el.classList.contains('active'));
    expect(hasActiveBefore).toBe(false);

    // Klick -> aktiv
    await star.click();
    await page.waitForTimeout(200);

    // Nach renderHistory wird das DOM neu aufgebaut, also Stern erneut selektieren
    const starAfterClick = page.locator('.history-card .fav-star').first();
    const hasActiveAfter = await starAfterClick.evaluate(el => el.classList.contains('active'));
    expect(hasActiveAfter).toBe(true);

    // Nochmal klicken -> nicht mehr aktiv
    await starAfterClick.click();
    await page.waitForTimeout(200);

    const starAfterSecond = page.locator('.history-card .fav-star').first();
    const hasActiveToggled = await starAfterSecond.evaluate(el => el.classList.contains('active'));
    expect(hasActiveToggled).toBe(false);

    expect(jsErrors).toEqual([]);
  });

  test('Favoriten werden in localStorage gespeichert', async () => {
    await loadPageWithHistory(page);

    // localStorage sollte anfangs leer sein
    const before = await page.evaluate(() => {
      return JSON.parse(localStorage.getItem('projectFavorites') || '[]');
    });
    expect(before).toEqual([]);

    // Ersten Stern klicken und Projekt-ID ermitteln
    const firstProjectId = await page.locator('.history-card .fav-star').first().evaluate(el => {
      // onclick enthaelt toggleFavorite('proj_fav_xxx')
      const match = el.getAttribute('onclick').match(/toggleFavorite\('([^']+)'\)/);
      return match ? match[1] : null;
    });
    await page.locator('.history-card .fav-star').first().click();
    await page.waitForTimeout(200);

    // localStorage pruefen
    const after = await page.evaluate(() => {
      return JSON.parse(localStorage.getItem('projectFavorites') || '[]');
    });
    expect(after).toContain(firstProjectId);
    expect(after.length).toBe(1);

    // Zweiten Stern klicken (nach renderHistory neu selektieren)
    const stars = page.locator('.history-card .fav-star');
    await stars.nth(1).click();
    await page.waitForTimeout(200);

    const afterTwo = await page.evaluate(() => {
      return JSON.parse(localStorage.getItem('projectFavorites') || '[]');
    });
    expect(afterTwo.length).toBe(2);

    expect(jsErrors).toEqual([]);
  });

  test('Filter "Favoriten" zeigt nur favorisierte Projekte', async () => {
    await loadPageWithHistory(page);

    // Alle 3 Karten sichtbar
    let cardCount = await page.locator('.history-card').count();
    expect(cardCount).toBe(3);

    // Erstes Projekt favorisieren
    await page.locator('.history-card .fav-star').first().click();
    await page.waitForTimeout(200);

    // Favoriten-Filter klicken
    await page.locator('button.history-filter-btn', { hasText: 'Favoriten' }).click();
    await page.waitForTimeout(300);

    // Nur 1 Karte sichtbar
    cardCount = await page.locator('.history-card').count();
    expect(cardCount).toBe(1);

    // Karte muss das favorisierte Projekt sein
    const title = await page.locator('.history-card .history-card-title').first().textContent();
    expect(title).toContain('Favorit-Projekt');

    // Stern in gefilterter Ansicht muss aktiv sein
    const isActive = await page.locator('.history-card .fav-star').first().evaluate(
      el => el.classList.contains('active')
    );
    expect(isActive).toBe(true);

    // Filter deaktivieren -> wieder 3 Karten
    await page.locator('button.history-filter-btn', { hasText: 'Favoriten' }).click();
    await page.waitForTimeout(300);

    cardCount = await page.locator('.history-card').count();
    expect(cardCount).toBe(3);

    expect(jsErrors).toEqual([]);
  });
});
