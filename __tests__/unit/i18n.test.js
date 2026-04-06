// i18n / Lokalisierung - Unit Tests
// Testet t(), Fallback, Interpolation und Sprachverwaltung

'use strict';

const { t, LANGUAGES, getLanguage, setLanguage, getTranslations, getKeys, translations } = require('../../src/i18n');

describe('t() – Übersetzungsfunktion', () => {
  beforeEach(() => {
    // Sprache vor jedem Test auf Deutsch zurücksetzen
    setLanguage('de');
  });

  test('gibt deutschen Text zurück für existierenden Key', () => {
    const result = t('phase.running', 'de');
    expect(result).toBe('Läuft');
  });

  test('gibt englischen Text zurück für existierenden Key', () => {
    const result = t('phase.running', 'en');
    expect(result).toBe('Running');
  });

  test('Fallback zu Deutsch wenn Key in EN fehlt', () => {
    // Temporär einen Key nur in DE anlegen
    translations.de['_test.only_de'] = 'Nur Deutsch';
    const result = t('_test.only_de', 'en');
    expect(result).toBe('Nur Deutsch');
    delete translations.de['_test.only_de'];
  });

  test('gibt Key zurück wenn in keiner Sprache vorhanden', () => {
    const result = t('nonexistent.key.xyz', 'de');
    expect(result).toBe('nonexistent.key.xyz');
  });

  test('Interpolation mit einem Parameter', () => {
    const result = t('agent.started', 'en', { id: 3 });
    expect(result).toBe('Agent 3 started');
  });

  test('Interpolation mit mehreren Parametern', () => {
    const result = t('agent.error', 'de', { id: 5, error: 'Timeout' });
    expect(result).toBe('Agent 5 Fehler: Timeout');
  });

  test('Interpolation mit Parametern in EN', () => {
    const result = t('error.rate_limit', 'en', { seconds: 30 });
    expect(result).toBe('Rate limit reached, waiting 30s');
  });

  test('ungültige Sprache → Fallback zu currentLanguage (de)', () => {
    const result = t('phase.error', 'fr');
    expect(result).toBe('Fehler');
  });

  test('null als Sprache → Fallback zu currentLanguage', () => {
    const result = t('phase.complete', null);
    expect(result).toBe('Abgeschlossen');
  });

  test('ohne Sprache → nutzt currentLanguage', () => {
    setLanguage('en');
    const result = t('phase.complete');
    expect(result).toBe('Complete');
  });

  test('Interpolation ohne params-Objekt funktioniert', () => {
    const result = t('agent.started', 'de');
    expect(result).toBe('Agent {id} gestartet');
  });

  test('Interpolation mit leerem params-Objekt', () => {
    const result = t('agent.started', 'de', {});
    expect(result).toBe('Agent {id} gestartet');
  });
});

describe('LANGUAGES', () => {
  test('enthält de und en', () => {
    expect(LANGUAGES).toHaveProperty('de');
    expect(LANGUAGES).toHaveProperty('en');
  });

  test('Labels sind korrekt', () => {
    expect(LANGUAGES.de).toBe('Deutsch');
    expect(LANGUAGES.en).toBe('English');
  });
});

describe('getLanguage / setLanguage', () => {
  beforeEach(() => {
    setLanguage('de');
  });

  test('getLanguage gibt aktuelle Sprache zurück', () => {
    expect(getLanguage()).toBe('de');
  });

  test('setLanguage ändert die Sprache', () => {
    setLanguage('en');
    expect(getLanguage()).toBe('en');
  });

  test('setLanguage mit ungültiger Sprache gibt false zurück', () => {
    const result = setLanguage('fr');
    expect(result).toBe(false);
    expect(getLanguage()).toBe('de');
  });

  test('setLanguage mit gültiger Sprache gibt true zurück', () => {
    const result = setLanguage('en');
    expect(result).toBe(true);
  });
});

describe('Vollständigkeit der Übersetzungen', () => {
  test('alle DE-Keys existieren auch in EN', () => {
    const deKeys = getKeys('de');
    const enKeys = getKeys('en');
    const missingInEn = deKeys.filter(k => !enKeys.includes(k));
    expect(missingInEn).toEqual([]);
  });

  test('alle EN-Keys existieren auch in DE', () => {
    const deKeys = getKeys('de');
    const enKeys = getKeys('en');
    const missingInDe = enKeys.filter(k => !deKeys.includes(k));
    expect(missingInDe).toEqual([]);
  });

  test('mindestens 50 Keys in DE vorhanden', () => {
    const deKeys = getKeys('de');
    expect(deKeys.length).toBeGreaterThanOrEqual(50);
  });

  test('mindestens 50 Keys in EN vorhanden', () => {
    const enKeys = getKeys('en');
    expect(enKeys.length).toBeGreaterThanOrEqual(50);
  });
});

describe('getTranslations', () => {
  test('gibt Übersetzungen für gültige Sprache zurück', () => {
    const trans = getTranslations('de');
    expect(trans).toBeTruthy();
    expect(trans['phase.running']).toBe('Läuft');
  });

  test('gibt null für ungültige Sprache zurück', () => {
    const trans = getTranslations('fr');
    expect(trans).toBeNull();
  });

  test('gibt Kopie zurück (kein Referenz-Leak)', () => {
    const trans = getTranslations('de');
    trans['phase.running'] = 'MODIFIED';
    expect(t('phase.running', 'de')).toBe('Läuft');
  });
});
