// E2E Notes Tests - Playwright + Jest
// Prueft Notiz-System: Icon sichtbar, Editor oeffnen, localStorage, Opacity

'use strict';
const path = require('path');
const http = require('http');
const express = require('express');

const TEST_PORT = 3282;
const BASE_URL = `http://localhost:${TEST_PORT}`;

const fakeProjects = [
  {
    id: 'proj_note_001',
    title: 'Notiz-Test Projekt',
    phase: 'complete',
    agentCount: 2,
    createdAt: Date.now() - 86400000,
    totalDuration: 60000,
    projectScore: 70,
    totalTokenUsage: { inputTokens: 500, outputTokens: 1000, totalTokens: 1500, estimatedCost: 0.03 }
  }
];

let server;
let browser;

function createTestServer() {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', '..', 'public')));

  app.get('/api/projects', (req, res) => res.json(fakeProjects));

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

  app.get('/api/templates', (req, res) => res.json({ templates: [], taskPresets: [] }));
  app.get('/api/search', (req, res) => res.json({ results: [] }));

  return app;
}

beforeAll(async () => {
  const app = createTestServer();
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(TEST_PORT, resolve));

  const { chromium } = require('playwright');
  browser = await chromium.launch({ headless: true });
}, 30000);

afterAll(async () => {
  if (browser) await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
}, 15000);

async function loadPageWithHistory(page) {
  // WebSocket-Verbindungsversuch abfangen, damit die Seite sofort auf SSE faellt
  await page.route(/\/ws$/, route => route.abort());

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });

  // Warten bis render() verfuegbar ist (JS geladen)
  await page.waitForFunction(
    () => typeof render === 'function' && typeof applyState === 'function',
    { timeout: 15000 }
  );

  // State direkt setzen und rendern (SSE kann auf Windows langsam sein)
  await page.evaluate((projects) => {
    applyState({
      phase: 'idle',
      agents: [],
      coordinator: {},
      totalTokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCost: 0 }
    });
    render();
    window.projectHistory = projects;
    if (typeof renderHistory === 'function') renderHistory();
  }, fakeProjects);

  // Warten bis historyArea existiert und gerendert ist
  await page.waitForFunction(
    () => {
      var el = document.getElementById('historyArea');
      return el !== null && el.innerHTML.length > 0;
    },
    { timeout: 10000 }
  );
}

describe('E2E Notes Tests', () => {
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

  test('Notiz-Icon ist in Projekt-Karte sichtbar', async () => {
    await loadPageWithHistory(page);

    const iconExists = await page.evaluate(() => {
      var icon = document.getElementById('note-icon-proj_note_001');
      if (!icon) return false;
      var rect = icon.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    expect(iconExists).toBe(true);

    // Icon muss den Titel "Notiz" haben
    const iconTitle = await page.evaluate(() => {
      var icon = document.getElementById('note-icon-proj_note_001');
      return icon ? icon.getAttribute('title') : '';
    });
    expect(iconTitle).toBe('Notiz');

    expect(jsErrors).toEqual([]);
  });

  test('Klick auf Notiz-Icon oeffnet Textarea-Editor', async () => {
    await loadPageWithHistory(page);

    // Editor muss initial versteckt sein
    const initiallyHidden = await page.evaluate(() => {
      var editor = document.getElementById('note-editor-proj_note_001');
      return editor ? editor.style.display === 'none' : false;
    });
    expect(initiallyHidden).toBe(true);

    // Klick auf das Notiz-Icon
    await page.evaluate(() => {
      toggleNoteEditor('proj_note_001');
    });
    await page.waitForTimeout(200);

    // Editor muss jetzt sichtbar sein
    const editorVisible = await page.evaluate(() => {
      var editor = document.getElementById('note-editor-proj_note_001');
      return editor ? editor.style.display === 'block' : false;
    });
    expect(editorVisible).toBe(true);

    // Textarea muss innerhalb des Editors existieren
    const hasTextarea = await page.evaluate(() => {
      var editor = document.getElementById('note-editor-proj_note_001');
      if (!editor) return false;
      var ta = editor.querySelector('textarea');
      return ta !== null;
    });
    expect(hasTextarea).toBe(true);

    expect(jsErrors).toEqual([]);
  });

  test('Text eingeben speichert in localStorage', async () => {
    await loadPageWithHistory(page);

    // localStorage vorher leeren
    await page.evaluate(() => {
      localStorage.removeItem('notes_proj_note_001');
    });

    // Editor oeffnen
    await page.evaluate(() => {
      toggleNoteEditor('proj_note_001');
    });
    await page.waitForTimeout(200);

    // Text eingeben via onNoteInput
    const testText = 'Meine Testnotiz fuer das Projekt';
    await page.evaluate((text) => {
      var editor = document.getElementById('note-editor-proj_note_001');
      var ta = editor.querySelector('textarea');
      ta.value = text;
      onNoteInput('proj_note_001', ta);
    }, testText);

    // localStorage pruefen
    const storedValue = await page.evaluate(() => {
      return localStorage.getItem('notes_proj_note_001');
    });
    expect(storedValue).toBe(testText);

    // getProjectNote muss denselben Wert liefern
    const noteValue = await page.evaluate(() => {
      return getProjectNote('proj_note_001');
    });
    expect(noteValue).toBe(testText);

    expect(jsErrors).toEqual([]);
  });

  test('Notiz-Icon zeigt volle Opacity wenn Notiz vorhanden', async () => {
    await loadPageWithHistory(page);

    // Ohne Notiz: Opacity muss 0.4 sein
    const opacityEmpty = await page.evaluate(() => {
      var icon = document.getElementById('note-icon-proj_note_001');
      return icon ? icon.style.opacity : '';
    });
    expect(opacityEmpty).toBe('0.4');

    // Editor oeffnen und Text eingeben
    await page.evaluate(() => {
      toggleNoteEditor('proj_note_001');
    });
    await page.waitForTimeout(200);

    await page.evaluate(() => {
      var editor = document.getElementById('note-editor-proj_note_001');
      var ta = editor.querySelector('textarea');
      ta.value = 'Eine Notiz';
      onNoteInput('proj_note_001', ta);
    });

    // Opacity muss jetzt 1 sein
    const opacityFull = await page.evaluate(() => {
      var icon = document.getElementById('note-icon-proj_note_001');
      return icon ? icon.style.opacity : '';
    });
    expect(opacityFull).toBe('1');

    // Text loeschen -> Opacity zurueck auf 0.4
    await page.evaluate(() => {
      var editor = document.getElementById('note-editor-proj_note_001');
      var ta = editor.querySelector('textarea');
      ta.value = '';
      onNoteInput('proj_note_001', ta);
    });

    const opacityCleared = await page.evaluate(() => {
      var icon = document.getElementById('note-icon-proj_note_001');
      return icon ? icon.style.opacity : '';
    });
    expect(opacityCleared).toBe('0.4');

    expect(jsErrors).toEqual([]);
  });
});
