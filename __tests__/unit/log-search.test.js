'use strict';

const path = require('path');
const fs = require('fs');
const LogSearchEngine = require('../../src/log-search');
const { tokenize, parseQuery, STOP_WORDS } = require('../../src/log-search');

describe('LogSearchEngine', () => {
  let engine;

  beforeEach(() => {
    engine = new LogSearchEngine();
  });

  // ── Tokenisierung ─────────────────────────────────────────

  test('tokenize extrahiert Wörter und wandelt in lowercase um', () => {
    const tokens = tokenize('Hello World Test');
    expect(tokens).toContain('hello');
    expect(tokens).toContain('world');
    expect(tokens).toContain('test');
  });

  test('tokenize entfernt Stoppwörter', () => {
    const tokens = tokenize('der die das und oder the a an');
    expect(tokens.length).toBe(0);
  });

  test('tokenize entfernt Sonderzeichen und kurze Wörter', () => {
    const tokens = tokenize('a! b? code+ ist x');
    // 'a', 'b', 'x' zu kurz; 'ist' ist Stoppwort; 'code' bleibt
    expect(tokens).toContain('code');
    expect(tokens).not.toContain('a');
    expect(tokens).not.toContain('ist');
  });

  test('tokenize gibt leeres Array für leeren Input', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize(null)).toEqual([]);
    expect(tokenize(undefined)).toEqual([]);
  });

  // ── Query Parser ──────────────────────────────────────────

  test('parseQuery erkennt AND-Verknüpfung (Standard)', () => {
    const result = parseQuery('react component');
    expect(result.terms).toContain('react');
    expect(result.terms).toContain('component');
    expect(result.operator).toBe('AND');
  });

  test('parseQuery erkennt OR-Verknüpfung', () => {
    const result = parseQuery('react OR vue');
    expect(result.terms).toContain('react');
    expect(result.terms).toContain('vue');
    expect(result.operator).toBe('OR');
  });

  test('parseQuery erkennt NOT-Terme', () => {
    const result = parseQuery('react NOT angular');
    expect(result.terms).toContain('react');
    expect(result.notTerms).toContain('angular');
  });

  test('parseQuery erkennt Minus-Prefix als NOT', () => {
    const result = parseQuery('react -angular');
    expect(result.terms).toContain('react');
    expect(result.notTerms).toContain('angular');
  });

  test('parseQuery erkennt Phrasen in Anführungszeichen', () => {
    const result = parseQuery('"exact phrase" react');
    expect(result.phrases).toContain('exact phrase');
    expect(result.terms).toContain('react');
  });

  test('parseQuery gibt leeres Ergebnis für leeren Input', () => {
    const result = parseQuery('');
    expect(result.terms).toEqual([]);
    expect(result.phrases).toEqual([]);
  });

  // ── Einfache Suche ────────────────────────────────────────

  test('search findet indexierte Dokumente', async () => {
    const tmpDir = path.join(__dirname, '..', '..', 'projects', 'proj_test_search_001');
    const agentDir = path.join(tmpDir, 'agent-1');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'conversation.jsonl'),
      JSON.stringify({ role: 'assistant', content: 'Die React-Komponente wurde erfolgreich erstellt' }) + '\n'
    );
    fs.writeFileSync(path.join(tmpDir, 'state.json'), JSON.stringify({
      projectTitle: 'Testprojekt React',
      agents: []
    }));

    await engine.indexProject('proj_test_search_001', tmpDir);
    const result = engine.search('react');

    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results[0].projectId).toBe('proj_test_search_001');

    // Aufräumen
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('search mit AND: alle Terme müssen vorkommen', async () => {
    const tmpDir = path.join(__dirname, '..', '..', 'projects', 'proj_test_search_002');
    const agentDir = path.join(tmpDir, 'agent-1');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'conversation.jsonl'),
      JSON.stringify({ role: 'assistant', content: 'React Komponente erstellt mit TypeScript' }) + '\n' +
      JSON.stringify({ role: 'assistant', content: 'Nur React ohne TS' }) + '\n'
    );
    fs.writeFileSync(path.join(tmpDir, 'state.json'), JSON.stringify({ projectTitle: 'AND-Test', agents: [] }));

    await engine.indexProject('proj_test_search_002', tmpDir);
    const result = engine.search('react AND typescript');

    // Nur Dokumente die BEIDE Terme enthalten
    for (const r of result.results) {
      const doc = engine._docs.get(r.docId);
      if (doc) {
        const lower = doc.content.toLowerCase();
        expect(lower).toContain('react');
        expect(lower).toContain('typescript');
      }
    }

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('search mit OR: mindestens ein Term genügt', async () => {
    const tmpDir = path.join(__dirname, '..', '..', 'projects', 'proj_test_search_003');
    const agentDir = path.join(tmpDir, 'agent-1');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'conversation.jsonl'),
      JSON.stringify({ role: 'assistant', content: 'Nur React hier' }) + '\n' +
      JSON.stringify({ role: 'assistant', content: 'Nur Vue hier' }) + '\n'
    );
    fs.writeFileSync(path.join(tmpDir, 'state.json'), JSON.stringify({ projectTitle: 'OR-Test', agents: [] }));

    await engine.indexProject('proj_test_search_003', tmpDir);
    const result = engine.search('react OR vue');

    // Mindestens 2 Ergebnisse (eines mit React, eines mit Vue)
    expect(result.results.length).toBeGreaterThanOrEqual(2);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('search mit NOT schliesst Terme aus', async () => {
    const tmpDir = path.join(__dirname, '..', '..', 'projects', 'proj_test_search_004');
    const agentDir = path.join(tmpDir, 'agent-1');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'conversation.jsonl'),
      JSON.stringify({ role: 'assistant', content: 'React Komponente ohne Angular' }) + '\n' +
      JSON.stringify({ role: 'assistant', content: 'Angular Service erstellt' }) + '\n'
    );
    fs.writeFileSync(path.join(tmpDir, 'state.json'), JSON.stringify({ projectTitle: 'NOT-Test', agents: [] }));

    await engine.indexProject('proj_test_search_004', tmpDir);
    const result = engine.search('komponente NOT angular');

    // Kein Ergebnis sollte 'angular' im indexierten Inhalt enthalten
    for (const r of result.results) {
      const doc = engine._docs.get(r.docId);
      if (doc) {
        const tokens = tokenize(doc.content);
        expect(tokens).not.toContain('angular');
      }
    }

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('search mit Phrasen findet exakte Übereinstimmung', async () => {
    const tmpDir = path.join(__dirname, '..', '..', 'projects', 'proj_test_search_005');
    const agentDir = path.join(tmpDir, 'agent-1');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'conversation.jsonl'),
      JSON.stringify({ role: 'assistant', content: 'Die React Komponente ist fertig' }) + '\n' +
      JSON.stringify({ role: 'assistant', content: 'React und auch Komponente getrennt' }) + '\n'
    );
    fs.writeFileSync(path.join(tmpDir, 'state.json'), JSON.stringify({ projectTitle: 'Phrase-Test', agents: [] }));

    await engine.indexProject('proj_test_search_005', tmpDir);
    const result = engine.search('"react komponente"');

    // Nur Ergebnisse die die exakte Phrase enthalten
    for (const r of result.results) {
      const doc = engine._docs.get(r.docId);
      if (doc) {
        expect(doc.content.toLowerCase()).toContain('react komponente');
      }
    }

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Highlighting ──────────────────────────────────────────

  test('search mit highlight markiert Treffer mit <mark> Tags', async () => {
    const tmpDir = path.join(__dirname, '..', '..', 'projects', 'proj_test_search_006');
    const agentDir = path.join(tmpDir, 'agent-1');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'conversation.jsonl'),
      JSON.stringify({ role: 'assistant', content: 'React Komponente fertig gestellt' }) + '\n'
    );
    fs.writeFileSync(path.join(tmpDir, 'state.json'), JSON.stringify({ projectTitle: 'Highlight-Test', agents: [] }));

    await engine.indexProject('proj_test_search_006', tmpDir);
    const result = engine.search('react', { highlight: true });

    expect(result.results.length).toBeGreaterThan(0);
    const snippet = result.results[0].snippet;
    expect(snippet).toContain('<mark>');
    expect(snippet).toContain('</mark>');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Pagination ────────────────────────────────────────────

  test('search respektiert limit und offset', async () => {
    const tmpDir = path.join(__dirname, '..', '..', 'projects', 'proj_test_search_007');
    const agentDir = path.join(tmpDir, 'agent-1');
    fs.mkdirSync(agentDir, { recursive: true });
    const lines = [];
    for (let i = 0; i < 10; i++) {
      lines.push(JSON.stringify({ role: 'assistant', content: `Testdokument Nummer ${i} mit Suchbegriff Alpha` }));
    }
    fs.writeFileSync(path.join(agentDir, 'conversation.jsonl'), lines.join('\n') + '\n');
    fs.writeFileSync(path.join(tmpDir, 'state.json'), JSON.stringify({ projectTitle: 'Pagination-Test', agents: [] }));

    await engine.indexProject('proj_test_search_007', tmpDir);

    const all = engine.search('alpha');
    const page1 = engine.search('alpha', { limit: 3, offset: 0 });
    const page2 = engine.search('alpha', { limit: 3, offset: 3 });

    expect(page1.results.length).toBeLessThanOrEqual(3);
    expect(page2.results.length).toBeLessThanOrEqual(3);
    expect(all.total).toBeGreaterThanOrEqual(page1.results.length + page2.results.length);

    // Offset verschiebt die Ergebnisse
    if (page1.results.length > 0 && page2.results.length > 0) {
      expect(page1.results[0].docId).not.toBe(page2.results[0].docId);
    }

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Zeitraum-Filter ───────────────────────────────────────

  test('search filtert nach Zeitraum', async () => {
    const tmpDir = path.join(__dirname, '..', '..', 'projects', 'proj_test_search_008');
    const agentDir = path.join(tmpDir, 'agent-1');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'conversation.jsonl'),
      JSON.stringify({ role: 'assistant', content: 'Zeitfilter Testdokument Alpha', timestamp: '2025-01-01T00:00:00Z' }) + '\n' +
      JSON.stringify({ role: 'assistant', content: 'Zeitfilter Testdokument Alpha Neu', timestamp: '2025-06-01T00:00:00Z' }) + '\n'
    );
    fs.writeFileSync(path.join(tmpDir, 'state.json'), JSON.stringify({ projectTitle: 'Zeit-Test', agents: [] }));

    await engine.indexProject('proj_test_search_008', tmpDir);

    const result = engine.search('zeitfilter', {
      dateFrom: '2025-05-01',
      dateTo: '2025-12-31'
    });

    // Nur das neuere Dokument sollte passen
    for (const r of result.results) {
      const ts = new Date(r.timestamp).getTime();
      expect(ts).toBeGreaterThanOrEqual(new Date('2025-05-01').getTime());
    }

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Leerer Index ──────────────────────────────────────────

  test('search auf leerem Index gibt leeres Ergebnis', () => {
    const result = engine.search('test');
    expect(result.results).toEqual([]);
    expect(result.total).toBe(0);
  });

  test('search mit leerem Query gibt leeres Ergebnis', () => {
    const result = engine.search('');
    expect(result.results).toEqual([]);
    expect(result.total).toBe(0);
  });

  // ── Relevanz-Sortierung ───────────────────────────────────

  test('häufigerer Term ergibt höheren Score', async () => {
    const tmpDir = path.join(__dirname, '..', '..', 'projects', 'proj_test_search_009');
    const agentDir = path.join(tmpDir, 'agent-1');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'conversation.jsonl'),
      JSON.stringify({ role: 'assistant', content: 'Python Python Python Python Python' }) + '\n' +
      JSON.stringify({ role: 'assistant', content: 'Python einmal' }) + '\n'
    );
    fs.writeFileSync(path.join(tmpDir, 'state.json'), JSON.stringify({ projectTitle: 'Relevanz-Test', agents: [] }));

    await engine.indexProject('proj_test_search_009', tmpDir);
    const result = engine.search('python');

    expect(result.results.length).toBeGreaterThanOrEqual(2);
    // Erstes Ergebnis sollte den höheren Score haben (mehr Vorkommen)
    expect(result.results[0].score).toBeGreaterThanOrEqual(result.results[1].score);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Statistiken ───────────────────────────────────────────

  test('getSearchStats gibt korrekte Statistiken', async () => {
    const tmpDir = path.join(__dirname, '..', '..', 'projects', 'proj_test_search_010');
    const agentDir = path.join(tmpDir, 'agent-1');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'conversation.jsonl'),
      JSON.stringify({ role: 'assistant', content: 'Statistik-Test Dokument' }) + '\n'
    );
    fs.writeFileSync(path.join(tmpDir, 'state.json'), JSON.stringify({ projectTitle: 'Stats-Test', agents: [] }));

    const statsBefore = engine.getSearchStats();
    expect(statsBefore.indexedProjects).toBe(0);
    expect(statsBefore.totalEntries).toBe(0);

    await engine.indexProject('proj_test_search_010', tmpDir);
    const statsAfter = engine.getSearchStats();
    expect(statsAfter.indexedProjects).toBe(1);
    expect(statsAfter.totalEntries).toBeGreaterThan(0);
    expect(statsAfter.lastIndexed).not.toBeNull();

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── clearIndex ────────────────────────────────────────────

  test('clearIndex leert den kompletten Index', async () => {
    const tmpDir = path.join(__dirname, '..', '..', 'projects', 'proj_test_search_011');
    const agentDir = path.join(tmpDir, 'agent-1');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'conversation.jsonl'),
      JSON.stringify({ role: 'assistant', content: 'Clear-Test Dokument' }) + '\n'
    );
    fs.writeFileSync(path.join(tmpDir, 'state.json'), JSON.stringify({ projectTitle: 'Clear-Test', agents: [] }));

    await engine.indexProject('proj_test_search_011', tmpDir);
    expect(engine.getSearchStats().totalEntries).toBeGreaterThan(0);

    engine.clearIndex();
    expect(engine.getSearchStats().totalEntries).toBe(0);
    expect(engine.getSearchStats().indexedProjects).toBe(0);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Suggestions ───────────────────────────────────────────

  test('getSuggestions gibt passende Vorschläge zurück', async () => {
    const tmpDir = path.join(__dirname, '..', '..', 'projects', 'proj_test_search_012');
    const agentDir = path.join(tmpDir, 'agent-1');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'conversation.jsonl'),
      JSON.stringify({ role: 'assistant', content: 'Datenbank Datenmigration Datenmodell' }) + '\n'
    );
    fs.writeFileSync(path.join(tmpDir, 'state.json'), JSON.stringify({ projectTitle: 'Suggest-Test', agents: [] }));

    await engine.indexProject('proj_test_search_012', tmpDir);
    const suggestions = engine.getSuggestions('daten');

    expect(suggestions.length).toBeGreaterThan(0);
    for (const s of suggestions) {
      expect(s.term.startsWith('daten')).toBe(true);
      expect(s).toHaveProperty('frequency');
    }

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
