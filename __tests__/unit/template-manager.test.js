'use strict';

const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;
const TemplateManager = require('../../src/template-manager');

// Temporaeres Verzeichnis fuer Tests
const TEST_DIR = path.join(__dirname, '..', '..', 'test-templates-' + Date.now());

let manager;

function makeTemplate(overrides) {
  return {
    name: 'Test Template',
    description: 'Ein Test-Template',
    category: 'Test',
    tags: ['test'],
    difficulty: 'beginner',
    agentCount: 2,
    tasks: [
      { title: 'Aufgabe 1', description: 'Beschreibung 1' }
    ],
    roles: [],
    config: {},
    author: 'Tester',
    version: '1.0.0',
    ...overrides
  };
}

beforeAll(async () => {
  await fsp.mkdir(TEST_DIR, { recursive: true });
  manager = new TemplateManager(TEST_DIR);
});

afterAll(async () => {
  // Aufräumen
  try {
    const files = await fsp.readdir(TEST_DIR);
    for (const f of files) {
      await fsp.unlink(path.join(TEST_DIR, f));
    }
    await fsp.rmdir(TEST_DIR);
  } catch (e) {
    // Ignorieren
  }
});

describe('TemplateManager', () => {

  // 1. Erstellen und Laden
  test('saveTemplate erstellt ein Template und getTemplate laedt es', async () => {
    const tpl = makeTemplate({ name: 'CRUD Test' });
    const saved = await manager.saveTemplate(tpl);

    expect(saved.id).toBeDefined();
    expect(saved.name).toBe('CRUD Test');
    expect(saved.createdAt).toBeDefined();
    expect(saved.updatedAt).toBeDefined();

    const loaded = await manager.getTemplate(saved.id);
    expect(loaded).not.toBeNull();
    expect(loaded.name).toBe('CRUD Test');
  });

  // 2. Alle laden
  test('loadTemplates gibt alle Templates zurueck', async () => {
    const all = await manager.loadTemplates();
    expect(Array.isArray(all)).toBe(true);
    expect(all.length).toBeGreaterThanOrEqual(1);
  });

  // 3. Loeschen
  test('deleteTemplate entfernt ein Template', async () => {
    const saved = await manager.saveTemplate(makeTemplate({ name: 'Zum Loeschen' }));
    await manager.deleteTemplate(saved.id);

    const loaded = await manager.getTemplate(saved.id);
    expect(loaded).toBeNull();
  });

  // 4. Loeschen eines nicht existierenden Templates wirft Fehler
  test('deleteTemplate wirft bei unbekannter ID', async () => {
    await expect(manager.deleteTemplate('non-existent-id-xyz'))
      .rejects.toThrow('Template nicht gefunden');
  });

  // 5. Validierung: fehlender Name
  test('validate erkennt fehlenden Namen', () => {
    const result = manager.validate({ tasks: [{ title: 'x' }] });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Name ist erforderlich');
  });

  // 6. Validierung: leere Tasks
  test('validate erkennt leere Tasks', () => {
    const result = manager.validate({ name: 'Test', tasks: [] });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Mindestens eine Aufgabe (tasks) ist erforderlich');
  });

  // 7. Validierung: gueltiges Template
  test('validate akzeptiert gueltiges Template', () => {
    const result = manager.validate(makeTemplate());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  // 8. Filter nach Tag
  test('listTemplates filtert nach Tag', async () => {
    await manager.saveTemplate(makeTemplate({ name: 'Tag-Test', tags: ['spezial'] }));
    const results = await manager.listTemplates({ tag: 'spezial' });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.every(t => t.tags.includes('spezial'))).toBe(true);
  });

  // 9. Filter nach Category
  test('listTemplates filtert nach Category', async () => {
    await manager.saveTemplate(makeTemplate({ name: 'Cat-Test', category: 'Backend' }));
    const results = await manager.listTemplates({ category: 'Backend' });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.every(t => t.category.toLowerCase() === 'backend')).toBe(true);
  });

  // 10. Filter nach Difficulty
  test('listTemplates filtert nach Difficulty', async () => {
    await manager.saveTemplate(makeTemplate({ name: 'Diff-Test', difficulty: 'advanced' }));
    const results = await manager.listTemplates({ difficulty: 'advanced' });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.every(t => t.difficulty === 'advanced')).toBe(true);
  });

  // 11. Import/Export
  test('exportTemplate und importTemplate funktionieren zusammen', async () => {
    const saved = await manager.saveTemplate(makeTemplate({ name: 'Export-Test' }));
    const jsonStr = await manager.exportTemplate(saved.id);

    expect(typeof jsonStr).toBe('string');
    const parsed = JSON.parse(jsonStr);
    expect(parsed.name).toBe('Export-Test');

    const imported = await manager.importTemplate(jsonStr);
    expect(imported.name).toBe('Export-Test');
    expect(imported.id).not.toBe(saved.id); // Neue ID
  });

  // 12. Import mit ungueltigem JSON wirft Fehler
  test('importTemplate wirft bei ungueltigem JSON', async () => {
    await expect(manager.importTemplate('kein json'))
      .rejects.toThrow('Ungueltiges JSON');
  });

  // 13. Bewertung
  test('rateTemplate berechnet Durchschnitt korrekt', async () => {
    const saved = await manager.saveTemplate(makeTemplate({ name: 'Rate-Test' }));

    let rated = await manager.rateTemplate(saved.id, 5);
    expect(rated.rating).toBe(5);
    expect(rated.ratingCount).toBe(1);

    rated = await manager.rateTemplate(saved.id, 3);
    expect(rated.rating).toBe(4); // (5+3)/2 = 4
    expect(rated.ratingCount).toBe(2);
  });

  // 14. Bewertung ausserhalb des Bereichs
  test('rateTemplate wirft bei ungueltiger Bewertung', async () => {
    const saved = await manager.saveTemplate(makeTemplate({ name: 'Bad-Rate' }));
    await expect(manager.rateTemplate(saved.id, 0))
      .rejects.toThrow('Bewertung muss zwischen 1 und 5 liegen');
    await expect(manager.rateTemplate(saved.id, 6))
      .rejects.toThrow('Bewertung muss zwischen 1 und 5 liegen');
  });

  // 15. Duplizierung
  test('duplicateTemplate erstellt eine Kopie mit neuem Namen', async () => {
    const saved = await manager.saveTemplate(makeTemplate({ name: 'Original' }));
    const duplicate = await manager.duplicateTemplate(saved.id, 'Kopie');

    expect(duplicate.id).not.toBe(saved.id);
    expect(duplicate.name).toBe('Kopie');
    expect(duplicate.rating).toBe(0);
    expect(duplicate.ratingCount).toBe(0);
    expect(duplicate.tasks).toEqual(saved.tasks);
  });

  // 16. Duplizierung ohne Namen erzeugt "(Kopie)" Suffix
  test('duplicateTemplate verwendet Standard-Name wenn keiner angegeben', async () => {
    const saved = await manager.saveTemplate(makeTemplate({ name: 'MeinTemplate' }));
    const duplicate = await manager.duplicateTemplate(saved.id);

    expect(duplicate.name).toBe('MeinTemplate (Kopie)');
  });

  // 17. getTemplate gibt null fuer unbekannte ID
  test('getTemplate gibt null fuer unbekannte ID', async () => {
    const result = await manager.getTemplate('gibt-es-nicht');
    expect(result).toBeNull();
  });

  // 18. saveTemplate ohne Tasks wirft Fehler
  test('saveTemplate wirft bei fehlendem Task', async () => {
    await expect(manager.saveTemplate({ name: 'Ohne Tasks', tasks: [] }))
      .rejects.toThrow('Template ungueltig');
  });
});
