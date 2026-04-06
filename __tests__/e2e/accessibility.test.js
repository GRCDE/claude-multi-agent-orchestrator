// E2E Accessibility Test - WCAG 2.1 Basics mit Playwright
// Prueft aria-labels, headings, form-labels, kontrast, tab-navigation, landmarks

'use strict';

const TEST_PORT = 3268;
const BASE_URL = `http://localhost:${TEST_PORT}`;

// ── Mocks ────────────────────────────────────────────────────
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

describe('E2E Accessibility Tests (WCAG 2.1)', () => {
  let page;

  beforeEach(async () => {
    const context = await browser.newContext();
    page = await context.newPage();
  });

  afterEach(async () => {
    if (page) await page.close();
  });

  test('Interaktive Elemente haben aria-labels oder zugaengliche Namen', async () => {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });

    const result = await page.evaluate(() => {
      const issues = [];

      // Alle sichtbaren Buttons pruefen
      const buttons = document.querySelectorAll('button');
      buttons.forEach((btn, i) => {
        const style = window.getComputedStyle(btn);
        // Nur sichtbare Buttons pruefen
        if (style.display === 'none' || style.visibility === 'hidden') return;
        const rect = btn.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return;

        const hasAriaLabel = btn.hasAttribute('aria-label');
        const hasTitle = btn.hasAttribute('title');
        const hasText = btn.textContent.trim().length > 0;
        if (!hasAriaLabel && !hasTitle && !hasText) {
          issues.push(`Button #${i} (id=${btn.id || 'none'}, class=${btn.className}) hat keinen zugaenglichen Namen`);
        }
      });

      // Alle sichtbaren Inputs pruefen
      const inputs = document.querySelectorAll('input, textarea, select');
      inputs.forEach((inp, i) => {
        const style = window.getComputedStyle(inp);
        if (style.display === 'none' || style.visibility === 'hidden') return;
        const rect = inp.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return;

        const hasAriaLabel = inp.hasAttribute('aria-label');
        const hasPlaceholder = inp.hasAttribute('placeholder');
        const hasTitle = inp.hasAttribute('title');
        const id = inp.id;
        const hasAssociatedLabel = id ? document.querySelector(`label[for="${id}"]`) !== null : false;
        // Auch pruefen ob das Element in einem label-Element verschachtelt ist
        const hasWrappingLabel = inp.closest('label') !== null;
        if (!hasAriaLabel && !hasPlaceholder && !hasTitle && !hasAssociatedLabel && !hasWrappingLabel) {
          issues.push(`Input #${i} (id=${inp.id || 'none'}, type=${inp.type}) hat keinen zugaenglichen Namen`);
        }
      });

      return { buttonCount: buttons.length, inputCount: inputs.length, issues };
    });

    // Es muessen Buttons und Inputs vorhanden sein
    expect(result.buttonCount).toBeGreaterThan(0);
    expect(result.inputCount).toBeGreaterThan(0);
    // Keine Accessibility-Probleme
    expect(result.issues).toEqual([]);
  });

  test('Seite hat ein Haupt-Heading (h1) und logische Heading-Hierarchie', async () => {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });

    const result = await page.evaluate(() => {
      const h1Elements = document.querySelectorAll('h1');
      const allHeadings = document.querySelectorAll('h1, h2, h3, h4, h5, h6');
      const headingLevels = Array.from(allHeadings).map(h => ({
        level: parseInt(h.tagName[1]),
        text: h.textContent.trim().substring(0, 50)
      }));

      // Pruefen ob Heading-Hierarchie logisch ist (kein Sprung von h1 zu h3)
      const skips = [];
      for (let i = 1; i < headingLevels.length; i++) {
        const prev = headingLevels[i - 1].level;
        const curr = headingLevels[i].level;
        if (curr > prev + 1) {
          skips.push(`Sprung von h${prev} zu h${curr} bei "${headingLevels[i].text}"`);
        }
      }

      return {
        h1Count: h1Elements.length,
        h1Text: h1Elements.length > 0 ? h1Elements[0].textContent.trim() : null,
        totalHeadings: allHeadings.length,
        headingLevels,
        skips
      };
    });

    // Mindestens ein h1 muss vorhanden sein
    expect(result.h1Count).toBeGreaterThanOrEqual(1);
    expect(result.h1Text).toBeTruthy();
    // Keine Spruenge in der Hierarchie
    expect(result.skips).toEqual([]);
  });

  test('Buttons sind sichtbar: nicht transparent und haben ausreichende Groesse', async () => {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });

    const result = await page.evaluate(() => {
      const issues = [];
      const checked = [];
      const buttons = document.querySelectorAll('button');
      buttons.forEach((btn, i) => {
        const style = window.getComputedStyle(btn);
        const display = style.display;
        const visibility = style.visibility;

        // Ueberspringe komplett unsichtbare Buttons (display:none, visibility:hidden)
        if (display === 'none' || visibility === 'hidden') return;

        const rect = btn.getBoundingClientRect();
        // Ueberspringe Buttons die in unsichtbaren Containern liegen (0x0)
        if (rect.width === 0 && rect.height === 0) return;

        const opacity = parseFloat(style.opacity);
        checked.push({ id: btn.id || '', width: rect.width, height: rect.height, opacity });

        if (opacity < 0.1) {
          issues.push(`Button (id=${btn.id || 'none'}) hat opacity ${opacity}`);
        }

        // Sichtbare Buttons muessen mindestens 10x10 gross sein (Touch-Target)
        if (rect.width < 10 || rect.height < 10) {
          issues.push(`Button (id=${btn.id || 'none'}) ist zu klein: ${Math.round(rect.width)}x${Math.round(rect.height)}`);
        }
      });

      return { buttonCount: buttons.length, checkedCount: checked.length, issues };
    });

    expect(result.checkedCount).toBeGreaterThan(0);
    expect(result.issues).toEqual([]);
  });

  test('Tab-Navigation: Fokus-Reihenfolge ist logisch durch Hauptelemente', async () => {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });

    // Seite fokussieren durch Klick auf den Body
    await page.click('body');

    // Tab durch die ersten fokussierbaren Elemente und Positionen sammeln
    const focusOrder = await page.evaluate(() => {
      const focusable = Array.from(document.querySelectorAll(
        'a[href], button:not([disabled]):not([tabindex="-1"]), input:not([disabled]):not([type="hidden"]):not([tabindex="-1"]), textarea:not([disabled]):not([tabindex="-1"]), select:not([disabled]):not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])'
      )).filter(el => {
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });

      return focusable.slice(0, 15).map(el => {
        const rect = el.getBoundingClientRect();
        return {
          tag: el.tagName.toLowerCase(),
          id: el.id || '',
          type: el.type || '',
          top: Math.round(rect.top),
          left: Math.round(rect.left),
          tabIndex: el.tabIndex
        };
      });
    });

    // Es muessen fokussierbare Elemente vorhanden sein
    expect(focusOrder.length).toBeGreaterThanOrEqual(3);

    // Pruefen dass die vertikale Reihenfolge grob logisch ist
    let majorViolations = 0;
    for (let i = 1; i < focusOrder.length; i++) {
      const prev = focusOrder[i - 1];
      const curr = focusOrder[i];
      // Wenn ein Element mehr als 300px nach oben springt, ist das verdaechtig
      if (curr.top < prev.top - 300) {
        majorViolations++;
      }
    }
    expect(majorViolations).toBe(0);

    // Fokussierbare Elemente programmatisch durchgehen und pruefen
    // dass sie den Fokus annehmen (tabIndex >= 0)
    const focusResults = await page.evaluate(() => {
      const focusable = Array.from(document.querySelectorAll(
        'a[href], button:not([disabled]):not([tabindex="-1"]), input:not([disabled]):not([type="hidden"]):not([tabindex="-1"]), textarea:not([disabled]):not([tabindex="-1"]), select:not([disabled]):not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])'
      )).filter(el => {
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });

      const results = [];
      for (let i = 0; i < Math.min(focusable.length, 8); i++) {
        const el = focusable[i];
        el.focus();
        const isFocused = document.activeElement === el;
        results.push({
          tag: el.tagName.toLowerCase(),
          id: el.id || '',
          tabIndex: el.tabIndex,
          receivedFocus: isFocused,
          top: Math.round(el.getBoundingClientRect().top)
        });
      }
      return results;
    });

    // Mindestens 3 Elemente muessen fokussierbar sein
    expect(focusResults.length).toBeGreaterThanOrEqual(3);

    // Alle getesteten Elemente muessen den Fokus annehmen
    const focusableCount = focusResults.filter(r => r.receivedFocus).length;
    expect(focusableCount).toBeGreaterThanOrEqual(3);

    // Keine negativen tabIndex-Werte bei sichtbaren interaktiven Elementen
    const negativeTabIndex = focusResults.filter(r => r.tabIndex < 0);
    expect(negativeTabIndex).toEqual([]);
  });

  test('Landmark-Rollen oder semantische Elemente vorhanden', async () => {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });

    const result = await page.evaluate(() => {
      const landmarks = {
        main: document.querySelectorAll('main, [role="main"]').length,
        nav: document.querySelectorAll('nav, [role="navigation"]').length,
        header: document.querySelectorAll('header, [role="banner"]').length,
        footer: document.querySelectorAll('footer, [role="contentinfo"]').length,
        search: document.querySelectorAll('[role="search"]').length,
        complementary: document.querySelectorAll('aside, [role="complementary"]').length,
        status: document.querySelectorAll('[role="status"]').length,
        list: document.querySelectorAll('[role="list"], [role="listbox"]').length
      };

      const totalLandmarks = Object.values(landmarks).reduce((a, b) => a + b, 0);

      // aria-live Regionen zaehlen (fuer dynamische Updates)
      const liveRegions = document.querySelectorAll('[aria-live]').length;

      // sr-only Elemente pruefen (Screen-Reader Texte)
      const srOnlyElements = document.querySelectorAll('.sr-only').length;

      return { landmarks, totalLandmarks, liveRegions, srOnlyElements };
    });

    // Mindestens 1 Landmark-Element muss vorhanden sein
    expect(result.totalLandmarks).toBeGreaterThanOrEqual(1);

    // aria-live Regionen fuer dynamische Inhalte muessen vorhanden sein
    expect(result.liveRegions).toBeGreaterThanOrEqual(1);
  });
});
