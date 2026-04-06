// E2E Token-Panel Tests - Playwright + Jest
// Prueft ob das Token-Panel korrekt rendert, Statistiken anzeigt, Budget-Info zeigt und schliessbar ist
// Startet den Server als Kindprozess um Kompatibilitaetsprobleme mit Jest-Transform zu vermeiden.

'use strict';
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const TEST_PORT = 3271;
const BASE_URL = `http://localhost:${TEST_PORT}`;

// ── Hilfsfunktionen ──────────────────────────────────────────

function waitForServer(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      http.get(url, (res) => {
        res.resume();
        resolve();
      }).on('error', () => {
        if (Date.now() - start > timeoutMs) {
          reject(new Error('Server start timeout'));
        } else {
          setTimeout(check, 300);
        }
      });
    };
    check();
  });
}

// ── Test Suite ────────────────────────────────────────────────

let browser;
let serverProcess;

beforeAll(async () => {
  // Server als Kindprozess starten
  serverProcess = spawn('node', ['-e', `
    process.env.PORT = '${TEST_PORT}';
    process.env.NODE_ENV = 'test';
    // Inline-Server der nur das Frontend served + SSE mit Token-Daten
    const express = require('express');
    const path = require('path');
    const app = express();
    app.use(express.static(path.join(__dirname, 'public')));

    // SSE Endpoint der Token-State broadcastet
    app.get('/api/stream', (req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      const stateData = {
        phase: 'running',
        agents: [
          { title: 'Frontend Agent', role: 'Frontend', status: 'done', tokenUsage: { inputTokens: 5000, outputTokens: 3000, totalTokens: 8000, estimatedCost: 0.06 } },
          { title: 'Backend Agent', role: 'Backend', status: 'done', tokenUsage: { inputTokens: 8000, outputTokens: 5000, totalTokens: 13000, estimatedCost: 0.10 } }
        ],
        coordinator: { tokenUsage: { inputTokens: 2000, outputTokens: 1000, totalTokens: 3000, estimatedCost: 0.02 } },
        totalTokenUsage: { inputTokens: 15000, outputTokens: 9000, totalTokens: 24000, estimatedCost: 0.18 },
        budget: null,
        startedAt: Date.now(),
        projectId: 'test-token-panel'
      };

      // SSE mit benanntem Event senden (Frontend nutzt addEventListener pro Event-Typ)
      res.write('id: 1\\nevent: state\\ndata: ' + JSON.stringify(stateData) + '\\n\\n');
    });

    // Status Endpoint
    app.get('/api/status', (req, res) => {
      res.json({
        phase: 'running',
        agents: [
          { title: 'Frontend Agent', role: 'Frontend', status: 'done', tokenUsage: { inputTokens: 5000, outputTokens: 3000, totalTokens: 8000, estimatedCost: 0.06 } },
          { title: 'Backend Agent', role: 'Backend', status: 'done', tokenUsage: { inputTokens: 8000, outputTokens: 5000, totalTokens: 13000, estimatedCost: 0.10 } }
        ],
        coordinator: { tokenUsage: { inputTokens: 2000, outputTokens: 1000, totalTokens: 3000, estimatedCost: 0.02 } },
        totalTokenUsage: { inputTokens: 15000, outputTokens: 9000, totalTokens: 24000, estimatedCost: 0.18 },
        budget: null,
        startedAt: Date.now(),
        projectId: 'test-token-panel'
      });
    });

    // Leere Endpoints die das Frontend erwartet
    app.get('/api/projects', (req, res) => res.json([]));
    app.get('/api/templates', (req, res) => res.json({ templates: [], taskPresets: [] }));
    app.get('/api/config', (req, res) => res.json({}));
    app.get('/api/prompts', (req, res) => res.json({ prompts: {} }));
    app.get('/api/milestones', (req, res) => res.json([]));
    app.get('/api/webhooks', (req, res) => res.json([]));
    app.get('/api/queue', (req, res) => res.json({ length: 0, items: [] }));
    app.get('/health', (req, res) => res.json({ status: 'ok' }));

    const server = app.listen(${TEST_PORT}, () => {
      console.log('Test server running on port ${TEST_PORT}');
    });

    process.on('SIGTERM', () => { server.close(); process.exit(0); });
    process.on('SIGINT', () => { server.close(); process.exit(0); });
  `], {
    cwd: path.join(__dirname, '..', '..'),
    stdio: ['pipe', 'pipe', 'pipe']
  });

  // Warten bis Server bereit ist
  await waitForServer(`${BASE_URL}/health`);

  // Browser starten
  const { chromium } = require('playwright');
  browser = await chromium.launch({ headless: true });
}, 30000);

afterAll(async () => {
  if (browser) await browser.close();
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
    // Warten bis Prozess beendet ist
    await new Promise(resolve => {
      serverProcess.on('exit', resolve);
      setTimeout(() => { serverProcess.kill('SIGKILL'); resolve(); }, 3000);
    });
  }
}, 15000);

