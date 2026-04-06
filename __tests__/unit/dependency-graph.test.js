// Dependency Graph - Unit Tests
// Testet Abhaengigkeitsaufloesung, zirkulaere Deps und Wartelogik

'use strict';
const path = require('path');
const fs = require('fs');

jest.mock('child_process', () => ({
  spawn: jest.fn(),
  execSync: jest.fn(() => 'claude 1.0.0'),
}));

jest.mock('../../src/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

// ── detectCircularDeps nachgebaut (nicht exportiert aus orchestrator.js) ──
function detectCircularDeps(tasks) {
  const taskCount = tasks.length;
  const adj = new Array(taskCount).fill(null).map(() => []);
  for (let i = 0; i < taskCount; i++) {
    const deps = tasks[i].depends_on || [];
    for (const d of deps) {
      if (d >= 0 && d < taskCount) adj[d].push(i);
    }
  }
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Array(taskCount).fill(WHITE);
  const circular = new Set();
  function dfs(u) {
    color[u] = GRAY;
    for (const v of adj[u]) {
      if (color[v] === GRAY) { circular.add(u); circular.add(v); }
      else if (color[v] === WHITE) { dfs(v); }
    }
    color[u] = BLACK;
  }
  for (let i = 0; i < taskCount; i++) {
    if (color[i] === WHITE) dfs(i);
  }
  return circular;
}

// ── validatePlan nachgebaut (depends_on-Validierung + Zyklus-Bereinigung) ──
function validatePlan(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Koordinator-Ausgabe ist kein gueltiges Objekt');
  }
  if (typeof parsed.project_title !== 'string' || !parsed.project_title.trim()) {
    throw new Error('Koordinator-Plan fehlt "project_title" (string)');
  }
  if (!Array.isArray(parsed.tasks) || parsed.tasks.length === 0) {
    throw new Error('Koordinator-Plan fehlt "tasks" (nicht-leeres Array)');
  }
  for (let i = 0; i < parsed.tasks.length; i++) {
    const t = parsed.tasks[i];
    if (!t.title || !t.task || !t.deliverable) {
      throw new Error(`Task ${i + 1} fehlt title, task oder deliverable`);
    }
    if (t.depends_on !== undefined) {
      if (!Array.isArray(t.depends_on)) {
        t.depends_on = [];
      } else {
        t.depends_on = t.depends_on
          .filter(d => Number.isInteger(d) && d >= 0 && d < parsed.tasks.length && d !== i);
      }
    } else {
      t.depends_on = [];
    }
  }
  const circularNodes = detectCircularDeps(parsed.tasks);
  if (circularNodes.size > 0) {
    for (const idx of circularNodes) {
      parsed.tasks[idx].depends_on = [];
    }
  }
  return parsed;
}

// ── Abhaengigkeits-Wartelogik simulieren (wie in orchestrator.js start()) ──
async function simulateDependencyExecution(tasks) {
  const taskCount = tasks.length;
  const completionOrder = [];
  const agentCompletions = new Array(taskCount);
  const agentStatuses = new Array(taskCount).fill('waiting');

  for (let i = 0; i < taskCount; i++) {
    agentCompletions[i] = (async () => {
      const deps = tasks[i].depends_on || [];
      const validDeps = deps.filter(d => d >= 0 && d < taskCount && d !== i);
      if (validDeps.length > 0) {
        agentStatuses[i] = 'waiting_deps';
        await Promise.allSettled(validDeps.map(d => agentCompletions[d]));
      }
      agentStatuses[i] = 'working';
      // Simuliere kurze Arbeit
      await new Promise(r => setTimeout(r, 10));
      agentStatuses[i] = 'done';
      completionOrder.push(i);
    })();
  }

  await Promise.allSettled(agentCompletions);
  return { completionOrder, agentStatuses };
}

