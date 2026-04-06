// Dependency Detection - Unit Tests
// Testet detectCircularDeps und depends_on Validierung

'use strict';

// detectCircularDeps aus orchestrator.js nachgebaut (nicht exportiert)
// Die Funktion baut einen Adjazenzgraphen und erkennt Zyklen via DFS
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

// depends_on Validierung wie in validatePlan
function validateDependsOn(tasks) {
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    if (t.depends_on !== undefined) {
      if (!Array.isArray(t.depends_on)) {
        t.depends_on = [];
      } else {
        t.depends_on = t.depends_on
          .filter(d => Number.isInteger(d) && d >= 0 && d < tasks.length && d !== i);
      }
    } else {
      t.depends_on = [];
    }
  }
  return tasks;
}

describe('detectCircularDeps()', () => {
  test('gibt leere Menge zurueck wenn keine Zyklen', () => {
    // A→B→C (linear, kein Zyklus)
    const tasks = [
      { title: 'A', depends_on: [] },
      { title: 'B', depends_on: [0] },
      { title: 'C', depends_on: [1] },
    ];
    const result = detectCircularDeps(tasks);
    expect(result.size).toBe(0);
  });

  test('erkennt einfachen Zyklus A→B→A', () => {
    const tasks = [
      { title: 'A', depends_on: [1] },
      { title: 'B', depends_on: [0] },
    ];
    const result = detectCircularDeps(tasks);
    expect(result.size).toBeGreaterThan(0);
    expect(result.has(0) || result.has(1)).toBe(true);
  });

  test('erkennt Ketten-Zyklus A→B→C→A', () => {
    const tasks = [
      { title: 'A', depends_on: [2] },
      { title: 'B', depends_on: [0] },
      { title: 'C', depends_on: [1] },
    ];
    const result = detectCircularDeps(tasks);
    expect(result.size).toBeGreaterThan(0);
  });

  test('leeres depends_on ist rueckwaertskompatibel', () => {
    const tasks = [
      { title: 'A' },
      { title: 'B' },
      { title: 'C' },
    ];
    // Kein depends_on-Feld gesetzt → soll nicht crashen
    const result = detectCircularDeps(tasks);
    expect(result.size).toBe(0);
  });

  test('out-of-range Dependencies werden ignoriert', () => {
    const tasks = [
      { title: 'A', depends_on: [99, -1, 100] },
      { title: 'B', depends_on: [5] },
    ];
    // Alle Indizes sind out-of-range → keine Kanten → kein Zyklus
    const result = detectCircularDeps(tasks);
    expect(result.size).toBe(0);
  });
});

describe('validateDependsOn()', () => {
  test('entfernt Selbst-Abhaengigkeit', () => {
    const tasks = [
      { title: 'A', depends_on: [0] },
      { title: 'B', depends_on: [1, 0] },
    ];
    validateDependsOn(tasks);
    expect(tasks[0].depends_on).toEqual([]);
    expect(tasks[1].depends_on).toEqual([0]);
  });
});
