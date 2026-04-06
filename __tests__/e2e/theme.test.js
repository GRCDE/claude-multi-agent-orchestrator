// E2E Theme/Dark-Mode Tests - Playwright + Jest
// Prueft ob Theme-Wechsel korrekt funktioniert (CSS-Variablen, Kontrast, Tastenkuerzel)

'use strict';
const path = require('path');

const TEST_PORT = 3266;
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

  await new Promise(resolve => setTimeout(resolve, 1000));

  const { chromium } = require('playwright');
  browser = await chromium.launch({ headless: true });
}, 30000);

afterAll(async () => {
  if (browser) await browser.close();
  if (serverMod && serverMod.cleanup) await serverMod.cleanup();
}, 15000);

describe('E2E Theme/Dark-Mode Tests', () => {
  let page;

  beforeEach(async () => {
    const context = await browser.newContext();
    page = await context.newPage();
  });

  afterEach(async () => {
    if (page) await page.close();
  });

  test('Standard-Theme wird korrekt geladen', async () => {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });

    // Seite muss ein data-theme Attribut haben (light oder dark)
    const theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    expect(['light', 'dark']).toContain(theme);

    // CSS-Variable --bg muss gesetzt sein
    const bg = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()
    );
    expect(bg).toBeTruthy();

    // CSS-Variable --txt muss gesetzt sein
    const txt = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--txt').trim()
    );
    expect(txt).toBeTruthy();

    // Body-Hintergrund muss von --bg abgeleitet sein
    const bodyBg = await page.evaluate(() =>
      getComputedStyle(document.body).backgroundColor
    );
    expect(bodyBg).toBeTruthy();
    expect(bodyBg).not.toBe('');
  });

  test('Dark-Mode Toggle wechselt Hintergrundfarbe', async () => {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });

    // Theme und CSS-Variable --bg vor dem Toggle
    const themeBefore = await page.evaluate(() =>
      document.documentElement.getAttribute('data-theme')
    );
    const bgVarBefore = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()
    );

    // Theme-Button klicken
    await page.evaluate(() => {
      document.getElementById('themeToggle').click();
    });

    // Warten bis data-theme sich aendert
    await page.waitForFunction(
      (prev) => document.documentElement.getAttribute('data-theme') !== prev,
      themeBefore,
      { timeout: 3000 }
    );

    // --bg muss sich geaendert haben
    const bgVarAfter = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()
    );
    expect(bgVarAfter).not.toBe(bgVarBefore);

    // Zurueck klicken
    const themeMiddle = await page.evaluate(() =>
      document.documentElement.getAttribute('data-theme')
    );
    await page.evaluate(() => {
      document.getElementById('themeToggle').click();
    });

    // Warten bis data-theme zurueckwechselt
    await page.waitForFunction(
      (prev) => document.documentElement.getAttribute('data-theme') !== prev,
      themeMiddle,
      { timeout: 3000 }
    );

    // --bg muss wieder den Originalwert haben
    const bgVarRestored = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()
    );
    expect(bgVarRestored).toBe(bgVarBefore);
  });

  test('Theme-Wechsel aendert CSS-Variablen (--bg, --txt)', async () => {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });

    // CSS-Variablen vor dem Toggle
    const varsBefore = await page.evaluate(() => {
      const s = getComputedStyle(document.documentElement);
      return {
        bg: s.getPropertyValue('--bg').trim(),
        txt: s.getPropertyValue('--txt').trim()
      };
    });

    // Theme umschalten
    await page.evaluate(() => {
      document.getElementById('themeToggle').click();
    });
    await page.waitForTimeout(100);

    // CSS-Variablen nach dem Toggle
    const varsAfter = await page.evaluate(() => {
      const s = getComputedStyle(document.documentElement);
      return {
        bg: s.getPropertyValue('--bg').trim(),
        txt: s.getPropertyValue('--txt').trim()
      };
    });

    // Beide Variablen muessen sich geaendert haben
    expect(varsAfter.bg).not.toBe(varsBefore.bg);
    expect(varsAfter.txt).not.toBe(varsBefore.txt);

    // Im Dark Mode muss --bg dunkel sein (#1c1c1a) und --txt hell (#e8e8e4) oder umgekehrt
    const themeAfter = await page.evaluate(() =>
      document.documentElement.getAttribute('data-theme')
    );
    if (themeAfter === 'dark') {
      expect(varsAfter.bg).toBe('#1c1c1a');
      expect(varsAfter.txt).toBe('#e8e8e4');
    } else {
      expect(varsAfter.bg).toBe('#ffffff');
      expect(varsAfter.txt).toBe('#1a1a18');
    }
  });

  test('Theme per "d" Taste togglebar', async () => {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });

    // Theme vor dem Tastendruck
    const themeBefore = await page.evaluate(() =>
      document.documentElement.getAttribute('data-theme')
    );

    // 'd' Taste druecken (kein Fokus auf Input-Feld)
    await page.keyboard.press('d');
    await page.waitForTimeout(100);

    // Theme muss gewechselt haben
    const themeAfter = await page.evaluate(() =>
      document.documentElement.getAttribute('data-theme')
    );
    expect(themeAfter).not.toBe(themeBefore);

    // Nochmal 'd' druecken -> zurueck
    await page.keyboard.press('d');
    await page.waitForTimeout(100);

    const themeRestored = await page.evaluate(() =>
      document.documentElement.getAttribute('data-theme')
    );
    expect(themeRestored).toBe(themeBefore);
  });

  test('UI-Elemente haben korrekten Kontrast im Dark Mode (Buttons sichtbar)', async () => {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });

    // In den Dark Mode wechseln falls nicht schon aktiv
    const currentTheme = await page.evaluate(() =>
      document.documentElement.getAttribute('data-theme')
    );
    if (currentTheme !== 'dark') {
      await page.evaluate(() => {
        document.getElementById('themeToggle').click();
      });
      // Warten bis data-theme auf dark steht und Hintergrund sich aendert
      await page.waitForFunction(
        () => document.documentElement.getAttribute('data-theme') === 'dark',
        { timeout: 3000 }
      );
      // Warten bis CSS-Transition abgeschlossen ist
      await page.waitForTimeout(500);
    }

    // Pruefen dass wir im Dark Mode sind
    const darkTheme = await page.evaluate(() =>
      document.documentElement.getAttribute('data-theme')
    );
    expect(darkTheme).toBe('dark');

    // Pruefe CSS-Variablen direkt (zuverlaessiger als computed styles waehrend Transitions)
    const cssVars = await page.evaluate(() => {
      const s = getComputedStyle(document.documentElement);
      return {
        bg: s.getPropertyValue('--bg').trim(),
        txt: s.getPropertyValue('--txt').trim(),
        bg2: s.getPropertyValue('--bg2').trim(),
        bg3: s.getPropertyValue('--bg3').trim(),
      };
    });

    // --bg muss dunkel sein im Dark Mode
    expect(cssVars.bg).toBe('#1c1c1a');
    // --txt muss hell sein im Dark Mode
    expect(cssVars.txt).toBe('#e8e8e4');

    // Hilfsfunktion: Hex zu Luminanz
    function hexLuminance(hex) {
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      return 0.299 * r + 0.587 * g + 0.114 * b;
    }

    // Kontrast zwischen --bg und --txt muss genuegend sein (> 100 Differenz)
    const bgLum = hexLuminance(cssVars.bg);
    const txtLum = hexLuminance(cssVars.txt);
    const contrastDiff = Math.abs(bgLum - txtLum);
    expect(contrastDiff).toBeGreaterThan(100);

    // Start-Button muss im DOM sichtbar sein
    const startBtnVisible = await page.isVisible('#startBtn');
    expect(startBtnVisible).toBe(true);

    // Toolbar-Buttons muessen sichtbar sein
    const topBtnCount = await page.locator('.top-btn').count();
    expect(topBtnCount).toBeGreaterThan(0);

    // Jeder Toolbar-Button muss sichtbar sein
    for (let i = 0; i < topBtnCount; i++) {
      const visible = await page.locator('.top-btn').nth(i).isVisible();
      expect(visible).toBe(true);
    }
  });
});