describe('Dependency Graph', () => {

  // ── Abhaengigkeiten werden korrekt aufgeloest ─────────────

  describe('Abhaengigkeiten werden korrekt aufgeloest', () => {
    test('lineare Kette: A → B → C', async () => {
      const tasks = [
        { title: 'A', task: 'a', deliverable: 'a', depends_on: [] },
        { title: 'B', task: 'b', deliverable: 'b', depends_on: [0] },
        { title: 'C', task: 'c', deliverable: 'c', depends_on: [1] },
      ];
      const { completionOrder } = await simulateDependencyExecution(tasks);
      // A muss vor B, B muss vor C
      expect(completionOrder.indexOf(0)).toBeLessThan(completionOrder.indexOf(1));
      expect(completionOrder.indexOf(1)).toBeLessThan(completionOrder.indexOf(2));
    });

    test('parallele Tasks ohne Abhaengigkeiten', async () => {
      const tasks = [
        { title: 'A', task: 'a', deliverable: 'a', depends_on: [] },
        { title: 'B', task: 'b', deliverable: 'b', depends_on: [] },
        { title: 'C', task: 'c', deliverable: 'c', depends_on: [] },
      ];
      const { completionOrder, agentStatuses } = await simulateDependencyExecution(tasks);
      // Alle sollten fertig sein
      expect(completionOrder).toHaveLength(3);
      expect(agentStatuses.every(s => s === 'done')).toBe(true);
    });

    test('Diamant-Abhaengigkeit: A → B,C → D', async () => {
      const tasks = [
        { title: 'A', task: 'a', deliverable: 'a', depends_on: [] },
        { title: 'B', task: 'b', deliverable: 'b', depends_on: [0] },
        { title: 'C', task: 'c', deliverable: 'c', depends_on: [0] },
        { title: 'D', task: 'd', deliverable: 'd', depends_on: [1, 2] },
      ];
      const { completionOrder } = await simulateDependencyExecution(tasks);
      // A muss vor B und C
      expect(completionOrder.indexOf(0)).toBeLessThan(completionOrder.indexOf(1));
      expect(completionOrder.indexOf(0)).toBeLessThan(completionOrder.indexOf(2));
      // B und C muessen vor D
      expect(completionOrder.indexOf(1)).toBeLessThan(completionOrder.indexOf(3));
      expect(completionOrder.indexOf(2)).toBeLessThan(completionOrder.indexOf(3));
    });

    test('mehrfache Abhaengigkeiten auf gleichen Task', async () => {
      const tasks = [
        { title: 'A', task: 'a', deliverable: 'a', depends_on: [] },
        { title: 'B', task: 'b', deliverable: 'b', depends_on: [0] },
        { title: 'C', task: 'c', deliverable: 'c', depends_on: [0] },
      ];
      const { completionOrder } = await simulateDependencyExecution(tasks);
      // A muss vor B und C
      expect(completionOrder.indexOf(0)).toBeLessThan(completionOrder.indexOf(1));
      expect(completionOrder.indexOf(0)).toBeLessThan(completionOrder.indexOf(2));
    });

    test('leere Tasks-Liste', () => {
      const result = detectCircularDeps([]);
      expect(result.size).toBe(0);
    });

    test('einzelner Task ohne Deps', async () => {
      const tasks = [{ title: 'A', task: 'a', deliverable: 'a', depends_on: [] }];
      const { completionOrder } = await simulateDependencyExecution(tasks);
      expect(completionOrder).toEqual([0]);
    });
  });

  // ── Zirkulaere Abhaengigkeiten ────────────────────────────

  describe('Zirkulaere Abhaengigkeiten erkennen', () => {
    test('einfacher Zyklus A ↔ B', () => {
      const tasks = [
        { title: 'A', task: 'a', deliverable: 'a', depends_on: [1] },
        { title: 'B', task: 'b', deliverable: 'b', depends_on: [0] },
      ];
      const circular = detectCircularDeps(tasks);
      expect(circular.size).toBeGreaterThan(0);
    });

    test('Dreieck-Zyklus A → B → C → A', () => {
      const tasks = [
        { title: 'A', task: 'a', deliverable: 'a', depends_on: [2] },
        { title: 'B', task: 'b', deliverable: 'b', depends_on: [0] },
        { title: 'C', task: 'c', deliverable: 'c', depends_on: [1] },
      ];
      const circular = detectCircularDeps(tasks);
      expect(circular.size).toBeGreaterThan(0);
    });

    test('teilweiser Zyklus: A linear, B ↔ C', () => {
      const tasks = [
        { title: 'A', task: 'a', deliverable: 'a', depends_on: [] },
        { title: 'B', task: 'b', deliverable: 'b', depends_on: [2] },
        { title: 'C', task: 'c', deliverable: 'c', depends_on: [1] },
      ];
      const circular = detectCircularDeps(tasks);
      expect(circular.size).toBeGreaterThan(0);
      // A sollte nicht betroffen sein (kein Zyklus fuer A)
      // B und C sind im Zyklus
      expect(circular.has(1) || circular.has(2)).toBe(true);
    });

    test('Selbst-Referenz wird durch validatePlan entfernt', () => {
      const plan = {
        project_title: 'Test',
        tasks: [
          { title: 'A', task: 'a', deliverable: 'a', depends_on: [0] },
          { title: 'B', task: 'b', deliverable: 'b', depends_on: [0] },
        ],
      };
      const validated = validatePlan(plan);
      // Selbst-Referenz bei Task 0 wurde entfernt
      expect(validated.tasks[0].depends_on).toEqual([]);
      // Gueltige Referenz von Task 1 auf Task 0 bleibt
      expect(validated.tasks[1].depends_on).toEqual([0]);
    });

    test('Zyklus wird durch validatePlan bereinigt', () => {
      const plan = {
        project_title: 'Test',
        tasks: [
          { title: 'A', task: 'a', deliverable: 'a', depends_on: [1] },
          { title: 'B', task: 'b', deliverable: 'b', depends_on: [0] },
        ],
      };
      const validated = validatePlan(plan);
      // Zirkulaere Deps wurden entfernt
      const circularAfter = detectCircularDeps(validated.tasks);
      expect(circularAfter.size).toBe(0);
    });
  });

  // ── validatePlan Randfaelle ───────────────────────────────

  describe('validatePlan Randfaelle', () => {
    test('out-of-range Indizes werden entfernt', () => {
      const plan = {
        project_title: 'Test',
        tasks: [
          { title: 'A', task: 'a', deliverable: 'a', depends_on: [99, -1, 5] },
          { title: 'B', task: 'b', deliverable: 'b', depends_on: [0, 100] },
        ],
      };
      const validated = validatePlan(plan);
      expect(validated.tasks[0].depends_on).toEqual([]);
      expect(validated.tasks[1].depends_on).toEqual([0]);
    });

    test('nicht-Array depends_on wird auf leeres Array gesetzt', () => {
      const plan = {
        project_title: 'Test',
        tasks: [
          { title: 'A', task: 'a', deliverable: 'a', depends_on: 'falsch' },
          { title: 'B', task: 'b', deliverable: 'b', depends_on: 42 },
        ],
      };
      const validated = validatePlan(plan);
      expect(validated.tasks[0].depends_on).toEqual([]);
      expect(validated.tasks[1].depends_on).toEqual([]);
    });

    test('fehlendes depends_on wird auf leeres Array gesetzt', () => {
      const plan = {
        project_title: 'Test',
        tasks: [
          { title: 'A', task: 'a', deliverable: 'a' },
          { title: 'B', task: 'b', deliverable: 'b' },
        ],
      };
      const validated = validatePlan(plan);
      expect(validated.tasks[0].depends_on).toEqual([]);
      expect(validated.tasks[1].depends_on).toEqual([]);
    });

    test('Float-Indizes werden herausgefiltert', () => {
      const plan = {
        project_title: 'Test',
        tasks: [
          { title: 'A', task: 'a', deliverable: 'a', depends_on: [] },
          { title: 'B', task: 'b', deliverable: 'b', depends_on: [0.5, 0] },
        ],
      };
      const validated = validatePlan(plan);
      // 0.5 ist kein Integer, wird entfernt; 0 bleibt
      expect(validated.tasks[1].depends_on).toEqual([0]);
    });

    test('null-Werte in depends_on werden herausgefiltert', () => {
      const plan = {
        project_title: 'Test',
        tasks: [
          { title: 'A', task: 'a', deliverable: 'a', depends_on: [] },
          { title: 'B', task: 'b', deliverable: 'b', depends_on: [null, undefined, 0] },
        ],
      };
      const validated = validatePlan(plan);
      expect(validated.tasks[1].depends_on).toEqual([0]);
    });
  });

  // ── Agent startet erst wenn Abhaengigkeiten fertig ────────

  describe('Agent startet erst wenn Abhaengigkeiten fertig', () => {
    test('Agent mit Dep wartet auf Abschluss', async () => {
      const statusLog = [];
      const tasks = [
        { title: 'A', task: 'a', deliverable: 'a', depends_on: [] },
        { title: 'B', task: 'b', deliverable: 'b', depends_on: [0] },
      ];

      const taskCount = tasks.length;
      const agentCompletions = new Array(taskCount);

      for (let i = 0; i < taskCount; i++) {
        agentCompletions[i] = (async () => {
          const deps = tasks[i].depends_on || [];
          if (deps.length > 0) {
            statusLog.push({ agent: i, event: 'waiting_deps' });
            await Promise.allSettled(deps.map(d => agentCompletions[d]));
            statusLog.push({ agent: i, event: 'deps_resolved' });
          }
          statusLog.push({ agent: i, event: 'start_work' });
          await new Promise(r => setTimeout(r, 20));
          statusLog.push({ agent: i, event: 'done' });
        })();
      }

      await Promise.allSettled(agentCompletions);

      // Agent 1 muss warten, bevor er startet
      const b_waiting = statusLog.findIndex(e => e.agent === 1 && e.event === 'waiting_deps');
      const a_done = statusLog.findIndex(e => e.agent === 0 && e.event === 'done');
      const b_deps_resolved = statusLog.findIndex(e => e.agent === 1 && e.event === 'deps_resolved');

      expect(b_waiting).toBeGreaterThanOrEqual(0);
      expect(b_deps_resolved).toBeGreaterThanOrEqual(0);
      // A muss fertig sein bevor B seine Deps als resolved markiert
      expect(a_done).toBeLessThan(b_deps_resolved);
    });

    test('Agent startet trotzdem wenn Abhaengigkeit fehlschlaegt', async () => {
      const tasks = [
        { title: 'A', task: 'a', deliverable: 'a', depends_on: [] },
        { title: 'B', task: 'b', deliverable: 'b', depends_on: [0] },
      ];

      const taskCount = tasks.length;
      const agentCompletions = new Array(taskCount);
      const agentStatuses = new Array(taskCount).fill('waiting');

      agentCompletions[0] = (async () => {
        agentStatuses[0] = 'working';
        await new Promise(r => setTimeout(r, 10));
        agentStatuses[0] = 'error';
        throw new Error('Agent 0 fehlgeschlagen');
      })();

      agentCompletions[1] = (async () => {
        agentStatuses[1] = 'waiting_deps';
        // Promise.allSettled wartet auch auf rejected Promises
        await Promise.allSettled([agentCompletions[0]]);
        // Agent startet trotzdem
        agentStatuses[1] = 'working';
        await new Promise(r => setTimeout(r, 10));
        agentStatuses[1] = 'done';
      })();

      await Promise.allSettled(agentCompletions);

      // Agent 0 ist error, Agent 1 ist trotzdem done
      expect(agentStatuses[0]).toBe('error');
      expect(agentStatuses[1]).toBe('done');
    });

    test('komplexer Graph: mehrere Ebenen von Abhaengigkeiten', async () => {
      // Level 0: A, B (keine Deps)
      // Level 1: C (haengt von A ab), D (haengt von B ab)
      // Level 2: E (haengt von C und D ab)
      const tasks = [
        { title: 'A', task: 'a', deliverable: 'a', depends_on: [] },
        { title: 'B', task: 'b', deliverable: 'b', depends_on: [] },
        { title: 'C', task: 'c', deliverable: 'c', depends_on: [0] },
        { title: 'D', task: 'd', deliverable: 'd', depends_on: [1] },
        { title: 'E', task: 'e', deliverable: 'e', depends_on: [2, 3] },
      ];
      const { completionOrder } = await simulateDependencyExecution(tasks);

      // A und B muessen vor ihren Abhaengigen fertig sein
      expect(completionOrder.indexOf(0)).toBeLessThan(completionOrder.indexOf(2));
      expect(completionOrder.indexOf(1)).toBeLessThan(completionOrder.indexOf(3));
      // C und D muessen vor E fertig sein
      expect(completionOrder.indexOf(2)).toBeLessThan(completionOrder.indexOf(4));
      expect(completionOrder.indexOf(3)).toBeLessThan(completionOrder.indexOf(4));
    });
  });
});
