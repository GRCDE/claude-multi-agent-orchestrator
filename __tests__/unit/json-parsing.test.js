// JSON-Parsing des Koordinator-Outputs - Unit Tests
// Testet das Extrahieren und Validieren von Aufgaben-JSON aus Claude-Antworten

function parseCoordinatorOutput(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw.replace(/```json\n?|```\n?/g, '').trim());
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) parsed = JSON.parse(match[0]);
    else throw new Error('Kein JSON gefunden');
  }
  if (!parsed.project_title || typeof parsed.project_title !== 'string') throw new Error('project_title fehlt');
  if (!Array.isArray(parsed.tasks) || parsed.tasks.length === 0) throw new Error('tasks fehlt/leer');
  for (const t of parsed.tasks) {
    if (!t.title || !t.task || !t.deliverable) throw new Error('Task unvollständig');
  }
  return parsed;
}

describe('parseCoordinatorOutput()', () => {
  const validJSON = JSON.stringify({
    project_title: 'Test', summary: 'Ein Test',
    tasks: [{ title: 'T1', task: 'Aufgabe 1', deliverable: 'Datei' }]
  });

  test('parst sauberes JSON', () => {
    const r = parseCoordinatorOutput(validJSON);
    expect(r.project_title).toBe('Test');
    expect(r.tasks).toHaveLength(1);
  });

  test('parst JSON mit ```json Wrapper', () => {
    const r = parseCoordinatorOutput('```json\n' + validJSON + '\n```');
    expect(r.project_title).toBe('Test');
  });

  test('extrahiert JSON aus Text per Regex', () => {
    const r = parseCoordinatorOutput('Hier ist mein Plan: ' + validJSON + ' Ende.');
    expect(r.project_title).toBe('Test');
  });

  test('wirft bei ungültigem JSON', () => {
    expect(() => parseCoordinatorOutput('kein json hier')).toThrow();
  });

  test('wirft bei fehlendem tasks Array', () => {
    expect(() => parseCoordinatorOutput('{"project_title":"X"}')).toThrow('tasks');
  });

  test('wirft bei leerem tasks Array', () => {
    expect(() => parseCoordinatorOutput('{"project_title":"X","tasks":[]}')).toThrow();
  });

  test('wirft bei Task ohne title', () => {
    const bad = JSON.stringify({ project_title: 'X', tasks: [{ task: 'x', deliverable: 'y' }] });
    expect(() => parseCoordinatorOutput(bad)).toThrow('unvollständig');
  });
});
