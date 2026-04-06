'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const ConfigProfileManager = require('../../src/config-profiles');

let tmpDir;
let manager;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'profiles-test-'));
  manager = new ConfigProfileManager(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('ConfigProfileManager', () => {

  // ── Default-Profile ──────────────────────────────────────
  test('Default-Profile sind vorhanden', () => {
    const profiles = manager.listProfiles();
    const names = profiles.map(p => p.name);
    expect(names).toContain('schnell');
    expect(names).toContain('standard');
    expect(names).toContain('gruendlich');
  });

  test('Default-Profile haben isDefault=true', () => {
    const profiles = manager.listProfiles();
    const defaults = profiles.filter(p => p.isDefault);
    expect(defaults.length).toBe(3);
  });

  test('Default-Profile koennen nicht geloescht werden', () => {
    expect(() => manager.deleteProfile('schnell')).toThrow('Default-Profil');
    expect(() => manager.deleteProfile('standard')).toThrow('Default-Profil');
    expect(() => manager.deleteProfile('gruendlich')).toThrow('Default-Profil');
  });

  // ── CRUD ─────────────────────────────────────────────────
  test('saveProfile erstellt neues Profil', () => {
    const config = { maxParallelAgents: 4, maxRounds: 8 };
    const profile = manager.saveProfile('mein-profil', config, 'Test-Beschreibung');

    expect(profile.name).toBe('mein-profil');
    expect(profile.description).toBe('Test-Beschreibung');
    expect(profile.config).toEqual(config);
    expect(profile.isDefault).toBe(false);
    expect(profile.createdAt).toBeTruthy();
    expect(profile.updatedAt).toBeTruthy();
  });

  test('loadProfile laedt gespeichertes Profil', () => {
    const config = { maxParallelAgents: 7 };
    manager.saveProfile('test-load', config, 'Laden-Test');

    const loaded = manager.loadProfile('test-load');
    expect(loaded.name).toBe('test-load');
    expect(loaded.config.maxParallelAgents).toBe(7);
  });

  test('loadProfile wirft Fehler bei unbekanntem Profil', () => {
    expect(() => manager.loadProfile('gibts-nicht')).toThrow('nicht gefunden');
  });

  test('deleteProfile loescht benutzerdefiniertes Profil', () => {
    manager.saveProfile('zum-loeschen', { maxRounds: 2 }, '');
    expect(manager.deleteProfile('zum-loeschen')).toBe(true);
    expect(() => manager.loadProfile('zum-loeschen')).toThrow('nicht gefunden');
  });

  test('listProfiles zeigt alle Profile', () => {
    manager.saveProfile('extra', { maxRounds: 10 }, 'Extra');
    const profiles = manager.listProfiles();
    expect(profiles.length).toBe(4); // 3 defaults + 1 custom
    const names = profiles.map(p => p.name);
    expect(names).toContain('extra');
  });

  // ── Validierung ──────────────────────────────────────────
  test('Ungueltige Namen werden abgelehnt (Sonderzeichen)', () => {
    expect(() => manager.saveProfile('test profil!', {}, '')).toThrow('alphanumerische');
  });

  test('Zu lange Namen werden abgelehnt', () => {
    const longName = 'a'.repeat(51);
    expect(() => manager.saveProfile(longName, {}, '')).toThrow('maximal 50');
  });

  test('Leerer Name wird abgelehnt', () => {
    expect(() => manager.saveProfile('', {}, '')).toThrow('nicht leer');
  });

  // ── Import / Export ──────────────────────────────────────
  test('exportProfile gibt JSON-String zurueck', () => {
    manager.saveProfile('export-test', { maxRounds: 5 }, 'Export');
    const json = manager.exportProfile('export-test');
    const parsed = JSON.parse(json);
    expect(parsed.name).toBe('export-test');
    expect(parsed.config.maxRounds).toBe(5);
  });

  test('importProfile importiert von JSON-String', () => {
    const data = {
      name: 'importiert',
      description: 'Importiertes Profil',
      config: { maxParallelAgents: 6, maxRounds: 12 },
    };
    const profile = manager.importProfile(JSON.stringify(data));
    expect(profile.name).toBe('importiert');
    expect(profile.config.maxParallelAgents).toBe(6);
    expect(profile.isDefault).toBe(false);

    // Soll auch ladbar sein
    const loaded = manager.loadProfile('importiert');
    expect(loaded.config.maxRounds).toBe(12);
  });

  test('importProfile wirft bei ungueltigem JSON', () => {
    expect(() => manager.importProfile('kein json')).toThrow('Ungueltiges JSON');
  });

  test('importProfile wirft bei fehlendem name/config', () => {
    expect(() => manager.importProfile(JSON.stringify({ description: 'nur desc' }))).toThrow('name und config');
  });

  // ── Aktives Profil ───────────────────────────────────────
  test('getActiveProfile gibt null zurueck wenn keins aktiv', () => {
    expect(manager.getActiveProfile()).toBeNull();
  });

  test('setActiveProfile setzt und liest aktives Profil', () => {
    manager.setActiveProfile('schnell');
    expect(manager.getActiveProfile()).toBe('schnell');
  });

  test('setActiveProfile mit null setzt zurueck', () => {
    manager.setActiveProfile('standard');
    manager.setActiveProfile(null);
    expect(manager.getActiveProfile()).toBeNull();
  });

  test('setActiveProfile wirft bei unbekanntem Profil', () => {
    expect(() => manager.setActiveProfile('fantasie')).toThrow('nicht gefunden');
  });

  test('listProfiles zeigt aktives Profil an', () => {
    manager.setActiveProfile('schnell');
    const profiles = manager.listProfiles();
    const schnell = profiles.find(p => p.name === 'schnell');
    expect(schnell.isActive).toBe(true);
    const standard = profiles.find(p => p.name === 'standard');
    expect(standard.isActive).toBe(false);
  });

  test('deleteProfile setzt aktives Profil zurueck wenn geloescht', () => {
    manager.saveProfile('temp', { maxRounds: 1 }, '');
    manager.setActiveProfile('temp');
    expect(manager.getActiveProfile()).toBe('temp');
    manager.deleteProfile('temp');
    expect(manager.getActiveProfile()).toBeNull();
  });
});