describe('E2E Token-Panel Tests', () => {
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

  test('Token-Panel oeffnet sich bei Klick auf Header', async () => {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });

    // Warte bis Token-Panel gerendert ist (es erscheint nur wenn totalTokens > 0)
    await page.waitForFunction(
      () => document.getElementById('tokenPanel') !== null,
      { timeout: 8000 }
    );

    // Token-Panel-Header muss sichtbar sein
    const headerVisible = await page.isVisible('.token-panel-header');
    expect(headerVisible).toBe(true);

    // Body sollte initial geschlossen sein (display: none)
    const bodyHidden = await page.evaluate(() => {
      var body = document.getElementById('tokenPanelBody');
      return body ? body.style.display : null;
    });
    expect(bodyHidden).toBe('none');

    // Klick auf Header oeffnet das Panel
    await page.evaluate(() => {
      document.querySelector('.token-panel-header').click();
    });

    // Body muss jetzt sichtbar sein
    const bodyVisible = await page.evaluate(() => {
      var body = document.getElementById('tokenPanelBody');
      return body ? body.style.display : null;
    });
    expect(bodyVisible).toBe('block');

    // Arrow muss open-Klasse haben
    const arrowOpen = await page.evaluate(() => {
      var arrow = document.getElementById('tokenPanelArrow');
      return arrow ? arrow.className.includes('open') : false;
    });
    expect(arrowOpen).toBe(true);

    expect(jsErrors).toEqual([]);
  });

  test('Panel zeigt Token-Statistiken (Tabelle mit Koordinator und Agenten)', async () => {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });

    await page.waitForFunction(
      () => document.getElementById('tokenPanel') !== null,
      { timeout: 8000 }
    );

    // Panel oeffnen
    await page.evaluate(() => {
      document.querySelector('.token-panel-header').click();
    });

    // Token-Tabelle muss vorhanden sein
    const hasTable = await page.evaluate(() => {
      return document.querySelector('#tokenPanel .token-table') !== null;
    });
    expect(hasTable).toBe(true);

    // Summary in Header muss Token-Anzahl anzeigen
    const summaryText = await page.evaluate(() => {
      var summary = document.querySelector('.token-panel-summary');
      return summary ? summary.textContent : '';
    });
    expect(summaryText).toContain('Tokens');

    // Koordinator-Zeile muss vorhanden sein
    const hasCoordRow = await page.evaluate(() => {
      var row = document.querySelector('#tokenPanel .token-row-coord');
      return row ? row.textContent.includes('Koordinator') : false;
    });
    expect(hasCoordRow).toBe(true);

    // Gesamt-Zeile muss vorhanden sein
    const hasTotalRow = await page.evaluate(() => {
      var row = document.querySelector('#tokenPanel .token-row-total');
      return row ? row.textContent.includes('Gesamt') : false;
    });
    expect(hasTotalRow).toBe(true);

    // Muss mindestens 2 Agent-Zeilen haben (+ Koordinator + Gesamt = min 4 Zeilen)
    const rowCount = await page.evaluate(() => {
      return document.querySelectorAll('#tokenPanel .token-table tbody tr').length;
    });
    expect(rowCount).toBeGreaterThanOrEqual(4);

    // Balkendiagramm muss vorhanden sein
    const hasBarStack = await page.evaluate(() => {
      return document.querySelector('#tokenPanel .token-bar-stack') !== null;
    });
    expect(hasBarStack).toBe(true);

    expect(jsErrors).toEqual([]);
  });

  test('Panel zeigt Budget-Info falls konfiguriert', async () => {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });

    // Warte bis SSE-State geladen ist und Token-Panel erscheint
    await page.waitForFunction(
      () => document.getElementById('tokenPanel') !== null,
      { timeout: 8000 }
    );

    // Ohne Budget: pruefen ob "Kein Token-Budget gesetzt" angezeigt wird
    const budgetText = await page.evaluate(() => {
      var el = document.getElementById('budgetBarWrap');
      return el ? el.textContent : '';
    });
    expect(budgetText).toContain('Kein Token-Budget');

    // Jetzt Budget via state simulieren und Budget-Anzeige aktualisieren
    await page.evaluate(() => {
      state.budget = { maxTokenBudget: 50000, warnTokenBudget: 40000, exceeded: false, warned: false };
      if (typeof updateBudgetDisplay === 'function') updateBudgetDisplay();
    });

    // Budget-Bar muss jetzt Token-Budget Label zeigen
    const budgetAfter = await page.evaluate(() => {
      var el = document.getElementById('budgetBarWrap');
      return el ? el.textContent : '';
    });
    expect(budgetAfter).toContain('Token-Budget');

    // Budget-Bar-Fill muss vorhanden sein
    const hasFill = await page.evaluate(() => {
      return document.querySelector('.budget-bar-fill') !== null;
    });
    expect(hasFill).toBe(true);

    expect(jsErrors).toEqual([]);
  });

  test('Token-Panel ist schliessbar (Toggle zurueck)', async () => {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });

    await page.waitForFunction(
      () => document.getElementById('tokenPanel') !== null,
      { timeout: 8000 }
    );

    // Panel oeffnen
    await page.evaluate(() => {
      document.querySelector('.token-panel-header').click();
    });

    // Pruefen dass Body sichtbar ist
    const bodyOpen = await page.evaluate(() => {
      var body = document.getElementById('tokenPanelBody');
      return body ? body.style.display : null;
    });
    expect(bodyOpen).toBe('block');

    // Panel schliessen (erneuter Klick)
    await page.evaluate(() => {
      document.querySelector('.token-panel-header').click();
    });

    // Body muss wieder ausgeblendet sein
    const bodyClosed = await page.evaluate(() => {
      var body = document.getElementById('tokenPanelBody');
      return body ? body.style.display : null;
    });
    expect(bodyClosed).toBe('none');

    // Arrow darf nicht mehr "open" haben
    const arrowClosed = await page.evaluate(() => {
      var arrow = document.getElementById('tokenPanelArrow');
      return arrow ? arrow.className.includes('open') : true;
    });
    expect(arrowClosed).toBe(false);

    expect(jsErrors).toEqual([]);
  });
});
